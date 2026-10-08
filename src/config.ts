import type { Env } from "../worker-configuration.d.ts";

// Cloudflare workerd 运行时提供 process.env（用于 WB2A_* 变量覆盖）。
declare const process: { env: Record<string, string | undefined> };

// 替代 Go 的 config.go：加载/归一/校验配置。
// 非敏感配置整体存 KV(WB2A_CONFIG, key="config")；敏感项（api_key/device_token）
// 走 Secrets，不在此处。WB2A_* 环境变量可覆盖默认值。

export interface UpstreamConfig {
  timeout_seconds: number;
  header_timeout_seconds: number;
  idle_timeout_seconds: number;
  user_agent: string;
  client_version: string;
  cli_version: string;
  client_name: string;
  device_token: string;
  passthrough_ip: boolean;
}

export interface GlobalConfig {
  enabled: boolean;
  chat_base: string;
  billing_base: string;
}

export interface CooldownConfig {
  soft_rate: number;
  soft_rate_max: number;
}

export interface ScheduleConfig {
  checkin_hours: number[];
  travel_hours: number[];
  activity_hours: number[];
  keepalive_hours: number[];
  blackcat_hours: number[];
  growth_hours: number[];
  checkin_enabled: boolean;
  travel_enabled: boolean;
  activity_enabled: boolean;
  keepalive_enabled: boolean;
  blackcat_enabled: boolean;
  growth_enabled: boolean;
  balance_refresh_enabled: boolean;
  balance_refresh_minutes: number;
}

export interface PoolConfig {
  max_in_flight: number;
  max_in_flight_global: number;
  breaker_threshold: number;
  breaker_cooldown: number;
  breaker_cooldown_max: number;
  degrade_threshold: number;
  degrade_cooldown: number;
  degrade_cooldown_max: number;
  idle_weight_per_hour: number;
  idle_weight_max: number;
  prefer_expiring: boolean;
  expiring_soon: number;
  cost_explore_interval: number;
  credit_floor: number;
}

export interface SessionStickyConfig {
  enabled: boolean;
  ttl: number;
  gc_interval: number;
}

export interface LoggingConfig {
  request_archive_enabled: boolean;
  request_retention_days: number;
  request_archive_max_mb: number;
  request_client_info: boolean;
}

export interface Config {
  /** 调用主钥匙：给 /v1/* 下游客户端用的全权凭证。 */
  api_key: string;
  /**
   * 面板登录口令：只用于进入 /panel/，**不可用于调用 /v1/***。
   *
   * 为什么要与 api_key 分开：原先两件事共用一把（router 里 `token === cfg.api_key`
   * 既放行面板也放行接口），于是「把调用密钥交给下游」等于「把管理面板交出去」。
   * 分离之后，即使面板口令泄露，攻击者改不了配置、导不出账号，也调不动接口。
   *
   * 空串 = 尚未单独设置 → 鉴权层回退到「面板也认 api_key」，保证老部署升级后
   * 不会因为登不进去而把自己锁在门外。想真正隔离就在面板点一次「生成」。
   */
  admin_key: string;
  auth_dir: string;
  state_file: string;
  trust_proxy: boolean;
  panel_package_detail_limit: number;
  logging: LoggingConfig;
  cooldown: CooldownConfig;
  schedule: ScheduleConfig;
  global: GlobalConfig;
  upstream: UpstreamConfig;
  features: { sanitize_blacklist_fingerprints: boolean };
  /**
   * 系统提示词（对齐 Go cmd/server/config.go PromptConfig）。
   * mode 三值：passthrough（默认，透传客户端原始 system）/ custom（替换）/
   * append（开头连续 system 块后叠加）。非法值在读取时归一为 passthrough。
   */
  prompt: { mode: string; file: string; text: string };
  pool: PoolConfig;
  session_sticky: SessionStickyConfig;
  /**
   * auto 虚拟模型编排（对齐 Go cmd/server/config.go AutoModel）。
   * 注意 override / on_empty 都是 **boolean**，不是字符串或映射。
   */
  auto_model: {
    enabled: boolean;
    day_primary: string;
    night_primary: string;
    day_start: number;
    day_end: number;
    virtual_id: string;
    /** 虚拟名与上游真实模型同名时仍接管（默认让位不劫持）。 */
    override: boolean;
    fallback: string[];
    /** 200 但正文为空视为失败并降级（默认 true）。 */
    on_empty: boolean;
    fallback_on: string[];
  };
  /** 任意模型 → 降级链（有序，带 realm 前缀）；与 auto_model.fallback 叠加展开。 */
  model_fallback: Record<string, string[]>;
}

