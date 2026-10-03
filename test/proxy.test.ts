import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { proxyChat, openAIError, clientIP } from "../src/services/proxy";
import { DEFAULT_CONFIG } from "../src/config";
import type { Auth } from "../src/types";

function makeAuth(uid: string): Auth {
  return {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: Date.now() + 3600_000,
    domain: "copilot.tencent.com",
    realm: "cn",
    uid,
    enterpriseId: "e",
    nickname: "n",
  };
}

function fakeEnv(auth: Auth) {
  let releaseCount = 0;
  const poolStub = {
    async fetch(req: Request) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/internal/pick") return new Response(JSON.stringify({ uid: auth.uid, auth }), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/internal/release") releaseCount++;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  // 可读写的内存 KV：降级门（prompt:degraded_until）要能落盘并读回。
  const kvMap = new Map<string, string>();
  const fakeKV = {
    m: kvMap,
    get: async (k: string) => kvMap.get(k) ?? null,
    put: async (k: string, v: string) => void kvMap.set(k, v),
    delete: async (k: string) => void kvMap.delete(k),
  };
  // SQL 记录器：用量链路要靠 INSERT（占位）+ UPDATE（回填）两条语句验证，
  // 光看返回值看不出来。sidecar 形态不影响既有测试——它们不检查 SQL。
  const sqlWrites: Array<{ sql: string; params: any[] }> = [];
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (...params: any[]) => ({
        run: async () => {
          sqlWrites.push({ sql, params });
          // last_row_id 给个固定值，回填时能否把用了同一 id 就有得验。
          return { meta: { last_row_id: 42, changes: 1 } };
        },
        all: async () => ({ results: [] }),
        first: async () => null,
      }),
    }),
  };
  const env = {
    POOL: { get: () => poolStub, idFromName: () => ({}) },
    WB2A_CONFIG: fakeKV,
    WB2A_CACHE: fakeKV,
    WB2A_DB: fakeDB,
    WB2A_LOGS: {},
    writes: sqlWrites,
    releaseCount: () => releaseCount,
  } as any;
  return env;
}

function mockUpstream(status: number, body: string) {
  return vi.fn(async (_req: Request) => new Response(body, { status, headers: { "content-type": "text/event-stream" } }));
}

describe("proxy helpers", () => {
  it("openAIError 形态一致", () => {
    const r = openAIError(429, "rate_limit_exceeded", "slow down", "hint");
    expect(r.status).toBe(429);
  });
  it("clientIP 尊重 cf-connecting-ip", () => {
    const req = new Request("https://x/v1/chat/completions", { headers: { "cf-connecting-ip": "1.2.3.4" } });
    expect(clientIP(req)).toBe("1.2.3.4");
  });
});

