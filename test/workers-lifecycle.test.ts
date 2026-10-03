import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { proxyChat } from "../src/services/proxy";
import { makeAuth, fakeEnv } from "./proxy.helper";

// Workers 执行生命周期守卫。
//
// 为什么主体必须是**静态检查**而不是运行时断言：这里是 Cloudflare Workers 的执行
// 语义问题——handler 返回 Response 之后，只有被 ctx.waitUntil 显式延寿的 promise 才
// 保证跑完，其余会在 isolate 回收时被静默丢弃。而 Node/vitest 根本没有 isolate 回收
// 这回事，所以「挂没挂 waitUntil」在本地运行结果完全一样：都写库、都通过。
// 也就是说这个缺陷在 CI 里天然测不出，只在真机上炸，症状是「有请求数、有延迟，
// token / credits / msg 却全 0」。故只能静态盯住源码形态防回来。

const root = resolve(__dirname, "..");
const proxySrc = readFileSync(resolve(root, "src/services/proxy.ts"), "utf8");
const apiSrc = readFileSync(resolve(root, "src/routes/api.ts"), "utf8");

describe("Workers 生命周期：响应返回后的写入必须挂 waitUntil", () => {
  it("proxyChat 暴露 waitUntil 参数，且缺省仍可独立调用（不破坏既有单测）", () => {
    expect(proxySrc).toMatch(/waitUntil:\s*\(p:\s*Promise<unknown>\)\s*=>\s*void\s*=/);
  });

  it("proxy.ts 内不再残留裸 floating promise 的收尾写入", () => {
    // 旧形态：`void backfillUsage(` / `void recordCost(` / `void consumeKey(`
    // / 不带任何前缀的 `log(env, ...)`。它们处在 return 之前的路径上时，
    // 写库动作会在响应返回后被丢掉，且不报错。
    for (const re of [
      /void\s+backfillUsage\(/,
      /void\s+recordCost\(/,
      /void\s+consumeKey\(/,
      /void\s+log\(/,
      /void\s+poolRPC\(env,\s*"\/internal\/release"/,
    ]) {
      expect(re.test(proxySrc), `命中未受保护的收尾写入: ${re}`).toBe(false);
    }
  });

  it("流式收尾（回填 / 记账 / 扣配额 / release）逐个挂了 waitUntil", () => {
    for (const call of [
      "waitUntil(backfillUsage(",
      "waitUntil(recordCost(",
      "waitUntil(consumeKey(",
      'waitUntil(poolRPC(env, "/internal/release"',
    ]) {
      expect(proxySrc, `缺少 ${call}`).toContain(call);
    }
  });

  it("api.ts 三个 chat 入口都注入了 waitUntil", () => {
    const lines = apiSrc.split("\n").filter((l) => l.includes("proxyChat("));
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l, `入口未注入 waitUntil: ${l.trim().slice(0, 70)}`).toContain("waitUntilOf(c)");
    }
  });

  it("回填拿不到行 id 时留声，而不是静默 return（否则「token 全 0」无头可查）", () => {
    expect(proxySrc).toContain("[usage] 跳过回填");
    expect(proxySrc).toContain("[reqlog] 请求日志写入失败");
  });
});

// 运行时 smoke：断言 waitUntil 真的被驱动、且被挂起的收尾任务最终把量写进了库。
// 验证不了「不被 isolate 回收」（Node 无此语义），但能保证钩子接通——尤其是
// 「每个收尾点都挂了」这一点有区分力：某个点漏挂，它就不会出现在 captured 里。
describe("waitUntil 接线 smoke", () => {
  afterEach(() => vi.unstubAllGlobals());

  const STREAM =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"usage":{"credit":1.5,"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\n' +
    "data: [DONE]\n\n";

  it("流式收尾（回填 / 记账 / release）逐个经 waitUntil 挂出，并把用量写进库", async () => {
    const captured: Array<Promise<unknown>> = [];
    const env = fakeEnv(makeAuth("u1"));
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      if (new URL((req as any).url).pathname.includes("/chat/completions")) {
        return new Response(STREAM, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    const req = new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cn:hy3", stream: true, messages: [] }),
    });
    const res = await proxyChat(
      env, req, "cn:hy3",
      { model: "cn:hy3", stream: true, messages: [] }, "0.0.0.0", "",
      null,
      (p) => { captured.push(p); },
    );
    expect(res.status).toBe(200);
    await res.text();
    await Promise.allSettled(captured);

    // 三个收尾点各挂一次：recordCost + backfillUsage + release（未传 keyRow，无 consumeKey）。
    // 漏挂任何一个都会在这里露出来——它就根本不会经过 waitUntil。
    expect(captured.length).toBeGreaterThanOrEqual(3);

    const upd = env.writes.find((w) => w.sql.includes("UPDATE request_logs"));
    expect(upd).toBeTruthy();
    expect(upd!.params.slice(0, 4)).toEqual([100, 50, 1.5, 0]);
  });
});
