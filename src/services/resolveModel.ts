import type { Env } from "../../worker-configuration.d.ts";
import type { Realm } from "../types";
import { fetchModels } from "./upstream";
import { poolRPC } from "../durable/account-pool";
import { storeModelRates } from "./rates";
import { effortListing } from "./efforts";
import { cacheKV, kvDelete, kvGetJSON, kvPutJSON, CACHE_KEY_MODELS, CACHE_KEY_MODELS_GLOBAL } from "../storage/kv";
import { invalidateModelsSnapshot, modelsSnapshot } from "./models-snapshot";
import { realmPrefix } from "./catalog";

// 模型目录解析（替代 internal/upstream/models.go + server/resolve_model.go）。
// realm 前缀 cn:/global:；目录刷新时顺带更新积分倍率快照（积分保底的目录兜底）
// 与 effort 能力表（出站 reasoning_effort 降级的数据源）。

export function stripRealm(model: string): { realm: Realm; model: string } {
  if (model.startsWith("global:")) return { realm: "global", model: model.slice("global:".length) };
  if (model.startsWith("cn:")) return { realm: "cn", model: model.slice("cn:".length) };
  return { realm: "cn", model };
}

/**
 * modelInfo 从上游目录条目解析标准字段（对齐 Go dynModelEntry.modelInfo）。
 * defaultEffort 新老双键兼容：reasoning.defaultEffort 优先，缺省回落 reasoning.effort。
 */
export function modelInfo(m: any): any {
  const r = m?.reasoning ?? {};
  return {
    ...m,
    context_window: Number(m?.maxInputTokens ?? 0),
    max_tokens: Number(m?.maxOutputTokens ?? 0),
    description: String(m?.descriptionZh ?? m?.description ?? ""),
    credits: String(m?.credits ?? ""),
    tags: Array.isArray(m?.tags) ? m.tags : [],
    vendor: String(m?.vendor ?? ""),
    is_default: !!m?.isDefault,
    supports_reasoning: !!m?.supportsReasoning,
    supports_tool_call: !!m?.supportsToolCall,
    only_reasoning: !!m?.onlyReasoning,
    supports_images: !!m?.supportsImages,
    max_allowed_size: Number(m?.maxAllowedSize ?? 0),
    can_disable_thinking: !!r?.canDisableThinking,
    reasoning_summary: String(r?.summary ?? ""),
    efforts: Array.isArray(r?.supportedEfforts) ? r.supportedEfforts : [],
    default_effort: String(r?.defaultEffort || r?.effort || ""),
  };
}

/**
 * decorateModels 补全 effort 能力（对齐 Go EffortListing 三级查找）：
 * 远端 supportedEfforts 优先，否则落产品级静态兜底表；皆无则不输出 effort 字段
 * （omitted，不是空数组）。defaultEffort 仅在命中 efforts 时才宣称。
 */
export function decorateModels(realm: Realm, raw: any[]): any[] {
  return raw.map((m: any) => {
    const mi = modelInfo(m);
    const id = String(mi.id ?? mi.name ?? "");
    const listing = effortListing(realm, id, mi.efforts, mi.default_effort);
    if (!listing) {
      delete mi.efforts;
      delete mi.default_effort;
      return mi;
    }
    mi.efforts = listing.efforts;
    if (listing.defaultEffort) mi.default_effort = listing.defaultEffort;
    else delete mi.default_effort;
    return mi;
  });
}

/** 目录成功缓存 TTL（秒）。对齐 Go globalModelsTTL = 1h。 */
const MODELS_TTL = 3600;
/** 探测失败负缓存 TTL（秒）。对齐 Go globalModelsFailCooldown = 5min：
 *  拉不出目录即意味着该域上游不可用，短时间内反复打上游只会放大故障。 */
const MODELS_FAIL_TTL = 300;

function failKey(realm: Realm): string {
  return `models_fail:${realm}`;
}

