import type { Env } from "../../worker-configuration.d.ts";
import type { Realm } from "../types";
import { cacheKV, kvGetJSON, CACHE_KEY_MODELS, CACHE_KEY_MODELS_GLOBAL } from "../storage/kv";

// 模型目录快照的进程内缓存。
//
// 存在理由：目录本身存在 KV 里（TTL 1h，见 resolveModel 的 MODELS_TTL），但**每请求**
// 会被读两次、且是两条互不知情的路径各读一遍同一个 key：
//   - resolveModel.realModelExists（虚拟模型名与上游同名时的让位判定，proxy 每请求 1 次）
//   - upstream.effortTables（reasoning_effort 降级表，出站前 1 次）
// 两条路径分处两个模块（upstream 不能 import resolveModel，会成环），所以谁也没法
// 复用对方读过的结果。KV 免费额度是 10 万次读/天，这条路径属于纯浪费。
//
// 60s 进程内缓存对「新模型可见性」的影响无感：目录刷新（listModels 命中上游）时会
// 主动 invalidate，只有被动等 KV TTL 过期的情况才最多滞后 60s。
const SNAPSHOT_TTL_MS = 60_000;

/**
 * snap 两域各自独立维护「取数时刻」。
 *
 * 原实现对 cn / global **两个 key 一并 Promise.all 读**：理由是一次请求后续两个域
 * 都可能用到，合并读比分两次 miss 更省。但这个前提在实测中不成立——绝大多数部署
 * 只服务一个域，另一域的 key 压根不存在。而 KV 确认「键不存在」的成本和命中一样
 * 要付一次往返（真机 ~50ms）：合并读等于**每次 miss 都为用不到的那一域白付一次**。
 * 改成按域惰性取数、各自独立过期，一次请求最多只读它真正要用的那一个 key。
 */
const snapStore: {
  ts: { cn: number; gl: number };
  data: { cn: any[]; gl: any[] };
} = { ts: { cn: 0, gl: 0 }, data: { cn: [], gl: [] } };

/** invalidateModelsSnapshot 目录刷新后调用，让新目录立刻可见。 */
export function invalidateModelsSnapshot(): void {
  snapStore.ts.cn = 0;
  snapStore.ts.gl = 0;
  snapStore.data.cn = [];
  snapStore.data.gl = [];
}

/**
 * modelsSnapshot 取该 realm 的模型目录（只读 KV 缓存，不触发任何上游探测）。
 * 未就绪返回空数组——调用方按「目录不可用」处理，与既有语义一致。
 */
export async function modelsSnapshot(
  env: Env,
  realm: Realm,
  opts?: { onCache?: (hit: boolean) => void },
): Promise<any[]> {
  const key = realm === "global" ? "gl" : "cn";
  const nowMs = Date.now();
  if (snapStore.ts[key] && nowMs - snapStore.ts[key] < SNAPSHOT_TTL_MS) {
    opts?.onCache?.(true);
    return snapStore.data[key];
  }
  const kv = cacheKV(env);
  // 只取当前 realm 的那一个 key：见 snapStore 的注释。
  const raw = await kvGetJSON<any[]>(kv, realm === "global" ? CACHE_KEY_MODELS_GLOBAL : CACHE_KEY_MODELS).catch(
    () => null,
  );
  snapStore.data[key] = Array.isArray(raw) ? raw : [];
  snapStore.ts[key] = nowMs;
  opts?.onCache?.(false);
  return snapStore.data[key];
}
