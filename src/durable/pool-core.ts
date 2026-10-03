import type { AccountState, ModelCostEntry } from "../types";

// 选号核心（替代 internal/pool/pick.go + entry.go 的选号侧纯逻辑）。
// 纯函数化：候选筛选 / 成本分层 / 短名单排序 / 加权随机 / 兜底，全部无 IO，
// 便于单测；account-pool.ts（DO 单线程）负责调用并持久化 lastUsed/usedSeq。

/** MODEL_COST_TTL 成本观测有效期 6h：覆盖「夜间免费」时段优惠，但不跨时段生效。 */
export const MODEL_COST_TTL = 6 * 3600_000;

/** MIN_PICK_GAP 防并发撞号窗口（生产 100ms）。 */
export const MIN_PICK_GAP = 100;

/** EXPIRING_VIRTUAL_SLOTS 快过期账号的虚拟实例倍数（放大其被选中概率）。 */
export const EXPIRING_VIRTUAL_SLOTS = 3;

/** pickWeights 选号相关配置子集。 */
export interface PickCfg {
  idle_weight_per_hour: number;
  idle_weight_max: number;
  prefer_expiring: boolean;
  expiring_soon: number;
  credit_floor: number;
  cost_explore_interval: number;
  max_in_flight: number;
  max_in_flight_global: number;
}

/** modelCostOf 读取成本台账（带 TTL；过期视为无观测）。 */
export function modelCostOf(a: AccountState, model: string, now: number): ModelCostEntry | null {
  if (!model || !a.modelCost) return null;
  const mc = a.modelCost[model];
  if (!mc) return null;
  if (!mc.lastSeen || now - mc.lastSeen > MODEL_COST_TTL) return null;
  return mc;
}

/** modelCooled 该模型是否处于模型级独立冷却（6004，多模型各自独立）。auditOnly 条目不参与避让。 */
export function modelCooled(a: AccountState, model: string, now: number): boolean {
  if (!model) return false;
  const mc = a.modelCooldowns?.[model];
  if (!mc || mc.auditOnly) return false;
  return !!mc.until && mc.until > now;
}

/**
 * healthy 账号级健康：未禁用 / 未冷却 / 未熔断 / 未降权。
 * 四个截止是**并列的或门**（不是取最远），任一未到期即不可选——这天然就是
 * 「冷却与熔断与降权并存、取更远者不叠加」，不需要显式比较长短。
 */
export function healthy(a: AccountState, now: number): boolean {
  if (a.status === "disabled") return false;
  if (a.cooldownUntil > now) return false;
  if ((a.breakerUntil ?? 0) > now) return false;
  if ((a.degradeUntil ?? 0) > now) return false;
  return true;
}

/** healthyForModel 模型级健康：模型独立冷却优先，再回落账号级。 */
export function healthyForModel(a: AccountState, model: string, now: number): boolean {
  if (a.status === "disabled") return false;
  if (modelCooled(a, model, now)) return false;
  return healthy(a, now);
}

/** inFlightFull 在途占满（上限按 realm 分档，0=不限）。 */
export function inFlightFull(a: AccountState, cfg: PickCfg): boolean {
  const limit = a.realm === "global" ? cfg.max_in_flight_global : cfg.max_in_flight;
  if (limit <= 0) return false;
  return a.inFlight >= limit;
}

/** hardCooled 余额耗尽硬冷却中（等签到恢复，调了必 402，不参与兜底）。 */
export function hardCooled(a: AccountState, now: number): boolean {
  const kind = a.cooldownKind;
  if (kind !== "hard" && kind !== "hard_credit") return false;
  return a.cooldownUntil > now;
}

/** expiry 当前生效的最近冷却/熔断/降权截止（三截止取最早）；不在冷却期返回 0。 */
export function expiry(a: AccountState, now: number): number {
  let t = 0;
  for (const v of [a.cooldownUntil, a.breakerUntil ?? 0, a.degradeUntil ?? 0]) {
    if (v > now && (t === 0 || v < t)) t = v;
  }
  return t;
}

/** fallbackKind 兜底账号属于哪一类：breaker（熔断期为最近截止）/ soft（软冷却或降权）。 */
export function fallbackKind(a: AccountState, now: number): string {
  const b = a.breakerUntil ?? 0;
  if (b > now) {
    const u = a.cooldownUntil;
    if (u <= now || b < u) return "breaker";
  }
  return "soft";
}

/** costTier 成本分层：0 已实测免费 / 1 无观测（含过期）/ 2 已实测收费。 */
export function costTier(a: AccountState, model: string, now: number): { tier: number; cost1k: number } {
  const mc = modelCostOf(a, model, now);
  if (!mc) return { tier: 1, cost1k: 0 };
  if (mc.costPer1k <= 0) return { tier: 0, cost1k: 0 };
  return { tier: 2, cost1k: mc.costPer1k };
}

