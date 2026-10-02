import type { Env } from "../../worker-configuration.d.ts";
import type { Realm } from "../types";
import { kvGetJSON, kvPutJSON, cacheKV } from "../storage/kv";
import { effectiveModelRate } from "./upstream";

// 模型积分倍率快照（替代 internal/upstream/client.go 的 modelRates + ModelRate）。
//
// 用途：积分保底的**目录兜底判据**——某 (账号,模型) 无本地实测台账（tier 1）时，
// 用上游随模型目录下发的牌价/优惠价判「该模型是否收费」。倍率由目录刷新时一并
// 落 KV（TTL 与模型目录一致），请求前即已知，不必为判收费去付一次探测学费。
//
// 为什么不放在 pool 里直接调 fetchModels：pool 位于 Durable Object 单实例内，
// 一次目录刷新要打两个上游端点；倍率是「可重建的非敏感数据」，放 KV 由
// 目录刷新路径（listModels）顺带更新，pool 只读快照即可。

const KEY_CN = "model_rates:cn";
const KEY_GLOBAL = "model_rates:global";
/** 快照 TTL（秒）。与模型目录缓存同量级：目录变了倍率随之变。 */
const TTL = 600;

/** 从模型目录条目抽取 { modelId: 生效倍率 }（跳过空/未知倍率）。 */
export function extractRates(models: any[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of models ?? []) {
    const id = typeof m?.id === "string" ? m.id : "";
    if (!id) continue;
    const rate = effectiveModelRate(m);
    if (rate) out[id] = rate;
  }
  return out;
}

/** 目录刷新后更新倍率快照（listModels 命中上游时调用）。 */
export async function storeModelRates(env: Env, realm: Realm, models: any[]): Promise<void> {
  await kvPutJSON(cacheKV(env), realm === "global" ? KEY_GLOBAL : KEY_CN, extractRates(models), TTL).catch(() => {});
}

/** 读某域倍率快照（无快照返回空表，不触发上游请求）。 */
export async function loadModelRates(env: Env, realm: Realm): Promise<Record<string, string>> {
  const t = await kvGetJSON<Record<string, string>>(cacheKV(env), realm === "global" ? KEY_GLOBAL : KEY_CN).catch(() => null);
  return t ?? {};
}

/**
 * RateLookup 返回 pool-core 需要的 `modelRateOf(realm, model) => string` 查表。
 * 两域合并读一次（KV 极快，未命中返回空串 = 未知 → 保守放行）。
 */
export async function rateLookup(env: Env): Promise<(realm: string, model: string) => string> {
  const [cn, gl] = await Promise.all([loadModelRates(env, "cn"), loadModelRates(env, "global")]);
  return (realm: string, model: string) => (realm === "global" ? gl[model] : cn[model]) ?? "";
}
