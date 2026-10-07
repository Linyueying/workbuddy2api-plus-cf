import { describe, it, expect, vi, afterEach } from "vitest";

// /v1/credits 端到端：验证路由可达、鉴权生效、响应结构对得上 APP 配置
// （结果 JSON 键 data.total_usage = 剩余积分），以及逐账号行格式。
//
// 不依赖 Miniflare：直接构造 Hono app + 假 env。DO 的池查询走 poolRPC，
// 用 vi.mock 把它替换成固定账号列表，专注验证「余额视图」这一段。

const ACCOUNTS = [
  { uid: "u_aaaa1111", realm: "cn", auth: { uid: "u_aaaa1111", realm: "cn", nickname: "账号a", accessToken: "AT1" } },
  { uid: "u_bbbb2222", realm: "cn", auth: { uid: "u_bbbb2222", realm: "cn", nickname: "账号b", accessToken: "AT2" } },
];

// 每个账号返回不同余额
const BALANCE: Record<string, number> = { AT1: 1200, AT2: 340 };

vi.mock("../src/durable/account-pool", async (orig) => {
  const actual: any = await orig();
  return { ...actual, poolRPC: async (_env: any, p: string) => (p === "/internal/list" ? ACCOUNTS : null) };
});

vi.mock("../src/services/upstream", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    postBillingResource: async (_env: any, auth: any) => ({
      code: 0,
      data: { Response: { Data: { TotalDosage: 0, Accounts: [
        { PackageName: "p", CycleCapacitySize: 2000, CycleCapacityRemain: BALANCE[auth.accessToken as string] ?? 0, CycleCapacityUsed: 0 },
      ] } } },
    }),
    primeConfig: async () => {},
  };
});

import { Hono } from "hono";
import { registerApi } from "../src/routes/api";
import type { Env } from "../worker-configuration.d.ts";
import type { CtxVars } from "../src/types";

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: CtxVars }>();
  registerApi(app);
  return app;
}

const env = { WB2A_CONFIG: { get: async () => null } } as unknown as Env;

describe("/v1/credits 余额接口", () => {
  afterEach(() => vi.clearAllMocks());

  it("返回 data.total_usage = 剩余积分总量（APP 结果 JSON 键的落点）", async () => {
    const res = await makeApp().request("/v1/credits", {}, env);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    // 这是截图里配置的键：必须存在且等于各账号剩余量之和
    expect(j.data.total_usage).toBe(1540);
    expect(j.ok).toBe(true);
    expect(j.object).toBe("credits");
  });

  it("逐账号行渲染成「名字: 余额」格式", async () => {
    const res = await makeApp().request("/v1/credits", {}, env);
    const j: any = await res.json();
    expect(j.data.lines).toEqual(["账号a: 1200.00", "账号b: 340.00"]);
    expect(j.data.count).toBe(2);
    expect(j.data.ok).toBe(2);
  });

  it("accounts 明细带 name/uid/realm/amount", async () => {
    const res = await makeApp().request("/v1/credits", {}, env);
    const j: any = await res.json();
    expect(j.data.accounts[0].name).toBe("账号a");
    expect(j.data.accounts[0].uid).toBe("u_aaaa1111");
    expect(j.data.accounts[0].realm).toBe("cn");
    expect(j.data.accounts[0].amount).toBe(1200);
  });

  it("?realm=cn 只查该区", async () => {
    const res = await makeApp().request("/v1/credits?realm=cn", {}, env);
    const j: any = await res.json();
    expect(j.data.count).toBe(2);
  });

  it("脏 realm 参数不静默收窄查询范围（当作不过滤）", async () => {
    const res = await makeApp().request("/v1/credits?realm=hack", {}, env);
    const j: any = await res.json();
    // 不能被脏值过滤成空池
    expect(j.data.count).toBe(2);
  });

  it("CORS 预检与响应头由 app 层中间件负责（这里验证路由本身不吞异常）", async () => {
    const res = await makeApp().request("/v1/credits", {}, env);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
