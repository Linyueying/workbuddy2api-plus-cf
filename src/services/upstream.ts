import type { Env } from "../../worker-configuration.d.ts";
import type { Auth, Realm } from "../types";
import { getConfig } from "../config";
import { prepareBody, type EffortTables } from "./payload";
import { injectPromptCacheKey, resolveConversationID } from "./cachekey";
import {
  CODEBUDDY_CLI_UA,
  CODEBUDY_IDE_UA,
  ENTERPRISE_PROBE_PATHS,
  mergeCatalog,
  parseEnterpriseCli,
  parseV3Config,
  type CatalogEntry,
} from "./catalog";
import { cacheKV, kvGetJSON, CACHE_KEY_MODELS, CACHE_KEY_MODELS_GLOBAL } from "../storage/kv";

// 上游 HTTP 封装（替代 internal/upstream/client.go）。全部走 fetch。
// realm 感知的 base：cn = copilot.tencent.com / codebuddy.cn；global = workbuddy.ai。

const CN = {
  chat: "https://copilot.tencent.com",
  billing: "https://www.codebuddy.cn",
  web: "https://www.workbuddy.cn",
};
const GLOBAL = {
  chat: "https://www.workbuddy.ai",
  billing: "https://www.workbuddy.ai",
  web: "https://www.workbuddy.ai",
};

export interface Bases {
  chat: string;
  billing: string;
  web: string;
}

export function basesFor(realm: Realm, env: Env): Bases {
  const cfg = _cfg;
  if (realm === "global") {
    return {
      chat: cfg.global.chat_base || GLOBAL.chat,
      billing: cfg.global.billing_base || GLOBAL.billing,
      web: GLOBAL.web,
    };
  }
  return CN;
}

// 模块内配置缓存：router 在每次请求入口调用 primeConfig(env)，
// 之后本模块内同步读取即可拿到实时配置（user_agent / client_name 等）。
import { DEFAULT_CONFIG as DEFAULT_FALLBACK } from "../config";
let _cfg: any = DEFAULT_FALLBACK;
export async function primeConfig(env: Env): Promise<void> {
  _cfg = await getConfig(env);
}
export function getConfigCached(_env: Env) {
  return _cfg;
}

