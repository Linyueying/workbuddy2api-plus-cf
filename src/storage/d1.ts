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
  "id, key_hash, name, models, created_at, last_used, enabled, expires_at, realm, ip_allowlist, max_ips, ips, last_ip, req_count, quota, used_tokens, quota_credit, used_credit, seq";

/** decodeKeyRow 把 D1 行的 JSON 列解成数组（缺列按 0/'' 兜住，兼容 0001 老行）。 */
export function decodeKeyRow(r: any): ApiKeyRow {
  return {
    id: String(r?.id ?? ""),
    key_hash: String(r?.key_hash ?? ""),
    name: String(r?.name ?? ""),
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
     (id, key_hash, name, models, created_at, last_used, enabled, expires_at, realm, ip_allowlist, max_ips, ips, last_ip, req_count, quota, used_tokens, quota_credit, used_credit, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.key_hash,
      row.name,
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
export async function insertRequestLog(env: Env, e: RequestLogEntry): Promise<void> {
  await run(
    env,
    `INSERT INTO request_logs (ts, channel, client_ip, user_agent, uid, model, realm, outcome, status, ms, msg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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

// ---------- 用量聚合（按模型+小时窗口）----------
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
