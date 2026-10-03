import type { UsageRow } from "../storage/d1";

// 用量聚合：request_logs（单次请求一级）→ 面板「用量」页的完整视图模型。
//
// 为什么不用 SQL GROUP BY 直接出结果：面板要的是「同一批行、四个维度分组、外加
// 一条零填充时序」，维度间还要共享 totals 的口径（平均延迟/速率/性价比）。写成
// 若干条 GROUP BY 会让口径在 SQL 里各写一遍、改一处漏三处；而窗口内的行数量级
// 是万级，一次性取出来在 Worker 里跑一遍线性扫描，反而更省心也更好测。
//
// 本文件全是不碰 env 的纯函数——这是刻意的：曾苦于 Workers 运行时在本地起不来，
// 凡过度依赖 env 的逻辑都测不到，而它恰恰是踩坑最集中的地方。

/** 小时桶 → 日桶的切换阈值：超过这个跨度再按小时画就全是针状了。 */
export const DAY_BUCKET_THRESHOLD_MS = 48 * 3600_000;

/** GroupStats 一个分组维度的统计量（by_* 与 credit_by_* 共用的行形态）。 */
export interface GroupStats {
  key: string;
  requests: number;
  errors: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** avg_latency_ms 平均延迟（ms）。失败请求也算进来，否则延迟会被人为压低。 */
  avg_latency_ms: number;
  avg_tokens_per_second: number;
  credits: number;
  /** credit_tokens 有 credit 的那些请求对应的 Token——「匹配 Token」。
   *  升级前或缺字段的历史请求不计，避免假装它们不花钱。 */
  credit_tokens: number;
  credit_samples: number;
  credits_per_1m_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  /** _latSum / _durSum 累加过程中的中间槽位（finalize 折算后删除，不出现在响应里）。 */
  _latSum?: number;
  _durSum?: number;
}

/** UsageSnapshot 面板用量页的视图模型，字段名与前端 renderUsage 一一对应。 */
export interface UsageSnapshot {
  window_from: string;
  window_to: string;
  since: string;
  buckets: number;
  totals: GroupStats;
  series: Array<{ t: string; scope: "hour" | "day"; prompt_tokens: number; completion_tokens: number; total_tokens: number; requests: number }>;
  by_account: Array<GroupStats & { extra: string; realm: string }>;
  by_model: GroupStats[];
  by_realm: GroupStats[];
  credit_by_account: Array<GroupStats & { nickname: string; realm: string }>;
  credit_by_model: Array<GroupStats & { rate: string }>;
}

/** num 把任意 D1 出来的值收敛成有限数字（NaN/undefined/null 一律 0）。 */
function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** uKey 分组键归一化：NULL/空统一成一个占位，避免 undefined 与 '' 分成两组。 */
function uKey(v: unknown): string {
  const s = String(v ?? "").trim();
  return s || "unknown";
}

/** emptyGroup 零值分组（累加器的初值）。 */
function emptyGroup(key: string): GroupStats {
  return {
    key,
    requests: 0,
    errors: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    avg_latency_ms: 0,
    avg_tokens_per_second: 0,
    credits: 0,
    credit_tokens: 0,
    credit_samples: 0,
    credits_per_1m_tokens: 0,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0,
  };
}

/**
 * accumulate 累加一行到分组累加器。
 *
 * 延迟/速率这类**比值**必须在最后统一算，不能逐行平均再平均（辛普森悖论：
 * 1 次 10 秒长请求与 99 次 100ms 请求，逐行均值是 199ms，真实均值是 100ms）。
 */
function accumulate(g: GroupStats, r: UsageRow): GroupStats {
  const pt = num(r.prompt_tokens);
  const ct = num(r.completion_tokens);
  const tt = pt + ct;
  const cr = num(r.credits);
  const hit = num(r.cache_read_tokens);
  g.requests++;
  if (r.outcome !== "ok") g.errors++;
  g.prompt_tokens += pt;
  g.completion_tokens += ct;
  g.total_tokens += tt;
  g._latSum = num(g._latSum) + num(r.ms);
  g._durSum = num(g._durSum) + num(r.ms);
  if (cr > 0) {
    g.credits += cr;
    g.credit_tokens += tt;
    g.credit_samples++;
  }
  // 缓存：读命中计入 hit；未命中用 prompt 扣掉命中的部分近似（上游没给更细的字段）。
  // pt < hit 说明数据不自洽（该行只报了缓存读），此时按 pt 封顶，避免未命中为负。
  g.cache_hit_tokens += hit;
  g.cache_miss_tokens += Math.max(0, pt - hit);
  return g;
}

/** finalize 收尾：把累加器里的中间量折算成比值。 */
function finalize(g: GroupStats): GroupStats {
  const latSum = num((g as any)._latSum);
  g.avg_latency_ms = g.requests ? latSum / g.requests : 0;
  // 速率按「总 Token / 总耗时」而不是逐个请求速率再平均——同上，避免长请求被稀释。
  const seconds = latSum / 1000;
  g.avg_tokens_per_second = seconds > 0 ? g.total_tokens / seconds : 0;
  g.credits_per_1m_tokens = g.credit_tokens > 0 ? (g.credits / g.credit_tokens) * 1_000_000 : 0;
  delete (g as any)._latSum;
  delete (g as any)._durSum;
  return g;
}

