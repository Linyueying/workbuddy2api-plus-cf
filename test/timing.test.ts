import { describe, it, expect, vi, afterEach } from "vitest";
import {
  newTimeline,
  markSince,
  addElapsed,
  timingHeaders,
  withTiming,
  headersWithTiming,
  type Timeline,
} from "../src/services/timing";
import { Hono } from "hono";
import { buildApp } from "../src/router";
import { invalidateConfig } from "../src/config";
import { proxyChat, openAIError } from "../src/services/proxy";
import type { Env } from "../worker-configuration.d.ts";
import { readFileSync } from "node:fs";
import { makeAuth, fakeEnv } from "./proxy.helper";

// TTFT 归因设施（services/timing.ts + 它在 proxy / router / api 里的埋点）。
//
// 这一组测试的存在理由：C0 是**观测**设施，观测设施本身测不出来就是没装——
// 头格式写错、某段压根没埋、只在成功路径写了错误路径没写，都不会报错，只会
// 表现为「真机上永远看不清慢在哪」。所以除了纯函数单测，还补了三条集成断言
// （成功流式 / 成功非流式 / 错误路径）与静态埋点守卫。

afterEach(() => vi.unstubAllGlobals());

describe("timing 纯函数", () => {
  it("markSince 记录毫秒，重复调用覆盖同名段", () => {
    const tl = newTimeline(0);
    markSince(tl, "pick", Date.now() - 42);
    expect(tl.seg.pick).toBeGreaterThanOrEqual(42);
    markSince(tl, "pick", Date.now());
    expect(tl.seg.pick).toBe(0);
  });

  it("时钟回拨不产生负值（负数会让下游解析器丢弃整条 Server-Timing）", () => {
    const tl = newTimeline(0);
    markSince(tl, "auth", Date.now() + 5_000); // 未来时刻 → 差值为负
    expect(tl.seg.auth).toBe(0);
  });

  it("addElapsed 累加而非覆盖（选号轮转会打多轮）", () => {
    const tl = newTimeline(0);
    addElapsed(tl, "pick", 30);
    addElapsed(tl, "pick", 25);
    expect(tl.seg.pick).toBe(55);
  });

  it("空分段表不输出噪声头", () => {
    expect(timingHeaders(newTimeline())).toEqual({});
  });

  it("Server-Timing 符合 name;dur= 语法且带 total", () => {
    const tl = newTimeline(Date.now() - 500);
    tl.seg.pick = 30;
    tl.seg.upstream = 120;
    const h = timingHeaders(tl);
    expect(h["Server-Timing"]).toMatch(/^pick;dur=30, upstream;dur=120, total;dur=/);
    expect(h["X-WB2A-Timing"]).toMatch(/^pick=30 upstream=120 total=/);
  });

  it("输出顺序固定按关键路径先后，与写入顺序无关", () => {
    const tl = newTimeline(0);
    tl.seg.upstream = 1;
    tl.seg.auth = 2;
    tl.seg.pick = 3;
    expect(timingHeaders(tl)["X-WB2A-Timing"].startsWith("auth=2 pick=3 upstream=1")).toBe(true);
  });

  it("未知段排在已知段之后（不丢数据，也不打乱已知顺序）", () => {
    const tl = newTimeline(0);
    tl.seg.pick = 5;
    tl.seg.zzz_custom = 7;
    const flat = timingHeaders(tl)["X-WB2A-Timing"];
    expect(flat.indexOf("pick=")).toBeLessThan(flat.indexOf("zzz_custom="));
  });

  it("浮点尾数被规整（0.30000000000000004 不该进响应头）", () => {
    const tl = newTimeline(0);
    tl.seg.pick = 0.30000000000000004;
    expect(timingHeaders(tl)["Server-Timing"]).toContain("pick;dur=0.3");
  });

  it("withTiming 写进自建响应；headersWithTiming 合并进 headers 字面量", () => {
    const tl = newTimeline(Date.now() - 10);
    tl.seg.pick = 4;
    const res = withTiming(new Response("x", { status: 200 }), tl);
    expect(res.headers.get("Server-Timing")).toContain("pick;dur=4");
    expect(res.headers.get("X-WB2A-Timing")).toContain("pick=4");

    const merged = headersWithTiming({ "content-type": "application/json" }, tl);
    expect(merged["content-type"]).toBe("application/json");
    expect(merged["Server-Timing"]).toBeTruthy();
  });
});

/** upstream SSE 常规成功响应夹具。 */
function mockOK() {
  return vi.fn(
    async (_req: Request) =>
      new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  );
}