/**
 * probeAuthFor 目录探测用的账号凭证。
 *
 * /v3/config 必须带真实 Bearer（空 token 直接 400 code=12403），所以从账号池
 * 取一个该 realm 的账号。**只借 token，不占在途名额**（探测不是业务请求）。
 * 池不可用或该 realm 无账号 → null，探测降级为匿名（企业端点家族仍可能可读）。
 */
async function probeAuthFor(env: Env, realm: Realm): Promise<any | null> {
  try {
    const list = await poolRPC(env, "/internal/list").catch(() => null);
    if (!Array.isArray(list)) return null;
    const hit = list.find((a: any) => a?.auth?.realm === realm && a?.auth?.accessToken);
    return hit?.auth ?? null;
  } catch {
    return null;
  }
}

/**
 * listModels 该 realm 的模型目录（带成功缓存 + 失败负缓存）。
 *
 * 探测一律走 fetchModels（v3-config-merge 双路并发），结果按 realm 加前缀后落
 * KV：/v1/models 直接透出，effort 查表与倍率快照都从这份缓存读（同源同 TTL）。
 *
 * 负缓存语义：两路探测全失败时写一个短 TTL 标记，期间直接返回空目录而不再
 * 打上游——纯动态无静态兜底，返回空即「该域暂不可用」，比反复探测更省也更稳。
 */
export async function listModels(env: Env, realm: Realm, auth?: any): Promise<any[]> {
  const key = realm === "global" ? CACHE_KEY_MODELS_GLOBAL : CACHE_KEY_MODELS;
  const kv = cacheKV(env);
  const cached = await kvGetJSON<any[]>(kv, key).catch(() => null);
  if (cached && Array.isArray(cached) && cached.length) return cached;
  // 负缓存命中：直接按「无目录」处理，零上游调用。
  if (await kvGetJSON<number>(kv, failKey(realm)).catch(() => null)) return [];

  const probeAuth = auth ?? (await probeAuthFor(env, realm));
  const raw = await fetchModels(env, realm, probeAuth ?? undefined).catch(() => [] as any[]);
  if (!raw.length) {
    await kvPutJSON(kv, failKey(realm), Date.now(), MODELS_FAIL_TTL).catch(() => {});
    return [];
  }
  const ids = decorateModels(realm, raw).map((m: any) => ({ ...m, id: realmPrefix(realm, m.id ?? m.name) }));
  await kvPutJSON(kv, key, ids, MODELS_TTL);
  // 进程内快照同步失效：realModelExists / effortTables 立刻看到新目录，
  // 不用等 60s 的快照 TTL。
  invalidateModelsSnapshot();
  // 探测成功 → 清负缓存标记。
  await kvDelete(kv, failKey(realm)).catch(() => {});
  // 倍率快照按裸模型名存（pool 侧按 (realm, 裸名) 查）。
  await storeModelRates(env, realm, raw).catch(() => {});
  return ids;
}

/**
 * realModelExists 该模型名是否在上游真实模型表里（只读本地缓存，不触发探测）。
 * 用途：虚拟模型名与上游同名时的让位判定（override=true 才接管），
 * 对齐 server.realModelExists。
 */
export async function realModelExists(env: Env, name: string): Promise<boolean> {
  const { realm, model } = stripRealm(name);
  if (!model) return false;
  // 走进程内快照：本函数每请求都被 proxy 调用一次，而这个 key 同请求里
  // upstream.effortTables 还要再读一遍。见 services/models-snapshot.ts。
  const cached = await modelsSnapshot(env, realm);
  if (!cached?.length) return false;
  return cached.some((m: any) => m?.id === (realm === "global" ? "global:" : "cn:") + model);
}

/** /v1/models 仅返回该子密钥白名单内的模型；管理员返回全部。 */
export async function modelsForApi(env: Env, realm: Realm, allowed?: string[]): Promise<any[]> {
  const all = await listModels(env, realm);
  if (!allowed || allowed.length === 0) return all;
  return all.filter((m) => allowed.includes(m.id));
}