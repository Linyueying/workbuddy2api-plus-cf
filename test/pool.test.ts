import { describe, it, expect, vi } from "vitest";
import { PoolDO } from "../src/durable/account-pool";
import type { Env } from "../worker-configuration.d.ts";
import type { Auth } from "../src/types";

// 账号池 Durable Object 测试：直接在 Node 里实例化 PoolDO，
// 用内存版 Storage 模拟 DO Storage（避免 Miniflare/workerd 环境差异）。
function memStorage() {
  const m = new Map<string, any>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k) : null),
    put: async (k: string, v: any) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    list: async (opts?: { prefix?: string }) => {
      const out = new Map<string, any>();
      for (const [k, v] of m) if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v);
      return out;
    },
    setAlarm: async () => {},
  } as any;
}

const fakeKV = {
  get: async () => null,
  put: async () => {},
  delete: async () => {},
};

function makeEnv(): Env {
  return {
    POOL: {} as any,
    WB2A_CONFIG: fakeKV as any,
    WB2A_CACHE: fakeKV as any,
    WB2A_DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) } as any,
    WB2A_LOGS: {} as any,
    WB2A_API_KEY: "test",
  } as unknown as Env;
}

function newPool(storage?: any): PoolDO {
  const state: any = { id: { toString: () => "main" }, storage: storage ?? memStorage() };
  return new PoolDO(state, makeEnv());
}

/** 记账版 Storage：记录每次读的键，用来抓「逐账号 get」这类读放大。 */
function countingStorage() {
  const m = new Map<string, any>();
  const reads: string[] = [];
  return {
    reads,
    get: async (k: string) => {
      reads.push(String(k));
      return m.has(k) ? m.get(k) : null;
    },
    put: async (k: string, v: any) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
    list: async (opts?: { prefix?: string }) => {
      reads.push("list:" + (opts?.prefix ?? ""));
      const out = new Map<string, any>();
      for (const [k, v] of m) if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v);
      return out;
    },
    setAlarm: async () => {},
  } as any;
}

async function rpc(pool: PoolDO, path: string, method = "GET", body?: unknown) {
  const res = await pool.fetch(
    new Request("https://pool" + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function auth(uid: string, realm: "cn" | "global" = "cn"): Auth {
  return {
    accessToken: "at-" + uid,
    refreshToken: "rt-" + uid,
    expiresAt: Date.now() + 3600_000,
    domain: realm === "global" ? "www.workbuddy.ai" : "copilot.tencent.com",
    realm,
    uid,
    enterpriseId: "e-" + uid,
    nickname: "nick-" + uid,
  };
}

describe("account pool DO", () => {
  it("初始状态为空", async () => {
    const pool = newPool();
    const r = await rpc(pool, "/internal/status");
    expect(r.json.total).toBe(0);
  });

  it("add 后可见并可选号", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    const st = await rpc(pool, "/internal/status");
    expect(st.json.total).toBe(1);
    expect(st.json.healthy).toBe(1);

    const pick = await rpc(pool, "/internal/pick", "POST", { realm: "cn", model: "hy3" });
    expect(pick.json.uid).toBe("u1");
  });

  it("acquire/release 调整在途计数", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/acquire", "POST", { uid: "u1" });
    const a = await rpc(pool, "/internal/auth/u1");
    expect(a.json).toBeTruthy();
    await rpc(pool, "/internal/release", "POST", { uid: "u1" });
  });

  it("disable 使账号下线；revive 恢复", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/manage", "POST", { uid: "u1", action: "disable" });
    const st = await rpc(pool, "/internal/status");
    expect(st.json.disabled).toBe(1);
    const pick = await rpc(pool, "/internal/pick", "POST", { realm: "cn", model: "hy3" });
    expect(pick.status).toBe(503);

    await rpc(pool, "/internal/manage", "POST", { uid: "u1", action: "revive" });
    const pick2 = await rpc(pool, "/internal/pick", "POST", { realm: "cn", model: "hy3" });
    expect(pick2.json.uid).toBe("u1");
  });

  it("remove 删除账号", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/remove", "POST", { uid: "u1" });
    const st = await rpc(pool, "/internal/status");
    expect(st.json.total).toBe(0);
  });

  it("note 硬积分耗尽立即冷却（状态机）", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "hard_credit" });
    const st = await rpc(pool, "/internal/status");
    expect(st.json.cooling).toBe(1);
  });

  it("连续 server 失败达熔断阈值后冷却", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    for (let i = 0; i < 3; i++) await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "server" });
    const st = await rpc(pool, "/internal/status");
    expect(st.json.cooling).toBe(1);
  });
});

