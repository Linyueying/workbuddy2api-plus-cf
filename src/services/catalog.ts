import type { Realm } from "../types";

// 上游模型目录的**纯解析层**（替代 internal/upstream/global_models.go 的解析部分 +
// client.go 的 fetchV3ConfigModelMap / fetchEnterpriseModels 解析段）。
//
// 刻意不碰网络：探测 IO 在 upstream.ts，本模块只做「bytes → 目录」。好处是
// 目录形态多变（多信封 / 窄表 / 换键名）都能纯函数单测，不必起 fetch mock。
//
// 两条探测路的分工（对齐 Go）：
//   - /v3/config：主路。带 CodeBuddy UA 才返回完整能力版（supportedEfforts、
//     393216 窗口）；对 UA 敏感——IDE UA 与 CLI UA 下发**不同模型集合**，
//     global 侧两路并发取并集。
//   - 企业端点家族（/v2 → /console）：补 v3 缺失的 id（如 gpt-5.3-codex 只在 /v2 下发）。

/** CODEBUDY_IDE_UA /v3/config 要求的官方 IDE UA。
 *  换成 CLI 三段式会拿到**精简目录**（flash 输出 128K、无 supportedEfforts）。
 *  版本号需随上游 IDE 发版跟进：过旧时该端点可能同样返回精简目录。 */
export const CODEBUDY_IDE_UA = "CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0";

/** CODEBUDDY_CLI_UA CLI 三段式 UA。实测该端点对不同 UA 下发不同模型集合：
 *  IDE UA → 14 条（含 o4-mini / enhance-1.0 / auto-chat，**无 deepseek 系列**）；
 *  CLI UA → 22 条（含 deepseek-v4.1-flash / gpt-6-astra / kimi-…，但无上述三者）。
 *  两路各有独有模型，缺一不可。仅用于 global 侧第二路探测，CN 侧单路 IDE。 */
export const CODEBUDDY_CLI_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

/** 企业模型目录端点候选序列（按 realm 切 base，路径"家族"）。
 *  /v2 首选（实测 200 含完整模型表），/console 兜底（同域旧路径，或 500）。 */
export const ENTERPRISE_PROBE_PATHS = ["/v2/enterprises/personal/models", "/console/enterprises/personal/models"];

/**
 * nonChatModel 判定是否非对话模型（应从目录剔除）。三类规则：
 *   - id 前缀 nes- / completion- / codewise-：嵌入/补全/代码专用，选了报 11102；
 *   - maxOutputTokens ≤ 256：tiny 输出非对话模型；
 *   - tags 含 text-to-image：图片生成模型，非本网关用途。
 */
export function nonChatModel(id: string, maxOutputTokens: number, tags: string[]): boolean {
  const k = String(id ?? "").trim().toLowerCase();
  for (const p of ["nes-", "completion-", "codewise-"]) if (k.startsWith(p)) return true;
  if (maxOutputTokens > 0 && maxOutputTokens <= 256) return true;
  for (const t of tags ?? []) if (t === "text-to-image") return true;
  return false;
}

/** 标准目录条目（对齐 Go ModelInfo）。id 恒为裸模型名（无 realm 前缀）。 */
export interface CatalogEntry {
  id: string;
  name?: string;
  context_window: number;
  max_tokens: number;
  max_allowed_size: number;
  description: string;
  credits: string;
  tags: string[];
  vendor: string;
  is_default: boolean;
  supports_reasoning: boolean;
  supports_tool_call: boolean;
  only_reasoning: boolean;
  supports_images: boolean;
  can_disable_thinking: boolean;
  reasoning_summary: string;
  efforts: string[];
  default_effort: string;
  [k: string]: unknown;
}

/** dynEntryOf 从上游原始条目解析标准字段（对齐 Go dynModelEntry.modelInfo）。
 *  defaultEffort 新老双键：reasoning.defaultEffort 优先，缺省回落 reasoning.effort。 */