function reqOf(stream: boolean): Request {
  return new Request("https://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "cn:hy3", stream, messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("proxyChat 计时头落地", () => {
  it("非流式成功：两个计时头都在，且含 cfg/prompt/models/pick/note/upstream 全段", async () => {
    vi.stubGlobal("fetch", mockOK());
    const env = fakeEnv(makeAuth("u1"));
    const tl = newTimeline(Date.now());
    const res = await proxyChat(
      env,
      reqOf(false),
      "cn:hy3",
      { model: "cn:hy3", stream: false, messages: [] },
      "0.0.0.0",
      "",
      null,
      undefined,
      tl,
    );
    expect(res.status).toBe(200);
    const st = res.headers.get("Server-Timing") ?? "";
    const flat = res.headers.get("X-WB2A-Timing") ?? "";
    for (const seg of ["cfg", "prompt", "models", "pick", "note", "upstream", "total"]) {
      expect(st).toContain(`${seg};dur=`);
      expect(flat).toContain(`${seg}=`);
    }
    // 关键：note 段必须被量出来——它是压在首字节之前的那趟 RPC，没有这一行
    // 就无法验证把它挪走（C1）到底省了多少。
    expect(tl.seg.note).toBeGreaterThanOrEqual(0);
    expect(tl.seg.upstream).toBeGreaterThanOrEqual(0);
  });

  it("流式成功：计时头在首字节之前就写好（返回时即可读，不必等流结束）", async () => {
    vi.stubGlobal("fetch", mockOK());
    const env = fakeEnv(makeAuth("u1"));
    const res = await proxyChat(
      env,
      reqOf(true),
      "cn:hy3",
      { model: "cn:hy3", stream: true, messages: [] },
      "0.0.0.0",
      "",
      null,
    );
    expect(res.status).toBe(200);
    // 不读 body 就能拿到 —— 这正是 TTFT 归因的前提
    expect(res.headers.get("X-WB2A-Timing")).toMatch(/upstream=\d+ total=\d+$/);
  });

  it("错误路径同样带计时（pick 慢导致的 503 画像与业务错误完全不同）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"boom"}', { status: 429, headers: { "content-type": "application/json" } })),
    );
    const env = fakeEnv(makeAuth("u1"));
    const res = await proxyChat(env, reqOf(false), "cn:hy3", { model: "cn:hy3", stream: false, messages: [] }, "0.0.0.0", "");
    expect(res.status).toBe(429);
    expect(res.headers.get("Server-Timing")).toContain("total;dur=");
    expect(res.headers.get("X-WB2A-Timing")).toContain("pick=");
  });

  it("openAIError 带 tl 时输出计时头（错误信封与成功路径同源）", () => {
    const tl = newTimeline(Date.now() - 12);
    tl.seg.pick = 5;
    const r = openAIError(503, "no_healthy_account", "none", undefined, tl);
    expect(r.headers.get("X-WB2A-Timing")).toContain("pick=5");
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });
});

// ---- 端到端：真跑一遍 Hono 中间件链 ----
//
// 上面的集成测试直连 proxyChat，绕过了 router/api 两层。而 t0 恰恰是在
// **最外层中间件**打的、auth 段是在**鉴权中间件**打的——这两处任何一处没接上，
// 响应头里就永远缺一段，而 proxyChat 层的测试完全看不出来。所以必须有一条
// 从 HTTP 入口打到 Response 的断言把整条链接起来。

function mkHttpEnv() {
  const kv = new Map<string, string>();
  // 子密钥行：verifyKey 只看 enabled / expires_at / 双配额 / IP，全给零值即放行。
  const keyRow = {
    id: "k-1", key_hash: "h", name: "n", prefix: "wbk_x", models: "[]", created_at: 0, last_used: 0,
    enabled: 1, expires_at: 0, realm: "", ip_allowlist: "[]", max_ips: 0, ips: "[]", last_ip: "",
    req_count: 0, quota: 0, used_tokens: 0, quota_credit: 0, used_credit: 0, seq: 1,
  };
  const auth = makeAuth("u1");
  return {
    WB2A_CONFIG: {
      put: async (k: string, v: string) => void kv.set(k, v),
      get: async (k: string, opts?: any) => {
        const raw = kv.get(k);
        if (raw == null) return null;
        return opts?.type === "json" ? JSON.parse(raw) : raw;
      },
      delete: async () => {},
    },
    WB2A_CACHE: { put: async () => {}, get: async () => null, delete: async () => {} },
    WB2A_DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => keyRow,
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1, last_row_id: 0 } }),
        }),
      }),
    },
    POOL: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async (req: Request) => {
          const p = new URL(req.url).pathname;
          const payload = p === "/internal/pick" ? { uid: auth.uid, auth, acquired: true } : { ok: true };
          return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
        },
      }),
    },
    WB2A_LOGS: {},
  } as any;
}

