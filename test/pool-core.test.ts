import { describe, it, expect } from "vitest";
import {
  pick,
  costTier,
  floorBlocked,
  modelCooled,
  healthy,
  hardCooled,
  expiry,
  fallbackKind,
  inFlightFull,
  expiringNow,
  MODEL_COST_TTL,
  type PickCfg,
} from "../src/durable/pool-core";
import type { AccountState, Realm } from "../src/types";

// 选号核心纯函数测试（对齐 internal/pool 的 pick_test/credit_floor_test 关键判据）。
// 不依赖 DO：直接构造候选集，注入确定性随机源。

const CFG: PickCfg = {
  idle_weight_per_hour: 0.5,
  idle_weight_max: 5,
  prefer_expiring: true,
  expiring_soon: 72,
  credit_floor: 0,
  cost_explore_interval: 0,
  max_in_flight: 2,
  max_in_flight_global: 4,
};

const NOW = 1_700_000_000_000;

function acct(uid: string, over: Partial<AccountState> = {}): AccountState {
  return {
    uid,
    auth: { accessToken: "t", refreshToken: "r", expiresAt: 0, domain: "", realm: "cn", uid, enterpriseId: "", nickname: uid },
    status: "healthy",
    cooldownUntil: 0,
    cooldownKind: "",
    inFlight: 0,
    consecutiveFailures: 0,
    nickname: uid,
    realm: "cn" as Realm,
    modelCooldowns: {},
    credits: 100,
    ...over,
  };
}

/** 确定性递增随机源（测试可复现）。 */
function seqRnd(n: number): () => number {
  let i = 0;
  return () => {
    i++;
    return (i % (n + 1)) / (n + 1);
  };
}

function noRate(): (realm: string, model: string) => string {
  return () => "";
}

describe("pool-core 成本分层", () => {
  it("tier 判定：实测免费=0，无观测=1，实测收费=2，过期观测回落到 1", () => {
    const free = acct("a", { modelCost: { m: { costPer1k: 0, lastSeen: NOW, samples: 3 } } });
    const paid = acct("b", { modelCost: { m: { costPer1k: 2.9, lastSeen: NOW, samples: 3 } } });
    const unknown = acct("c");
    const stale = acct("d", { modelCost: { m: { costPer1k: 0, lastSeen: NOW - MODEL_COST_TTL - 1, samples: 9 } } });
    expect(costTier(free, "m", NOW).tier).toBe(0);
    expect(costTier(paid, "m", NOW).tier).toBe(2);
    expect(costTier(paid, "m", NOW).cost1k).toBeCloseTo(2.9);
    expect(costTier(unknown, "m", NOW).tier).toBe(1);
    // 时段优惠不跨时段：过期观测不得复活 tier 0。
    expect(costTier(stale, "m", NOW).tier).toBe(1);
  });

  it("硬过滤只留最优层：tier1（无观测）优先于 tier2（已实测收费）", () => {
    const cands = [
      acct("paid", { modelCost: { m: { costPer1k: 2.9, lastSeen: NOW, samples: 2 } } }),
      acct("unknown"),
    ];
    const r = pick(cands, {
      realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg: CFG,
      modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(10),
    });
    // 未知号必须胜出：否则免费号永远轮不到，也就永远学不到限免。
    expect(r.uid).toBe("unknown");
  });

  it("tier0 存在时全部选 tier0（免费优先）", () => {
    const cands = [
      acct("paid", { modelCost: { m: { costPer1k: 5, lastSeen: NOW, samples: 2 } } }),
      acct("free", { modelCost: { m: { costPer1k: 0, lastSeen: NOW, samples: 2 } } }),
    ];
    for (let i = 0; i < 5; i++) {
      const r = pick(cands, {
        realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg: CFG,
        modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(3),
      });
      expect(r.uid).toBe("free");
    }
  });

  it("条件探索：tier0 垄断 + 存在 tier1 + 超窗口 → 本次切 tier1-only", () => {
    const cfg = { ...CFG, cost_explore_interval: 30 };
    const cands = [
      acct("free", { modelCost: { m: { costPer1k: 0, lastSeen: NOW, samples: 2 } } }),
      acct("unknown"),
    ];
    const exploreLast: Record<string, number> = {};
    // 首次（零值 = 从未探索）即应探索。
    const r1 = pick(cands, {
      realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg,
      modelRateOf: noRate(), exploreLast, rnd: seqRnd(5),
    });
    expect(r1.explored).toBe(true);
    expect(r1.uid).toBe("unknown");
    // 窗口内不再探索（同一 tick 连续 pick）。
    const r2 = pick(cands, {
      realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg,
      modelRateOf: noRate(), exploreLast, rnd: seqRnd(5),
    });
    expect(r2.explored).toBe(false);
    expect(r2.uid).toBe("free");
    // 超窗口后恢复探索。
    const r3 = pick(cands, {
      realm: "cn", model: "m", exclude: new Set(), now: NOW + 31_000, cfg,
      modelRateOf: noRate(), exploreLast, rnd: seqRnd(5),
    });
    expect(r3.explored).toBe(true);
  });

  it("探索窗口按 (realm, model) 独立分桶", () => {
    const cfg = { ...CFG, cost_explore_interval: 30 };
    const cands = [
      acct("free", { realm: "cn", modelCost: { m: { costPer1k: 0, lastSeen: NOW, samples: 2 } } }),
      acct("unknown", { realm: "cn" }),
    ];
    const exploreLast: Record<string, number> = {};
    pick(cands, { realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg, modelRateOf: noRate(), exploreLast, rnd: seqRnd(5) });
    expect(Object.keys(exploreLast)).toEqual(["cn\x1fm"]);
  });

  it("cost_explore_interval=0 时关停探索", () => {
    const cands = [
      acct("free", { modelCost: { m: { costPer1k: 0, lastSeen: NOW, samples: 2 } } }),
      acct("unknown"),
    ];
    const r = pick(cands, {
      realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg: CFG,
      modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(5),
    });
    expect(r.explored).toBe(false);
    expect(r.uid).toBe("free");
  });
});