export function dynEntryOf(m: any, fallbackId = ""): CatalogEntry {
  const r = m?.reasoning ?? {};
  const id = String(m?.id ?? m?.modelId ?? m?.model ?? m?.name ?? fallbackId ?? "").trim();
  const tags = Array.isArray(m?.tags) ? m.tags.map((t: any) => String(t)) : [];
  return {
    ...m,
    id,
    name: String(m?.name ?? ""),
    context_window: Number(m?.maxInputTokens ?? 0),
    max_tokens: Number(m?.maxOutputTokens ?? 0),
    max_allowed_size: Number(m?.maxAllowedSize ?? 0),
    description: String(m?.descriptionZh ?? m?.description ?? ""),
    credits: String(m?.credits ?? ""),
    tags,
    vendor: String(m?.vendor ?? ""),
    is_default: !!m?.isDefault,
    supports_reasoning: !!m?.supportsReasoning,
    supports_tool_call: !!m?.supportsToolCall,
    only_reasoning: !!m?.onlyReasoning,
    supports_images: !!m?.supportsImages,
    can_disable_thinking: !!r?.canDisableThinking,
    reasoning_summary: String(r?.summary ?? ""),
    efforts: Array.isArray(r?.supportedEfforts) ? r.supportedEfforts.map((e: any) => String(e).trim()).filter(Boolean) : [],
    default_effort: String(r?.defaultEffort || r?.effort || "").trim(),
  };
}

/** 目录探测结果：names（有序、去重）+ infos（窄表形态为 null）+ effort 能力桶。 */
export interface CatalogProbe {
  names: string[];
  infos: CatalogEntry[] | null;
  efforts: Record<string, string[]>;
  defaults: Record<string, string>;
}

function emptyProbe(): CatalogProbe {
  return { names: [], infos: null, efforts: {}, defaults: {} };
}

function fail(): CatalogProbe & { error: string } {
  return { ...emptyProbe(), error: "empty" };
}

/** isRecord 是否是普通对象（非数组、非 null）。 */
function isRecord(v: any): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * resolveCatalogArray 从 payload 定位模型数组：本身是数组直接用；是对象则依次尝试
 * models / items / list / data / result 键（递归下钻，取第一个解析出数组的分支）。
 * 覆盖 data.models / data.items / data.list / 顶层 models 等变体。
 */
export function resolveCatalogArray(payload: any): any[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return null;
  for (const key of ["models", "items", "list", "data", "result"]) {
    if (!(key in payload)) continue;
    const got = resolveCatalogArray(payload[key]);
    if (got) return got;
  }
  return null;
}

/** envelopePayload 剥信封：code 存在且非 0 → 拒（无 code 字段放行，兼容无信封直出）；
 *  payload = data（非空非 null 时）否则整包。 */
function envelopePayload(raw: any): any | null {
  if (!isRecord(raw)) return null;
  if ("code" in raw) {
    const code = Number(raw.code);
    if (Number.isFinite(code) && code !== 0) return null;
  }
  if ("data" in raw) {
    const d = raw.data;
    if (d !== null && d !== undefined && !(typeof d === "string" && d.trim() === "")) return d;
  }
  return raw;
}

/**
 * parseCatalog 多信封兼容解析模型目录（对齐 Go parseGlobalModelNames）。
 * 三形态依次尝试：
 *   1. 对象数组 → dynEntryOf 全字段（与 CN 目录同构，零口径漂移）：id 回退链
 *      id→modelId→model→name，disabled 剔除；
 *   2. 窄表字符串数组 → 仅 ID，元数据留空（infos 为 null，窗口由调用方兜底链处理）；
 *   3. 动态兜底 → 逐对象宽松解析（上游换键名时不至于整域空列表）。
 * 解析成功但名单为空 → 报错（等价「该端点没给全」）。
 */