export function buildHeaders(auth: Auth, env: Env, extra?: Record<string, string>): Headers {
  const cfg = _cfg;
  const h = new Headers();
  h.set("Authorization", "Bearer " + auth.accessToken);
  h.set("User-Agent", cfg.upstream.user_agent);
  h.set("Content-Type", "application/json");
  h.set("Accept", "application/json, text/event-stream");
  if (auth.device_token) h.set("X-Device-Token", auth.device_token);
  if (cfg.upstream.client_name) {
    h.set("X-IDE-Name", "workbuddy2api");
    h.set("X-IDE-Client-Name", cfg.upstream.client_name);
    h.set("X-IDE-Client-Version", cfg.upstream.client_version);
    h.set("X-IDE-Version", cfg.upstream.client_version);
  }
  h.set("X-Conversation-Request-ID", crypto.randomUUID());
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

export async function withTimeout(req: Request, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(req, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---- Token 刷新（两段式，网络 I/O 在锁外）----
export async function refreshToken(env: Env, auth: Auth): Promise<Auth> {
  const base = basesFor(auth.realm, env);
  const headers = new Headers();
  headers.set("Authorization", "Bearer " + auth.accessToken);
  headers.set("Content-Type", "application/json");
  headers.set("User-Agent", getConfigCached(env).upstream.user_agent);
  const body = JSON.stringify({ refreshToken: auth.refreshToken });
  const res = await withTimeout(
    new Request(base.chat + "/v2/plugin/auth/token/refresh", { method: "POST", headers, body }),
    getConfigCached(env).upstream.timeout_seconds * 1000,
  );
  if (!res.ok) {
    throw new Error("refresh_token_failed:" + res.status);
  }
  const j = (await res.json().catch(() => ({}))) as any;
  const expiresIn = Number(j.expiresIn ?? j.expires_in ?? 3600);
  return {
    ...auth,
    accessToken: j.accessToken ?? j.access_token ?? auth.accessToken,
    refreshToken: j.refreshToken ?? j.refresh_token ?? auth.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export function needsRefresh(auth: Auth, withinMs = 10 * 60_000): boolean {
  return auth.expiresAt - Date.now() < withinMs;
}

/**
 * effortTables 该 realm 的 effort 能力表（出站 reasoning_effort 降级用）。
 * 只读本地模型目录缓存，不触发探测；缓存未就绪返回空表（payload 侧透传不降级）。
 *
 * 这里直接读 KV 而不走 resolveModel：resolveModel 依赖本模块的 fetchModels，
 * 反向 import 会成环。effort 表与模型目录同源同 TTL，读同一份缓存即可。
 */
async function effortTables(env: Env, realm: Realm): Promise<EffortTables> {
  const kv = cacheKV(env);
  const key = realm === "global" ? CACHE_KEY_MODELS_GLOBAL : CACHE_KEY_MODELS;
  const cached = await kvGetJSON<any[]>(kv, key).catch(() => null);
  const efforts: Record<string, string[]> = {};
  const defaults: Record<string, string> = {};
  for (const m of cached ?? []) {
    // 缓存里 id 带 realm 前缀，需剥掉才是裸模型名（payload 按 body.model 精确匹配）。
    const bare = String(m?.id ?? "").replace(/^(cn|global):/, "");
    if (!bare) continue;
    if (Array.isArray(m?.efforts) && m.efforts.length) efforts[bare] = m.efforts;
    if (m?.default_effort) defaults[bare] = String(m.default_effort);
  }
  return { efforts, defaults };
}

// ---- Chat 流式 ----

/**
 * chatStream 出站 chat 请求。
 *
 * body 经 payload 管线改写（prepareBody）：强制 stream、max_completion_tokens
 * 翻译、tool 归一化与配对清理、developer→system、image_url 形态、deepseek
 * thinking 开关与 effort 降级、指纹脱敏，再注入按账号隔离的 prompt_cache_key
 * （费用降 ~17×）。global 域额外套用兜底 system。
 */
export async function chatStream(
  env: Env,
  auth: Auth,
  model: string,
  body: any,
  passHeaders: Headers,
): Promise<Response> {
  const base = basesFor(auth.realm, env);
  const headers = buildHeaders(auth, env);
  // 透传会话相关头（conversation id 等），其余以网关默认为主
  for (const [k, v] of passHeaders.entries()) {
    if (k.toLowerCase().startsWith("x-conversation") || k.toLowerCase() === "x-request-id") headers.set(k, v);
  }
  const cfg = getConfigCached(env);
  const payload = prepareBody({ ...body, model }, {
    realm: auth.realm,
    sanitize: cfg.features?.sanitize_blacklist_fingerprints !== false,
    tables: await effortTables(env, auth.realm).catch(() => undefined),
    globalOn: auth.realm === "global",
  });
  // prompt_cache_key 在管线之后注入（管线不碰该字段）。
  await injectPromptCacheKey(payload, auth.uid, resolveConversationID(payload)).catch(() => {});
  const req = new Request(base.chat + "/v2/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return withTimeout(req, cfg.upstream.timeout_seconds * 1000);
}

// ---- 模型目录（两路并发合并）----

/**
 * promoActive 评估一条优惠在 now（epoch ms）是否生效：enabled + validFrom/Until 内
 * + 落在任一 daily 窗口（支持 23:00→07:50 跨午夜）。schedule 缺省视为全天生效。
 * 时间口径固定 Asia/Shanghai（上游日程的 timezone 实测恒为该时区）。
 */
function promoActive(p: any, now: number): boolean {
  if (!p?.enabled) return false;
  const d = new Date(now + 8 * 3600_000);
  const cur = d.getUTCHours() * 60 + d.getUTCMinutes();
  const sc = p.schedule;
  if (sc && typeof sc === "object") {
    if (sc.validFrom) {
      const from = Date.parse(sc.validFrom);
      if (Number.isFinite(from) && now < from) return false;
    }
    if (sc.validUntil) {
      const until = Date.parse(sc.validUntil);
      if (Number.isFinite(until) && now >= until) return false;
    }
    const daily: any[] = Array.isArray(sc.daily) ? sc.daily : [];
    if (daily.length) {
      let inWindow = false;
      for (const w of daily) {
        const st = promoClock(w?.start);
        const ed = promoClock(w?.end);
        if (st < 0 || ed < 0) continue;
        if (st <= ed ? cur >= st && cur < ed : cur >= st || cur < ed) {
          inWindow = true;
          break;
        }
      }
      if (!inWindow) return false;
    }
  }
  return true;
}

/** promoClock "23:00" → 分钟数；无法解析返回 -1。 */
function promoClock(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return -1;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59) return -1;
  return h * 60 + mi;
}

/**
 * applyModelPromotions 把当前生效的优惠挂到目录条目（同模型多条命中取 priority
 * 最高）。无 discount 对象的条目（错峰类只有时段文案）只挂标签/说明，promoFactor
 * 留 undefined——不编造机器可读折扣。
 */
function applyModelPromotions(list: any[], promos: any[], now: number): void {
  if (!promos?.length || !list.length) return;
  const idx = new Map<string, any>();
  for (const m of list) if (m?.id) idx.set(m.id, m);
  const best = new Map<string, { prio: number; p: any }>();
  for (const p of promos) {
    if (!promoActive(p, now)) continue;
    for (const id of p.modelIds ?? []) {
      if (!idx.has(id)) continue; // 目录外模型不挂
      const cur = best.get(id);
      if (!cur || (p.priority ?? 0) > cur.prio) best.set(id, { prio: p.priority ?? 0, p });
    }
  }
  for (const [id, c] of best) {
    const m = idx.get(id)!;
    if (c.p.badge?.label) m.promoLabel = c.p.badge.label;
    if (c.p.hover?.textZh) m.promoNote = c.p.hover.textZh;
    if (c.p.discount && typeof c.p.discount.factor === "number") {
      m.promoFactor = c.p.discount.factor;
      m.promoCredits = c.p.discount.discountedCredits ?? "";
    }
  }
}

/**
 * effectiveModelRate 模型当前生效倍率：有机器可读优惠取折扣价，否则牌价。
 * 返回可比较的数值字符串（"" = 未知）。这是积分保底 tier1（无本地实测）判收费的
 * 目录兜底数据源——只看实测会让「无观测」恒等于放行，高价新模型恰恰全池无观测。
 */
export function effectiveModelRate(mi: any): string {
  if (mi?.promoFactor != null && String(mi?.promoCredits ?? "").trim() !== "") {
    return normalizeModelRate(mi.promoCredits);
  }
  return normalizeModelRate(mi?.credits);
}

/** normalizeModelRate 兼容 "x0.05" / "0.50x" / "0.05 credits"；无法数值化返回去后缀原文。 */
export function normalizeModelRate(raw: string): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.toLowerCase().endsWith("credits")) s = s.slice(0, -"credits".length).trim();
  const lower = s.toLowerCase();
  if (lower.startsWith("x")) s = s.slice(1).trim();
  else if (lower.endsWith("x")) s = s.slice(0, -1).trim();
  if (!s) return "";
  const v = Number(s);
  return Number.isFinite(v) ? String(v) : String(raw).trim();
}

/**
 * probeV3 /v3/config 单路探测（UA 参数化）。
 *
 * 该端点对 UA 敏感且**不同 UA 下发不同模型集合**（见 CODEBUDDY_CLI_UA 注释），
 * global 侧据此并发两路取并集。必须带 CodeBuddy/CodeBuddyIDE 版本号，
 * 否则 400 code=12403。
 */
async function probeV3(env: Env, auth: Auth, ua: string): Promise<{ names: string[]; infos: CatalogEntry[]; promotions: any[] } | null> {
  const base = basesFor(auth.realm, env);
  const h = new Headers();
  h.set("Accept", "application/json, text/plain, */*");
  h.set("X-Requested-With", "XMLHttpRequest");
  h.set("Authorization", "Bearer " + auth.accessToken);
  if (auth.uid) h.set("X-User-Id", auth.uid);
  h.set("X-Domain", v3Domain(auth, base.chat));
  h.set("X-Product", "SaaS");
  h.set("User-Agent", ua);
  h.set("X-CodeBuddy-Request", "1");
  try {
    const res = await fetch(base.chat + "/v3/config", { headers: h });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const probe = parseV3Config(j);
    if (probe.error || !probe.table.size) return null;
    const names = [...probe.table.keys()].sort(); // map 迭代序随机，排序保输出稳定
    return { names, infos: names.map((id) => probe.table.get(id)!), promotions: probe.promotions };
  } catch {
    return null; // 网络层失败：本路降级，不拖累另一路
  }
}

/** v3Domain /v3/config 的 X-Domain 头（对齐 Go v3ConfigDomain）。 */
function v3Domain(auth: Auth, chatBase: string): string {
  const d = String(auth.domain ?? "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (d) return d;
  try {
    return new URL(chatBase).host || "copilot.tencent.com";
  } catch {
    return "copilot.tencent.com";
  }
}

/** probeEnterprise 企业端点家族单路：/v2 首选 → /console 兜底。 */
async function probeEnterprise(env: Env, auth: Auth): Promise<CatalogEntry[] | null> {
  const base = basesFor(auth.realm, env);
  for (const path of ENTERPRISE_PROBE_PATHS) {
    try {
      const h = buildHeaders({ ...auth }, env);
      const res = await fetch(base.chat + path, { headers: h });
      if (!res.ok) continue;
      const j = await res.json().catch(() => null);
      const infos = parseEnterpriseCli(j);
      if (infos.length) return infos;
    } catch {
      // 试下一个路径
    }
  }
  return null;
}

/**
 * fetchModels 探测模型目录（替代 Go FetchModels + FetchGlobalModelInfos）。
 *
 * v3-config-merge：动态目录 = /v3/config（主路，完整能力版）+ 企业端点
 * （/v2 → /console，补缺）的并集，两路**并发**探测。合并去重 key = 模型 id，
 * v3 条目字段权威（credits 等以 v3 为准），企业端点只补 v3 缺失的模型。
 * 两路独立容错：任一路失败不拖累另一路；两路全失败才返回空（**纯动态，无静态
 * 名单兜底**——假名单只会让客户端选到 11102 的模型）。
 *
 * realm 差异：global 侧 /v3/config 额外并发 CLI UA 一路（两 UA 各有独有模型），
 * CN 侧只走 IDE UA 单路。
 */
export async function fetchModels(env: Env, realm: Realm, auth?: Auth): Promise<any[]> {
  const a: Auth = auth ?? ({ ...emptyAuth(realm) } as Auth);
  const base = basesFor(realm, env);
  void base;

  const [v3IDE, v3CLI, enterprise] = await Promise.all([
    probeV3(env, a, CODEBUDY_IDE_UA),
    realm === "global" ? probeV3(env, a, CODEBUDDY_CLI_UA) : Promise.resolve(null),
    probeEnterprise(env, a),
  ]);

  // v3 两路自合并：IDE 路字段权威（响应更大、单条字段更全），CLI 路只补缺失 id。
  let v3: { names: string[]; infos: CatalogEntry[]; promotions: any[] } | null = null;
  if (v3IDE && v3CLI) {
    const merged = mergeCatalog({ names: v3IDE.names, infos: v3IDE.infos }, { names: v3CLI.names, infos: v3CLI.infos });
    v3 = { names: merged.names, infos: merged.infos ?? [], promotions: v3IDE.promotions };
  } else if (v3IDE) {
    v3 = v3IDE;
  } else if (v3CLI) {
    v3 = v3CLI;
  }

  let entries: CatalogEntry[];
  if (v3 && enterprise) {
    const merged = mergeCatalog({ names: v3.names, infos: v3.infos }, { names: enterprise.map((e) => e.id), infos: enterprise });
    entries = merged.infos ?? v3.infos;
  } else if (v3) {
    entries = v3.infos;
  } else if (enterprise) {
    entries = enterprise;
  } else {
    return []; // 两路全失败
  }

  // 限时优惠：Credits 是牌价，客户端显示的是生效价，面板据此展示两者。
  applyModelPromotions(entries as any[], v3?.promotions ?? [], Date.now());
  return entries as any[];
}

function emptyAuth(realm: Realm): Auth {
  return { accessToken: "", refreshToken: "", expiresAt: 0, domain: "", realm, uid: "", enterpriseId: "", nickname: "" };
}

// ---- 余额 / 积分 ----
export interface Credits {
  credits: number;
  creditsTotal: number;
  /** 快过期子集（expiring_soon 窗口内到期且有余额的积分，≤ credits）。 */
  expiring: number;
  /** 最早未来到期批次的到期时刻（epoch ms），0 = 无有效批次。 */
  earliestExpiry: number;
  /** 同一到期时刻所有正余额包的剩余量之和。 */
  earliestRemaining: number;
}

/** 单个积分包（面板「积分构成」用，对齐 Go CreditPackage）。 */
export interface CreditPackage {
  name: string;
  remain: number;
  used: number;
  size: number;
  end_time?: string;
  expires_at?: number;
  created_at?: string;
  package_code?: string;
  sub_product_code?: string;
  sub_product_name?: string;
  cycle?: boolean;
}

/** 上游套餐到期时间的墙钟格式（UTC+8 固定，对齐 Go softRateResetLoc）。 */
const PKG_END_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
/** 格式化 epoch ms 为 UTC+8 墙钟 "YYYY-MM-DD HH:mm:ss"。 */
function pkgEndLayout(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}
/** 解析上游套餐到期墙钟为 epoch ms；空/格式异常返回 0（UTC+8 解释）。 */
function parsePkgEnd(raw: string): number {
  const m = PKG_END_RE.exec(String(raw ?? "").trim());
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
}

/**
 * packageRemainUsed 聚合单套餐 remain/used/size（对齐 Go packageRemainUsed，
 * 单一事实来源）。CycleCapacitySize>0 走周期字段，否则回退 Capacity 字段。
 */
export function packageRemainUsed(a: any): { remain: number; used: number; size: number } {
  const cSize = Number(a?.CycleCapacitySize ?? 0);
  if (cSize > 0) {
    let remain = Number(a?.CycleCapacityRemain ?? 0);
    const size = cSize;
    if (remain < 0) remain = 0;
    if (remain > size) remain = size;
    let used = size - remain;
    const cUsed = Number(a?.CycleCapacityUsed ?? 0);
    if (cUsed > used) {
      used = cUsed;
      if (size >= used) remain = size - used;
    }
    return { remain, used, size };
  }
  const size = Number(a?.CapacitySize ?? 0);
  let remain = Number(a?.CapacityRemain ?? 0);
  if (remain < 0) remain = 0;
  let used = Number(a?.CapacityUsed ?? 0);
  if (used === 0 && size > remain) used = size - remain;
  return { remain, used, size };
}

/** get-user-resource / daily-checkin 的路径候选：global 先无 /v2 再有，cn 单路径。 */
export function billingMeterPaths(realm: Realm): string[] {
  return realm === "global"
    ? ["/billing/meter/get-user-resource", "/v2/billing/meter/get-user-resource"]
    : ["/v2/billing/meter/get-user-resource"];
}
export function checkinMeterPaths(realm: Realm): string[] {
  return realm === "global"
    ? ["/billing/meter/daily-checkin", "/v2/billing/meter/daily-checkin"]
    : ["/v2/billing/meter/daily-checkin"];
}

/** 余额查询请求体（上游按此过滤有效积分包，对齐 Go）。 */
export function resourceBody(now: number): string {
  return JSON.stringify({
    PageNumber: 1,
    PageSize: 100,
    ProductCode: "p_tcaca",
    Status: [0, 3],
    PackageEndTimeRangeBegin: pkgEndLayout(now),
    PackageEndTimeRangeEnd: pkgEndLayout(now + 365 * 101 * 24 * 3600_000),
  });
}

/** 从信封里取 data.Response.Data.Accounts（doJSON 已解一层 code/data）。 */
export function resourceAccounts(j: any): any[] {
  return j?.data?.Response?.Data?.Accounts ?? j?.Response?.Data?.Accounts ?? [];
}

/** resourceTotalDosage 取上游声明的总消耗量（TotalDosage），缺省 0。 */
export function resourceTotalDosage(j: any): number {
  return Number(j?.data?.Response?.Data?.TotalDosage ?? j?.Response?.Data?.TotalDosage ?? 0);
}

/** isAlreadyCheckin 判定「今日已签到」（上游返回 code 14001）。 */
export function isAlreadyCheckin(j: any): boolean {
  const code = Number(j?.code ?? 0);
  const msg = String(j?.msg ?? "");
  return code === 14001 || /已签到|already\s*check/i.test(msg);
}

/**
 * getCreditsDetailed 查余额聚合（对齐 Go UserResourceDetailedWithExpiry）。
 * soonMs > 0 时把「到期时间落在窗口内」的余额计入 expiring（优先消耗，
 * 避免赠送积分到期作废）；同时返回最早未来到期批次供最早到期优先路由。
 * soonMs ≤ 0 时 expiring 恒 0（禁用该路由门槛）。
 */
export async function getCreditsDetailed(env: Env, auth: Auth, soonMs: number): Promise<Credits> {
  const base = basesFor(auth.realm, env);
  const now = Date.now();
  const timeout = getConfigCached(env).upstream.timeout_seconds * 1000;
  let env_: any = null;
  const paths = billingMeterPaths(auth.realm);
  for (const p of paths) {
    const res = await withTimeout(
      new Request(base.billing + p, { method: "POST", headers: buildHeaders(auth, env), body: resourceBody(now) }),
      timeout,
    );
    // 仅 404 换路径（路径不存在才值得 fallback），其他错误直接返回空聚合。
    if (res.status === 404 && p !== paths[paths.length - 1]) continue;
    env_ = await res.json().catch(() => ({}));
    break;
  }
  let remain = 0;
  let total = 0;
  let expiring = 0;
  let earliestExpiry = 0;
  let earliestRemaining = 0;
  for (const acct of resourceAccounts(env_)) {
    const r = packageRemainUsed(acct);
    const size = Math.max(r.size, r.remain);
    remain += r.remain;
    total += size;
    if (r.remain <= 0) continue;
    const end = parsePkgEnd(acct?.CycleEndTime ?? "");
    if (!end || end <= now) continue;
    if (!earliestExpiry || end < earliestExpiry) {
      earliestExpiry = end;
      earliestRemaining = r.remain;
    } else if (end === earliestExpiry) {
      earliestRemaining += r.remain;
    }
    if (soonMs > 0 && end <= now + soonMs) expiring += r.remain;
  }
  return { credits: remain, creditsTotal: total, expiring, earliestExpiry, earliestRemaining };
}

/** getCredits 只要聚合余额（面板展示用；soon=0 不做快过期分桶）。 */
export async function getCredits(env: Env, auth: Auth): Promise<Credits> {
  return getCreditsDetailed(env, auth, 0);
}

/**
 * creditPackages 逐包构成（面板「积分构成」用，对齐 Go CreditPackages）。
 * remain/size 为各包求和；按面额降序。
 */
export async function creditPackages(env: Env, auth: Auth): Promise<CreditPackage[]> {
  const base = basesFor(auth.realm, env);
  const now = Date.now();
  const timeout = getConfigCached(env).upstream.timeout_seconds * 1000;
  let env_: any = null;
  const paths = billingMeterPaths(auth.realm);
  for (const p of paths) {
    const res = await withTimeout(
      new Request(base.billing + p, { method: "POST", headers: buildHeaders(auth, env), body: resourceBody(now) }),
      timeout,
    );
    if (res.status === 404 && p !== paths[paths.length - 1]) continue;
    env_ = await res.json().catch(() => ({}));
    break;
  }
  const out: CreditPackage[] = [];
  for (const p of resourceAccounts(env_)) {
    const r = packageRemainUsed(p);
    const raw = String(p?.ExpiredTime ?? "") || String(p?.PackageEndTime ?? "") || String(p?.CycleEndTime ?? "");
    const cp: CreditPackage = {
      name: String(p?.PackageName ?? ""),
      remain: r.remain,
      used: r.used,
      size: r.size,
      package_code: String(p?.PackageCode ?? ""),
      sub_product_code: String(p?.SubProductCode ?? ""),
      sub_product_name: String(p?.SubProductName ?? ""),
      cycle: Number(p?.CycleCapacitySize ?? 0) > 0,
    };
    if (raw) {
      cp.end_time = raw;
      const end = parsePkgEnd(raw);
      if (end) cp.expires_at = end;
    }
    const ct = Number(p?.CreateTime ?? 0);
    if (ct > 0) cp.created_at = new Date(ct).toISOString();
    out.push(cp);
  }
  return out.sort((a, b) => b.size - a.size);
}

// ---- 签到 ----
export async function dailyCheckin(env: Env, auth: Auth): Promise<{ done: boolean; message?: string; already: boolean }> {
  const base = basesFor(auth.realm, env);
  const timeout = getConfigCached(env).upstream.timeout_seconds * 1000;
  const paths = checkinMeterPaths(auth.realm);
  for (const p of paths) {
    const res = await withTimeout(
      new Request(base.billing + p, { method: "POST", headers: buildHeaders(auth, env), body: "{}" }),
      timeout,
    );
    if (res.status === 404 && p !== paths[paths.length - 1]) continue;
    const j = (await res.json().catch(() => ({}))) as any;
    const already = isAlreadyCheckin(j);
    return { done: res.ok || already, already, message: j?.msg };
  }
  return { done: false, already: false, message: "checkin unreachable" };
}

// ============================================================================
// 通用 JSON 信封底座（替代 client.go 的 doJSON / growthJSON / billingJSON /
// growthJSONMP / BillingHeaders）。任务、报告、桌面/小程序事件的公共底座。
// ============================================================================

/** UpstreamError 上游错误（对齐 Go *Error：kind + status + msg）。 */
export class UpstreamError extends Error {
  constructor(public kind: string, public status: number, msg: string) {
    super(msg);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/** classifyStatus 粗分类（复用 classify.ts 的逻辑避免循环依赖则内联最小版）。 */
function kindFor(status: number, body: string): string {
  if (status === 429) return "soft_rate";
  if (status === 402) return "hard_credit";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  return "none";
}

/**
 * doJSON 发请求并解 {code,msg,data} 信封。
 * HTTP 非 2xx或业务 code != 0 → 抛 UpstreamError（kind/status/msg）。
 */
export async function doJSON(req: Request, timeoutMs?: number): Promise<any> {
  const cfg = _cfg;
  const ms = timeoutMs ?? cfg.upstream.timeout_seconds * 1000;
  const res = await withTimeout(req, ms);
  const raw = await res.text();
  if (!res.ok) {
    throw new UpstreamError(kindFor(res.status, raw), res.status, truncate(raw, 200));
  }
  let env: any;
  try {
    env = JSON.parse(raw);
  } catch {
    throw new Error(`parse failed (body: ${truncate(raw, 120)})`);
  }
  if (env && typeof env === "object" && "code" in env && env.code !== 0) {
    let kind = kindFor(res.status, String(env.msg ?? ""));
    if (kind === "none") kind = "client";
    throw new UpstreamError(kind, res.status, `code=${env.code} msg=${truncate(String(env.msg ?? ""), 160)}`);
  }
  return env?.data;
}

/** BillingHeaders growth/billing 域请求头（对齐 headers.go BillingHeaders）。 */
export function billingHeaders(auth: Auth, env: Env, extra?: Record<string, string>): Headers {
  const cfg = _cfg;
  const h = new Headers();
  h.set("Authorization", "Bearer " + auth.accessToken);
  h.set("Accept", "application/json");
  h.set("Content-Type", "application/json");
  h.set("User-Agent", cfg.upstream.user_agent);
  h.set("Accept-Language", auth.realm === "global" ? "en-US,en;q=0.9" : "zh-CN,zh;q=0.9");
  if (auth.uid) h.set("X-User-Id", auth.uid);
  if (auth.enterpriseId) {
    h.set("X-Enterprise-Id", auth.enterpriseId);
    h.set("X-Tenant-Id", auth.enterpriseId);
  }
  if (auth.domain) h.set("X-Domain", auth.domain);
  const dt = auth.device_token || cfg.upstream.device_token;
  if (dt) h.set("X-Device-Token", dt);
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

/** growthJSON growth 域（chatBase，无 /v2 前缀）请求+ 解信封。 */
export function growthJSON(auth: Auth, env: Env, method: string, path: string, body?: any): Promise<any> {
  const base = basesFor(auth.realm, env);
  const h = billingHeaders(auth, env);
  return doJSON(new Request(base.chat + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
}

/** mpPlatform 小程序口径头值（小程序限定任务全链路要求）。 */
export const MP_PLATFORM = "miniprogram";

/** growthJSONMP growth 域请求 + 叠加 X-Client-Platform: miniprogram。 */
export function growthJSONMP(auth: Auth, env: Env, method: string, path: string, body?: any): Promise<any> {
  const base = basesFor(auth.realm, env);
  const h = billingHeaders(auth, env, { "X-Client-Platform": MP_PLATFORM });
  return doJSON(new Request(base.chat + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
}

/** billingJSON billing 域（billingBase）请求 + 解信封。 */
export function billingJSON(auth: Auth, env: Env, method: string, path: string, body?: any): Promise<any> {
  const base = basesFor(auth.realm, env);
  const h = billingHeaders(auth, env);
  return doJSON(new Request(base.billing + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
}

// ---- 桌面 / 小程序 / web 指纹上报底座 ----

/** desktopUA 桌面客户端 UA（实测 5.5.6 内嵌 CLI 2.137.1）。 */
export const DESKTOP_UA = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1";

/** webUA web 端（浏览器）UA 形态。 */
export const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/** deriveID 由 uid 稳定派生 36 位 hex 设备标识（模拟固定设备，幂等）。 */
export function deriveID(auth: Auth, salt: string): string {
  // 同步稳定派生（事件指纹用，不能异步）。用 FNV 风格混合保证确定性即可——
  // 与Go sha256 目的相同（稳定、不可由外部预测），事件指纹不做安全用途。
  const s = salt + ":" + auth.uid;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  let out = "";
  let a = h1, b = h2;
  for (let i = 0; i < 4; i++) {
    a = Math.imul(a ^ (a >>> 13), 0x5bd1e995) >>> 0;
    out += (a & 0xff).toString(16).padStart(2, "0");
  }
  for (let i = 0; i < 4; i++) {
    b = Math.imul(b ^ (b >>> 11), 0x27d4eb2f) >>> 0;
    out += (b & 0xff).toString(16).padStart(2, "0");
  }
  return out.slice(0, 36);
}

export function desktopFingerprint(auth: Auth): Record<string, any> {
  const now = Date.now();
  return {
    timezone: "Asia/Shanghai",
    reportDelay: 2000,
    userId: auth.uid,
    username: auth.nickname,
    userNickname: auth.nickname,
    product: "SaaS",
    releaseDate: 1789036585355,
    commit: "5f9692923c93033111c51ad7b003eb80204a9b75",
    ideName: "WorkBuddy",
    ideType: "WorkBuddy",
    ideVersion: "5.5.6",
    machineId: deriveID(auth, "machine"),
    sessionId: deriveID(auth, "session"),
    extName: "workbuddy-desktop",
    extVersion: "5.5.6",
    os: "win32",
    arch: "x64",
    osVersion: "10.0.26220",
    cpuCores: 20,
    memorySize: 24,
    timestamp: now,
    presentAt: now,
  };
}

/** mpEventBase 小程序埋点公共指纹。 */
export function mpEventBase(auth: Auth): Record<string, any> {
  return {
    timestamp: Date.now(),
    ideType: "WorkBuddy_MP",
    ideVersion: "2.4.0",
    extName: "workbuddy-mp",
    extVersion: "2.4.0",
    product: "SaaS",
    ideName: "wx_app_cloud",
    platform: "mini_program",
    os: "windows",
    osVersion: "11",
    arch: "x64",
    machineId: "0655736a-607f-4d9d-b430-58176ee9a090",
    timezone: "Asia/Shanghai",
    userId: auth.uid,
    userNickname: auth.nickname,
  };
}

// ---- OAuth 设备流 ----
/**
 * LOGIN_CLIENT_UA 设备授权流专用 UA（对齐 Go clientUA）。
 * 不能用配置里的 user_agent：上游 auth/state 按 CLI 客户端指纹放行。
 */
export const LOGIN_CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";

/**
 * loginOrigin 按 realm 返回设备授权的Origin/Referer 基础域。
 * cn → codebuddy.cn；global → www.workbuddy.ai（与 base 同域）。
 * 上游校验 Origin，缺头会 400。
 */
export function loginOrigin(realm: Realm): string {
  return realm === "global" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn";
}

/** loginHeaders 设备授权三端点的公共头（对齐 Go commonHeaders）。 */
export function loginHeaders(realm: Realm): Headers {
  const origin = loginOrigin(realm);
  const h = new Headers();
  h.set("Content-Type", "application/json");
  h.set("Accept", "application/json, text/plain, */*");
  h.set("X-Requested-With", "XMLHttpRequest");
  h.set("Origin", origin);
  h.set("Referer", origin + "/");
  h.set("User-Agent", LOGIN_CLIENT_UA);
  return h;
}

/**
 * loginDoJSON 发一次设备授权 JSON 请求并解 {code,msg,data} 信封。
 * HTTP ≥300 或业务 code != 0 → 抛 UpstreamError（对齐 Go doJSON）。
 *
 * 关键：必须显式检查这两个错误位。早前实现只解信封不管状态码，上游 400 被
 * 吞成空 state，调用方看到的是"没拿到 state"——与"网络失败"完全无法区分，
 * 排查时只能干瞪眼。
 */
async function loginDoJSON(
  realm: Realm,
  method: string,
  path: string,
  body?: string,
): Promise<{ data: any; status: number }> {
  const cfg = _cfg;
  const full = loginBaseFor(realm) + path;
  const res = await withTimeout(
    new Request(full, { method, headers: loginHeaders(realm), body }),
    cfg.upstream.timeout_seconds * 1000,
  );
  const raw = await res.text();
  if (res.status >= 300) {
    throw new UpstreamError(kindFor(res.status, raw), res.status, `http_error: upstream ${res.status}`);
  }
  let env: any;
  try {
    env = JSON.parse(raw);
  } catch {
    throw new Error(`parse failed (body: ${truncate(raw, 120)})`);
  }
  if (env && typeof env === "object" && "code" in env && env.code !== 0) {
    throw new UpstreamError("client", res.status, `code=${env.code} msg=${truncate(String(env.msg ?? ""), 160)}`);
  }
  return { data: env?.data, status: res.status };
}

/** loginBaseFor 设备授权的 chat base（无配置覆盖，与 Go loginEndpoints 同口径）。 */
function loginBaseFor(realm: Realm): string {
  return realm === "global" ? "https://www.workbuddy.ai" : "https://copilot.tencent.com";
}

/**
 * oauthState 发起设备授权：POST /v2/plugin/auth/state?platform=CLI 拿 state + authUrl。
 * state 由上游服务端签发（无 PKCE）。
 */
export async function oauthState(env: Env, realm: Realm): Promise<{ state: string; authUrl: string }> {
  const r = await loginDoJSON(realm, "POST", "/v2/plugin/auth/state?platform=CLI", "{}");
  const d = r.data ?? {};
  return { state: String(d.state ?? ""), authUrl: String(d.authUrl ?? "") };
}

/**
 * oauthToken 轮询授权结果（GET auth/token?state=）。
 *
 * 未完成时上游返回业务 code != 0（「login ing」），此时**不抛错**、返回空对象，
 * 由pollLogin 判 pending —— 否则「浏览器还没点完」与「授权被拒」无法区分，
 * 每 3s 轮询会不断抛错刷日志。
 * 成功时返回解信封后的 data（accessToken/refreshToken/expiresIn）。
 */
export async function oauthToken(env: Env, realm: Realm, state: string): Promise<any> {
  const base = loginBaseFor(realm);
  const res = await withTimeout(
    new Request(base + "/v2/plugin/auth/token?state=" + encodeURIComponent(state), {
      headers: loginHeaders(realm),
    }),
    getConfigCached(env).upstream.timeout_seconds * 1000,
  );
  const j: any = await res.json().catch(() => ({}));
  // code != 0 = pending / 业务拒绝，两种都不是"拿到 token"。
  if (Number(j?.code ?? 0) !== 0) return {};
  return j?.data ?? {};
}

/**
 * oauthAccount 取授权账号的 uid/nickname（带 Bearer）。
 * 这步是可选信息（拿不到也能落池，只是昵称退化成 uid），故失败返回空对象。
 */
export async function oauthAccount(env: Env, realm: Realm, state: string, accessToken = ""): Promise<any> {
  const base = loginBaseFor(realm);
  const h = loginHeaders(realm);
  if (accessToken) h.set("Authorization", `Bearer ${accessToken}`);
  const res = await withTimeout(
    new Request(base + "/v2/plugin/login/account?state=" + encodeURIComponent(state), { headers: h }),
    getConfigCached(env).upstream.timeout_seconds * 1000,
  );
  const j: any = await res.json().catch(() => ({}));
  if (Number(j?.code ?? 0) !== 0) return {};
  return j?.data ?? {};
}