/** groupBy 按 keyOf 分组后 finalize，并按 key 排序保证输出稳定。 */
function groupBy(rows: UsageRow[], keyOf: (r: UsageRow) => string): GroupStats[] {
  const map = new Map<string, GroupStats>();
  for (const r of rows) {
    const k = keyOf(r);
    let g = map.get(k);
    if (!g) map.set(k, (g = emptyGroup(k)));
    accumulate(g, r);
  }
  return [...map.values()].map(finalize).sort((a, b) => a.key.localeCompare(b.key));
}

/** isoLocal 把 epoch ms 格式化成「北京时间」的 YYYY-MM-DDTHH:mm。
 *
 *  为什么要偏移 8 小时再用 toISOString：toISOString 恒输出 UTC，直接 slice 会让
 *  面板上的时间比用户实际早 8 小时。而前端这里是 `new Date(s)` 按**浏览器本地**
 *  解析（不是 Date.parse 的 UTC 语义），所以给本地时区的字符串才对得上。
 */
export function isoLocal(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 16);
}

/** bucketOf 按窗口跨度选桶粒度。 */
export function bucketOf(span: number): { scope: "hour" | "day"; step: number } {
  return span > DAY_BUCKET_THRESHOLD_MS
    ? { scope: "day", step: 24 * 3600_000 }
    : { scope: "hour", step: 3600_000 };
}

/** floorTo shift 后的零点：小时/日桶的边界都必须按北京时间切，否则每天的桶会
 *  在北京时间 08:00 断一刀。 */
function floorToBeijing(ms: number, step: number): number {
  const bj = ms + 8 * 3600_000;
  const floored = Math.floor(bj / step) * step;
  return floored - 8 * 3600_000;
}

/** seriesOf 生成零填充时序：窗口内每个桶都出现（没有请求也是 0），否则图上一个
 *  孤零零的柱子看不出「其余时间确实用量为零」。 */
export function seriesOf(rows: UsageRow[], from: number, to: number): UsageSnapshot["series"] {
  const { scope, step } = bucketOf(to - from);
  const map = new Map<number, { prompt_tokens: number; completion_tokens: number; total_tokens: number; requests: number }>();
  for (const r of rows) {
    const b = floorToBeijing(num(r.ts), step);
    const cur = map.get(b) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 };
    const pt = num(r.prompt_tokens);
    const ct = num(r.completion_tokens);
    cur.prompt_tokens += pt;
    cur.completion_tokens += ct;
    cur.total_tokens += pt + ct;
    cur.requests++;
    map.set(b, cur);
  }
  const out: UsageSnapshot["series"] = [];
  // 点数上限：http——一次 90 天窗口用日桶是 90 个点；用小时桶跨度已被阈值卡在 48。
  const start = floorToBeijing(Math.min(from, to), step);
  for (let t = start; t <= Math.max(from, to); t += step) {
    const v = map.get(t) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 };
    out.push({
      t: isoLocal(t).slice(0, scope === "day" ? 10 : 13),
      scope,
      ...v,
    });
  }
  return out;
}

export interface UsageQuery {
  from: number;
  to: number;
  /** since 最早一条日志的时间（无数据则 0）。 */
  since: number;
  /** nicknames uid → 昵称；取不到时降级显示 uid 前 8 位（前端已自己兜底）。 */
  nicknames?: Record<string, string>;
  /** rates model → 倍率（如 "3.0"）；没有则前端显示 "—"。 */
  rates?: Record<string, string>;
}

/** buildUsageSnapshot 聚合入口：行数组 → 面板视图模型。 */
export function buildUsageSnapshot(rows: UsageRow[], q: UsageQuery): UsageSnapshot {
  const totals = finalize(rows.reduce(accumulate, emptyGroup("all")));
  const byAccountRaw = groupBy(rows, (r) => uKey(r.uid));
  const byModel = groupBy(rows, (r) => uKey(r.model));
  const byRealm = groupBy(rows, (r) => uKey(r.realm));

  // 账号的 realm 取该 uid 出现最多的那个（同一个号可以同时在 cn/global 被用）。
  const realmOf = new Map<string, string>();
  for (const r of rows) {
    const uid = uKey(r.uid);
    const rl = uKey(r.realm);
    if (rl === "unknown") continue;
    realmOf.set(uid, rl); // 最后一个胜出：与 txn 顺序一致，够用且无需再算一次众数
  }

  return {
    window_from: isoLocal(q.from),
    window_to: isoLocal(q.to),
    since: q.since ? isoLocal(q.since) : "",
    buckets: rows.length,
    totals,
    series: seriesOf(rows, q.from, q.to),
    by_account: byAccountRaw.map((g) => ({
      ...g,
      extra: q.nicknames?.[g.key] ?? "",
      realm: realmOf.get(g.key) ?? "unknown",
    })),
    by_model: byModel,
    by_realm: byRealm,
    // 积分维度只保留真的花了钱的行：全 0 的分组只会把「—」塞满整张表。
    credit_by_account: byAccountRaw
      .filter((g) => g.credits > 0)
      .map((g) => ({ ...g, nickname: q.nicknames?.[g.key] ?? "", realm: realmOf.get(g.key) ?? "unknown" })),
    credit_by_model: byModel
      .filter((g) => g.credits > 0)
      .map((g) => ({ ...g, rate: q.rates?.[g.key] ?? "" })),
  };
}