describe("proxyChat", () => {
  beforeEach(() => {});
  afterEach(() => vi.unstubAllGlobals());

  it("非流式成功：聚合上游并回 chat.completion", async () => {
    // 用聚合（非 TransformStream）路径覆盖代理核心逻辑（流式透传在 workerd 原生运行）
    const fetchMock = mockUpstream(200, 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    vi.stubGlobal("fetch", fetchMock);
    const env = fakeEnv(makeAuth("u1"));
    const req = new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" },
      body: JSON.stringify({ model: "cn:hy3", stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    const res = await proxyChat(env, req, "cn:hy3", { model: "cn:hy3", stream: false, messages: [] }, "9.9.9.9", "ua");
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.choices[0].message.content).toContain("hi");
  });

  it("出站 body 经payload 管线：强制 stream + cache_key 注入 + 指纹脱敏，入参 body 不被污染", async () => {
    let sent: any = null;
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      if (new URL((req as any).url).pathname.includes("/chat/completions")) {
        sent = await req.clone().json();
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    const env = fakeEnv(makeAuth("u1"));
    const req = new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cn:hy3", stream: false, messages: [] }),
    });
    // 非流式入参：管线强制 stream=true，但代理层仍按 body.stream=false 走聚合路径
    const bodyIn = {
      model: "cn:hy3",
      stream: false,
      max_completion_tokens: 2000,
      messages: [
        { role: "developer", content: "sys" },
        { role: "user", content: "Main branch (you will usually use this for PRs)" },
      ],
    };
    const res = await proxyChat(env, req, "cn:hy3", bodyIn, "0.0.0.0", "");
    expect(res.status).toBe(200);
    // 出站：管线生效
    expect(sent.stream).toBe(true);
    expect(sent.max_tokens).toBe(2000);
    expect("max_completion_tokens" in sent).toBe(false);
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[1].content).toBe("Default branch (you will usually use this for PRs)");
    // cache_key：按账号隔离注入
    expect(String(sent.prompt_cache_key)).toMatch(/^wb2a-u1-[0-9a-f]{32}$/);
    // 入参 body 未被污染（stream 仍是 false，role/content 原样）
    expect(bodyIn.stream).toBe(false);
    expect(bodyIn.messages[0].role).toBe("developer");
    expect(bodyIn.messages[1].content).toBe("Main branch (you will usually use this for PRs)");
    expect("max_tokens" in bodyIn).toBe(false);
  });

  it("上游 429 -> OpenAI 错误信封（不崩溃）", async () => {
    const fetchMock = mockUpstream(429, JSON.stringify({ code: "rate_limit_exceeded" }));
    vi.stubGlobal("fetch", fetchMock);
    const env = fakeEnv(makeAuth("u1"));
    const req = new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cn:hy3", stream: false, messages: [] }),
    });
    const res = await proxyChat(env, req, "cn:hy3", { model: "cn:hy3", stream: false, messages: [] }, "0.0.0.0", "");
    const j = await res.json();
    expect(j.error.code).toBe("rate_limit_exceeded");
  });

  it("内容拦截（指纹误报）→ 换 Degraded 提示词同请求内重试一次并成功", async () => {
    // 第一次出站带客户端原始 system → 上游按审核文案 400；网关判定误报，
    // 触发降级并把 system 换成 Degraded 重试；第二次出站即命中。
    const sent: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      if (new URL((req as any).url).pathname.includes("/chat/completions")) {
        const b = await req.clone().json();
        sent.push(b);
        if (b.messages[0]?.content?.includes("客户端原文")) {
          return new Response(JSON.stringify({ code: 400, msg: "Request blocked by security policy" }), {
            status: 400, headers: { "content-type": "application/json" },
          });
        }
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    const env = fakeEnv(makeAuth("u1"));
    const req = new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cn:hy3", stream: false, messages: [] }),
    });
    const res = await proxyChat(
      env, req, "cn:hy3",
      { model: "cn:hy3", stream: false, messages: [{ role: "system", content: "客户端原文" }, { role: "user", content: "U" }] },
      "0.0.0.0", "",
    );
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(2);
    // 第一次：客户端原文在头部
    expect(sent[0].messages[0].content).toBe("客户端原文");
    // 第二次：已替换为 Degraded，且不带客户端原文
    expect(sent[1].messages[0].content).not.toContain("客户端原文");
    expect(sent[1].messages[0].content).toBe(
      "You are a helpful assistant. Respond in the user's language, follow the user's instructions, and be direct and concise.",
    );
    // 降级状态已持久化到 KV（次日 00:00 CST 前有效）
    expect(Number(env.WB2A_CACHE.m.get("prompt:degraded_until"))).toBeGreaterThan(Date.now());
  });

  it("内容拦截重试后仍被拦 → 回 content_blocked，不无限重试", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      if (new URL((req as any).url).pathname.includes("/chat/completions")) {
        calls++;
        return new Response(JSON.stringify({ code: 400, msg: "Request blocked by security policy" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    const env = fakeEnv(makeAuth("u1"));
    const req = new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cn:hy3", stream: false, messages: [] }),
    });
    const res = await proxyChat(
      env, req, "cn:hy3",
      { model: "cn:hy3", stream: false, messages: [{ role: "user", content: "U" }] },
      "0.0.0.0", "",
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("content_blocked");
    // 降级重试只给一次机会：原始 + 降级 = 2 次，不继续轮转
    expect(calls).toBe(2);
  });
});