export function parseCatalog(raw: any): CatalogProbe & { error?: string } {
  const payload = envelopePayload(raw);
  if (payload === null) return fail();
  const arr = resolveCatalogArray(payload);
  if (!arr) return fail();

  // 形态 1：对象数组
  const names: string[] = [];
  const infos: CatalogEntry[] = [];
  const efforts: Record<string, string[]> = {};
  const defaults: Record<string, string> = {};
  let allObjects = arr.length > 0;
  for (const m of arr) {
    if (!isRecord(m)) {
      allObjects = false;
      continue;
    }
    if (m.disabled === true) continue;
    const e = dynEntryOf(m);
    if (!e.id) {
      allObjects = false;
      continue;
    }
    names.push(e.id);
    infos.push(e);
    if (e.efforts.length) efforts[e.id] = e.efforts;
    if (e.default_effort) defaults[e.id] = e.default_effort;
  }
  if (allObjects && names.length) return { names, infos, efforts, defaults };

  // 形态 2：窄表字符串数组（混合数组里的裸 ID 也走这里）
  const strs = arr.filter((v: any) => typeof v === "string");
  if (strs.length === arr.length) {
    const out = strs.map((s: string) => s.trim()).filter(Boolean);
    return out.length ? { names: out, infos: null, efforts: {}, defaults: {} } : fail();
  }

  // 形态 3：动态兜底（逐对象宽松解析）
  const looseNames: string[] = [];
  const looseInfos: CatalogEntry[] = [];
  const lEfforts: Record<string, string[]> = {};
  const lDefaults: Record<string, string> = {};
  for (const item of arr) {
    if (typeof item === "string") {
      const id = item.trim();
      if (!id) continue;
      looseNames.push(id);
      looseInfos.push(dynEntryOf({}, id));
      continue;
    }
    if (!isRecord(item)) continue;
    const e = parseLooseEntry(item);
    if (!e) continue;
    looseNames.push(e.id);
    looseInfos.push(e);
    if (e.efforts.length) lEfforts[e.id] = e.efforts;
    if (e.default_effort) lDefaults[e.id] = e.default_effort;
  }
  return looseNames.length ? { names: looseNames, infos: looseInfos, efforts: lEfforts, defaults: lDefaults } : fail();
}

/**
 * parseLooseEntry 单模型对象的宽松解析（多信封兜底路径，对齐 Go parseGlobalModelLoose）：
 * id 依次回退 id/modelId/model/name；窗口键回退 maxInputTokens/contextWindow、
 * 上限键回退 maxOutputTokens/maxTokens；reasoning 档位 defaultEffort 新键优先、
 * effort 老键兜底。disabled 剔除。**credits 恒不解析**（倍率不进 global 路径）。
 */
