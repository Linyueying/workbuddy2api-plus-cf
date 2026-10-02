import type { Env } from "../worker-configuration.d.ts";

// Cloudflare workerd 运行时提供 process.env（用于 WB2A_* 变量覆盖）。
declare const process: { env: Record<string, string | undefined> };

// 替代 Go 的 config.go：加载/归一/校验配置。
// 非敏感配置整体存 KV(WB2A_CONFIG, key="config")；敏感项（api_key/device_token/upstash）
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
  api_key: string;
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
  upstash: { url: string; token: string };
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
    chat_base: "https://copilot.tencent.com",
    billing_base: "https://www.codebuddy.cn",
  },
  upstream: {
    timeout_seconds: 120,
    header_timeout_seconds: 30,
    idle_timeout_seconds: 60,
    user_agent: "WorkBuddy/2.0.0 CLI/2.0.0",
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
  upstash: { url: "", token: "" },
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
let cache: { ts: number; cfg: Config } | null = null;

/** invalidateConfig 清缓存。改配置/ 自检等需要立刻看到新值时用。 */
export function invalidateConfig(): void {
  cache = null;
}

/**
 * 绕过缓存读配置。
 *
 * 给「需要反映真实现场」的调用用——部署自检是其中之一：若自检读到 5s 内的旧
 * 缓存（例如此前刚部署、Secret 后补），会把 "key 没配" 误判成已配，反之亦然。
 * 诊断路径宁可多读一次 KV，也不接受被缓存误导。
 */
export async function getConfigFresh(env: Env): Promise<Config> {
  invalidateConfig();
  return getConfig(env);
}

/** 从 KV 读取配置并合并默认值与 WB2A_* 环境变量覆盖。 */
export async function getConfig(env: Env): Promise<Config> {
  if (cache && Date.now() - cache.ts < 5000) return cache.cfg;
  let stored: Partial<Config> = {};
  try {
    const raw = await env.WB2A_CONFIG.get(KV_KEY, { type: "json" });
    if (raw) stored = raw as Partial<Config>;
  } catch {
    /* KV 未配置时使用默认配置 */
  }
  const cfg: Config = mergeDeep(DEFAULT_CONFIG, stored) as Config;

  // 环境变量覆盖（敏感项也可从 Secrets 注入；Secrets 已挂在 env 上）。
  if (env.WB2A_API_KEY) cfg.api_key = env.WB2A_API_KEY;
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
