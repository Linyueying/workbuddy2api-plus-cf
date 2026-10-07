import type { Hono } from "hono";
import type { Env } from "../../worker-configuration.d.ts";
import { getConfig, saveConfig } from "../config";
import { poolRPC } from "../durable/account-pool";
import {
  healthy as coreHealthy,
  inFlightFull as coreInFlightFull,
  type PickCfg,
} from "../durable/pool-core";
import { listModels } from "../services/resolveModel";
import {
  queryRequestLogs,
  requestLogStats,
  truncateRequestLogs,
  usageByAccountWindow,
  type AccountUsageAgg,
  listKeys,
  getKey,
  insertKey,
  patchKey,
  deleteKey,
  purgeLegacyKeys,
  maxKeySeq,
  quotaUsage,
  run,
} from "../storage/d1";
import { getUsage } from "../storage/usage";
// 子密钥内存缓存的失效钩子：管理面每改一次密钥行都必须调它。
// 否则「停用 / 改配额 / 清零用量 / 轮换」会被隔离内存里的旧行挡住最长 30s
// ——其中轮换尤其严重：旧明文在缓存有效期内仍能通过鉴权，等于轮换没有立即生效。
import { invalidateKeyCache, PREFIX } from "../services/apikeys";
import { kvGetJSON, CACHE_KEY_OUTPUT_PROBES, cacheKV } from "../storage/kv";
import { forEachAccount, runCreditReport, runTrialBatch, prettyReport } from "../services/tasks";
import { creditPackages, getCredits } from "../services/upstream";
import {
  signinOne,
  renderSigninTable,
  summarizeSignin,
  type SigninOutcome,
} from "../services/checkin";
import { normRealm } from "../services/apikeys";
import { BUILD_COMMIT } from "../generated/build-info";
import type { ApiKeyRow, Auth } from "../types";
import type { CtxVars } from "../types";

const VERSION = "1.0.0-pages";
const STARTED_AT = Date.now();

/** outcome 的中文口径（与前端 reqOutcomeTag 的标签一致；「错误/失败」会被
 *  前端 loadLogs 的关键词规则染成红色级别，映射时不要改成不含关键词的词）。 */
const OUTCOME_CN: Record<string, string> = {
  success: "成功",
  http_error: "HTTP 错误",
  stream_error: "流错误",
  interrupted: "中断",
};

/**
 * requestLogLine 把一条 request_logs 行拼成日志正文。
 *
 * cf 版没有 Go 版的进程内日志环，/panel/api/logs 的条目全部来自 request_logs，
 * 这里负责把它压成一行人能读的文本：结果 · 模型 · 账号 · 状态 · 耗时 · token · 积分。
 * uid 截前 8 位（面板场景够定位，又不至于把窄屏一行占满）。
 */
