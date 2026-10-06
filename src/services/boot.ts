// 冷启动 / 缓存命中的可观测性底座。
//
// 为什么单独一个文件：冷启动与缓存命中的状态，一部分是 **isolate 的属性**（不是
// 请求的属性），而 Hono 的 Context 是每请求一份、且只能在 app.fetch 内部拿到。
// 那些「本 isolate 只记一次 / 跨请求共享」的量（uptime 基准、每请求的缓存探针）
// 必须放在模块作用域，由需要它的地方各自来读。
//
// X-Worker-Uptime / X-Cold-Start / X-Auth-Cache / X-Models-Cache 这串头要回答的
// 是同一件事：「这次请求在关键路径上到底付了几次后端往返」。把冷启动现场从
// 「isolate 刚起来」和「cache TTL 到期」两种不同成因里区分开，二者要改的东西
// 完全不同（前者砍启动期 I/O，后者拉长 TTL），混在一起 p95 没有统计意义。

/**
 * WORKER_START 本 isolate 模块加载时刻（epoch ms）。
 *
 * 用作 X-Worker-Uptime 的基准：头里输出 `Date.now() - WORKER_START`，即本 isolate
 * 存活毫秒数。刻意用 Date.now() 而不是 performance.now()：uptime 是「差值」语义，
 * 基准点只取一次，不受两种时钟不可相减的影响；且这是响应头而不是计时段，不参与
 * 任何 now()-based 的相减，不存在把归因数据报废的风险。
 */
const WORKER_START = Date.now();

/** uptimeMs 本 isolate 已存活毫秒数（>=0）。 */
export function uptimeMs(): number {
  return Math.max(0, Date.now() - WORKER_START);
}

// —— 缓存命中观测（X-Auth-Cache / X-Models-Cache / 重写后的 X-Cold-Start 的数据源）——
//
// probe 是**每请求一份**：挂在 Hono Context 上，由鉴权中间件建好，各缓存读函数
// 通过 onCache 回调填 hit/miss，最后在 CORS 中间件汇总成响应头。模块级缓存命中
// 与否由各自的读函数判定，这里只负责聚合——这样各缓存模块保持单一职责。

export interface CacheProbe {
  /** getConfig 的 KV 命中情况（鉴权与 proxy 都会读，故可能多条）。 */
  config: boolean[];
  /** loadKeyByHash 的 D1 命中情况（仅子密钥路径）。 */
  key: boolean[];
  /** modelsSnapshot 的 KV 命中情况（模型目录）。 */
  models: boolean[];
}

/** newCacheProbe 建一个空的每请求缓存探针。 */
export function newCacheProbe(): CacheProbe {
  return { config: [], key: [], models: [] };
}

export type CacheHit = "hit" | "miss" | null;

/** cacheStatus 把一组 hit/miss 归一成 hit / miss / null（空）。 */
export function cacheStatus(arr: boolean[]): CacheHit {
  if (!arr.length) return null;
  return arr.some((x) => !x) ? "miss" : "hit";
}
