import { describe, it, expect, vi, afterEach } from "vitest";
import {
  newTimeline,
  markSince,
  addElapsed,
  timingHeaders,
  withTiming,
  headersWithTiming,
  now,
  type Timeline,
} from "../src/services/timing";
import { Hono } from "hono";
import { buildApp } from "../src/router";
import { invalidateConfig } from "../src/config";
import { invalidateKeyCache } from "../src/services/apikeys";
import { invalidateModelsSnapshot } from "../src/services/models-snapshot";
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
    markSince(tl, "pick", now() - 42);
    expect(tl.seg.pick).toBeGreaterThanOrEqual(42);
    markSince(tl, "pick", now());
    // 亚毫秒时钟下这里不会精确等于 0（两次 now() 之间过了几十微秒），
    // 断言落到「已归零到亚毫秒量级」而非 Object.is(0)。
    expect(tl.seg.pick).toBeLessThan(1);
  });

  it("时钟回拨不产生负值（负数会让下游解析器丢弃整条 Server-Timing）", () => {
    const tl = newTimeline(0);
    markSince(tl, "auth", now() + 5_000); // 未来时刻 → 差值为负
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
    const tl = newTimeline(now() - 500);
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
    const tl = newTimeline(now() - 10);
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
    const tl = newTimeline();
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
    expect(res.headers.get("X-WB2A-Timing")).toMatch(/upstream=[\d.]+ total=[\d.]+$/);
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
    const tl = newTimeline(now() - 12);
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

  it("冷启动观测落地：X-Cold-Start / X-Worker-Uptime 存在且跨域可读", async () => {
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
    // 没有这个标记，「这次慢到底是冷启动还是热启动」只能靠猜——
    // 而两者要改的东西完全不同（前者砍启动期 I/O，后者砍请求路径 I/O）。
    expect(res.headers.get("X-Cold-Start")).toMatch(/^[01]$/);
    expect(Number(res.headers.get("X-Worker-Uptime"))).toBeGreaterThanOrEqual(0);
    // 跨域客户端要能读到这两个头，必须列进 Expose-Headers，否则 JS 恒为 null
    const expose = res.headers.get("Access-Control-Expose-Headers") ?? "";
    expect(expose).toContain("X-Cold-Start");
    expect(expose).toContain("X-Worker-Uptime");
  });

  it("缓存命中头：首次请求走后端(miss)，同 isolate 二次命中(hit)", async () => {
    vi.stubGlobal("fetch", mockOK());
    const env = mkHttpEnv();
    await env.WB2A_CONFIG.put("config", JSON.stringify({ api_key: "sk-main" }));
    // 复位全部模块级缓存，保证「首次请求」真的是 miss，二次才是 hit
    invalidateConfig();
    invalidateKeyCache();
    invalidateModelsSnapshot();

    const a = new Hono<{ Bindings: Env }>();
    buildApp(a as any);
    const req = (auth: string) =>
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${auth}` },
        body: JSON.stringify({ model: "cn:hy3", stream: false, messages: [{ role: "user", content: "hi" }] }),
      });

    // 第一次：冷缓存，config(KV) / key(D1) / models(KV) 三个读全 miss
    const r1 = await a.fetch(req("wbk_abc"), env);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("X-Auth-Cache")).toBe("miss");
    expect(r1.headers.get("X-Models-Cache")).toBe("miss");
    // X-Cold-Start 已重写为「是否发生过缓存 miss」：全 miss → 1
    expect(r1.headers.get("X-Cold-Start")).toBe("1");

    // 第二次：同 isolate，模块级缓存已热，应全部 hit
    const r2 = await a.fetch(req("wbk_abc"), env);
    expect(r2.status).toBe(200);
    expect(r2.headers.get("X-Auth-Cache")).toBe("hit");
    expect(r2.headers.get("X-Models-Cache")).toBe("hit");
    expect(r2.headers.get("X-Cold-Start")).toBe("0");

    const expose = r2.headers.get("Access-Control-Expose-Headers") ?? "";
    expect(expose).toContain("X-Auth-Cache");
    expect(expose).toContain("X-Models-Cache");
  });
});

describe("埋点守卫（静态）", () => {
  const proxySrc = readFileSync(new URL("../src/services/proxy.ts", import.meta.url), "utf8");
  const routerSrc = readFileSync(new URL("../src/router.ts", import.meta.url), "utf8");
  const apiSrc = readFileSync(new URL("../src/routes/api.ts", import.meta.url), "utf8");
  const timingSrc = readFileSync(new URL("../src/services/timing.ts", import.meta.url), "utf8");

  it("每一段的计时点位都在（删掉任何一处都会让该段永远不出现）", () => {
    expect(proxySrc).toContain('markSince(tl, "cfg"');
    // prompt / models 是并行发起的两段（省下一次串行 KV 往返），故不落在 await 后，
    // 而是在各自的 .then 里打点——断言也要跟着改成按段名判dan而不是按句式。
    expect(proxySrc).toContain('tl.seg.prompt =');
    expect(proxySrc).toContain('tl.seg.models =');
    expect(proxySrc).toContain('addElapsed(tl, "pick"');
    expect(proxySrc).toContain('tl.seg.note = 0');
    expect(proxySrc).toContain('markSince(tl, "upstream"');
  });

  it("migrate 段埋点在位（它曾是完全隐形的关键路径开销）", () => {
    // 迁移原本 await 在 app.fetch 之前、任何中间件计时范围之外，是冷启动最大
    // 单项开销却在响应头里完全看不到。现在搬进 router 中间件，经 CtxVars 传
    // 给 api.ts 写进时间线。三处任一处被删，该段就永远不出现——故静态守卫。
    expect(routerSrc).toContain('c.set("wb2aMigrateMs"');
    expect(apiSrc).toContain("tl.seg.migrate =");
    // 段名必须进了输出顺序表，否则 timingHeaders 会把它当作「未知段」排到最后
    expect(timingSrc).toContain('"migrate"');
  });

  it("迁移必须在鉴权之前、且在计时起点之后（顺序错了 migrate 段就没意义）", () => {
    const t0At = routerSrc.indexOf('c.set("wb2aT0"');
    const migAt = routerSrc.indexOf("await autoMigrate(c.env)");
    expect(t0At).toBeGreaterThan(-1);
    expect(migAt).toBeGreaterThan(-1);
    // t0 先打点，迁移后跑 —— 否则 total 里根本不含迁移耗时
    expect(t0At).toBeLessThan(migAt);
  });

  it("全链路只用 now()，不许混 Date.now()（两种时钟相减会让归因数据报废）", () => {
    // performance.now() 是 isolate 相对毫秒、Date.now() 是 epoch，二者不可相减。
    // 任何一个埋点写成 Date.now()，那一段就会变成天文数字或被归零。
    for (const [name, src] of [["proxy", proxySrc], ["router", routerSrc], ["api", apiSrc]] as const) {
      const bad = [...src.matchAll(/const t[A-Z]\w* = Date\.now\(\)/g)];
      expect(bad.map((m) => m[0]), `${name} 出现 timing 混用`).toEqual([]);
      const bad2 = [...src.matchAll(/Date\.now\(\) - t[A-Z]\w*/g)];
      expect(bad2.map((m) => m[0]), `${name} 出现 timing 混用`).toEqual([]);
    }
    // 反过来：新的时间源必须真的被用起来
    expect(apiSrc).toContain("const tBody = now()");
    expect(routerSrc).toContain('c.set("wb2aT0", now())');
    expect(proxySrc).toContain("const tPick = now()");
  });

  it("note 已挂 waitUntil，不再挡在首字节之前", () => {
    expect(proxySrc).toContain('waitUntil(poolRPC(env, "/internal/note"');
    // 旧的同步等待写法必须消失：只要还有一处 await note，TTFT 就还背着这一趟
    expect(proxySrc).not.toContain('await poolRPC(env, "/internal/note", "POST", { uid, kinds');
  });

  it("prompt 与 models 并行（两次 KV 读不再首尾相接）", () => {
    expect(proxySrc).toContain("Promise.all([policyP, existsP])");
  });

  it("pick 计时放在 finally 里（异常重试也要计入，不能被 throw 跳过）", () => {
    expect(proxySrc).toContain("} finally {\n      addElapsed(tl, \"pick\", now() - tPick);\n    }");
  });

  it("t0 由最外层中间件打点，auth 段只在子密钥路径设置", () => {
    expect(routerSrc).toContain('c.set("wb2aT0", now())');
    expect(routerSrc).toContain('c.set("wb2aAuthMs", now() - authStart)');
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
  it("newTimeline 的缺省 t0 合理，且与 biz 用同一支时钟", () => {
    const tl: Timeline = newTimeline();
    // t0 取自 performance.now()（isolate 相对毫秒），不是 epoch。
    expect(tl.t0).toBeGreaterThanOrEqual(0);
    expect(tl.t0).toBeLessThan(Date.now()); // epoch 大得多，能错到几十万倍
    expect(tl.t0).toBeGreaterThan(now() - 1000);
    expect(tl.seg).toEqual({});
  });
});