describe("pool-core 积分保底", () => {
  it("触底号接收费模型被拦；免费模型放行", () => {
    const poor = acct("poor", { credits: 1, modelCost: { m: { costPer1k: 2.9, lastSeen: NOW, samples: 1 } } });
    const cfg = { ...CFG, credit_floor: 100 };
    expect(floorBlocked(poor, "m", cfg, NOW, noRate(), "cn")).toBe(true);
    const free = acct("poor2", { credits: 1, modelCost: { m: { costPer1k: 0, lastSeen: NOW, samples: 1 } } });
    expect(floorBlocked(free, "m", cfg, NOW, noRate(), "cn")).toBe(false);
  });

  it("无本地观测时用目录倍率兜底判收费（堵住「无观测 = 放行」漏洞）", () => {
    const poor = acct("poor", { credits: 1 });
    const cfg = { ...CFG, credit_floor: 100 };
    // 同名模型在 CN / global 两域倍率可不同：只有 CN 目录下发了该倍率。
    const rate = (realm: string, m: string) => (realm === "cn" && m === "kimi-k3-1" ? "1.62" : "");
    expect(floorBlocked(poor, "kimi-k3-1", cfg, NOW, rate, "cn")).toBe(true);
    // global 域目录未覆盖 → 未知 → 保守放行（不是「免费」，是「无法判收费」）。
    expect(floorBlocked(poor, "kimi-k3-1", cfg, NOW, rate, "global")).toBe(false);
  });

  it("倍率未知（目录外/内部模型）保守放行；倍率 0（限免）放行", () => {
    const poor = acct("poor", { credits: 1 });
    const cfg = { ...CFG, credit_floor: 100 };
    expect(floorBlocked(poor, "internal-x", cfg, NOW, noRate(), "cn")).toBe(false);
    const zero = () => "0.00";
    expect(floorBlocked(poor, "hy4-preview-f", cfg, NOW, zero, "cn")).toBe(false);
  });

  it("余额未触底不拦（保底只拦触底号）", () => {
    const rich = acct("rich", { credits: 500, modelCost: { m: { costPer1k: 9, lastSeen: NOW, samples: 1 } } });
    const cfg = { ...CFG, credit_floor: 100 };
    expect(floorBlocked(rich, "m", cfg, NOW, noRate(), "cn")).toBe(false);
  });

  it("保底在选号里生效：触底号不会被选去接收费模型", () => {
    const cfg = { ...CFG, credit_floor: 100 };
    const cands = [
      acct("poor", { credits: 1, modelCost: { m: { costPer1k: 2.9, lastSeen: NOW, samples: 1 } } }),
      acct("rich", { credits: 900, modelCost: { m: { costPer1k: 2.9, lastSeen: NOW, samples: 1 } } }),
    ];
    for (let i = 0; i < 6; i++) {
      const r = pick(cands, { realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg, modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(7) });
      expect(r.uid).toBe("rich");
    }
  });
});

