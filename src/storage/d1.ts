import type { Env } from "../../worker-configuration.d.ts";
import type { ApiKeyRow, RequestLogEntry } from "../types";

// D1 封装：用量、请求日志、子密钥、任务中心队列。
// 见 migrations/0001_init.sql。

export function db(env: Env): D1Database {
  return env.WB2A_DB;
}

export async function run(env: Env, sql: string, params: unknown[] = []): Promise<D1Result> {
  return db(env).prepare(sql).bind(...(params as any[])).run();
}

export async function all<T = any>(env: Env, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db(env).prepare(sql).bind(...(params as any[])).all<T>();
  return r.results;
}

export async function first<T = any>(env: Env, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db(env).prepare(sql).bind(...(params as any[])).first<T>();
  return (r as T) ?? null;
}

// ---------- 子密钥 ----------
// JSON 列（models / ip_allowlist / ips）读出时统一解码成数组，写入时统一编码，
// 免得每个调用点各写一遍 parse/stringify。见 migrations/0002_apikey_quota.sql。

const KEY_COLS =
  "id, key_hash, name, prefix, models, created_at, last_used, enabled, expires_at, realm, ip_allowlist, max_ips, ips, last_ip, req_count, quota, used_tokens, quota_credit, used_credit, seq";

/** decodeKeyRow 把 D1 行的 JSON 列解成数组（缺列按 0/'' 兜住，兼容 0001 老行）。 */
export function decodeKeyRow(r: any): ApiKeyRow {
  return {
    id: String(r?.id ?? ""),
    key_hash: String(r?.key_hash ?? ""),
    name: String(r?.name ?? ""),
    // 0004 之前的老行没有 prefix 列 → 空串，前端按「未知」渲染而不报错。
    prefix: String(r?.prefix ?? ""),
    models: decodeArr(r?.models),
    created_at: Number(r?.created_at ?? 0),
    last_used: Number(r?.last_used ?? 0),
    enabled: Number(r?.enabled ?? 1),
    expires_at: Number(r?.expires_at ?? 0),
    realm: String(r?.realm ?? ""),
    ip_allowlist: decodeArr(r?.ip_allowlist),
    max_ips: Number(r?.max_ips ?? 0),
    ips: decodeArr(r?.ips),
    last_ip: String(r?.last_ip ?? ""),
    req_count: Number(r?.req_count ?? 0),
    quota: Number(r?.quota ?? 0),
    used_tokens: Number(r?.used_tokens ?? 0),
    quota_credit: Number(r?.quota_credit ?? 0),
    used_credit: Number(r?.used_credit ?? 0),
    seq: Number(r?.seq ?? 0),
  };
}