export const DEFAULT_CONFIG: Config = {
  api_key: "",
  // 默认空 → 面板回退认 api_key（老部署行为不变）。见 Config.admin_key 注释。
  admin_key: "",
  auth_dir: "auths",
  state_file: "state.json",
  trust_proxy: true,
  panel_package_detail_limit: 20,
  logging: {
    request_archive_enabled: true,
    request_retention_days: 7,
    request_archive_max_mb: 256,
    request_client_info: true,
  },
  cooldown: { soft_rate: 600, soft_rate_max: 3600 },
  schedule: {
    checkin_hours: [9, 21],
    travel_hours: [9, 21],
    activity_hours: [10],
    keepalive_hours: [22],
    blackcat_hours: [23],
    growth_hours: [1],
    checkin_enabled: true,
    travel_enabled: true,
    activity_enabled: true,
    keepalive_enabled: true,
    blackcat_enabled: false,
    growth_enabled: true,
    balance_refresh_enabled: true,
    balance_refresh_minutes: 5,
  },
  global: {
    enabled: true,
    // ⚠️ 两个 base 必须留空：运行时由 basesFor 回落 GLOBAL 常量（workbuddy.ai）。
    // 早期这里误填国内域（copilot.tencent.com / codebuddy.cn，从 CN 段复制未改），
    // 非空默认值把 basesFor 的 `cfg.global.x || GLOBAL.x` 短路——国际版账号的
    // chat/账单请求全被打到国内域，面板明明显示「国际版」却一直 401。
    // KV 中已存的旧错误值在 getConfig 里做一次性迁移清空。
    chat_base: "",
    billing_base: "",
  },
  upstream: {
    timeout_seconds: 120,
    header_timeout_seconds: 30,
    idle_timeout_seconds: 60,
    // 对齐原版 converter._KIND_UA["workbuddy"] 的真实客户端 UA 口径。
    // 原版注释明确：自造 UA（如 WorkBuddy/2.0.0 CLI/2.0.0）属「画像不自洽」，
    // 是风控网关的拒单依据之一。可用 WB2A_USER_AGENT 覆盖。
    user_agent: "CLI/5.3.14 WorkBuddy/5.3.14",
    client_version: "2.0.0",
    cli_version: "2.0.0",
    client_name: "workbuddy2api",
    device_token: "",
    passthrough_ip: false,
  },
  // 默认 true（对齐 Go Default()）：出站请求体黑名单指纹脱敏。false = 完全还原。
  features: { sanitize_blacklist_fingerprints: true },
  // 默认 passthrough（对齐 Go Default()）：透传客户端原始 system，不做网关注入。
  // file = WB2A_CACHE 里的键名（Go 是磁盘路径，Workers 无文件系统）。
  prompt: { mode: "passthrough", file: "", text: "" },
  pool: {
    max_in_flight: 2,
    max_in_flight_global: 4,
    breaker_threshold: 3,
    breaker_cooldown: 60,
    breaker_cooldown_max: 1800,
    degrade_threshold: 5,
    degrade_cooldown: 300,
    degrade_cooldown_max: 3600,
    idle_weight_per_hour: 0.1,
    idle_weight_max: 2,
    prefer_expiring: true,
    expiring_soon: 72,
    cost_explore_interval: 30,
    credit_floor: 0,
  },
  session_sticky: { enabled: true, ttl: 1800, gc_interval: 300 },
  auto_model: {
    enabled: false,
    day_primary: "",
    night_primary: "",
    day_start: 8,
    day_end: 23,
    virtual_id: "",
    override: false,
    fallback: [],
    on_empty: true,
    fallback_on: [],
  },
  model_fallback: {},
};

const KV_KEY = "config";

/** 合法 prompt.mode（对齐 Go normalizePrompt）。 */
export type PromptMode = "passthrough" | "custom" | "append";

/**
 * normalizePromptMode 校验并归一 prompt.mode。
 * 空串等同 passthrough；非法值返回 null（调用方决定报错还是回落）。
 */
export function normalizePromptMode(mode: unknown): PromptMode | null {
  const m = String(mode ?? "").trim().toLowerCase();
  if (m === "" || m === "passthrough") return "passthrough";
  if (m === "custom") return "custom";
  if (m === "append") return "append";
  return null;
}

// 每请求缓存（DO 单实例内仍是单线程，ctx 短暂，函数内复用即可）。
//
// ⚠️ 这里的实现是 **stale-while-revalidate**，不是简单的 TTL 缓存。原因见
// getConfig 的注释：配置是每请求必读的，任何一次冷 miss 都会把 ~100ms 的 KV
// 往返直接压在用户感知的首字节上。
let cache: { ts: number; cfg: Config } | null = null;
/** 后台刷新去重：陈旧窗口内的并发请求只触发一次刷新，而不是每请求一次。 */
let refreshing: Promise<void> | null = null;

