import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startLogin, pollLogin } from "../src/services/oauth";
import type { Env } from "../worker-configuration.d.ts";

function fakeKV() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
  };
}

function fakeEnv() {
  const kv = fakeKV();
  const poolStub = {
    async fetch(req: Request) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/internal/add" || p === "/internal/manage") return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return {
    POOL: { get: () => poolStub, idFromName: () => ({}) },
    WB2A_CONFIG: kv,
    WB2A_CACHE: kv,
    WB2A_DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
    WB2A_LOGS: {},
  } as unknown as Env;
}

function mockFetch() {
  return vi.fn(async (req: Request) => {
    const url = (req as any).url as string;
    // 上游设备授权三端点均为 {code,msg,data} 信封（对齐 Go doJSON 的 env.Data 解法），
    // 早期 mock 用扁平 {state:...} 形态，与真实上游不符。
    if (url.includes("/v2/plugin/auth/state")) {
      return json({ code: 0, data: { state: "S123", authUrl: "https://x/authorize?state=S123" } });
    }
    if (url.includes("/v2/plugin/auth/token")) {
      return json({ code: 0, data: { accessToken: "AT", refreshToken: "RT", expiresIn: 3600 } });
    }
    if (url.includes("/v2/plugin/login/account")) {
      return json({ code: 0, data: { uid: "u_abc", nickname: "Tom", enterpriseId: "e1" } });
    }
    if (url.includes("/daily-checkin")) return json({ code: 0, msg: "ok" });
    // 上游真实结构：data.Response.Data.Accounts（对齐 Go resourceAccounts）。
    if (url.includes("/get-user-resource")) {
      return json({
        code: 0,
        data: {
          Response: {
            Data: {
              TotalDosage: 100,
              Accounts: [{ PackageName: "签到包", CycleCapacitySize: 100, CycleCapacityRemain: 10, CycleCapacityUsed: 90 }],
            },
          },
        },
      });
    }
    return json({ code: 0, data: {} });
  });
}
function json(o: any, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

describe("oauth device flow", () => {
  beforeEach(() => {});
  afterEach(() => vi.unstubAllGlobals());

  it("start -> poll 完成登录并落池", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const env = fakeEnv();
    const start = await startLogin(env, "cn");
    expect(start.ok).toBe(true);
    expect(start.state).toBe("S123");

    const poll = await pollLogin(env, "S123");
    expect(poll.done).toBe(true);
    expect(poll.uid).toBe("u_abc");
    expect(poll.credits).toBe(10);
  });

  it("poll 未就绪返回 done:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      const url = (req as any).url as string;
      if (url.includes("/v2/plugin/auth/state")) return json({ code: 0, data: { state: "S2", authUrl: "x" } });
      // pending：上游返回业务 code != 0（"login ing"），无 token。
      if (url.includes("/v2/plugin/auth/token")) return json({ code: 10001, msg: "login ing" });
      return json({ code: 0, data: {} });
    }));
    const env = fakeEnv();
    const s = await startLogin(env, "cn");
    const poll = await pollLogin(env, s.state);
    expect(poll.done).toBe(false);
  });

  // ---- 以下为oauthState 的错误位判定（回归防护）----
  //
  // 旧实现只解信封不管 HTTP 状态：上游 400 被吞成空 state，调用方看到的是
  // 「没拿到 state」，与网络故障完全无法区分，排查时无从下手。

  it("oauthState 上游 4xx 抛错而非静默返回空 state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ code: 12403, msg: "bad request" }, 400)));
    const env = fakeEnv();
    await expect(startLogin(env, "cn")).rejects.toThrow(/upstream 400/);
  });

  it("oauthState 业务 code!=0 抛错并带 code/msg", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ code: 12403, msg: "缺少 header" })));
    const env = fakeEnv();
    await expect(startLogin(env, "cn")).rejects.toThrow(/12403/);
  });

  it("oauthState 上游 200 但 state 为空 → ok:false（不抛）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ code: 0, data: {} })));
    const env = fakeEnv();
    const r = await startLogin(env, "cn");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("empty state");
  });

  it("设备授权请求带 Origin/Referer/X-Requested-With/CLI UA（缺 Origin 上游会 400）", async () => {
    const spy = mockFetch();
    vi.stubGlobal("fetch", spy);
    await startLogin(fakeEnv(), "cn");
    const req = spy.mock.calls[0][0] as unknown as Request;
    const h = (req as Request).headers ?? new Headers();
    expect(h.get("Origin")).toBe("https://www.codebuddy.cn");
    expect(h.get("Referer")).toBe("https://www.codebuddy.cn/");
    expect(h.get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(h.get("User-Agent")).toBe("CLI/2.63.2 CodeBuddy/2.63.2");
  });

  it("global realm 的 Origin 切到 workbuddy.ai", async () => {
    const spy = mockFetch();
    vi.stubGlobal("fetch", spy);
    await startLogin(fakeEnv(), "global");
    const req = spy.mock.calls[0][0] as unknown as Request;
    const h = (req as Request).headers ?? new Headers();
    expect(h.get("Origin")).toBe("https://www.workbuddy.ai");
    expect(String((req as Request).url)).toContain("www.workbuddy.ai");
  });
});
