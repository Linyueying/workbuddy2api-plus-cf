import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runHealthChecks, healthReport } from "../src/services/health";
import type { Env } from "../worker-configuration.d.ts";

// 部署自检的核心价值：把「wrangler pages deploy 照样成功、但服务实际不可用」
// 这三类故障变成可见的 503 + 明确修复命令。故这里逐项验证判据。

/**可编程 fake env：逐项控制绑定是否可用。 */
function makeEnv(opts: {
  apiKey?: string | null;
  configThrows?: boolean;
  d1Throws?: boolean;
  d1HasApikeys?: boolean;
  kvThrows?: boolean;
  poolThrows?: boolean;
} = {}) {
  const {
    apiKey = "0123456789abcdef0123",
    configThrows = false,
    d1Throws = false,
    d1HasApikeys = true,
    kvThrows = false,
    poolThrows = false,
  } = opts;

  const cfgKV = {
    get: async (k: string) => {
      if (configThrows) throw new Error("kv down");
      // 空配置 = 默认配置（api_key: ""），Secret 缺失即此形态。
      // 注意必须返回**对象**：getConfig 用 { type: "json" } 读，返回字符串会
      // 让 mergeDeep 把整个 stored 当标量，cfg.prompt 等嵌套默认值全部缺失。
      if (k === "config") return opts.apiKey === null ? null : { api_key: apiKey };
      return null;
    },
    put: async () => {},
    delete: async () => {},
  };

  const cacheKV = {
    get: async () => {
      if (kvThrows) throw new Error("cache down");
      return null;
    },
    put: async () => {},
    delete: async () => {},
  };

  const d1 = {
    prepare: (sql: string) => {
      if (d1Throws) return { first: async () => { throw new Error("d1 down"); } };
      // 第一条是「任意表存在吗」→ 有表即返回行；第二条查 apikeys 是否存在。
      const probingApikeys = sql.includes("AND name='apikeys'");
      return { first: async () => (probingApikeys ? (d1HasApikeys ? { name: "apikeys" } : null) : { name: "request_logs" }) };
    },
  };

  const pool = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    }),
  };

  return {
    WB2A_CONFIG: cfgKV,
    WB2A_CACHE: cacheKV,
    WB2A_DB: d1,
    // poolThrows 模拟「Pages 项目未绑定 POOL」→ env.POOL 为 undefined，
    // 触发 health.ts 的 unbound 分支（提示「Durable Object 绑定缺失」）。
    POOL: poolThrows ? (undefined as unknown as typeof pool) : pool,
  } as unknown as Env;
}

const byName = (checks: { name: string }[], n: string) => checks.find((c) => c.name === n);

describe("health /部署自检", () => {
  // getConfig 有 5s 模块级缓存，跨 case 复用 env 会串味。
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => vi.restoreAllMocks());

  it("全部正常 → ready:true", async () => {
    const { ready, checks } = await runHealthChecks(makeEnv());
    expect(ready).toBe(true);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  // ---- 阻塞项 3：空 api_key（部署成功但面板全锁）----
  it("空管理员钥匙 → ready:false 且 hint 给出修复命令", async () => {
    const { ready, checks } = await runHealthChecks(makeEnv({ apiKey: null }));
    expect(ready).toBe(false);
    const c = byName(checks, "admin_api_key");
    expect(c?.ok).toBe(false);
    expect(c?.hint).toContain("401");
    expect(c?.hint).toContain("wrangler pages secret put");
  });

  it("短钥匙只warn 不阻断（用户可能故意用短串）", async () => {
    const { ready, checks } = await runHealthChecks(makeEnv({ apiKey: "short" }));
    expect(ready).toBe(true);
    const c = byName(checks, "admin_api_key_strength");
    expect(c?.ok).toBe(true);
    expect(c?.warn).toBe(true);
  });

  it("长钥匙不产生 strength 警告项", async () => {
    const { checks } = await runHealthChecks(makeEnv());
    expect(byName(checks, "admin_api_key_strength")).toBeUndefined();
    expect(byName(checks, "admin_api_key")?.ok).toBe(true);
  });

  // ---- 阻塞项 2：D1 未建表（部署成功但首个写请求 500）----
  it("D1 缺 apikeys 表 → ready:false 并指向 db-init", async () => {
    const { ready, checks } = await runHealthChecks(makeEnv({ d1HasApikeys: false }));
    expect(ready).toBe(false);
    const c = byName(checks, "d1_schema");
    expect(c?.ok).toBe(false);
    expect(c?.hint).toContain("db-init");
  });

  it("D1 不可达 → ready:false", async () => {
    const { ready, checks } = await runHealthChecks(makeEnv({ d1Throws: true }));
    expect(ready).toBe(false);
    expect(byName(checks, "d1_reachable")?.ok).toBe(false);
  });

  // ---- 其他绑定 ----
  it("KV 不可读只 warn 不阻断（只是模型探测变慢）", async () => {
    const { ready, checks } = await runHealthChecks(makeEnv({ kvThrows: true }));
    expect(ready).toBe(true);
    expect(byName(checks, "kv_cache")?.warn).toBe(true);
  });

  it("账号池 DO 不可用 → ready:false", async () => {
    const { ready, checks } = await runHealthChecks(makeEnv({ poolThrows: true }));
    expect(ready).toBe(false);
    expect(byName(checks, "pool_do")?.hint).toContain("Durable Object 绑定");
  });

  it("读配置抛错 → getConfig 回落默认配置，故报「钥匙空」而非 config_readable", async () => {
    // getConfig 刻意吞掉 KV 读取异常并回落默认配置（注释：KV 未配置时使用默认配置），
    // 否则 KV 未绑定会让整站500。于是 KV 挂掉的自检表现是"钥匙为空"——
    // 仍然 ready:false，只是提示指向 secret 而非 KV，两个都指向排查方向。
    const { ready, checks } = await runHealthChecks(makeEnv({ configThrows: true }));
    expect(ready).toBe(false);
    expect(byName(checks, "admin_api_key")?.ok).toBe(false);
    // 其余探测照常进行，不因配置读失败而中断（能拿到的信息越多越好排查）。
    expect(checks.length).toBeGreaterThan(1);
    expect(byName(checks, "d1_reachable")?.ok).toBe(true);
  });

  // ---- healthz 响应体 ----
  it("healthReport 输出 ready +逐项 checks", async () => {
    const rep = await healthReport(makeEnv()) as any;
    expect(rep.ready).toBe(true);
    expect(rep.ok).toBe(true);
    expect(Array.isArray(rep.checks)).toBe(true);
    expect(rep.checks.length).toBeGreaterThan(3);
  });

  it("healthReport 在配置坏时仍返回结构（不抛），供探针定位", async () => {
    const rep = await healthReport(makeEnv({ apiKey: null })) as any;
    expect(rep.ok).toBe(true);        // HTTP 层通
    expect(rep.ready).toBe(false);     // 但配置坏
    const c = rep.checks.find((x: any) => x.name === "admin_api_key");
    expect(c.hint).toContain("secret put");
  });
});