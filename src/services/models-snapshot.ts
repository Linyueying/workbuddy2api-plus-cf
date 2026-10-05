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

let snap: { ts: number; cn: any[]; gl: any[] } | null = null;

/** invalidateModelsSnapshot 目录刷新后调用，让新目录立刻可见。 */
export function invalidateModelsSnapshot(): void {
  snap = null;
}

/**
 * modelsSnapshot 取该 realm 的模型目录（只读 KV 缓存，不触发任何上游探测）。
 * 未就绪返回空数组——调用方按「目录不可用」处理，与既有语义一致。
 */
export async function modelsSnapshot(env: Env, realm: Realm): Promise<any[]> {
  if (snap && Date.now() - snap.ts < SNAPSHOT_TTL_MS) {
    return realm === "global" ? snap.gl : snap.cn;
  }
  const kv = cacheKV(env);
  // 两域一起读：一次请求通常只用一个域，但两域共享同一个 isolate，
  // 合并成一次 Promise.all 比两次各自 miss 更省（miss 时才付这 2 次读）。
  const [cn, gl] = await Promise.all([
    kvGetJSON<any[]>(kv, CACHE_KEY_MODELS).catch(() => null),
    kvGetJSON<any[]>(kv, CACHE_KEY_MODELS_GLOBAL).catch(() => null),
  ]);
  snap = { ts: Date.now(), cn: Array.isArray(cn) ? cn : [], gl: Array.isArray(gl) ? gl : [] };
  return realm === "global" ? snap.gl : snap.cn;
}
