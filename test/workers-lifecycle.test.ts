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
      /void\s+close\(/,
      /void\s+recordCost\(/,
      /void\s+consumeKey\(/,
      /void\s+log\(/,
      /void\s+poolRPC\(env,\s*"\/internal\/release"/,
    ]) {
      expect(re.test(proxySrc), `命中未受保护的收尾写入: ${re}`).toBe(false);
    }
  });

  it("流式收尾（日志 / 扣配额 / 带成本的 release）逐个挂了 waitUntil", () => {
    for (const call of [
      "waitUntil(\n            log(",
      "waitUntil(consumeKey(",
      'waitUntil(poolRPC(env, "/internal/release"',
    ]) {
      expect(proxySrc, `缺少 ${call}`).toContain(call);
    }
    // 成本台账必须搭 release 的车一起发（合并跨 Worker 往返），不能退回单独的
    // model-cost RPC —— 那会多一次跨 Worker HTTP 往返。
    expect(proxySrc).toContain("release(costOf(");
    expect(proxySrc).not.toContain("waitUntil(recordCost(");
  });

  // 单写守卫：占位 INSERT + 末帧 UPDATE 的老形态必须回不来。它有两个代价——
  // 多付一行 D1 写入额度（免费套餐按行数计），以及 UPDATE 掉进 unprotected 窗口
  // 就被静默丢弃（正是「有请求数有延迟、token 恒 0」的成因）。
  it("请求日志不得出现「占位 + 回填」双写：proxy.ts 不再 import updateRequestLogUsage", () => {
    expect(proxySrc).not.toContain("updateRequestLogUsage");
    expect(proxySrc).not.toContain("backfillUsage");
  });

  it("流式分支不得在首字节之前 await 写日志（D1 往返不能压进 TTFB）", () => {
    // 老形态：`const logId = await log(...)` 出现在 streamChat 之前。
    expect(proxySrc).not.toMatch(/await\s+log\(/);
  });

  it("api.ts 三个 chat 入口都注入了 waitUntil", () => {
    const lines = apiSrc.split("\n").filter((l) => l.includes("proxyChat("));
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l, `入口未注入 waitUntil: ${l.trim().slice(0, 70)}`).toContain("waitUntilOf(c)");
    }
  });

  it("日志写不进去时必须留声，而不是静默 return（否则「token 全 0」无头可查）", () => {
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

    // 收尾点逐个挂出：log + release（成本台账已并入 release；未传 keyRow，无 consumeKey）。
    // 漏挂任何一个都会在这里露出来——它就根本不会经过 waitUntil。
    expect(captured.length).toBeGreaterThanOrEqual(2);

    // 单写：用量随唯一那条 INSERT 落清，不再有 UPDATE 回填。
    const inserts = env.writes.filter((w) => w.sql.includes("INSERT INTO request_logs"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params.slice(-4)).toEqual([100, 50, 1.5, 0]);
    expect(env.writes.filter((w) => w.sql.includes("UPDATE request_logs"))).toHaveLength(0);
  });
});