describe("pool-core 健康与模型级冷却", () => {
  it("6004 模型级冷却只避让该模型，其他模型仍可选（每模型独立）", () => {
    const a = acct("a", { modelCooldowns: { "hy3": { until: NOW + 600_000, reason: "6004 model rate limit" } } });
    expect(modelCooled(a, "hy3", NOW)).toBe(true);
    expect(modelCooled(a, "glm-5.2", NOW)).toBe(false);
    expect(healthy(a, NOW)).toBe(true); // 账号级仍健康
  });

  it("auditOnly 条目只进台账不影响路由", () => {
    const a = acct("a", { modelCooldowns: { "hy3": { until: NOW + 600_000, auditOnly: true } } });
    expect(modelCooled(a, "hy3", NOW)).toBe(false);
  });

  it("过期的模型级冷却不再避让", () => {
    const a = acct("a", { modelCooldowns: { "hy3": { until: NOW - 1 } } });
    expect(modelCooled(a, "hy3", NOW)).toBe(false);
  });

  it("健康判定：冷却 / 熔断 / 降权三者任一未到期即不可选（并存不叠加）", () => {
    expect(healthy(acct("a", { cooldownUntil: NOW + 1000 }), NOW)).toBe(false);
    expect(healthy(acct("a", { breakerUntil: NOW + 1000 }), NOW)).toBe(false);
    expect(healthy(acct("a", { degradeUntil: NOW + 1000 }), NOW)).toBe(false);
    expect(healthy(acct("a", { status: "disabled" }), NOW)).toBe(false);
    expect(healthy(acct("a", { cooldownUntil: NOW - 1, breakerUntil: NOW - 1, degradeUntil: NOW - 1 }), NOW)).toBe(true);
  });

  it("在途占满按 realm 分档", () => {
    expect(inFlightFull(acct("a", { inFlight: 2 }), CFG)).toBe(true);
    expect(inFlightFull(acct("b", { inFlight: 3, realm: "global" }), CFG)).toBe(false);
    expect(inFlightFull(acct("c", { inFlight: 4, realm: "global" }), CFG)).toBe(true);
    const unlimited = { ...CFG, max_in_flight: 0, max_in_flight_global: 0 };
    expect(inFlightFull(acct("d", { inFlight: 99 }), unlimited)).toBe(false);
  });

  it("硬冷却识别（余额耗尽号）", () => {
    expect(hardCooled(acct("a", { cooldownKind: "hard_credit", cooldownUntil: NOW + 1000 }), NOW)).toBe(true);
    expect(hardCooled(acct("b", { cooldownKind: "soft_rate", cooldownUntil: NOW + 1000 }), NOW)).toBe(false);
    expect(hardCooled(acct("c", { cooldownKind: "hard_credit", cooldownUntil: NOW - 1 }), NOW)).toBe(false);
  });

  it("expiry 三截止取最早；fallbackKind 区分熔断与软冷却", () => {
    const a = acct("a", { cooldownUntil: NOW + 5000, breakerUntil: NOW + 2000, degradeUntil: NOW + 9000 });
    expect(expiry(a, NOW)).toBe(NOW + 2000);
    expect(fallbackKind(a, NOW)).toBe("breaker");
    const b = acct("b", { cooldownUntil: NOW + 1000, degradeUntil: NOW + 9000 });
    expect(expiry(b, NOW)).toBe(NOW + 1000);
    expect(fallbackKind(b, NOW)).toBe("soft");
    expect(expiry(acct("c"), NOW)).toBe(0);
  });

  it("快过期批次识别（prefer_expiring 的前提）", () => {
    expect(
      expiringNow(acct("a", { creditsExpiring: 50, creditsEarliestRemaining: 50, creditsEarliestExpiry: NOW + 3600_000 }), NOW),
    ).toBe(true);
    // 已过期批次不再算压力。
    expect(
      expiringNow(acct("b", { creditsExpiring: 50, creditsEarliestRemaining: 50, creditsEarliestExpiry: NOW - 1 }), NOW),
    ).toBe(false);
  });
});