describe("端到端：中间件链把计时接通", () => {
  it("子密钥请求：响应头含 auth 段，且 CORS 放行计时头", async () => {
    vi.stubGlobal("fetch", mockOK());
    const env = mkHttpEnv();
    await env.WB2A_CONFIG.put("config", JSON.stringify({ api_key: "sk-main" }));
    invalidateConfig();

    const a = new Hono<{ Bindings: Env }>();
    buildApp(a as any);
    const res = await a.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer wbk_abc" },
        body: JSON.stringify({ model: "cn:hy3", stream: false, messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const flat = res.headers.get("X-WB2A-Timing") ?? "";
    // auth 段只有端到端才测得到：它是 router 里打的，proxyChat 层永远看不见
    expect(flat).toContain("auth=");
    expect(flat).toContain("body=");
    expect(flat).toContain("upstream=");
    // 跨域可读：Expose-Headers 少一个，浏览器侧的 JS 就永远拿不到这些值
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("X-WB2A-Timing");
    // 回归守卫：CORS 头原本写在 `await next()` 之前，被 Hono 的 set res 丢弃了 ——
    // 成功响应上从来没有 Access-Control-Allow-Origin，而走 c.json 的鉴权失败
    // 路径却有。跨域浏览器客户端这次才是真的能通。
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // 顺序也是关键路径顺序：auth 必须在 body / pick 之前
    expect(flat.indexOf("auth=")).toBeLessThan(flat.indexOf("pick="));
  });

  it("管理员钥匙：不走 D1，故不输出恒为 0 的 auth 段", async () => {
    vi.stubGlobal("fetch", mockOK());
    const env = mkHttpEnv();
    await env.WB2A_CONFIG.put("config", JSON.stringify({ api_key: "sk-main" }));
    invalidateConfig();

    const a = new Hono<{ Bindings: Env }>();
    buildApp(a as any);
    const res = await a.fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer sk-main" },
        body: JSON.stringify({ model: "cn:hy3", stream: false, messages: [] }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-WB2A-Timing")).not.toContain("auth=");
  });
});

describe("埋点守卫（静态）", () => {
  const proxySrc = readFileSync(new URL("../src/services/proxy.ts", import.meta.url), "utf8");
  const routerSrc = readFileSync(new URL("../src/router.ts", import.meta.url), "utf8");
  const apiSrc = readFileSync(new URL("../src/routes/api.ts", import.meta.url), "utf8");

  it("每一段的计时点位都在（删掉任何一处都会让该段永远不出现）", () => {
    expect(proxySrc).toContain('markSince(tl, "cfg"');
    expect(proxySrc).toContain('markSince(tl, "prompt"');
    expect(proxySrc).toContain('markSince(tl, "models"');
    expect(proxySrc).toContain('addElapsed(tl, "pick"');
    expect(proxySrc).toContain('markSince(tl, "note"');
    expect(proxySrc).toContain('markSince(tl, "upstream"');
  });

  it("pick 计时放在 finally 里（异常重试也要计入，不能被 throw 跳过）", () => {
    expect(proxySrc).toContain("} finally {\n      addElapsed(tl, \"pick\", Date.now() - tPick);\n    }");
  });

  it("t0 由最外层中间件打点，auth 段只在子密钥路径设置", () => {
    expect(routerSrc).toContain('c.set("wb2aT0", Date.now())');
    expect(routerSrc).toContain('c.set("wb2aAuthMs", Date.now() - authStart)');
    // 三个 /v1 入口都必须计时，漏一个就有一条链路是黑盒
    for (const route of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
      expect(apiSrc).toContain(`app.post("${route}"`);
    }
    expect((apiSrc.match(/const tl = timelineOf\(c\);/g) ?? []).length).toBe(3);
  });

  it("自定义响应头必须进 Expose-Headers，否则跨域 JS 读不到", () => {
    expect(routerSrc).toContain("Access-Control-Expose-Headers");
    expect(routerSrc).toContain("X-WB2A-Timing");
  });
});

/** 类型自洽性：Timeline 是跨层契约，形状变了编译就该炸。 */
describe("Timeline 契约", () => {
  it("newTimeline 的缺省 t0 不晚于调用时刻", () => {
    const before = Date.now();
    const tl: Timeline = newTimeline();
    expect(tl.t0).toBeGreaterThanOrEqual(before);
    expect(tl.seg).toEqual({});
  });
});