// 流式用量的写入曾是全链路最脆的一环：日志路径从不覆盖流式（面板日志页全空），
// 用量表更是从未被写过。这两件事在沙箱里本来没法验（依赖 TransformStream），
// 好在 Node 18+ 已内置全局 TransformStream —— 管道能跑，就能覆盖到。
describe("流式用量写入（占位 + 末帧回填）", () => {
  const STREAM_WITH_USAGE =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":" there"}}],"usage":{"credit":1.5,"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\n' +
    "data: [DONE]\n\n";

  function envFor() {
    const env = fakeEnv(makeAuth("u1"));
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      if (new URL((req as any).url).pathname.includes("/chat/completions")) {
        return new Response(STREAM_WITH_USAGE, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    return env;
  }

  function reqFor() {
    return new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cn:hy3", stream: true, messages: [] }),
    });
  }

  it("流式请求写一条日志（占位），此前完全不写——面板日志页全空的直接原因", async () => {
    const env = envFor();
    const res = await proxyChat(env, reqFor(), "cn:hy3", { model: "cn:hy3", stream: true, messages: [] }, "0.0.0.0", "");
    expect(res.status).toBe(200);
    // 把流读完才会触发末帧回填。这里顺带锁定「流式转发内容不丢」：
    // 用户曾实测到 200 + SSE 头 + 零正文（sseSplit 的 while 循环不更新缓冲导致
    // 无限 enqueue 同一帧，Worker 被 OOM 杀掉），这类退化一定会让这里变空或超时。
    const text = await res.text();
    expect(text).toContain("hi");
    expect(text).toContain("there");
    await new Promise((r) => setTimeout(r, 0));

    const inserts = env.writes.filter((w) => w.sql.includes("INSERT INTO request_logs"));
    expect(inserts).toHaveLength(1); // 恰好一条：不重复记账
    // 占位时还没有用量，四列应为 0
    const p = inserts[0].params;
    expect(p.slice(-4)).toEqual([0, 0, 0, 0]);
  });

  it("末帧 usage 回填到同一行（UPDATE 的 WHERE id 取自 INSERT 返回的 rowid）", async () => {
    const env = envFor();
    const res = await proxyChat(env, reqFor(), "cn:hy3", { model: "cn:hy3", stream: true, messages: [] }, "0.0.0.0", "");
    await res.text();
    await new Promise((r) => setTimeout(r, 0));

    const upd = env.writes.find((w) => w.sql.includes("UPDATE request_logs"));
    expect(upd).toBeTruthy();
    // SQL 列序：prompt_tokens, completion_tokens, credits, cache_read_tokens, msg, id
    // msg 记录上游原始 usage（诊断用，便于面板看到上游到底回了什么）。
    expect(upd!.params.slice(0, 4)).toEqual([100, 50, 1.5, 0]);
    expect(String(upd!.params[4])).toContain("usage=");
    expect(upd!.params[5]).toBe(42);
  });

  it("非流式也写且只写一条：token/credit 随 INSERT 一次落清，无需回填", async () => {
    const env = envFor();
    const req = new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cn:hy3", stream: false, messages: [] }),
    });
    const res = await proxyChat(env, req, "cn:hy3", { model: "cn:hy3", stream: false, messages: [] }, "0.0.0.0", "");
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));

    const inserts = env.writes.filter((w) => w.sql.includes("INSERT INTO request_logs"));
    expect(inserts).toHaveLength(1); // 回归：此前两个 log 调用点叠加会写成 2 条
    expect(inserts[0].params.slice(-4)).toEqual([100, 50, 1.5, 0]);
    // 非流式不需要回填
    expect(env.writes.filter((w) => w.sql.includes("UPDATE request_logs"))).toHaveLength(0);
  });

  it("流式请求结束后必须 release（回归：此前只 acquire 从不 release → inFlight 泄漏 → 全账号占满 → no_healthy_account）", async () => {
    const env = envFor();
    const res = await proxyChat(env, reqFor(), "cn:hy3", { model: "cn:hy3", stream: true, messages: [] }, "0.0.0.0", "");
    expect(res.status).toBe(200);
    await res.text(); // 完整读完流才会触发 onEnd → release
    await new Promise((r) => setTimeout(r, 0));
    expect(env.releaseCount()).toBeGreaterThanOrEqual(1);
  });
});

describe("proxyChat / 选号失败分类", () => {
  afterEach(() => vi.unstubAllGlobals());

  // 用一个可定制的 POOL.fetch 覆盖默认成功实现。
  function envWithPoolFetch(poolFetch: (req: Request) => Promise<Response>) {
    const env = fakeEnv(makeAuth("u1"));
    (env as any).POOL = { get: () => ({ fetch: poolFetch }), idFromName: () => ({}) } as any;
    return env;
  }

  const body = { model: "cn:hy3", stream: false, messages: [{ role: "user", content: "hi" }] };
  const req = new Request("https://x/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("POOL 传输层连不上 → 'account pool unreachable' 且 hint 指向绑定", async () => {
    const env = envWithPoolFetch(async () => { throw new Error("Cannot read properties of undefined (reading 'get')"); });
    const res = await proxyChat(env, req, "cn:hy3", body, "0.0.0.0", "");
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.error.message).toContain("account pool unreachable");
    expect(j.error.gateway_hint).toContain("Durable Object 绑定");
  });

  it("DO 返回 no_healthy_account(503) → 还原为 'no healthy account available'，且带上诊断", async () => {
    const env = envWithPoolFetch(async () =>
      new Response(
        JSON.stringify({
          error: "no_healthy_account",
          realm: "cn",
          byRealm: { cn: { total: 0, healthy: 0 } },
          diagnose: { total: 0, by_reason: {}, sample: [] },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await proxyChat(env, req, "cn:hy3", body, "0.0.0.0", "");
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.error.message).toContain("no healthy account available");
    expect(j.error.code).toBe("no_healthy_account");
    // 诊断信息应透传：message 含 reasons 摘要，hint 含「各不可选原因」明细
    expect(j.error.message).toContain("reasons=");
    expect(j.error.gateway_hint).toContain("各不可选原因");
  });

  it("DO 返回其它错误(500) → 'account pool DO error (HTTP 500)'", async () => {
    const env = envWithPoolFetch(async () =>
      new Response(JSON.stringify({ error: "internal", msg: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await proxyChat(env, req, "cn:hy3", body, "0.0.0.0", "");
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.error.message).toContain("account pool DO error (HTTP 500)");
  });
});