describe("pool-core 选号主流程", () => {
  it("exclude 命中的号被跳过（请求级轮换）", () => {
    const cands = [acct("u1"), acct("u2"), acct("u3")];
    const r = pick(cands, {
      realm: "cn", model: "m", exclude: new Set(["u1", "u2"]), now: NOW, cfg: CFG,
      modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(4),
    });
    expect(r.uid).toBe("u3");
  });

  it("realm 过滤：global 模型只路由 global 账号", () => {
    const cands = [acct("cn1", { realm: "cn" }), acct("gl1", { realm: "global" })];
    const r = pick(cands, {
      realm: "global", model: "m", exclude: new Set(), now: NOW, cfg: CFG,
      modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(4),
    });
    expect(r.uid).toBe("gl1");
  });

  it("minPickGap：窗口内刚用过的号被挤向其他候选", () => {
    const cands = [acct("u1", { lastUsed: NOW, usedSeq: 1 }), acct("u2", { lastUsed: 0, usedSeq: 2 })];
    const r = pick(cands, {
      realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg: CFG,
      modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(4),
    });
    expect(r.uid).toBe("u2");
  });

  it("top5 全刚用过 → LRU 兜底按 usedSeq 取最旧者（与时间精度无关）", () => {
    // 全部 lastUsed == NOW（模拟 Windows ~0.5ms 时钟精度），usedSeq 严格全序。
    const cands = [
      acct("u1", { lastUsed: NOW, usedSeq: 5 }),
      acct("u2", { lastUsed: NOW, usedSeq: 2 }),
      acct("u3", { lastUsed: NOW, usedSeq: 9 }),
    ];
    const r = pick(cands, {
      realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg: CFG,
      modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(4),
    });
    expect(r.uid).toBe("u2");
  });

  it("全冷却兜底：取到期最早者，排除禁用与硬冷却", () => {
    const cands = [
      acct("disabled", { status: "disabled", cooldownUntil: NOW + 1000 }),
      acct("hard", { cooldownKind: "hard_credit", cooldownUntil: NOW + 1000 }),
      acct("soon", { cooldownUntil: NOW + 3000 }),
      acct("later", { breakerUntil: NOW + 9000 }),
    ];
    const r = pick(cands, {
      realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg: CFG,
      modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(4),
    });
    expect(r.fallback).toBe(true);
    expect(r.uid).toBe("soon");
  });

  it("全冷却兜底也受积分保底约束（触底号不被捞回来接收费模型）", () => {
    const cfg = { ...CFG, credit_floor: 100 };
    const cands = [
      acct("poor", { credits: 1, cooldownUntil: NOW + 1000, modelCost: { m: { costPer1k: 5, lastSeen: NOW, samples: 1 } } }),
      acct("rich", { credits: 900, cooldownUntil: NOW + 5000, modelCost: { m: { costPer1k: 5, lastSeen: NOW, samples: 1 } } }),
    ];
    const r = pick(cands, { realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg, modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(4) });
    expect(r.uid).toBe("rich");
  });

  it("全禁用时返回 null（上层映射 no_healthy_account）", () => {
    const cands = [acct("a", { status: "disabled" }), acct("b", { status: "disabled" })];
    const r = pick(cands, {
      realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg: CFG,
      modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(4),
    });
    expect(r.uid).toBeNull();
  });

  it("model 为空时不做成本分层（无模型上下文）", () => {
    const cands = [acct("a"), acct("b", { status: "disabled" })];
    const r = pick(cands, {
      realm: "cn", model: "", exclude: new Set(), now: NOW, cfg: CFG,
      modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(4),
    });
    expect(r.uid).toBe("a");
  });

  it("加权分布：闲置久的号被选中的次数明显更多", () => {
    const cands = [acct("hot", { lastUsed: NOW, usedSeq: 1 }), acct("cold", { lastUsed: NOW - 72 * 3600_000, usedSeq: 2 })];
    let coldHits = 0;
    for (let i = 0; i < 200; i++) {
      // 每次 pick 前把 lastUsed 重置，模拟时间推进（否则会被 minPickGap 全过滤）。
      cands[0].lastUsed = NOW;
      cands[1].lastUsed = NOW - 72 * 3600_000;
      const r = pick(cands, {
        realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg: CFG,
        modelRateOf: noRate(), exploreLast: {}, rnd: Math.random,
      });
      if (r.uid === "cold") coldHits++;
    }
    expect(coldHits).toBeGreaterThan(150);
  });

  it("realm 不匹配时本 realm 选不到，但 realm=\"\" 放宽后能选到另一 realm 的账号", () => {
    // 复现「国际版账号 realm=global，请求模型未带 global: 前缀 → stripRealm 默认算成 cn」：
    // 此前会被 a.realm !== "cn" 全量过滤返回 null，永远 no_healthy_account，尽管池里有可用账号。
    const onlyGlobal = [acct("g1", { realm: "global" }), acct("g2", { realm: "global" })];
    const rCn = pick(onlyGlobal, {
      realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg: CFG,
      modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(4),
    });
    expect(rCn.uid).toBeNull(); // 本 realm 无号 → 兜底前返回 null
    const rAny = pick(onlyGlobal, {
      realm: "", model: "m", exclude: new Set(), now: NOW, cfg: CFG,
      modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(4),
    });
    expect(rAny.uid).not.toBeNull(); // 放宽 realm 限制 → 能选到 global 账号
    expect(["g1", "g2"]).toContain(rAny.uid);
  });

  it("realm 匹配时仍严格隔离：cn 请求不应选到 global 账号", () => {
    const mixed = [acct("c1", { realm: "cn" }), acct("g1", { realm: "global" })];
    for (let i = 0; i < 10; i++) {
      const r = pick(mixed, {
        realm: "cn", model: "m", exclude: new Set(), now: NOW, cfg: CFG,
        modelRateOf: noRate(), exploreLast: {}, rnd: seqRnd(6),
      });
      expect(r.uid).toBe("c1"); // 候选仅 c1（g1 被 realm 过滤），稳定选中
    }
  });
});
