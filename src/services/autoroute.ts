// 模型编排（替代 internal/autoroute/autoroute.go）：auto 虚拟模型昼夜轮换 + 降级链。
//
// 纯函数（Config 值语义 + 显式 now），无全局状态，可单测。设计边界：
//   - 只做「选哪个模型」，不做「选哪个账号」（正交，账号由 pool 负责）；
//   - 编排结果是**候选链**而非覆盖式改写：链首首选，后续仅在可降级错误触发；
//   - model_fallback 递归展开（去重、限深 3、限长 8，防配置成环）。

/** maxChain 候选链长度上限（防配置成环/过长导致请求放大）。 */
const MAX_CHAIN = 8;
/** maxExpandDepth model_fallback 递归展开深度上限。 */
const MAX_EXPAND_DEPTH = 3;

/** NoHealthyAccount 本地「无可用账号」的降级类别名（与 classify 命名空间统一）。 */
export const NO_HEALTHY_ACCOUNT = "no_healthy_account";

/**
 * defaultKinds 默认可触发降级的错误类别。判据「换号解决不了、换模型可能解决」：
 * 限流/额度/该后端无此模型/上游故障/账号授权故障/404/无可用账号。
 * 反之内容拦截/参数错/上下文超长/请求体解析失败是请求本身问题，不降级。
 */
const DEFAULT_KINDS = [
  "soft_rate", "hard_credit", "model_blocked", "server",
  "account_fault", "not_found", NO_HEALTHY_ACCOUNT,
];

/** AutoModelConfig auto_model + model_fallback 两段配置。 */
export interface AutoModelConfig {
  enabled: boolean;
  day_primary: string;
  night_primary: string;
  day_start: number;
  day_end: number;
  fallback: string[];
  model_fallback: Record<string, string[]>;
  virtual_id: string;
  override: boolean;
  on_empty: boolean;
  fallback_on: string[];
}

/** RealmOf 取模型名的 realm 前缀（"cn:hy3" → "cn"；无前缀 → "cn"）。 */
export function RealmOf(model: string): string {
  const i = model.indexOf(":");
  if (i < 0) return "cn";
  const p = model.slice(0, i);
  return p === "cn" || p === "global" ? p : "cn";
}

/** BareOf 取去前缀的裸模型名。 */
export function BareOf(model: string): string {
  const i = model.indexOf(":");
  if (i < 0) return model;
  const p = model.slice(0, i);
  return p === "cn" || p === "global" ? model.slice(i + 1) : model;
}

function virtualID(c: AutoModelConfig): string {
  const s = (c.virtual_id ?? "").trim();
  return s || "auto";
}

/**
 * IsVirtual 该模型名是否应由编排接管。realExists = 该名字在上游真实模型表存在。
 * 存在且未开 override → 不接管（让位给上游同名模型，避免静默替换既有能力）。
 */
export function IsVirtual(c: AutoModelConfig, model: string, realExists: boolean): boolean {
  if (!c.enabled) return false;
  if (BareOf(model) !== virtualID(c)) return false;
  if (realExists && !c.override) return false;
  return true;
}

/** isDay 当前小时是否落在白天窗口 [day_start, day_end)。start==end 视为全天白天。 */
function isDay(c: AutoModelConfig, hour: number): boolean {
  const s = c.day_start ?? 8;
  const e = c.day_end ?? 23;
  if (s === e) return true;
  if (s < e) return hour >= s && hour < e;
  return hour >= s || hour < e; // 跨零点窗口
}

/** filterRealm 按 realm 过滤候选链；want 空时原样返回。 */
function filterRealm(list: string[], want: string): string[] {
  if (!want) return list.filter(Boolean);
  return list.filter((m) => m && RealmOf(m) === want);
}

/** primary 按时段与 realm 挑主模型。hour 为 Asia/Shanghai 0-23。 */
function primary(c: AutoModelConfig, hour: number, wantRealm: string): string {
  const day = (c.day_primary ?? "").trim();
  const night = (c.night_primary ?? "").trim();
  if (wantRealm) {
    // 带 realm 前缀的 auto（如 global:auto）：只在该 realm 候选里选。
    if (day && RealmOf(day) === wantRealm) {
      if (isDay(c, hour) || !night || RealmOf(night) !== wantRealm) return day;
      return night;
    }
    if (night && RealmOf(night) === wantRealm) return night;
    for (const m of c.fallback ?? []) if (RealmOf(m) === wantRealm) return m;
    return "";
  }
  if (isDay(c, hour)) return day || night;
  return night || day;
}

/** expand 逐项按 model_fallback 递归展开（去重、限深、限长，防配置成环）。 */
function expand(c: AutoModelConfig, chain: string[]): string[] {
  const mf = c.model_fallback ?? {};
  if (chain.length === 1 && mf[chain[0]] == null) return chain;
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (m: string, depth: number) => {
    if (!m || seen.has(m) || out.length >= MAX_CHAIN) return;
    seen.add(m);
    out.push(m);
    if (depth >= MAX_EXPAND_DEPTH) return;
    for (const nx of mf[m] ?? []) walk((nx ?? "").trim(), depth + 1);
  };
  for (const m of chain) walk(m, 0);
  return out.length ? out : chain;
}

/**
 * Chain 返回该请求的模型候选链（链首首选）。非虚拟模型且无 model_fallback 时
 * 返回单元素链 [model]——与未启用编排完全一致。
 * @param shanghaiHour 当前 Asia/Shanghai 小时（0-23），由调用方按 now 计算注入（纯函数）。
 */
export function Chain(c: AutoModelConfig, model: string, shanghaiHour: number, realExists: boolean): string[] {
  let chain = [model];
  if (IsVirtual(c, model, realExists)) {
    const i = model.indexOf(":");
    const p = i > 0 ? model.slice(0, i) : "";
    const want = p === "cn" || p === "global" ? p : "";
    const pr = primary(c, shanghaiHour, want);
    if (pr) {
      chain = [pr, ...filterRealm(c.fallback ?? [], want)];
    }
  }
  return expand(c, chain);
}

/** VirtualIDs 应在 /v1/models 里列出的虚拟模型名（裸 auto + 主模型 realm 前缀）。 */
export function VirtualIDs(c: AutoModelConfig): string[] | null {
  if (!c.enabled) return null;
  const vid = virtualID(c);
  const out = [vid];
  const seen = new Set([vid]);
  for (const p of [c.day_primary, c.night_primary]) {
    const t = (p ?? "").trim();
    if (!t) continue;
    const id = RealmOf(t) + ":" + vid;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** kindSet 生效的降级类别集合（显式配置优先，空 = 默认）。 */
function kindSet(c: AutoModelConfig): Set<string> {
  const set = new Set<string>();
  const on = c.fallback_on ?? [];
  if (!on.length) {
    for (const k of DEFAULT_KINDS) set.add(k);
    return set;
  }
  for (const k of on) {
    const t = (k ?? "").trim();
    if (t) set.add(t);
  }
  return set;
}

/** Fallbackable 该错误类别是否应触发模型降级。 */
export function Fallbackable(c: AutoModelConfig, kind: string): boolean {
  if (!kind) return false;
  return kindSet(c).has(kind.trim());
}