/** expiringNow 是否有当前仍有效的快过期积分批次。 */
export function expiringNow(a: AccountState, now: number): boolean {
  return (
    (a.creditsExpiring ?? 0) > 0 &&
    (a.creditsEarliestRemaining ?? 0) > 0 &&
    (a.creditsEarliestExpiry ?? 0) > now
  );
}

/** weightOf 普通加权：credits 比例 ×10 + 闲置补偿（从未使用给满分）。 */
function weightOf(a: AccountState, maxCredits: number, cfg: PickCfg, now: number): number {
  let w = 1.0;
  if (maxCredits > 0) w += ((a.credits ?? 0) / maxCredits) * 10;
  if (!a.lastUsed) {
    w += cfg.idle_weight_max; // 从未使用 → 满分
  } else {
    const hours = (now - a.lastUsed) / 3600000;
    let idleW = hours * cfg.idle_weight_per_hour;
    if (idleW > cfg.idle_weight_max) idleW = cfg.idle_weight_max;
    if (idleW < 0) idleW = 0; // 时钟回拨钳 0
    w += idleW;
  }
  return w;
}

/** routingWeightOf叠加快过期虚拟实例倍数。 */
function routingWeightOf(a: AccountState, maxCredits: number, cfg: PickCfg, now: number): number {
  const w = weightOf(a, maxCredits, cfg, now);
  if (cfg.prefer_expiring && expiringNow(a, now)) return w * EXPIRING_VIRTUAL_SLOTS;
  return w;
}

/**
 * floorBlocked 积分保底拦截：floor>0 且账号触底（credits<floor）且该模型**收费**。
 * 收费判据两级：1) 本地实测台账 cost>0；2) 无观测时用目录倍率兜底（rate>0）。
 * 未知倍率放行（保守，避免拦掉内部/别名模型导致号永久失联）。
 */
export function floorBlocked(
  a: AccountState,
  model: string,
  cfg: PickCfg,
  now: number,
  modelRateOf: (realm: string, model: string) => string,
  realm: string,
): boolean {
  if (cfg.credit_floor <= 0 || !model || (a.credits ?? 0) >= cfg.credit_floor) return false;
  const mc = modelCostOf(a, model, now);
  if (mc) return mc.costPer1k > 0;
  const rate = modelRateOf(realm, model);
  if (!rate) return false;
  const v = Number(rate);
  return Number.isFinite(v) && v > 0;
}

/** 加权随机抽签（claude-api selectWeightedRandom 参考口径）。 */
function pickWeighted(cands: AccountState[], cfg: PickCfg, now: number, rnd: () => number): AccountState {
  let maxCredits = 0;
  for (const a of cands) if ((a.credits ?? 0) > maxCredits) maxCredits = a.credits ?? 0;
  let total = 0;
  const weights = cands.map((a) => {
    const w = Math.floor(routingWeightOf(a, maxCredits, cfg, now) * 1_000_000);
    total += w;
    return w;
  });
  if (total <= 0) return cands[Math.floor(rnd() * cands.length)];
  let r = Math.floor(rnd() * total);
  let acc = 0;
  for (let i = 0; i < cands.length; i++) {
    acc += weights[i];
    if (r < acc) return cands[i];
  }
  return cands[cands.length - 1];
}

/** Fisher-Yates 洗牌（等权时打散，避免字典序饿死）。 */
function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** pick 的输入（realm 已由调用方在候选集上过滤，或传 "" 不过滤）。 */
export interface PickInput {
  realm: string;
  model: string;
  exclude: Set<string>;
  now: number;
  cfg: PickCfg;
  modelRateOf: (realm: string, model: string) => string;
  /** cost_explore 上次探索时刻表：key = realm\x1fmodel。 */
  exploreLast: Record<string, number>;
  rnd: () => number;
}

/** pick 选出账号（不含 lastUsed/usedSeq 写回，由调用方在锁内完成）。返回 uid 或 null。 */
export interface PickResult {
  uid: string | null;
  /** 本次 pick 是否切了成本探索层（tier0 垄断 → tier1-only 搭车改道）。 */
  explored: boolean;
  /** 是否走了全冷却兜底（无 healthy 候选）。 */
  fallback: boolean;
  /** 兜底账号的冷却类别（breaker / soft），仅 fallback 时有值。 */
  fallbackKind: string;
}