export function requestLogLine(e: {
  outcome?: string; model?: string | null; uid?: string | null; status?: string | number | null;
  ms?: number | null; prompt_tokens?: number | null; completion_tokens?: number | null; credits?: number | null;
}): string {
  const parts: string[] = [OUTCOME_CN[String(e.outcome || "")] || String(e.outcome || "请求")];
  if (e.model) parts.push(String(e.model));
  if (e.uid) parts.push("uid=" + String(e.uid).slice(0, 8));
  if (e.status) parts.push("HTTP " + e.status);
  const ms = Number(e.ms || 0);
  if (ms > 0) parts.push(ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms");
  const tok = Number(e.prompt_tokens || 0) + Number(e.completion_tokens || 0);
  if (tok > 0) parts.push(tok >= 1000 ? (tok / 1000).toFixed(1) + "k tok" : tok + " tok");
  const cr = Number(e.credits || 0);
  if (cr > 0) parts.push("积分 " + cr.toFixed(2));
  return parts.join(" · ");
}

/**
 * 账号池「成功/失败」「用量」列的数据源：request_logs 窗口聚合（口径与用量页一致）。
 *
 * 此前这两个数据从 DO 的运行时计数（successCount/errTotal）出，与用量页（D1 权威
 * 账本）对不上号；token_usage 在 AccountState 里根本没有数据源。统一改为 D1 聚合。
 *
 * 前端在账号池视图下每 5s 轮询一次 overview，聚合结果做 60s 模块级缓存——
 * D1 扫描量只随时间增长（每分钟一次），不随轮询放大。
 */
const ACCT_USAGE_TTL_MS = 60_000;
const ACCT_USAGE_HOURS = 24; // 与用量页缺省窗口一致
let acctUsageCache: { at: number; byUid: Map<string, AccountUsageAgg> } | null = null;

/**
 * 用量页结果的进程内缓存。
 *
 * 为什么必须有：/panel/api/usage 是本项目**最贵的一笔账**。`queryUsageWindow`
 * 扫 [from,to] 窗口内的全部日志行（上限 5 万），而 D1 免费额度按**扫描行数**计
 * （500 万行/天）——不是返回行数。前端 60s 轮询一次，一天 1440 次刷新 × 窗口行数；
 * 保留 7 天、日均 1 万请求时就是 1440 万行/天，额度三天见底，而且症状是"某天开始
 * 用量页集体 500"，很难联想到是刷新太勤。
 *
 * 为什么 TTL 是 5 分钟而不是 60s：缓存 TTL 必须与轮询间隔**错开**才有意义。
 * TTL 60s 配 60s 轮询等于每次都 miss（边界抖动下几乎必然 miss），缓存白加。
 * 5 分钟 → 每 5 次刷新才扫一次 D1，扫描量降到 1/5。
 *
 * 缓存键按分钟取整：前端默认传滚动窗口（from/to 由 Date.now() 现算），
 * 每次刷新的毫秒值都不同，不取整的话键永不命中。
 */
const USAGE_TTL_MS = 300_000;
let usageCache: { key: string; at: number; body: unknown } | null = null;

/** resetUsageCache 仅供测试：用量页缓存是模块级状态，跨用例会互相污染。 */
export function resetUsageCache(): void {
  usageCache = null;
}

async function accountUsageByUid(env: Env, hours = ACCT_USAGE_HOURS): Promise<Map<string, AccountUsageAgg>> {
  if (acctUsageCache && Date.now() - acctUsageCache.at < ACCT_USAGE_TTL_MS) return acctUsageCache.byUid;
  const to = Date.now();
  const rows = await usageByAccountWindow(env, to - hours * 3600_000, to).catch(() => []);
  const byUid = new Map<string, AccountUsageAgg>(rows.map((r) => [r.uid, r]));
  acctUsageCache = { at: Date.now(), byUid };
  return byUid;
}

function genKey(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return "sk-" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * keyPrefix 取明文前 12 字符做展示掩码（对齐 Go apikeys 里 `plain[:12]`）。
 *
 * 12 这个长度是刻意选的：够露出 `sk-` + 足够区分同一账号下的多把钥匙，
 * 又不足以让人拿它去猜剩下的 48 位。
 */
function keyPrefix(plain: string): string {
  return String(plain ?? "").slice(0, 12);
}
/**
 * genAdminKey 生成面板登录口令：`sk-` + base64url(18 字节随机)。
 *
 * 格式刻意对齐 Go cmd/server/config.go 的 WriteDefault（`"sk-" + base64.RawURLEncoding(18B)`）。
 *
 * 与子密钥（genKey）同样是 `sk-` 开头，但两者字符集不同、且靠**路径**分流：
 * 面板口令只在 /panel/* 被认，子密钥只在 /v1/* 被认，同一请求不会走两条分支。
 * 面板口令用作 /v1 调用会被当作子密钥去查 D1、查不到即 401 —— 结论一致。
 */
function genAdminKey(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  // btoa → 标准 base64，再换成 Go RawURLEncoding 的 URL 安全字符集（去 padding）。
  return "sk-" + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** numOr 取有限数值，缺省/非法回落 def。配额字段的零值语义是「不限」，故负数也压到 0。 */
function numOr(v: unknown, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return def;
  return n;
}

/**
 * validateKeyInput 子密钥入参校验。
 *
 * 只拒「语义上不可能」的值（负数配额、非字符串名字段、数组字段塞了非数组），
 * 其余一律宽容归一——管理面板是自家人在用，为一个手滑的空字符串打回整次
 * 保存只会逼人改用 API。partial=true 时只校验出现的字段（PATCH 语义）。
 */
function validateKeyInput(body: any, partial = false): string | null {
  if (body.quota !== undefined && Number(body.quota) < 0) return "invalid_quota";
  if (body.quota_credit !== undefined && (!Number.isFinite(Number(body.quota_credit)) || Number(body.quota_credit) < 0)) {
    return "invalid_quota_credit";
  }
  if (body.max_ips !== undefined && Number(body.max_ips) < 0) return "invalid_max_ips";
  if (!partial && body.name !== undefined && typeof body.name !== "string") return "invalid_name";
  for (const f of ["models", "ip_allowlist"]) {
    if (body[f] !== undefined && !Array.isArray(body[f])) return `invalid_${f}`;
  }
  return null;
}

export function registerPanel(app: Hono<{ Bindings: Env; Variables: CtxVars }>) {
  // 概览
  app.get("/panel/api/overview", async (c) => {
    const cfg = await getConfig(c.env);
    const now = Date.now();
    // 单次 RPC 取回账号列表 + sticky（原本 status 与 list 是两次 DO 请求）。
    // 概览统计项在 Worker 侧用 pool-core 的同一份纯函数算出，口径与 DO 内 status() 一致。
    const pool = (await poolRPC(c.env, "/internal/list?stats=1").catch(() => null)) as any;
    const accounts = (pool?.accounts ?? []) as any[];
    const pcfg: PickCfg = {
      idle_weight_per_hour: cfg.pool.idle_weight_per_hour,
      idle_weight_max: cfg.pool.idle_weight_max,
      prefer_expiring: cfg.pool.prefer_expiring,
      expiring_soon: cfg.pool.expiring_soon,
      credit_floor: cfg.pool.credit_floor,
      cost_explore_interval: cfg.pool.cost_explore_interval,
      max_in_flight: cfg.pool.max_in_flight,
      max_in_flight_global: cfg.pool.max_in_flight_global,
    };
    let healthyN = 0, coolingN = 0, disabledN = 0, inFlightFullN = 0;
    for (const a of accounts) {
      // 与 DO status() 同口径：disabled 优先，其次 healthy，其余计 cooling。
      if (a.status === "disabled") disabledN++;
      else if (coreHealthy(a, now)) healthyN++;
      else coolingN++;
      if (coreInFlightFull(a, pcfg)) inFlightFullN++;
    }
    // 成功/失败与用量列：D1 窗口聚合（与用量页同口径、同缺省窗口 24h）。
    const usageByUid = await accountUsageByUid(c.env);
    // commit 号：Pages 部署环境带 CF_PAGES_COMMIT_SHA（部署时的真实提交），
    // 本地/测试回落到构建时生成的 BUILD_COMMIT。
    const pagesSha = (c.env as unknown as Record<string, string | undefined>).CF_PAGES_COMMIT_SHA;
    return c.json({
      version: VERSION,
      commit: (pagesSha || BUILD_COMMIT || "").slice(0, 7),
      uptime_sec: Math.floor((now - STARTED_AT) / 1000),
      auth_required: true,
      redis_mode: false,
      sticky_sessions: Number(pool?.sticky_sessions ?? 0) || 0,
      total: accounts.length,
      healthy: healthyN,
      cooling: coolingN,
      disabled: disabledN,
      in_flight_full: inFlightFullN,
      usage_window_hours: ACCT_USAGE_HOURS,
      // 序列化对齐前端（Go 版）契约：前端 renderAccounts/renderPackages/groupItems
      // 读的是 snake_case 字段名，且需要 success_count/err_total/last_success/
      // breaker_until/degrade_until/cool_remaining_sec/cool_kind/disabled/reason/
      // checkin_done/model_costs 等运行时字段——后端此前只映射了 7 个基础字段，
      // 导致账号池整列空白（行能画、但成功/失败/用量/状态标签全空）。
      accounts: (accounts ?? []).map((a) => {
        // 聚合行口径与 usage-agg.ts 一致：requests 含失败；均值延迟在展示层折算
        // （总耗时/请求数），避免逐行平均的辛普森悖论。
        //
        // 速率的分子**只能是 completion**：prompt 是输入、不参与吐字，把它算进来
        // 会让长上下文账号的速率放大一个数量级（与 usage-agg.ts 同一处修复，
        // 对齐 Go 的 TokensPerSecond = completion*1000/latencyMs）。
        const u = usageByUid.get(String(a.uid));
        const requests = Number(u?.requests ?? 0) || 0;
        const errors = Math.min(Number(u?.errors ?? 0) || 0, requests);
        const msSum = Number(u?.ms_sum ?? 0) || 0;
        const totalTokens = Number(u?.total_tokens ?? 0) || 0;
        const completionTokens = Number(u?.completion_tokens ?? 0) || 0;
        return {
          uid: a.uid,
          nickname: a.nickname,
          realm: a.realm,
          status: a.status,
          disabled: a.status === "disabled",
          reason: a.disabledReason ?? "",
          credits: a.credits ?? 0,
          credits_total: a.creditsTotal ?? 0,
          in_flight: a.inFlight ?? 0,
          success_count: requests - errors,
          err_total: errors,
          last_success: a.lastSuccess ? new Date(a.lastSuccess).toISOString() : "",
          breaker_until: a.breakerUntil ? new Date(a.breakerUntil).toISOString() : "",
          degrade_until: a.degradeUntil ? new Date(a.degradeUntil).toISOString() : "",
          cool_remaining_sec: a.cooldownUntil > now ? Math.max(0, Math.floor((a.cooldownUntil - now) / 1000)) : 0,
          cool_kind: a.cooldownKind ?? "",
          checkin_done: a.checkinDone ?? false,
          rate_limited_models: [],
          model_costs: Object.entries(a.modelCost ?? {}).map(([model, c]) => ({
            model,
            cost_per_1k: (c as { costPer1k?: number })?.costPer1k ?? 0,
          })),
          token_usage: {
            request_count: requests,
            total_tokens: totalTokens,
            last_latency_ms: requests > 0 ? msSum / requests : 0,
            // 吐字速率 = completion / 窗口总耗时。不是 total_tokens——那会把输入
            // token 算成吐字（详见上方注释与 usage-agg.ts 的同类修复）。
            last_tokens_per_second: msSum > 0 ? completionTokens / (msSum / 1000) : 0,
          },
        };
      }),
    });
  });

  // 日志环形缓冲（读 D1 最近 entries）。
  // 字段口径必须与 Go 版面板一致：{ ts, ch, text }，ch ∈ chat/task/sys——
  // 前端 vendor 的 loadLogs 按 e.ch 筛频道、e.text 渲染正文并按关键词着色。
  // 之前返回 { channel, msg }，前端全部渲染成 "undefined"（真机截图实锤）。
  app.get("/panel/api/logs", async (c) => {
    const entries = await queryRequestLogs(c.env, { limit: 200 }).catch(() => []);
    return c.json({ entries: entries.map((e) => ({ ts: e.ts, ch: e.channel || "sys", text: requestLogLine(e) })) });
  });

  // 请求记录概要（运行日志页顶部「已完成 / 成功 / HTTP / 平均 / 进行中」）。
  //
  // 早先这里是个写死的 `{ requests: 0 }` 桩——于是真机上概要条永远是「已完成 0 /
  // 成功 —」，且前端只在 metrics.archive.enabled 为真时才用 request_logs 的真实数据，
  // 这个开关 CF 端从不置位，导致整张请求记录表恒空。这里改为对 D1 做一次轻量
  // COUNT/SUM/AVG（不拉明细，D1 按扫描行计费，概要约=一条聚合 SQL），窗口与右侧
  // 时间范围一致。in_flight 来自账号池 DO（在途占用的账号数），拉不到就记 0。
  app.get("/panel/api/request_metrics", async (c) => {
    const q = c.req.query();
    // 「全部历史」预设（preset=0）前端什么参数都不发；这种情形要统计整张表，
    // 不能退化成「近 24h」——否则概要条与下方请求记录表区间不一致。
    const hasRange = !!(q.from || q.to || q.hours);
    const toMs = q.to ? Number(q.to) * 1000 : Date.now();
    const fromMs = q.from
      ? Number(q.from) * 1000
      : toMs - (Number(q.hours) || 24) * 3600_000;
    const m = await requestLogStats(
      c.env,
      hasRange ? { from: fromMs, to: toMs } : {},
    ).catch(() => null);
    let inFlight = 0;
    try {
      const list = (await poolRPC(c.env, "/internal/list").catch(() => [])) as any[];
      for (const a of list || []) inFlight += Number(a?.inFlight ?? a?.in_flight ?? 0);
    } catch {
      /* 账号池不可达不阻断概要 */
    }
    return c.json({
      ...(m || { completed: 0, success_rate: null, http_success_rate: null, avg_duration_ms: 0 }),
      in_flight: inFlight,
      // d1=true 告诉前端「日志落 D1，没有 JSONL 归档」——前端据此改文案、并
      // 始终用 request_logs 的真实明细当表格数据源（见 loadLogs 的 recent 取值）。
      d1: true,
      archive: { enabled: false },
    });
  });

  app.get("/panel/api/request_logs", async (c) => {
    const q = c.req.query();
    const rows = await queryRequestLogs(c.env, {
      limit: Number(q.limit) || 200,
      outcome: q.outcome,
      account: q.account,
      model: q.model,
      client_ip: q.client_ip,
      user_agent: q.user_agent,
      from: q.from ? Number(q.from) * 1000 : undefined,
      to: q.to ? Number(q.to) * 1000 : undefined,
    }).catch(() => []);
    // ⚠️ 字段名归一：前端 renderRequestTable 消费的是 Go 版口径
    // （time / duration_ms / account / request_id / credit_known …），而 D1 列名是
    // ts / ms / uid / id / credits。直接透传原始列会让整张表渲染成一片「—」。
    const entries = rows.map((e) => ({
      time: e.ts,
      outcome: e.outcome,
      status: e.status,
      model: e.model,
      account: e.uid,
      client_ip: e.client_ip,
      user_agent: e.user_agent,
      request_id: e.id,
      duration_ms: e.ms,
      prompt_tokens: Number(e.prompt_tokens) || 0,
      completion_tokens: Number(e.completion_tokens) || 0,
      total_tokens: (Number(e.prompt_tokens) || 0) + (Number(e.completion_tokens) || 0),
      credit: Number(e.credits) || 0,
      credit_known: e.credits != null,
    }));
    return c.json({ entries, limit: Number(q.limit) || 200 });
  });

  // 模型目录（直连上游实时探测）
  app.get("/panel/api/models", async (c) => {
    const cn = await listModels(c.env, "cn").catch(() => []);
    const gl = await listModels(c.env, "global").catch(() => []);
    return c.json({ ok: true, models: [...cn, ...gl] });
  });

  // 导入：配置
  app.post("/panel/api/import/config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = await saveConfig(c.env, body);
    return c.json({ ok: true, restart_required: [] as string[] });
  });

  // 导入：auths 数组
  app.post("/panel/api/import/auths", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const arr: any[] = Array.isArray(body) ? body : body.accounts ?? [];
    let imported = 0;
    const errors: string[] = [];
    for (const a of arr) {
      try {
        await poolRPC(c.env, "/internal/add", "POST", { auth: a });
        await poolRPC(c.env, "/internal/manage", "POST", { uid: a.uid, action: "revive" });
        imported++;
      } catch (e: any) {
        errors.push(String(e?.message ?? e));
      }
    }
    return c.json({ ok: true, imported, errors });
  });

  // 导入：cockpit 多账号文件（multipart）
  app.post("/panel/api/import/cockpit", async (c) => {
    const form = await c.req.parseBody({ all: true }).catch(() => null);
    const file = form?.["file"] as File | undefined;
    if (!file) return c.json({ ok: false, error: "no file" }, 400);
    const text = await file.text();
    let arr: any[] = [];
    try {
      const j = JSON.parse(text);
      arr = Array.isArray(j) ? j : j.accounts ?? [j];
    } catch {
      return c.json({ ok: false, error: "invalid json" }, 400);
    }
    let imported = 0;
    const errors: string[] = [];
    for (const a of arr) {
      try {
        await poolRPC(c.env, "/internal/add", "POST", { auth: a });
        imported++;
      } catch (e: any) {
        errors.push(String(e?.message ?? e));
      }
    }
    return c.json({ ok: true, imported, errors });
  });

  // 配置读写
  app.get("/panel/api/config", async (c) => {
    const cfg = await getConfig(c.env);
    return c.json(cfg);
  });
  app.post("/panel/api/config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = await saveConfig(c.env, body);
    return c.json({ ok: true, restart_required: [] as string[] });
  });

  // 面板登录口令：与调用主钥匙 api_key 分开的一把，只用来进面板。
  //
  // 为什么不再共用：共用时「给下游发一把调用密钥」等于把管理面板交出去。
  // 生成是一次性的——明文只在响应里出现这一次，之后只读得到「已设置」，
  // 忘了就得再生成一把（旧的立即失效），不做 recover。
  app.post("/panel/api/admin/panel-key", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cur = await getConfig(c.env);
    // clear：退回「面板认 api_key」的老行为。手滑生成后想恢复时用这条路，
    // 免得只剩一把没处记录的口令把自己关在外面。
    if (body?.clear) {
      await saveConfig(c.env, { ...cur, admin_key: "" });
      return c.json({ ok: true, cleared: true });
    }
    const next = genAdminKey();
    await saveConfig(c.env, { ...cur, admin_key: next });
    return c.json({ ok: true, plain: next });
  });
  /** GET 面板口令是否已独立设置（不回照明文：忘了只能重生成）。 */
  app.get("/panel/api/admin/panel-key", async (c) => {
    const cfg = await getConfig(c.env);
    return c.json({ ok: true, set: !!cfg.admin_key, shared_with_api_key: !cfg.admin_key });
  });

  // 子密钥
  app.get("/panel/api/keys", async (c) => {
    const keys = await listKeys(c.env).catch(() => []);
    return c.json({ ok: true, keys });
  });
  app.post("/panel/api/keys", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const key = genKey();
    const bad = validateKeyInput(body);
    if (bad) return c.json({ ok: false, error: bad }, 400);
    const row: ApiKeyRow = {
      id: crypto.randomUUID(),
      key_hash: await sha256Hex(key),
      name: String(body.name || "key"),
      prefix: keyPrefix(key),
      models: Array.isArray(body.models) ? body.models.map(String) : [],
      created_at: Date.now(),
      last_used: 0,
      enabled: body.enabled === false || body.enabled === 0 ? 0 : 1,
      expires_at: numOr(body.expires_at, 0),
      realm: normRealm(body.realm),
      ip_allowlist: Array.isArray(body.ip_allowlist) ? body.ip_allowlist.map(String) : [],
      max_ips: numOr(body.max_ips, 0),
      ips: [],
      last_ip: "",
      req_count: 0,
      quota: numOr(body.quota, 0),
      used_tokens: 0,
      quota_credit: numOr(body.quota_credit, 0),
      used_credit: 0,
      seq: (await maxKeySeq(c.env).catch(() => 0)) + 1,
    };
    await insertKey(c.env, row).catch(() => {});
    // key / plain **必须同时在**：这是 Go internal/panel/keys.go 的契约
    //（`{"key": k, "plain": plain}`），前端 showIssued(r.plain) 读的是 plain。
    // 只返回 key 会让「仅此刻可见」的明文框弹出一个空字符串——看似小错，
    // 实际是用户永远拿不到自己刚创建的密钥。
    return c.json({ ok: true, key, plain: key, id: row.id });
  });
  app.get("/panel/api/keys/:id", async (c) => {
    const k = await getKey(c.env, c.req.param("id")).catch(() => null);
    return c.json({ ok: true, key: k });
  });
  // 改管控字段（停用/配额/IP/模型/有效期）。不接收 key_hash —— 轮换走 /rotate。
  app.patch("/panel/api/keys/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const bad = validateKeyInput(body, true);
    if (bad) return c.json({ ok: false, error: bad }, 400);
    await patchKey(c.env, c.req.param("id"), body).catch(() => {});
    // 改的是同一把钥匙的管控字段（含 enabled / 配额），缓存里那行就此作废。
    invalidateKeyCache();
    const k = await getKey(c.env, c.req.param("id")).catch(() => null);
    return c.json({ ok: true, key: k });
  });
  app.delete("/panel/api/keys/:id", async (c) => {
    await deleteKey(c.env, c.req.param("id")).catch(() => {});
    invalidateKeyCache();
    return c.json({ ok: true });
  });

  // POST /panel/api/keys/purge-legacy —— 清理前缀迁移遗留的旧子密钥记录。
  //
  // 背景：子密钥前缀由 `wbk_` 改成了 `sk-`（为兼容客户端的密钥形状校验）。
  // 旧记录在库里**已经不可用**（鉴权只认 sk-），但它们的 prefix 列还挂着
  // `wbk_…`，会留在列表里让管理员误以为「这把还能用」。
  //
  // 为什么不做成自动迁移：删数据是不可逆的破坏性动作，不该藏在每次请求都可能
  // 触发的 ensureSchema 里。管理员可能只是想留档，必须由人显式点一下。
  //
  // 判据：prefix 不以当前 PREFIX 开头即视为遗留（不硬编码 "wbk_"——万一将来
  // 前缀再改，这条清理逻辑自动跟着走，不会留下第二个硬编码的坑）。
  app.post("/panel/api/keys/purge-legacy", async (c) => {
    const removed = await purgeLegacyKeys(c.env, PREFIX).catch(() => -1);
    if (removed < 0) return c.json({ ok: false, error: "purge failed" }, 500);
    // 整表删了一批行，进程内那份密钥缓存整体作废（无法逐条精确失效）。
    invalidateKeyCache();
    return c.json({ ok: true, removed, prefix: PREFIX });
  });

  // POST /reset 语义**必须与 Go 一致**：清零已用额度，而不是换密钥
  //（Go internal/panel/keys.go 的 keysReset 调的是 ResetUsage）。
  // 此前这里做了密钥轮换，而前端按钮文案写的是「重置用量统计」——管理员以为
  // 只是续期的无害操作，实际所有客户端瞬间 401，且新明文被丢弃、无处可寻。
  // 轮换这种**不可逆且会打挂下游**的动作，必须走独立的 /rotate。
  app.post("/panel/api/keys/:id/reset", async (c) => {
    const r = await run(
      c.env,
      "UPDATE apikeys SET used_tokens = 0, used_credit = 0, req_count = 0 WHERE id = ?",
      [c.req.param("id")],
    ).catch(() => null);
    // 清零用量必须立刻可见：否则刚点完「重置用量」，下一个请求撞上缓存里的旧计数
    // 照样被 429 拦住——管理员会以为是重置功能坏了。
    invalidateKeyCache();
    // 行不存在时不报错——幂等语义，调一次和调十次结果相同。
    return c.json({ ok: true, changed: Number(r?.meta?.changes ?? 0) });
  });
  // 清零已用额度（续期/加配额后免重建密钥）。语义与 /reset 相同，保留用于兼容早期客户端。
  app.post("/panel/api/keys/:id/reset_usage", async (c) => {
    await run(c.env, "UPDATE apikeys SET used_tokens = 0, used_credit = 0, req_count = 0 WHERE id = ?", [
      c.req.param("id"),
    ]).catch(() => {});
    invalidateKeyCache(); // 同 /reset：清零必须立刻对鉴权可见
    return c.json({ ok: true });
  });
  // Go 没有轮换能力，这是 CF 侧的增强：换一把新明文，**旧密钥立即失效**。
  // 返回 plain 让前端一次性展示——轮换后不展示新密钥等于把用户锁在门外。
  app.post("/panel/api/keys/:id/rotate", async (c) => {
    const id = c.req.param("id");
    const k = await getKey(c.env, id).catch(() => null);
    if (!k) return c.json({ ok: false }, 404);
    const key = genKey();
    // prefix 必须跟着换：留在旧掩码上会让列表页继续显示一把已作废的钥匙。
    await insertKey(c.env, { ...k, key_hash: await sha256Hex(key), prefix: keyPrefix(key) }).catch(() => {});
    // ⚠️ 这是安全口径，不是性能问题：轮换的语义就是「旧明文立即失效」。而鉴权
    // 走的是带缓存的读——不清缓存，旧 key 在它的 TTL 内照样能通过，轮换等于
    // 延迟生效。这一行删掉，轮换就从「紧急止损手段」退化成「30 秒后止损」。
    invalidateKeyCache();
    return c.json({ ok: true, key, plain: key });
  });
  // 配额概览（面板顶部：多少把钥匙、已用多少 token/积分、多少把已超额）。
  app.get("/panel/api/keys/quota", async (c) => {
    return c.json({ ok: true, ...(await quotaUsage(c.env).catch(() => ({ keys: 0, tokens: 0, credit: 0, exhausted: 0 }))) });
  });
  app.post("/panel/api/keys/check-models", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cn = await listModels(c.env, "cn").catch(() => []);
    const gl = await listModels(c.env, "global").catch(() => []);
    const all = new Set([...cn, ...gl].map((m: any) => m.id));
    const invalid = (body.models ?? []).filter((m: string) => !all.has(m));
    return c.json({ ok: true, invalid });
  });

  // 用量：从 request_logs 实时聚合成面板「用量」页的视图模型。
  //
  // 这里曾是 `/panel/api/usage` 返回一张独立的 usage 表的原始行，而前端 renderUsage
  // 期待的是 totals/series/by_*/credit_by_* 一整套——字段完全对不上，所以即便有数据
  // 页面也只会是一片空。两套口径必须对齐，且只能有一套数据源。
  app.get("/panel/api/usage", async (c) => {
    const q = c.req.query();
    const to = Date.now();
    // 前端 trangeQuery 传的是**秒**（自定义/固定区间）；滚动窗口传 hours。两者
    // 都可能缺席，缺省给 24 小时——与前端 trangeState 的默认预设保持一致。
    const hours = Number(q.hours) || 24;
    const toMs = q.to ? Number(q.to) * 1000 : to;
    const fromMs = q.from ? Number(q.from) * 1000 : toMs - hours * 3600_000;

    // 命中缓存直接回：连 /internal/list 这次 DO 调用也一并省掉。
    const ckey = `${Math.floor(fromMs / 60_000)}|${Math.floor(toMs / 60_000)}`;
    if (usageCache && usageCache.key === ckey && Date.now() - usageCache.at < USAGE_TTL_MS) {
      return c.json(usageCache.body);
    }

    // 昵称是明细表的润色项，拿不到就降级显示 uid —— 不能因为它失败就整页空。
    const accounts = ((await poolRPC(c.env, "/internal/list").catch(() => [])) as any[]) ?? [];
    const nicknames: Record<string, string> = {};
    for (const a of accounts) {
      if (a?.uid && a?.nickname) nicknames[String(a.uid)] = String(a.nickname);
    }

    const snap = await getUsage(c.env, { from: fromMs, to: toMs, nicknames }).catch(() => null);
    if (!snap) return c.json({ ok: false, buckets: 0, totals: {}, series: [], by_account: [], by_model: [], by_realm: [], credit_by_account: [], credit_by_model: [] });
    // raw_latest：最近 5 条日志的原始行（含 msg 里的上游 usage 原文）。
    // 用途单一——当 token 全 0 时，用户能一眼看到「库里到底存了什么」，
    // 区分「上游没回 usage」与「回了解析/写库失败」，不必再靠猜。
    const rawLatest = await queryRequestLogs(c.env, { limit: 5, from: fromMs, to: toMs }).catch(() => []);
    const body = { ok: true, ...snap, raw_latest: rawLatest };
    // 只缓存成功结果：失败形态（snap 为 null）不该被缓存成 5 分钟的"空页面"。
    usageCache = { key: ckey, at: Date.now(), body };
    return c.json(body);
  });
  app.post("/panel/api/usage/save", async (c) => {
    return c.json({ ok: true });
  });

  // 手动重置用量信息：清空 request_logs，让用量页 / 账号用量 / 运行日志全部归零重算。
  //
  // 为什么是清这张表而不是去改 apikey 的 used_tokens/used_credit：前者是「统计口径」
  // 的源头——用量、账号成功/失败、运行日志全都从它实时聚合；后者是「配额占用」的
  // 计数器，归零会立刻放大一个账号的可用额度，与「重置用量展示」不是一回事。
  // 调用方（面板按钮）会带二次确认，这里只管执行。
  app.post("/panel/api/usage/reset", async (c) => {
    try {
      const deleted = await truncateRequestLogs(c.env);
      resetUsageCache();
      return c.json({ ok: true, deleted });
    } catch (e: any) {
      return c.json({ ok: false, error: String(e?.message ?? e) }, 500);
    }
  });

  // 模型探测
  app.get("/panel/api/model_probes", async (c) => {
    const probes = (await kvGetJSON(cacheKV(c.env), CACHE_KEY_OUTPUT_PROBES).catch(() => null)) as any;
    return c.json({ probes: probes ?? [], exists: !!probes, updated_at: probes?.updated_at ?? null });
  });

  // 积分包：逐账号向上游实时查询（对齐 Go panel.packages）。
  // 并发上限 3，避免瞬时打满上游限流；单号失败只在对应行标 error，不影响整页。
  app.get("/panel/api/packages", async (c) => {
    const accounts = ((await poolRPC(c.env, "/internal/list").catch(() => [])) as any[]) ?? [];
    const rows: any[] = new Array(accounts.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= accounts.length) return;
        const a = accounts[i];
        const row: any = { uid: a.uid, nickname: a.nickname, realm: a.realm, remain: 0, size: 0, packages: [] };
        try {
          const auth = a.auth as Auth;
          if (!auth?.accessToken) throw new Error("account not loaded");
          const packs = await creditPackages(c.env, auth);
          row.packages = packs;
          row.remain = packs.reduce((s, p) => s + p.remain, 0);
          row.size = packs.reduce((s, p) => s + p.size, 0);
        } catch (e: any) {
          row.error = String(e?.message ?? e);
        }
        rows[i] = row;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, accounts.length) }, worker));
    // 余额降序：多的在前，便于和少的对比。
    rows.sort((x, y) => (y.remain ?? 0) - (x.remain ?? 0));
    return c.json({ accounts: rows });
  });

  // 校园代金券
  app.get("/panel/api/school/vouchers", async (c) => {
    const out = await forEachAccount(c.env, (auth) =>
      fetch("https://www.workbuddy.cn/api/school/vouchers", { headers: { Authorization: "Bearer " + auth.accessToken } }).then((r) => r.json().catch(() => ({}))),
    ).catch(() => []);
    return c.json({ ok: true, results: out });
  });

  // ---- CLI 能力的服务端入口（替代 cmd/credit、cmd/trial）----
  //
  // Go 侧这两个命令是遍历本地 auths/ 目录的独立二进制；Workers 下账号池在 DO、
  // 凭证在 Secrets，能力上移为服务端批量操作，这里是它们的 HTTP 落点。
  // ?pretty=1 返回人类可读行数组（CLI 直接打印），默认返回结构化 JSON。

  // GET /panel/api/credits?realm=cn|global&pretty=1
  app.get("/panel/api/credits", async (c) => {
    const realm = c.req.query("realm") || undefined;
    const report = await runCreditReport(c.env, realm);
    if (c.req.query("pretty") === "1") return c.json({ ok: true, lines: prettyReport(report) });
    return c.json(report);
  });

  // POST /panel/api/trial —— 批量领取 global trial 加油包（CN 自动 N/A）
  app.post("/panel/api/trial", async (c) => {
    const { rows, summary } = await runTrialBatch(c.env);
    return c.json({ ok: summary.fail === 0, summary, accounts: rows });
  });

  /**
   * POST /panel/api/signin_report —— 批量签到并**同步返回逐账号结果**。
   *
   * 与 /panel/api/checkin_all 的区别不是重复：后者是 fire-and-forget（后台跑完
   * 只能去面板看日志），对齐的是定时任务；而 CLI 要的是 cmd/signin 那张逐账号
   * 表格（谁 OK、谁已签、谁 AUTH_INVALID），必须同步拿结果。
   * 并发压到 3（同/packages）：全池串行会撞 Workers 请求时限。
   * 签到结果不回写面板缓存——余额台账由 runCheckin 那条链路负责刷新。
   */
  app.post("/panel/api/signin_report", async (c) => {
    const realm = c.req.query("realm") || undefined;
    const list = ((await poolRPC(c.env, "/internal/list").catch(() => [])) as any[]) ?? [];
    const rows: SigninOutcome[] = new Array(list.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= list.length) return;
        const a = list[i];
        if (realm && a.realm !== realm) continue;
        const r = await signinOne(c.env, a.auth as Auth);
        // 顺手查余额（对齐 cmd/signin 的 remain 列），失败留 null 不影响签到判定。
        try {
          const cr = await getCredits(c.env, a.auth as Auth);
          rows[i] = { ...r, remain: cr.credits, creditsTotal: cr.creditsTotal };
        } catch {
          rows[i] = r;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
    const filled = rows.filter(Boolean);
    return c.json({ ok: true, summary: summarizeSignin(filled), accounts: filled, table: renderSigninTable(filled) });
  });
}
