import type { Env } from "../../worker-configuration.d.ts";

// KV 封装：WB2A_CONFIG（配置）与 WB2A_CACHE（模型目录缓存等）。
// 注意：KV 非强一致、有最终一致窗口，仅存非敏感、可重建数据。

export async function kvGetJSON<T>(ns: KVNamespace, key: string): Promise<T | null> {
  try {
    const v = await ns.get(key, { type: "json" });
    return (v as T) ?? null;
  } catch {
    return null;
  }
}

export async function kvPutJSON(ns: KVNamespace, key: string, value: unknown, ttl?: number): Promise<void> {
  const opt: KVNamespacePutOptions = {};
  if (ttl && ttl > 0) opt.expirationTtl = ttl;
  await ns.put(key, JSON.stringify(value), opt);
}

export async function kvGetText(ns: KVNamespace, key: string): Promise<string | null> {
  return ns.get(key).catch(() => null);
}

export async function kvPutText(ns: KVNamespace, key: string, value: string, ttl?: number): Promise<void> {
  const opt: KVNamespacePutOptions = {};
  if (ttl && ttl > 0) opt.expirationTtl = ttl;
  await ns.put(key, value, opt);
}

export async function kvDelete(ns: KVNamespace, key: string): Promise<void> {
  await ns.delete(key).catch(() => {});
}

/** 模型目录缓存（带 TTL）。 */
export const CACHE_KEY_MODELS = "models:cn";
export const CACHE_KEY_MODELS_GLOBAL = "models:global";
export const CACHE_KEY_MODEL_JSON = "model.json";
export const CACHE_KEY_OUTPUT_PROBES = "output_probes.json";

export function configKV(env: Env): KVNamespace {
  return env.WB2A_CONFIG;
}
export function cacheKV(env: Env): KVNamespace {
  return env.WB2A_CACHE;
}
