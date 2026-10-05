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
// 精度说明：一律走 `performance.now()`（亚毫秒），不用 Date.now()。
//
// 这不是洁癖——真机上 `body` 段恒显示为 0 就是这个坑：几十 KB 请求体的读取加
// JSON.parse 大约 0.3~0.8ms，Date.now() 的毫秒分辨率把它整个抹成 0，于是看不出
// 「到底是快还是压根没计时」这种本质区别。TTFT 优化到后期要争的就是这几毫秒的
// 取舍，计时器自己不能成为瓶颈。
// Workers 与 Node 都有 performance.now()；万一在某种运行时下缺席，回落到
// Date.now()（只是重新引入亚毫秒抹平，不会崩）。
const perf: { now(): number } | undefined = typeof performance !== "undefined" ? performance : undefined;

/**
 * now 单调时钟毫秒（浮点）。
 *
 * ⚠️ 必须用**单调**时钟：performance.now() 不受系统时钟调整影响，而 Date.now()
 * 会被 NTP 校正回拨。计时差值一旦为负，Server-Timing 的解析方会直接丢弃整条头。
 *
 * ⚠️⚠️ 全链路**只能**用这一支表：`performance.now()` 返回的是「isolate 启动至今
 * 的毫秒」（几百~几十万量级），`Date.now()` 是 epoch（1.7e12 量级），两者**不能
 * 相减**。任何一个埋点图省事写了 Date.now()，那一段的差值就会变成天文数字
 * （或负到被归零），整条归因数据当场报废。所有取时刻处一律 `now()`。
 */
export function now(): number {
  return perf ? perf.now() : Date.now();
}

/** Timeline 一次请求的分段计时表。 */
export interface Timeline {
  /** t0 请求进入网关的时刻（epoch ms）。早于一切中间件。 */
  t0: number;
  /** seg 分段名 → 毫秒。同名的重复标记累加或覆盖，由调用方语义决定。 */
  seg: Record<string, number>;
}

/** newTimeline 建表。t0 缺省取调用时刻（调用方应尽量传入更早的真实入口时刻）。 */
export function newTimeline(t0 = now()): Timeline {
  return { t0, seg: {} };
}

/**
 * markSince 把「从 since 到现在」记为一段耗时（毫秒），返回该毫秒数。
 *
 * 负值一律归零：虽然改用单调时钟后不会再出现，但外部传入的 since 可能是用别的
 * 时间源取的（比如有人在调用侧混用了 Date.now()），负值会让下游解析器丢弃整条
 * Server-Timing 头，宁可显示 0 也别让整段归因数据消失。
 */
export function markSince(tl: Timeline, name: string, since: number): number {
  const ms = Math.max(0, now() - since);
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
  const total = Math.max(0, now() - tl.t0);
  const st = [...keys.map((k) => `${k};dur=${round1(tl.seg[k])}`), `total;dur=${round1(total)}`].join(", ");
  // 紧凑版统一取一位小数：原先这里用 Math.round 取整，亚毫秒段（body / cfg /
  // note 这类已经优化到 <1ms 的）会一整片糊成 0，看不出优化到底生效没有。
  const flat = [...keys.map((k) => `${k}=${round1(tl.seg[k])}`), `total=${round1(total)}`].join(" ");
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
