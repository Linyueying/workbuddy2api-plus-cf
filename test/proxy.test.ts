import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { proxyChat, openAIError, clientIP } from "../src/services/proxy";
import { makeAuth, fakeEnv } from "./proxy.helper";

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

  /** envForWith 用指定的上游流构造 env；envFor 沿用理想形态（既有断言依赖它）。 */
  function envForWith(streamBody: string) {
    const env = fakeEnv(makeAuth("u1"));
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      if (new URL((req as any).url).pathname.includes("/chat/completions")) {
        return new Response(streamBody, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    return env;
  }

  function envFor() {
    return envForWith(STREAM_WITH_USAGE);
  }

  function reqFor() {
    return new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cn:hy3", stream: true, messages: [] }),
    });
  }

  it("流式请求在流结束时写且只写一条日志（此前完全不写——面板日志页全空的直接原因）", async () => {
    const env = envFor();
    const res = await proxyChat(env, reqFor(), "cn:hy3", { model: "cn:hy3", stream: true, messages: [] }, "0.0.0.0", "");
    expect(res.status).toBe(200);
    // 把流读完才会触发收尾写日志。这里顺带锁定「流式转发内容不丢」：
    // 用户曾实测到 200 + SSE 头 + 零正文（sseSplit 的 while 循环不更新缓冲导致
    // 无限 enqueue 同一帧，Worker 被 OOM 杀掉），这类退化一定会让这里变空或超时。
    const text = await res.text();
    expect(text).toContain("hi");
    expect(text).toContain("there");
    await new Promise((r) => setTimeout(r, 0));

    const inserts = env.writes.filter((w) => w.sql.includes("INSERT INTO request_logs"));
    expect(inserts).toHaveLength(1); // 恰好一条：不重复记账
    // 单写就带用量：末四列 prompt_tokens, completion_tokens, credits, cache_read_tokens
    expect(inserts[0].params.slice(-4)).toEqual([100, 50, 1.5, 0]);
    // 且不再有「占位 + 回填」的第二条 UPDATE —— 省一行 D1 写入额度，
    // 也免掉 UPDATE 掉进 unprotected 窗口被静默丢弃（token 恒 0 的根因）。
    expect(env.writes.filter((w) => w.sql.includes("UPDATE request_logs"))).toHaveLength(0);
  });

  it("末帧用量随唯一那条 INSERT 落清，并把上游原始 usage 写进 msg 供排查", async () => {
    const env = envFor();
    const res = await proxyChat(env, reqFor(), "cn:hy3", { model: "cn:hy3", stream: true, messages: [] }, "0.0.0.0", "");
    await res.text();
    await new Promise((r) => setTimeout(r, 0));

    const ins = env.writes.find((w) => w.sql.includes("INSERT INTO request_logs"));
    expect(ins).toBeTruthy();
    // msg 记录上游原始 usage（诊断用，便于面板看到上游到底回了什么）。
    const msg = String(ins!.params.find((p: any) => typeof p === "string" && String(p).startsWith("usage=")) ?? "");
    expect(msg).toContain("usage=");
  });

  it("客户端中途断连：abort 分支补写一条日志（单写语义下不能整条丢失）", async () => {
    const env = envFor();
    const ac = new AbortController();
    const req = new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cn:hy3", stream: true, messages: [] }),
      signal: ac.signal,
    });
    const res = await proxyChat(env, req, "cn:hy3", { model: "cn:hy3", stream: true, messages: [] }, "0.0.0.0", "");
    expect(res.status).toBe(200);
    ac.abort();
    await new Promise((r) => setTimeout(r, 0));

    const inserts = env.writes.filter((w) => w.sql.includes("INSERT INTO request_logs"));
    expect(inserts).toHaveLength(1);
    // 没有 usage 帧可回填，四列为 0，但 msg 必须说清「为什么没有用量」。
    expect(inserts[0].params.slice(-4)).toEqual([0, 0, 0, 0]);
    expect(JSON.stringify(inserts[0].params)).toContain("断开");
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

  // 真实上游的 SSE 帧往往带 event: 行、且以 \r\n\r\n 分隔。旧实现的
  // replace(/^data:\s?/) 与 tail.split(/\n\n/) 在这两种形态下都会把 usage 静默丢掉，
  // 而下游 sseTransform 仍能把正文完好转发给用户——于是症状就是
  // 「对话一切正常，唯独用量页的输入/输出 Token 全是 0」。
  const STREAM_REAL_SHAPE =
    "event: message\r\n" +
    'data: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\n' +
    "event: message\r\n" +
    'data: {"choices":[{"delta":{"content":"好"}}],"usage":{"credit":2.5,"prompt_tokens":200,"completion_tokens":80,"total_tokens":280,"prompt_cache_hit_tokens":64}}\r\n\r\n' +
    "data: [DONE]\r\n\r\n";

  it("真实帧形态（event: 行 + CRLF）：末帧用量照样随 INSERT 落清，token 不再是 0", async () => {
    const env = envForWith(STREAM_REAL_SHAPE);
    const res = await proxyChat(env, reqFor(), "cn:hy3", { model: "cn:hy3", stream: true, messages: [] }, "0.0.0.0", "");
    expect(res.status).toBe(200);
    // 顺带锁死「用户侧回复完好」——修用量不能把转发赔进去。
    const text = await res.text();
    expect(text).toContain("你");
    expect(text).toContain("好");
    await new Promise((r) => setTimeout(r, 0));

    const ins = env.writes.find((w) => w.sql.includes("INSERT INTO request_logs"));
    expect(ins).toBeTruthy();
    // 末四列：prompt_tokens, completion_tokens, credits, cache_read_tokens
    expect(ins!.params.slice(-4)).toEqual([200, 80, 2.5, 64]);
  });

  it("真实帧形态 + 非流式：用量随 INSERT 一次落清（含缓存命中列）", async () => {
    const env = envForWith(STREAM_REAL_SHAPE);
    const req = new Request("https://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cn:hy3", stream: false, messages: [] }),
    });
    const res = await proxyChat(env, req, "cn:hy3", { model: "cn:hy3", stream: false, messages: [] }, "0.0.0.0", "");
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));

    const inserts = env.writes.filter((w) => w.sql.includes("INSERT INTO request_logs"));
    expect(inserts).toHaveLength(1);
    // 末四列：prompt_tokens, completion_tokens, credits, cache_read_tokens
    expect(inserts[0].params.slice(-4)).toEqual([200, 80, 2.5, 64]);
    expect(env.writes.filter((w) => w.sql.includes("UPDATE request_logs"))).toHaveLength(0);
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