describe("账号池 P1 状态机", () => {
  it("连败降权：达阈临时出池，降权期内不延长", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    // 默认 degrade_threshold=5：连败 4 次仍可选。
    for (let i = 0; i < 4; i++) {
      await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "failures" });
    }
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn" })).json.uid).toBe("u1");

    // 第 5 次达阈 → 降权（breaker 未达阈，故 cooldownUntil 不变，只有 degradeUntil）。
    const n5 = await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "failures" });
    expect(n5.json.degradeUntil).toBeGreaterThan(Date.now());
    expect(n5.json.consecutiveFails).toBe(0); // 达阈即清零
    expect(n5.json.cooldownUntil).toBe(0); // 降权不写账号级冷却
    // 降权中：池内无 healthy 候选 → 走全冷却兜底（降权号参与兜底：失败形态是
    // 「不知道原因」，到期放行半开试探正是兜底语义，Go 同口径）。
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn" })).json.fallback).toBe(true);
    // 有健康号时不选降权号。
    await rpc(pool, "/internal/add", "POST", { auth: auth("u2") });
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn" })).json.uid).toBe("u2");
    expect((await rpc(pool, "/internal/status")).json.degraded).toBe(1);

    // 降权期内再连败 5 次：不延长（degradeUntil 不变）。
    const before = n5.json.degradeUntil;
    for (let i = 0; i < 5; i++) {
      await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "failures" });
    }
    const after = await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "failures" });
    expect(after.json.degradeUntil).toBe(before);
  });

  it("成功清零连败计数与降权截止", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    for (let i = 0; i < 5; i++) await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "failures" });
    const ok = await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "success" });
    expect(ok.json.degradeUntil).toBe(0);
    expect(ok.json.consecutiveFails).toBe(0);
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn" })).json.uid).toBe("u1");
  });

  it("6004 带重置时间 → 模型级独立冷却（切模型即可用，不冷却账号）", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    const resetAt = Date.now() + 3_600_000;
    await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "soft_rate", model: "hy3", resetAt, reason: '{"code":6004}' });
    // 账号级仍健康（该模型被避让，其他模型可用）。
    const st = await rpc(pool, "/internal/status");
    expect(st.json.healthy).toBe(1);
    expect(st.json.model_cooldowns).toBe(1);
    // 选号：请求 hy3 选不到（503），请求别的模型能选到。
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn", model: "hy3" })).status).toBe(503);
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn", model: "glm-5.2" })).json.uid).toBe("u1");
  });

  it("11102 负缓存：命中后该模型避让，成功即清（model_block_clear）", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "model_blocked", model: "hy3" });
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn", model: "hy3" })).status).toBe(503);
    // 该 (账号,模型) 又通了 → 负缓存清除，恢复可选。
    await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "model_block_clear", model: "hy3" });
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn", model: "hy3" })).json.uid).toBe("u1");
  });

  it("成本台账：NoteModelCost 记 EMA 单价并内插扣减余额", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/credits", "POST", { uid: "u1", credits: 1000, creditsTotal: 1000 });
    // 10 credit / 1000 token = 10/1k
    await rpc(pool, "/internal/model-cost", "POST", { uid: "u1", model: "hy3", credit: 10, tokens: 1000 });
    let r = await rpc(pool, "/internal/model-cost", "POST", { uid: "u1", model: "hy3", credit: 20, tokens: 1000 });
    // EMA alpha=0.3：10*0.7 + 20*0.3 = 13
    expect(r.json.modelCost.hy3.costPer1k).toBeCloseTo(13, 5);
    expect(r.json.modelCost.hy3.samples).toBe(2);
    // 余额内插扣减：1000 - 10 - 20 = 970
    expect(r.json.credits).toBe(970);
    // tokens<=0 不记录（无法折算单价）。
    const r2 = await rpc(pool, "/internal/model-cost", "POST", { uid: "u1", model: "hy4", credit: 5, tokens: 0 });
    expect(r2.json.modelCost.hy4).toBeUndefined();
  });

  it("成本分层选号：免费号优先于已实测收费号", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("paid") });
    await rpc(pool, "/internal/add", "POST", { auth: auth("free") });
    // paid 实测收费 5/1k；free 实测免费 0/1k。
    await rpc(pool, "/internal/model-cost", "POST", { uid: "paid", model: "hy3", credit: 5, tokens: 1000 });
    await rpc(pool, "/internal/model-cost", "POST", { uid: "free", model: "hy3", credit: 0, tokens: 1000 });
    for (let i = 0; i < 5; i++) {
      expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn", model: "hy3" })).json.uid).toBe("free");
    }
  });

  it("条件探索：tier0 垄断时按窗口搭车改道到无观测号，事件计数递增", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("free") });
    await rpc(pool, "/internal/add", "POST", { auth: auth("unknown") });
    await rpc(pool, "/internal/model-cost", "POST", { uid: "free", model: "hy3", credit: 0, tokens: 1000 });
    // 首次：窗口内从未探索 → 切 tier1-only。
    const p1 = await rpc(pool, "/internal/pick", "POST", { realm: "cn", model: "hy3" });
    expect(p1.json.explored).toBe(true);
    expect(p1.json.uid).toBe("unknown");
    let st = await rpc(pool, "/internal/status");
    expect(st.json.cost_explore_events).toBe(1);
    expect(st.json.cost_explore).toBe(true);
    expect(Object.keys(st.json.cost_explore_last)).toEqual(["cn\x1fhy3"]);
    // 窗口内再次 pick：不再探索，回 tier0。
    const p2 = await rpc(pool, "/internal/pick", "POST", { realm: "cn", model: "hy3" });
    expect(p2.json.explored).toBe(false);
    expect(p2.json.uid).toBe("free");
    st = await rpc(pool, "/internal/status");
    expect(st.json.cost_explore_events).toBe(1);
    expect(st.json.model_cost_entries).toBe(1);
  });

  it("credits 写回钳位：子集不超过余额，过期批次清空", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    const past = Date.now() - 1000;
    const r = await rpc(pool, "/internal/credits", "POST", {
      uid: "u1", credits: 100, creditsTotal: 500, expiring: 999, earliestExpiry: past, earliestRemaining: 50,
    });
    expect(r.json.credits).toBe(100);
    const list = await rpc(pool, "/internal/list");
    expect(list.json[0].creditsExpiring).toBe(100); // 钳到 credits
    expect(list.json[0].creditsEarliestExpiry).toBe(0); // 已过期 → 清空
    expect(list.json[0].creditsEarliestRemaining).toBe(0);
  });

  it("session_dead 需连续 3 次才禁用（容忍偶发抖动）", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "session_dead" });
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn" })).json.uid).toBe("u1");
    await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "session_dead" });
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn" })).json.uid).toBe("u1");
    await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "session_dead" });
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn" })).status).toBe(503);
  });

  it("软冷却有界退避：已在冷却中再次 429 不延长（防越重试越冷）", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    const n1 = await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "soft_rate" });
    const n2 = await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "soft_rate" });
    expect(n2.json.cooldownUntil).toBe(n1.json.cooldownUntil);
  });

  it("revive 清空冷却/熔断/降权/模型台账", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "soft_rate" });
    await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "model_blocked", model: "hy3" });
    await rpc(pool, "/internal/manage", "POST", { uid: "u1", action: "revive" });
    const st = await rpc(pool, "/internal/status");
    expect(st.json.healthy).toBe(1);
    expect(st.json.model_cooldowns).toBe(0);
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn", model: "hy3" })).json.uid).toBe("u1");
  });

  // 读放大回归：老实现在 pick/list/status 每条路径上都无条件 refreshCache()，
  // 而 allAccts 是「逐 uid storage.get」——N 个账号 = N+1 次 Storage 读，
  // 且 pick 在**每条对话请求的关键路径**上，账号越多首字越慢。
  it("账号装载一次，后续 pick 零账号读（N+1 → 0）", async () => {
    const st = countingStorage();
    const pool = newPool(st);
    for (const u of ["u1", "u2", "u3"]) await rpc(pool, "/internal/add", "POST", { auth: auth(u) });
    // 首次 pick 触发装载（批量 list + 一次 index get）。
    await rpc(pool, "/internal/pick", "POST", { realm: "cn" });
    st.reads.length = 0;
    for (let i = 0; i < 5; i++) await rpc(pool, "/internal/pick", "POST", { realm: "cn" });
    const acct = st.reads.filter((k) => k.startsWith("acct:") || k.startsWith("list:"));
    expect(acct).toEqual([]);
    // 账号数翻倍不应改变这条结论（真正被验证的是「不随 N 增长」）。
    for (const u of ["u4", "u5", "u6"]) await rpc(pool, "/internal/add", "POST", { auth: auth(u) });
    st.reads.length = 0;
    await rpc(pool, "/internal/pick", "POST", { realm: "cn" });
    expect(st.reads.filter((k) => k.startsWith("acct:") || k.startsWith("list:"))).toEqual([]);
  });

  // 缓存必须存「活对象」：storage.get 每次返回独立副本，若 acquire/release 改的是副本、
  // 而 pick 读的是缓存里的另一个对象，inFlight 就会各写各的、互相覆盖 —— 比慢更危险。
  it("写穿：acquire/release/note 的改动对 pick 与 status 立刻可见", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/acquire", "POST", { uid: "u1" });
    expect((await rpc(pool, "/internal/list")).json[0].inFlight).toBe(1);
    await rpc(pool, "/internal/release", "POST", { uid: "u1" });
    expect((await rpc(pool, "/internal/list")).json[0].inFlight).toBe(0);

    // 冷却也一样：note 之后必须立刻不再可选（不能还按旧快照选出号）。
    await rpc(pool, "/internal/add", "POST", { auth: auth("u2") });
    await rpc(pool, "/internal/note", "POST", { uid: "u2", kind: "soft_rate" });
    expect((await rpc(pool, "/internal/status")).json.cooling).toBe(1);
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn" })).json.uid).toBe("u1");
  });

  it("remove 同步除名：删掉的号不会被内存态再选中", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/add", "POST", { auth: auth("u2") });
    await rpc(pool, "/internal/pick", "POST", { realm: "cn" }); // 触发装载
    await rpc(pool, "/internal/remove", "POST", { uid: "u1" });
    await rpc(pool, "/internal/remove", "POST", { uid: "u2" });
    expect((await rpc(pool, "/internal/status")).json.total).toBe(0);
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn" })).status).toBe(503);
  });

  // ── 跨 Worker RPC 合并 ────────────────────────────────────────────────
  // PoolDO 跑在独立 Worker 上，每次 RPC = 一次完整 HTTP 往返。这三个字段把
  // "永远成对出现"的调用并进同一次往返：pick+acquire、双 note、cost+release。
  it("pick 带 acquire：选号成功即在同一次调用内占位（inFlight+1）", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    const p = await rpc(pool, "/internal/pick", "POST", { realm: "cn", acquire: 1 });
    expect(p.json.uid).toBe("u1");
    expect(p.json.acquired).toBe(true);
    expect((await rpc(pool, "/internal/list")).json[0].inFlight).toBe(1);
    // 不带 acquire 时不占位（保持旧语义，兼容未升级的调用方）。
    const pool2 = newPool();
    await rpc(pool2, "/internal/add", "POST", { auth: auth("u1") });
    const p2 = await rpc(pool2, "/internal/pick", "POST", { realm: "cn" });
    expect(p2.json.acquired).toBe(false);
    expect((await rpc(pool2, "/internal/list")).json[0].inFlight).toBe(0);
  });

  it("note kinds 批量：一次 RPC 施加多个事件，且只落一次盘", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "model_blocked", model: "hy3" });
    const r = await rpc(pool, "/internal/note", "POST", { uid: "u1", kinds: ["model_block_clear", "success"] , model: "hy3" });
    expect(r.json.ok).toBe(true);
    // 负缓存已清 → 该模型恢复可选；success 也记到了（errTotal 不因成功增长）。
    expect((await rpc(pool, "/internal/pick", "POST", { realm: "cn", model: "hy3" })).json.uid).toBe("u1");
    // 单发形态仍然可用（兼容）。
    const r2 = await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "success" });
    expect(r2.json.ok).toBe(true);
  });

  it("release 带 cost：成本台账与释放在途一次做完", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/credits", "POST", { uid: "u1", credits: 1000, creditsTotal: 1000 });
    await rpc(pool, "/internal/pick", "POST", { realm: "cn", acquire: 1 });
    const r = await rpc(pool, "/internal/release", "POST", { uid: "u1", cost: { model: "hy3", credit: 10, tokens: 1000 } });
    expect(r.json.ok).toBe(true);
    expect(r.json.inFlight).toBe(0);
    const a = (await rpc(pool, "/internal/list")).json[0];
    expect(a.inFlight).toBe(0);
    // 台账已记（10 credit / 1000 token = 10/1k），余额内插扣减 1000-10=990。
    expect(a.modelCost.hy3.costPer1k).toBeCloseTo(10, 5);
    expect(a.credits).toBe(990);
    // tokens<=0 不记台账（无法折算单价），但释放照常。
    const r2 = await rpc(pool, "/internal/release", "POST", { uid: "u1", cost: { model: "hy4", credit: 5, tokens: 0 } });
    expect(r2.json.ok).toBe(true);
    expect((await rpc(pool, "/internal/list")).json[0].modelCost.hy4).toBeUndefined();
  });

  it("pick 就地刷新临期 token（调用方不必再跑一趟 refresh RPC）", async () => {
    const pool = newPool();
    // expiresAt 落在 needsRefresh 的 10 分钟窗口内 → 选号时应被就地刷新。
    const nearExpiry: Auth = { ...auth("u1"), expiresAt: Date.now() + 60_000 };
    await rpc(pool, "/internal/add", "POST", { auth: nearExpiry });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ accessToken: "at-new", refreshToken: "rt-new", expiresIn: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    try {
      const p = await rpc(pool, "/internal/pick", "POST", { realm: "cn" });
      expect(p.json.auth.accessToken).toBe("at-new");
      // 刷新结果必须落盘（写穿），否则下次还要再刷一次。
      expect((await rpc(pool, "/internal/auth/u1")).json.accessToken).toBe("at-new");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("刷新失败不阻断选号：退回旧 token，由调用方兜底重试", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: { ...auth("u1"), expiresAt: Date.now() + 60_000 } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    try {
      const p = await rpc(pool, "/internal/pick", "POST", { realm: "cn" });
      expect(p.json.uid).toBe("u1");
      expect(p.json.auth.accessToken).toBe("at-u1"); // 旧 token 仍在
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("list 暴露模型级冷却与成本台账（运维可观测性）", async () => {
    const pool = newPool();
    await rpc(pool, "/internal/add", "POST", { auth: auth("u1") });
    await rpc(pool, "/internal/note", "POST", { uid: "u1", kind: "model_blocked", model: "hy3" });
    await rpc(pool, "/internal/model-cost", "POST", { uid: "u1", model: "hy3", credit: 0, tokens: 1000 });
    const res = await pool.fetch(new Request("https://pool/internal/list"));
    const list: any[] = await res.json();
    expect(list[0].modelCooldowns.hy3.reason).toContain("11102");
    expect(list[0].modelCooldowns.hy3.hits).toBe(1);
    expect(list[0].modelCost.hy3.costPer1k).toBe(0);
  });
});