export function parseLooseEntry(obj: Record<string, any>): CatalogEntry | null {
  const str = (k: string) => String(obj[k] ?? "").trim();
  let id = str("id");
  for (const k of ["modelId", "model", "name"]) {
    if (id) break;
    id = str(k);
  }
  if (!id) return null;
  if (obj.disabled === true) return null;
  const num = (...keys: string[]) => {
    for (const k of keys) {
      const n = Number(obj[k]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };
  const r = isRecord(obj.reasoning) ? obj.reasoning : {};
  return {
    ...obj,
    id,
    name: str("name"),
    context_window: num("maxInputTokens", "contextWindow"),
    max_tokens: num("maxOutputTokens", "maxTokens"),
    max_allowed_size: num("maxAllowedSize"),
    description: str("descriptionZh") || str("description"),
    credits: "",
    tags: Array.isArray(obj.tags) ? obj.tags.map((t: any) => String(t)) : [],
    vendor: str("vendor"),
    is_default: !!obj.isDefault,
    supports_reasoning: !!obj.supportsReasoning,
    supports_tool_call: !!obj.supportsToolCall,
    only_reasoning: !!obj.onlyReasoning,
    supports_images: !!obj.supportsImages,
    can_disable_thinking: !!r.canDisableThinking,
    reasoning_summary: String(r.summary ?? ""),
    efforts: Array.isArray(r.supportedEfforts) ? r.supportedEfforts.map((e: any) => String(e).trim()).filter(Boolean) : [],
    default_effort: String(r.defaultEffort || r.effort || "").trim(),
  };
}

/**
 * mergeCatalog 两路合并（primary 为主，secondary 只补 primary 缺失的 id）：
 * names 按 id 去重（primary 原序在前，secondary 补充项在其原序后追加——稳定输出，
 * 不依赖 map 迭代序）；infos 同步合并。窄表形态（secondary infos 为 null）时
 * 保持 null——无对象字段不编造。
 */
export function mergeCatalog(
  primary: { names: string[]; infos: CatalogEntry[] | null },
  secondary: { names: string[]; infos: CatalogEntry[] | null },
): { names: string[]; infos: CatalogEntry[] | null } {
  if (!secondary.names.length) return { names: primary.names, infos: primary.infos };
  const seen = new Set<string>();
  const names: string[] = [];
  for (const id of primary.names) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    names.push(id);
  }
  let infos: CatalogEntry[] | null = primary.infos ? [...primary.infos] : null;
  for (const id of secondary.names) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    names.push(id);
    if (!infos) continue; // 窄表：不编造字段
    const hit = (secondary.infos ?? []).find((e) => e.id === id);
    if (hit) infos.push(hit);
  }
  return { names, infos };
}

/** mergeEffortBuckets 合并两路 effort 桶：主路权威，副路只补主路缺失的模型档位。 */
export function mergeEffortBuckets(primary: Record<string, string[]>, secondary: Record<string, string[]>): Record<string, string[]> {
  if (!Object.keys(secondary).length) return primary;
  const out = { ...primary };
  for (const [id, v] of Object.entries(secondary)) if (!(id in out)) out[id] = v;
  return out;
}

/** mergeEffortDefaults 合并两路 defaultEffort：主路权威，副路只补缺失。 */
export function mergeEffortDefaults(primary: Record<string, string>, secondary: Record<string, string>): Record<string, string> {
  if (!Object.keys(secondary).length) return primary;
  const out = { ...primary };
  for (const [id, v] of Object.entries(secondary)) if (!(id in out)) out[id] = v;
  return out;
}

/**
 * parseEnterpriseCli 企业端点解析（对齐 Go fetchEnterpriseModels）：
 * 取 agents[name=cli].models 的 id 名单，按 data.models 建字段表，
 * nonChatModel + disabled 双重过滤。
 *
 * 与 parseCatalog 的区别：企业端点**必须**按 agents[cli] 过滤（cli 面之外的
 * 模型客户端选不到），而不是全量下发。
 */
export function parseEnterpriseCli(raw: any): CatalogEntry[] {
  const payload = envelopePayload(raw);
  if (!isRecord(payload)) return [];
  const all = Array.isArray(payload.models) ? payload.models : [];
  const agents = Array.isArray(payload.agents) ? payload.agents : [];
  const cli = agents.find((a: any) => String(a?.name ?? "") === "cli");
  const cliIds: string[] = Array.isArray(cli?.models) ? cli.models.map((x: any) => String(x)) : [];
  if (!cliIds.length) return [];
  const table = new Map<string, any>();
  for (const m of all) {
    if (!isRecord(m)) continue;
    const id = String(m.id ?? m.modelId ?? m.model ?? m.name ?? "").trim();
    if (!id) continue;
    if (nonChatModel(id, Number(m.maxOutputTokens ?? 0), Array.isArray(m.tags) ? m.tags.map((t: any) => String(t)) : [])) continue;
    table.set(id, m);
  }
  const out: CatalogEntry[] = [];
  for (const id of cliIds) {
    const m = table.get(id);
    if (!m || m.disabled === true) continue;
    out.push(dynEntryOf(m, id));
  }
  return out;
}

