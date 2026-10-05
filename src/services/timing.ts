// 请求关键路径分段计时（输出 Server-Timing / X-WB2A-Timing 响应头）。
//
// 存在理由：首 Token 延迟（TTFT）是这个网关最难归因、也最影响体感的一项。
// 从请求进网关到第一个字节发出，中间**串行**串着这些环节：
//
//   鉴权（D1 读子密钥）→ 读请求体 → 读配置（KV）→ 提示词策略（KV）
//   → 模型存在性判定（KV）→ 跨 Worker 的 pick RPC → note RPC → 上游握手
//
// 任一段变慢都会原样加到用户感知的「等待回复」里，而它们全藏在同一个
// 「还没开始输出」的空档中，从外部看不出任何区别——只能靠猜。这里把每一段的
// 毫秒数打进响应头，真机上 `curl -I` 一次就能看清时间花在哪，优化才有靶子。
//
// 为什么用 Server-Timing 而不只自定义一个头：它是 HTTP 标准（RFC 8470 配套），
// Chrome DevTools 的 Timing 面板、Safari、`curl -w '%header{server-timing}'`
// 都原生识别，不必接工具链。额外再给一份紧凑纯文本的 X-WB2A-Timing，
// 是为了在终端里贴出来对比时一眼能读完（Server-Timing 的 `;dur=` 语法很啰嗦）。
//
// 精度说明：全部走 Date.now()（毫秒），不用 performance.now() 的亚毫秒——这里要
// 区分的是「几十毫秒的 IO 往返」与「几百毫秒的上游握手」，毫秒足够，而
// performance.now() 在部分非 Workers 运行时下并不保证可用。

/** Timeline 一次请求的分段计时表。 */
export interface Timeline {
  /** t0 请求进入网关的时刻（epoch ms）。早于一切中间件。 */
  t0: number;
  /** seg 分段名 → 毫秒。同名的重复标记累加或覆盖，由调用方语义决定。 */
  seg: Record<string, number>;
}

/** newTimeline 建表。t0 缺省取调用时刻（调用方应尽量传入更早的真实入口时刻）。 */
export function newTimeline(t0 = Date.now()): Timeline {
  return { t0, seg: {} };
}

/**
 * markSince 把「从 since 到现在」记为一段耗时（毫秒），返回该毫秒数。
 *
 * 负值一律归零：时钟回拨（NTP 校正）会让差值为负，而负数打进 Server-Timing
 * 会让下游解析器直接丢弃整条头。
 */
export function markSince(tl: Timeline, name: string, since: number): number {
  const ms = Math.max(0, Date.now() - since);
  tl.seg[name] = ms;
  return ms;
}

/**
 * addElapsed 把一段耗时**累加**到已存在的同名段上。
 *
 * 给「同一动作会发生多次」的场景用——选号 RPC 在轮转重试时会打好几轮，
 * 用户关心的是「选号这件事总共花了多久」，而不是最后一轮的耗时。
 */
export function addElapsed(tl: Timeline, name: string, ms: number): void {
  const cur = tl.seg[name];
  tl.seg[name] = Math.max(0, (cur ?? 0) + ms);
}

/**
 * SEG_ORDER 分段输出顺序：按**关键路径的先后**，而不是对象插入顺序。
 *
 * 对象插入顺序取决于代码执行路径（错误路径会跳过若干段），直接遍历会让每次
 * 响应的字段顺序都不同，diff 起来很痛苦。固定按关键路径排，缺哪段就少哪段。
 */
const SEG_ORDER = ["auth", "body", "cfg", "prompt", "models", "pick", "refresh", "note", "upstream"];

/** round1 保留一位小数，去掉浮点尾数（0.30000000000000004 这种不该出现在头里）。 */
function round1(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/**
 * timingHeaders 生成要注入响应的两个计时头。
 *
 * total 恒 = 生成时刻 - t0，**不是**各段之和：关键路径外还有 Workers 调度、
 * CORS 中间件、路由匹配等未计入段的开销，二者之差本身就是有用信息
 * （差值大 = 计时漏段了）。
 *
 * 空表返回空对象：没有记到任何段时不要输出一个只有 `total;dur=0` 的噪声头
 * ——那会让人误以为计时生效了但其实什么都没记。
 */
export function timingHeaders(tl: Timeline): Record<string, string> {
  const keys = [
    ...SEG_ORDER.filter((k) => tl.seg[k] !== undefined),
    ...Object.keys(tl.seg).filter((k) => !SEG_ORDER.includes(k)),
  ];
  if (!keys.length) return {};
  const total = Math.max(0, Date.now() - tl.t0);
  const st = [...keys.map((k) => `${k};dur=${round1(tl.seg[k])}`), `total;dur=${round1(total)}`].join(", ");
  const flat = [...keys.map((k) => `${k}=${Math.round(tl.seg[k])}`), `total=${Math.round(total)}`].join(" ");
  return { "Server-Timing": st, "X-WB2A-Timing": flat };
}

/**
 * withTiming 把计时头写进一个已构造好的 Response。
 *
 * ⚠️ 只有**自建**的 Response 才能写：从 `fetch()` 拿到的上游响应在 Workers 里
 * headers 是不可变的（immutable），直接 set 会抛 TypeError。本文件的调用点都在
 * 自建响应上（流式的 new Response(reader) / 非流式的 new Response(json)）。
 */
export function withTiming<T extends Response>(res: T, tl: Timeline): T {
  for (const [k, v] of Object.entries(timingHeaders(tl))) res.headers.set(k, v);
  return res;
}

/** headersWithTiming 在构造 Response 时把计时头并进 headers 字面量。 */
export function headersWithTiming(base: Record<string, string>, tl: Timeline): Record<string, string> {
  return { ...base, ...timingHeaders(tl) };
}