/** invalidateConfig 清缓存。改配置/ 自检等需要立刻看到新值时用。 */
export function invalidateConfig(): void {
  cache = null;
}

/**
 * 绕过缓存读配置。
 *
 * 给「需要反映真实现场」的调用用——部署自检是其中之一：若自检读到缓存里的旧值
 * （例如此前刚部署、Secret 后补），会把 "key 没配" 误判成已配，反之亦然。
 * 诊断路径宁可多读一次 KV，也不接受被缓存误导。
 */
export async function getConfigFresh(env: Env): Promise<Config> {
  invalidateConfig();
  return getConfig(env);
}

// 三处 KV 读（配置 / 降级门 / 模型目录）在真机上都实测在 100ms 量级，而它们
// 全是**每请求必读**。差别在于各自有没有缓存，以及缓存的 TTL 够不够长：
//   配置   —— 原先 5s TTL：请求间隔一旦超过 5s 就重新 miss，等于每请求付一次
//   降级门 —— 原先完全没缓存：稳定 100ms，一次不落
//   模型目录 —— 60s 快照：同样会周期性 miss
// 统一策略见 getConfig 的 stale-while-revalidate 与下面两个常量。

/** CONFIG_FRESH_MS 这段时间内认为缓存是新鲜的，直接返回、零 IO。 */
const CONFIG_FRESH_MS = 30_000;
/**
 * CONFIG_STALE_MS 超过这个时长就认为数据不可信，连陈旧值都不该再返回。
 *
 * 只会出现在 isolate 长时间 idle 后又收到请求的场景（后台刷新 promise 会随
 * isolate 一起被回收，没有机会更新 ts）。留一个大窗口是为了不把它设计成
 * 「读不到配置就全站 5xx」——那种失败模式比用一份 5 分钟前的配置糟糕得多。
 */
const CONFIG_STALE_MS = 300_000;

/** loadConfig 真正读一次 KV 并做归一（唯一的实际 IO 点）。 */
async function loadConfig(env: Env): Promise<Config> {
  let stored: Partial<Config> = {};
  try {
    const raw = await env.WB2A_CONFIG.get(KV_KEY, { type: "json" });
    if (raw) stored = raw as Partial<Config>;
  } catch {
    /* KV 未配置时使用默认配置 */
  }
  const cfg: Config = mergeDeep(DEFAULT_CONFIG, stored) as Config;

  // 一次性迁移：早期 DEFAULT_CONFIG.global 误填国内域（复制 CN 段未改），且可能
  // 已随「保存配置」写进 KV——mergeDeep 下 stored 覆盖默认，只改默认值救不了
  // 已部署实例。国际版的 chat/billing 只可能是 workbuddy.ai（basesFor 里回落
  // GLOBAL 常量），这里把已知错误值清空以回落。
  const BAD_GLOBAL_BASES = ["https://copilot.tencent.com", "https://www.codebuddy.cn"];
  if (BAD_GLOBAL_BASES.includes(cfg.global.chat_base)) cfg.global.chat_base = "";
  if (BAD_GLOBAL_BASES.includes(cfg.global.billing_base)) cfg.global.billing_base = "";

  // 环境变量覆盖（敏感项也可从 Secrets 注入；Secrets 已挂在 env 上）。
  if (env.WB2A_API_KEY) cfg.api_key = env.WB2A_API_KEY;
  if (env.WB2A_ADMIN_KEY) cfg.admin_key = env.WB2A_ADMIN_KEY;
  if (env.WB2A_DEVICE_TOKEN) cfg.upstream.device_token = env.WB2A_DEVICE_TOKEN;
  // prompt.mode 归一（对齐 Go normalizePrompt）：空串等同 passthrough，非法值
  // 回落 passthrough 而非抛错——Go 是启动期 fail fast，Workers 是每请求读配置，
  // 为一个提示词字段把线上流量全打成 5xx 不划算，且原值保留便于面板回显修正。
  cfg.prompt.mode = normalizePromptMode(cfg.prompt.mode) ?? "passthrough";
  if (process.env.WB2A_SOFT_RATE) cfg.cooldown.soft_rate = Number(process.env.WB2A_SOFT_RATE);
  if (process.env.WB2A_SOFT_RATE_MAX) cfg.cooldown.soft_rate_max = Number(process.env.WB2A_SOFT_RATE_MAX);
  if (process.env.WB2A_TIMEOUT_SECONDS) cfg.upstream.timeout_seconds = Number(process.env.WB2A_TIMEOUT_SECONDS);
  if (process.env.WB2A_USER_AGENT) cfg.upstream.user_agent = process.env.WB2A_USER_AGENT;
  if (process.env.WB2A_CLIENT_VERSION) cfg.upstream.client_version = process.env.WB2A_CLIENT_VERSION;
  if (process.env.WB2A_CLI_VERSION) cfg.upstream.cli_version = process.env.WB2A_CLI_VERSION;
  if (process.env.WB2A_CLIENT_NAME) cfg.upstream.client_name = process.env.WB2A_CLIENT_NAME;
  if (process.env.WB2A_PASSTHROUGH_IP) cfg.upstream.passthrough_ip = process.env.WB2A_PASSTHROUGH_IP === "true";
  if (process.env.WB2A_EXPIRING_SOON) cfg.pool.expiring_soon = Number(process.env.WB2A_EXPIRING_SOON);
  if (process.env.WB2A_PREFER_EXPIRING) cfg.pool.prefer_expiring = process.env.WB2A_PREFER_EXPIRING === "true";

  cache = { ts: Date.now(), cfg };
  return cfg;
}