export function pick(candsIn: AccountState[], inp: PickInput): PickResult {
  const { realm, model, exclude, now, cfg } = inp;
  const healthyOf = model ? (a: AccountState) => healthyForModel(a, model, now) : (a: AccountState) => healthy(a, now);
  const baseOk = (a: AccountState) => {
    if (exclude.has(a.uid)) return false;
    if (realm && a.realm !== realm) return false;
    if (!healthyOf(a)) return false;
    if (floorBlocked(a, model, cfg, now, inp.modelRateOf, realm)) return false;
    return true;
  };
  // 首选：健康 + 在途未满（负载均衡）。
  let cands = candsIn.filter((a) => baseOk(a) && !inFlightFull(a, cfg));
  if (cands.length === 0) {
    // 在途全满时放宽 inFlight 限制：inFlight 是「无状态 Workers 下会泄漏的软计数」
    // （客户端断连/Worker 被驱逐/RPC 丢失都会让它只增不减），不能当硬门槛——
    // 否则单账号泄漏一次就永久锁死（no_healthy_account, reasons={in_flight_full:1}）。
    // 这里只保留健康/冷却/保底等真实约束，靠池内并发自然限流。
    cands = candsIn.filter(baseOk);
  }
  if (cands.length === 0) {
    // 全冷却兜底：从软冷却/熔断/降权的账号里选到期最早者（禁用与硬冷却除外）。
    let best: AccountState | null = null;
    for (const a of candsIn) {
      if (exclude.has(a.uid)) continue;
      if (realm && a.realm !== realm) continue;
      if (a.status === "disabled") continue;
      if (hardCooled(a, now)) continue;
      if (floorBlocked(a, model, cfg, now, inp.modelRateOf, realm)) continue;
      const exp = expiry(a, now);
      if (exp === 0) continue;
      if (!best || exp < expiry(best, now)) best = a;
    }
    return { uid: best?.uid ?? null, explored: false, fallback: true, fallbackKind: best ? fallbackKind(best, now) : "" };
  }

  // 成本分层硬过滤（model 非空时）：只保留最优层。无观测(tier1)优先于已实测收费(tier2)。
  let bestTier = 2;
  if (model) {
    for (const a of cands) {
      const ti = costTier(a, model, now).tier;
      if (ti < bestTier) bestTier = ti;
    }
    // 条件探索：tier0 垄断 + 存在 tier1 + 超窗口 → 本次切 tier1-only（搭车改道）。
    let explored = false;
    if (cfg.cost_explore_interval > 0 && bestTier === 0) {
      const hasTier1 = cands.some((a) => costTier(a, model, now).tier === 1);
      const key = realm + "\x1f" + model;
      const last = inp.exploreLast[key] ?? 0;
      if (hasTier1 && now - last >= cfg.cost_explore_interval * 1000) {
        inp.exploreLast[key] = now;
        bestTier = 1;
        explored = true;
      }
    }
    cands = cands.filter((a) => costTier(a, model, now).tier === bestTier);
    return withUid(finishPick(cands, inp), explored, false, "");
  }
  return withUid(finishPick(cands, inp), false, false, "");
}

function withUid(uid: string | null, explored: boolean, fallback: boolean, kind: string): PickResult {
  return { uid, explored, fallback, fallbackKind: uid ? kind : "" };
}

/** 短名单截断 + minPickGap + LRU 兜底 + 加权抽签，返回 uid。 */
function finishPick(cands: AccountState[], inp: PickInput): string | null {
  if (cands.length === 0) return null;
  const { cfg, now, rnd } = inp;
  let maxCredits = 0;
  for (const a of cands) if ((a.credits ?? 0) > maxCredits) maxCredits = a.credits ?? 0;

  // 预计算权重（O(n)），再按 (cost1k 升, 权重降, uid) 排序。
  type W = { a: AccountState; w: number; cost1k: number };
  const ws: W[] = cands.map((a) => ({
    a,
    w: routingWeightOf(a, maxCredits, cfg, now),
    cost1k: inp.model ? costTier(a, inp.model, now).cost1k : 0,
  }));
  // 等权洗牌：候选 >5 且存在等权时打散（独立随机源，不影响抽签语义）。
  let pool = ws;
  if (ws.length > 5) {
    const eq = ws.some((x) => x.w === ws[0].w);
    if (eq) pool = shuffle(ws, rnd);
  }
  pool.sort((x, y) => {
    if (x.cost1k !== y.cost1k) return x.cost1k - y.cost1k; // 收费层单价低在前
    if (x.w !== y.w) return y.w - x.w;
    return x.a.uid < y.a.uid ? -1 : 1;
  });
  const candsAll = pool.map((x) => x.a);
  const top5 = candsAll.length > 5 ? candsAll.slice(0, 5) : candsAll;

  // minPickGap：窗口内刚用过的号排除（防并发撞号）。
  const eligible = top5.filter((a) => now - (a.lastUsed ?? 0) >= MIN_PICK_GAP);
  let chosen: AccountState;
  if (eligible.length === 0) {
    // top5 全刚用过 → LRU 兜底：全候选里选 usedSeq 最小者。
    chosen = candsAll[0];
    for (const a of candsAll) if ((a.usedSeq ?? 0) < (chosen.usedSeq ?? 0)) chosen = a;
  } else {
    chosen = pickWeighted(eligible, cfg, now, rnd);
  }
  return chosen.uid;
}