/** V3Probe /v3/config 单路探测的解析结果。 */
export interface V3Probe {
  /** 按模型 id 建的条目表（已并入试用横幅模型、已剔除非对话条目）。 */
  table: Map<string, CatalogEntry>;
  /** 限时优惠原始数组（交由调用方挂到目录上）。 */
  promotions: any[];
  error?: string;
}

/**
 * parseV3Config /v3/config 响应解析（对齐 Go fetchV3ConfigModelMap 的解析段）：
 *   - code 非 0 → 报错；
 *   - data.models 建表，剔除非对话条目；
 *   - 补入 productFeaturesConfig.ModelTrialBanner 的试用模型：能力字段从
 *     targetModelId 继承（试用版与转正目标同族），但 **credits 与 tags 显式清空**
 *     ——它们描述的是「转正后」的计费与营销信息，用在免费试用版上会误导下游展示；
 *   - 透出 modelPromotions。
 */
export function parseV3Config(raw: any): V3Probe {
  if (!isRecord(raw)) return { table: new Map(), promotions: [], error: "not an object" };
  const code = Number(raw.code ?? 0);
  if (Number.isFinite(code) && code !== 0) return { table: new Map(), promotions: [], error: `code=${raw.code}` };
  const data = isRecord(raw.data) ? raw.data : {};
  const table = new Map<string, CatalogEntry>();
  for (const m of Array.isArray(data.models) ? data.models : []) {
    if (!isRecord(m)) continue;
    const e = dynEntryOf(m);
    if (!e.id) continue;
    if (nonChatModel(e.id, e.max_tokens, e.tags)) continue;
    table.set(e.id, e);
  }
  // 试用横幅模型：上游把「N 天免费试用」的模型只放在这里，data.models 里没有
  // （实测 global 侧 hy4-preview-f 即如此，但该模型实际可调用）。
  const banners = data.productFeaturesConfig?.ModelTrialBanner?.banners;
  for (const b of Array.isArray(banners) ? banners : []) {
    const id = String(b?.modelId ?? "").trim();
    if (!id || table.has(id)) continue;
    const tgt = String(b?.targetModelId ?? "").trim();
    let e: CatalogEntry = tgt && table.has(tgt) ? { ...table.get(tgt)!, id } : { ...dynEntryOf({}), id };
    e.credits = "";
    e.tags = [];
    table.set(id, e);
  }
  if (!table.size) return { table, promotions: [], error: "empty models" };
  const promotions = Array.isArray(data.modelPromotions) ? data.modelPromotions : Array.isArray(raw.modelPromotions) ? raw.modelPromotions : [];
  return { table, promotions };
}

/**
 * extractEfforts 从条目列表抽 effort 能力桶（supportedEfforts 数组优先；缺数组但
 * defaultEffort 单档非空也入 defaults 桶）并顺带返回有序 names。
 */
export function extractEfforts(infos: CatalogEntry[] | null): CatalogProbe {
  const names: string[] = [];
  const efforts: Record<string, string[]> = {};
  const defaults: Record<string, string> = {};
  const out: CatalogEntry[] = [];
  for (const mi of infos ?? []) {
    if (!mi.id) continue;
    names.push(mi.id);
    out.push(mi);
    if (mi.efforts.length) efforts[mi.id] = mi.efforts;
    if (mi.default_effort) defaults[mi.id] = mi.default_effort;
  }
  return { names, infos: out, efforts, defaults };
}

/**
 * realmPrefix 目录条目加 realm 前缀（/v1/models 输出用；缓存里也存带前缀的 id，
 * effort 查表侧按裸名匹配——见 upstream.effortTables）。
 */
export function realmPrefix(realm: Realm, id: string): string {
  return (realm === "global" ? "global:" : "cn:") + id;
}