/**
 * getConfig 取网关配置（stale-while-revalidate）。
 *
 * 为什么不能用「命中就返回、过期就等 KV」的朴素 TTL：这行代码在**每个请求**的
 * 关键路径上，而且它比看起来更早——鉴权中间件里第一件事就读它。任何一次冷 miss
 * 都会把 ~100ms 的 KV 往返加在用户感知的首字节上，且这笔开销会被记到 auth 段，
 * 从外面看还以为是子密钥的 D1 查询慢了。真机数据里 auth 在 123ms 与 247ms 之间
 * 反复横跳，混进去的正是这一项。
 *
 * SWR 的行为：
 *   - 新鲜（<30s）  → 直接返回缓存，零 IO；
 *   - 陈旧（>30s）  → **立即返回旧值**，同时在后台刷新，下一个请求就拿到新的。
 *     代价是此刻的 isolate 最多慢一个请求周期的可见性；换来的是请求永不等 KV。
 *   - 无缓存        → 不得不 await（否则鉴权拿不到 api_key 会把全站打成 401）。
 *     这一跳只在 isolate 冷启动时发生一次。
 *
 * 一致性由两处兜住：面板保存配置时 saveConfig 会清缓存（改的那个 isolate 立即可
 * 见）；其余 isolate 最多滞后一个刷新周期。这对「改完配置立刻生效」完全够用。
 */
export async function getConfig(
  env: Env,
  opts?: { onCache?: (hit: boolean) => void },
): Promise<Config> {
  const nowTs = Date.now();
  if (cache) {
    if (nowTs - cache.ts < CONFIG_FRESH_MS) {
      opts?.onCache?.(true);
      return cache.cfg;
    }
    if (nowTs - cache.ts < CONFIG_STALE_MS) {
      // 后台刷新不去 await：这是本函数存在的全部意义——把 KV 往返从首字节路径上
      // 移除。refreshing 去重，避免陈旧窗口内的 N 个并发请求打出 N 次 KV 读。
      if (!refreshing) {
        refreshing = loadConfig(env)
          .then((cfg) => {
            cache = { ts: Date.now(), cfg };
          })
          .catch(() => {
            // 刷新失败就让它下次重试；旧值继续用，不因一次读失败而全站 500。
          })
          .finally(() => {
            refreshing = null;
          });
      }
      // 本请求未 await KV（旧值直接返回 + 后台刷新），视为命中。
      opts?.onCache?.(true);
      return cache.cfg;
    }
    // 超过 STALE：不敢再用，回落同步读（真·miss，付了 KV 往返）。
    const cfg = await refreshNow(env);
    opts?.onCache?.(false);
    return cfg;
  }
  // 无缓存：冷启动必经，必须 await（否则拿不到 api_key 全站 401）。
  const cfg = await refreshNow(env);
  opts?.onCache?.(false);
  return cfg;
}

/** refreshNow 同步读一次并落缓存（冷启动 / 数据过旧时的回落路径）。 */
async function refreshNow(env: Env): Promise<Config> {
  const cfg = await loadConfig(env);
  cache = { ts: Date.now(), cfg };
  return cfg;
}

/** 写回配置到 KV（POST /panel/api/config）。敏感项不在 body 里。 */
export async function saveConfig(env: Env, cfg: Partial<Config>): Promise<Config> {
  const merged = mergeDeep(DEFAULT_CONFIG, cfg) as Config;
  await env.WB2A_CONFIG.put(KV_KEY, JSON.stringify(merged));
  cache = null;
  return merged;
}

// 极简深合并（只覆盖对象/标量，数组整体替换）。
function mergeDeep(base: any, over: any): any {
  if (over === null || over === undefined) return base;
  if (typeof base !== "object" || Array.isArray(base) || typeof over !== "object" || Array.isArray(over)) {
    return over;
  }
  const out: any = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = mergeDeep(base[k], over[k]);
  }
  return out;
}