function decodeArr(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  const s = String(v ?? "").trim();
  if (!s) return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

export async function listKeys(env: Env): Promise<ApiKeyRow[]> {
  const rows = await all<any>(env, `SELECT ${KEY_COLS} FROM apikeys ORDER BY seq DESC, created_at DESC`);
  return rows.map(decodeKeyRow);
}

export async function getKey(env: Env, id: string): Promise<ApiKeyRow | null> {
  const r = await first<any>(env, `SELECT ${KEY_COLS} FROM apikeys WHERE id = ?`, [id]);
  return r ? decodeKeyRow(r) : null;
}

export async function getKeyByHash(env: Env, keyHash: string): Promise<ApiKeyRow | null> {
  const r = await first<any>(env, `SELECT ${KEY_COLS} FROM apikeys WHERE key_hash = ?`, [keyHash]);
  return r ? decodeKeyRow(r) : null;
}

export async function insertKey(env: Env, row: ApiKeyRow): Promise<void> {
  await run(
    env,
    `INSERT OR REPLACE INTO apikeys
     (id, key_hash, name, prefix, models, created_at, last_used, enabled, expires_at, realm, ip_allowlist, max_ips, ips, last_ip, req_count, quota, used_tokens, quota_credit, used_credit, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.key_hash,
      row.name,
      row.prefix ?? "",
      JSON.stringify(row.models ?? []),
      row.created_at,
      row.last_used ?? 0,
      row.enabled ?? 1,
      row.expires_at ?? 0,
      row.realm ?? "",
      JSON.stringify(row.ip_allowlist ?? []),
      row.max_ips ?? 0,
      JSON.stringify(row.ips ?? []),
      row.last_ip ?? "",
      row.req_count ?? 0,
      row.quota ?? 0,
      row.used_tokens ?? 0,
      row.quota_credit ?? 0,
      row.used_credit ?? 0,
      row.seq ?? 0,
    ],
  );
}

/** patchKey 按白名单字段更新子密钥（管理面 PATCH 用；未出现的字段不动）。
 *  用到的字段名必须显式列出——不接受任意列名拼 SQL。 */
const PATCHABLE: Record<string, string> = {
  name: "name",
  models: "models",
  enabled: "enabled",
  expires_at: "expires_at",
  realm: "realm",
  ip_allowlist: "ip_allowlist",
  max_ips: "max_ips",
  quota: "quota",
  quota_credit: "quota_credit",
};

export async function patchKey(env: Env, id: string, patch: Record<string, unknown>): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [field, col] of Object.entries(PATCHABLE)) {
    if (!(field in patch)) continue;
    let v = patch[field];
    if (col === "models" || col === "ip_allowlist") v = JSON.stringify(Array.isArray(v) ? v.map(String) : []);
    else if (col === "enabled" || col === "max_ips" || col === "expires_at") v = Number(v) || 0;
    else if (col === "quota" || col === "quota_credit") v = Math.max(0, Number(v) || 0);
    else v = String(v ?? "");
    sets.push(`${col} = ?`);
    params.push(v);
  }
  if (!sets.length) return;
  params.push(id);
  await run(env, `UPDATE apikeys SET ${sets.join(", ")} WHERE id = ?`, params);
}

export async function deleteKey(env: Env, id: string): Promise<void> {
  await run(env, "DELETE FROM apikeys WHERE id = ?", [id]);
}

/** maxKeySeq 当前最大创建序号（新建时 +1；同刻创建靠它分先后）。 */
export async function maxKeySeq(env: Env): Promise<number> {
  const r = await first<any>(env, "SELECT COALESCE(MAX(seq), 0) AS s FROM apikeys");
  return Number(r?.s ?? 0);
}

/** usageStats 汇总子密钥的已用配额（面板顶部概览用）。 */
export async function quotaUsage(env: Env): Promise<{ keys: number; tokens: number; credit: number; exhausted: number }> {
  const r = await first<any>(
    env,
    `SELECT COUNT(*) AS keys,
            COALESCE(SUM(used_tokens), 0) AS tokens,
            COALESCE(SUM(used_credit), 0) AS credit,
            COALESCE(SUM(CASE WHEN (quota > 0 AND used_tokens >= quota) OR (quota_credit > 0 AND used_credit >= quota_credit) THEN 1 ELSE 0 END), 0) AS exhausted
     FROM apikeys`,
  );
  return {
    keys: Number(r?.keys ?? 0),
    tokens: Number(r?.tokens ?? 0),
    credit: Number(r?.credit ?? 0),
    exhausted: Number(r?.exhausted ?? 0),
  };
}

// ---------- 请求日志 ----------

/** USAGE_COLUMNS 用量指标列名 → DDL 定义。sqlite 的 ADD COLUMN 不支持 IF NOT
 *  EXISTS，也没法一次 import Marx多列，故按字典逐列补。见 0003 迁移。
 *
 *  自愈的存在理由：本项目的目标部署方式是 CF Git 集成（推 GitHub 自动构建），
 *  用户侧没有 CLI，migrations/*.sql 只能靠手工去 D1 Console 粘贴——漏掉这一步
 *  的概率极高，而症状是「用量页全空」这种无声失败。宁可在首次写日志时自己把列
 *  补上，也不要让一个 14 列的 INSERT 因为缺 4 列而永久静默失效。
 */
const USAGE_COLUMNS: Record<string, string> = {
  prompt_tokens: "prompt_tokens INTEGER NOT NULL DEFAULT 0",
  completion_tokens: "completion_tokens INTEGER NOT NULL DEFAULT 0",
  credits: "credits REAL NOT NULL DEFAULT 0",
  cache_read_tokens: "cache_read_tokens INTEGER NOT NULL DEFAULT 0",
};

/** usageColumnsReady 自愈状态：同一次实例生命周期内只尝试一次，失败即放弃
 *  （不能每个请求都探测一次列）。 */
let usageColumnsReady: Promise<boolean> | null = null;

/** isMissingColumn 判断 D1 报错是否为「列不存在」。 */
function isMissingColumn(e: any): boolean {
  const m = String(e?.message ?? e ?? "").toLowerCase();
  return m.includes("no such column") || m.includes("has no column named");
}

/** ensureUsageColumns 自愈：给 request_logs 补上缺失的用量列。 */
async function ensureUsageColumns(env: Env): Promise<boolean> {
  if (!usageColumnsReady) {
    usageColumnsReady = (async () => {
      for (const [col, ddl] of Object.entries(USAGE_COLUMNS)) {
        try {
          await db(env).prepare(`ALTER TABLE request_logs ADD COLUMN ${ddl}`).run();
        } catch (e: any) {
          // 列已存在报 duplicate column name —— 正是我们想要的终态，不算失败。
          if (!String(e?.message ?? "").toLowerCase().includes("duplicate column")) return false;
        }
      }
      return true;
    })().catch(() => Promise.resolve(false));
  }
  return usageColumnsReady;
}

/**
 * insertRequestLog 写一条请求日志，返回自增 id（供流式回填用量）。
 *
 * 流式无法在开始时就知道用量（usage 在末帧），所以这里是「先占位、后 UPDATE」：
 * 拿到 id 才能在流结束时把 token/credit 回写到同一行。见 updateRequestLogUsage。
 */
export async function insertRequestLog(env: Env, e: RequestLogEntry): Promise<number> {
  const params = [
    e.ts,
    e.channel,
    e.client_ip ?? null,
    e.user_agent ?? null,
    e.uid ?? null,
    e.model ?? null,
    e.realm ?? null,
    e.outcome,
    e.status,
    e.ms,
    e.msg ?? null,
    Number(e.prompt_tokens ?? 0) || 0,
    Number(e.completion_tokens ?? 0) || 0,
    Number(e.credits ?? 0) || 0,
    Number(e.cache_read_tokens ?? 0) || 0,
  ];
  const sql = `INSERT INTO request_logs
     (ts, channel, client_ip, user_agent, uid, model, realm, outcome, status, ms, msg,
      prompt_tokens, completion_tokens, credits, cache_read_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  try {
    const r = await db(env).prepare(sql).bind(...(params as any[])).run();
    return Number(r?.meta?.last_row_id ?? 0);
  } catch (err) {
    // 首次遇到缺列：自愈补列后重试一次。仍失败才是真故障（D1 只读/配额等）。
    if (isMissingColumn(err) && (await ensureUsageColumns(env))) {
      const r = await db(env).prepare(sql).bind(...(params as any[])).run();
      return Number(r?.meta?.last_row_id ?? 0);
    }
    throw err;
  }
}

/** UsagePatch 流式末帧回填的用量字段。 */
export interface UsagePatch {
  prompt_tokens?: number;
  completion_tokens?: number;
  credits?: number;
  cache_read_tokens?: number;
}

/** updateRequestLogUsage 把末帧用量回填到流式开始时的占位日志行。
 *  rawUsage 为上游原始 usage 文本，写进 msg 供排查（可为空）。 */
export async function updateRequestLogUsage(env: Env, id: number, u: UsagePatch, rawUsage?: string): Promise<void> {
  if (!id) return;
  await run(
    env,
    `UPDATE request_logs SET prompt_tokens = ?, completion_tokens = ?, credits = ?, cache_read_tokens = ?, msg = ?
     WHERE id = ?`,
    [
      Number(u.prompt_tokens ?? 0) || 0,
      Number(u.completion_tokens ?? 0) || 0,
      Number(u.credits ?? 0) || 0,
      Number(u.cache_read_tokens ?? 0) || 0,
      rawUsage ? `usage=${rawUsage.slice(0, 400)}` : null,
      id,
    ],
  );
}

export interface RequestLogQuery {
  limit?: number;
  outcome?: string;
  account?: string;
  model?: string;
  client_ip?: string;
  user_agent?: string;
  from?: number;
  to?: number;
}

export async function queryRequestLogs(env: Env, q: RequestLogQuery): Promise<RequestLogEntry[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.outcome) { where.push("outcome = ?"); params.push(q.outcome); }
  if (q.account) { where.push("uid = ?"); params.push(q.account); }
  if (q.model) { where.push("model = ?"); params.push(q.model); }
  if (q.client_ip) { where.push("client_ip = ?"); params.push(q.client_ip); }
  if (q.user_agent) { where.push("user_agent LIKE ?"); params.push(`%${q.user_agent}%`); }
  if (q.from) { where.push("ts >= ?"); params.push(q.from); }
  if (q.to) { where.push("ts <= ?"); params.push(q.to); }
  const sql =
    "SELECT * FROM request_logs" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY ts DESC LIMIT " + Math.min(Number(q.limit) || 200, 1000);
  return all<RequestLogEntry>(env, sql, params);
}

/**
 * deleteRequestLogsBefore 删除 ts 严格早于 cutoff 的请求日志，返回删除行数。
 *
 * 存在理由：无 R2 绑定时（R2 为可选资源）归档链路会整体跳过，D1 的
 * request_logs 只增不减、迟早顶到容量上限。此时改为「到期即从 D1 清理」，
 * 保留天数语义与归档一致，只是没有冷备份——这是不用 R2 的必然取舍。
 */
export async function deleteRequestLogsBefore(env: Env, cutoff: number): Promise<number> {
  const r = await run(env, "DELETE FROM request_logs WHERE ts < ?", [cutoff]);
  return Number(r?.meta?.changes ?? 0);
}

// ---------- 用量 ----------
// 0001 建的 usage 表（hour,model,realm,tokens,cnt）已废弃：它按小时预聚合且无
// uid，面板要的「按账号」「prompt/completion 拆分」「credit」「缓存命中」全都
// 出不来；更要命的是它的写入函数 recordUsage 从未被任何地方调用。用量改从
// request_logs 实时聚合——那才是唯一真实在被写的表。表保留不删：历史数据不动，
// 也不值得为一张空表写 DROP（万一有人已经在用）。

/** UsageRow 用量聚合的输入行：单次请求一级，未聚合。 */
export interface UsageRow {
  ts: number;
  uid: string | null;
  model: string | null;
  realm: string | null;
  outcome: string;
  status: number;
  ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  credits: number;
  cache_read_tokens: number;
}

/**
 * queryUsageWindow 取 [from, to] 窗口内的日志行（含失败与非 relevant 通道）。
 *
 * 失败也取：面板要「请求数（含失败尝试）」和失败率。
 * LIMIT 50000：90 天窗口的上限保护。再大就是全表扫描 + 序列化成本失控，
 * 真到那个量级应该按小时物化，而不是继续加 LIMIT。
 */
export async function queryUsageWindow(env: Env, from: number, to: number): Promise<UsageRow[]> {
  return all<UsageRow>(
    env,
    `SELECT ts, uid, model, realm, outcome, status, ms,
            COALESCE(prompt_tokens, 0) AS prompt_tokens,
            COALESCE(completion_tokens, 0) AS completion_tokens,
            COALESCE(credits, 0) AS credits,
            COALESCE(cache_read_tokens, 0) AS cache_read_tokens
     FROM request_logs WHERE ts >= ? AND ts <= ? ORDER BY ts LIMIT 50000`,
    [from, to],
  ).catch(() => []);
}

/** oldestRequestLogTs 最早一条日志的时间戳（用量页「数据自 …」用），无数据返 0。 */
export async function oldestRequestLogTs(env: Env): Promise<number> {
  const r = await first<any>(env, "SELECT MIN(ts) AS t FROM request_logs").catch(() => null);
  return Number(r?.t ?? 0) || 0;
}

/**
 * AccountUsageAgg 账号池「成功/失败」「用量」列的窗口聚合行。
 *
 * 口径必须与 usage-agg.ts 逐项一致（那是用量页的唯一权威口径）：
 *   requests    = 窗口内全部日志行（含失败，与用量页「请求数」同源）
 *   errors      = outcome != 'ok' 的行数（NULL 按失败算，宁多勿漏）
 *   total_tokens= prompt + completion
 *   ms_sum      = 全部 ms 之和（均值延迟/速率在展示层折算，避免逐行平均的辛普森悖论）
 */
export interface AccountUsageAgg {
  uid: string;
  requests: number;
  errors: number;
  total_tokens: number;
  ms_sum: number;
}

/** usageByAccountWindow 按 uid 聚合 [from, to] 窗口内的请求日志（GROUP BY 在 D1 侧完成，返回行数 = 账号数）。 */
export async function usageByAccountWindow(env: Env, from: number, to: number): Promise<AccountUsageAgg[]> {
  return all<AccountUsageAgg>(
    env,
    `SELECT uid,
            COUNT(*) AS requests,
            SUM(CASE WHEN outcome IS NULL OR outcome != 'ok' THEN 1 ELSE 0 END) AS errors,
            SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)) AS total_tokens,
            SUM(COALESCE(ms, 0)) AS ms_sum
     FROM request_logs
     WHERE ts >= ? AND ts <= ? AND uid IS NOT NULL AND uid != ''
     GROUP BY uid`,
    [from, to],
  ).catch(() => []);
}

export async function recordUsage(env: Env, model: string, realm: string, tokens: number, ts: number): Promise<void> {
  await run(
    env,
    `INSERT INTO usage (hour, model, realm, tokens, cnt) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(hour, model, realm) DO UPDATE SET tokens = tokens + excluded.tokens, cnt = cnt + 1`,
    [Math.floor(ts / 3600000) * 3600000, model, realm, tokens],
  );
}

export async function queryUsage(env: Env, from: number, to: number): Promise<any[]> {
  return all(
    env,
    `SELECT hour, model, realm, tokens, cnt FROM usage WHERE hour >= ? AND hour <= ? ORDER BY hour`,
    [Math.floor(from / 3600000) * 3600000, Math.floor(to / 3600000) * 3600000],
  );
}
