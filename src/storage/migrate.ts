import type { Env } from "../../worker-configuration.d.ts";

// D1 自动迁移：Worker 启动时自检建表，部署后无需手工跑 db-init。
//
// 存在的理由：Pages 的 Git 集成只负责 build + deploy，不会执行任何数据库迁移。
// 原方案 `npm run db:init:remote` 是一次性手工操作，忘了跑的话部署照样成功、
// 首个写请求才 500，错误埋在很深处。把迁移搬进 Worker 进程内，就可以做到
// "推代码 → 部署 → 直接可用"。
//
// 三条硬约束：
//   1. D1 的 prepare() 一次只能跑一条语句 → SQL 必须按 `;` 拆开逐条执行；
//   2. SQLite 的 ALTER TABLE ADD COLUMN **不支持 IF NOT EXISTS**
//      → 加列前必须 PRAGMA table_info 探测，否则重跑必炸 duplicate column；
//   3. 多个 isolate 可能同时首次触发 → ADD COLUMN 存在竞态，
//      必须吞掉 "duplicate column name" 而不是让它冒到调用方。

// 0001 的 DDL（与 migrations/0001_init.sql 保持同步，全部 IF NOT EXISTS）
const SCHEMA_0001 = [
  `CREATE TABLE IF NOT EXISTS apikeys (
     id TEXT PRIMARY KEY,
     key_hash TEXT NOT NULL,
     name TEXT NOT NULL,
     models TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL,
     last_used INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_apikeys_hash ON apikeys(key_hash)`,
  `CREATE TABLE IF NOT EXISTS request_logs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     channel TEXT NOT NULL DEFAULT 'chat',
     client_ip TEXT,
     user_agent TEXT,
     uid TEXT,
     model TEXT,
     realm TEXT,
     outcome TEXT NOT NULL,
     status INTEGER NOT NULL,
     ms INTEGER NOT NULL,
     msg TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_reqlogs_ts ON request_logs(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reqlogs_uid ON request_logs(uid)`,
  `CREATE TABLE IF NOT EXISTS usage (
     hour INTEGER NOT NULL,
     model TEXT NOT NULL,
     realm TEXT NOT NULL,
     tokens INTEGER NOT NULL DEFAULT 0,
     cnt INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (hour, model, realm)
   )`,
  `CREATE TABLE IF NOT EXISTS task_queue (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     uid TEXT NOT NULL,
     task_id TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_taskqueue_uid ON task_queue(uid, status)`,
];

// 0002 的新增列（与 migrations/0002_apikey_quota.sql 保持同步）。
// 每条都要带默认值，保证 0001 时代的老行读出来语义不变。
const COLS_0002: { name: string; ddl: string }[] = [
  { name: "enabled", ddl: "enabled INTEGER NOT NULL DEFAULT 1" },
  { name: "expires_at", ddl: "expires_at INTEGER" },
  { name: "realm", ddl: "realm TEXT NOT NULL DEFAULT ''" },
  { name: "ip_allowlist", ddl: "ip_allowlist TEXT NOT NULL DEFAULT '[]'" },
  { name: "max_ips", ddl: "max_ips INTEGER NOT NULL DEFAULT 0" },
  { name: "ips", ddl: "ips TEXT NOT NULL DEFAULT '[]'" },
  { name: "last_ip", ddl: "last_ip TEXT NOT NULL DEFAULT ''" },
  { name: "req_count", ddl: "req_count INTEGER NOT NULL DEFAULT 0" },
  { name: "quota", ddl: "quota INTEGER NOT NULL DEFAULT 0" },
  { name: "used_tokens", ddl: "used_tokens INTEGER NOT NULL DEFAULT 0" },
  { name: "quota_credit", ddl: "quota_credit REAL NOT NULL DEFAULT 0" },
  { name: "used_credit", ddl: "used_credit REAL NOT NULL DEFAULT 0" },
  { name: "seq", ddl: "seq INTEGER NOT NULL DEFAULT 0" },
];

// 0004：子密钥展示掩码（与 migrations/0004_apikey_prefix.sql 保持同步）。
// Go apikeys.Key.Prefix 存的是**明文前 12 字符**，供列表页显示 `wbk_1a2b3c…`，
// 既不落明文也让管理员能认出是哪一把。CF 此前缺这一列，列表那格恒为空。
const COLS_0004: { name: string; ddl: string }[] = [
  { name: "prefix", ddl: "prefix TEXT NOT NULL DEFAULT ''" },
];

const INDEX_0002 = `CREATE INDEX IF NOT EXISTS idx_apikeys_seq ON apikeys(seq DESC)`;

export type MigrateState =
  | { status: "skipped"; reason: string }
  | { status: "ok"; created: string[]; added_cols: string[] }
  | { status: "error"; error: string; created: string[]; added_cols: string[] };

// 每个 isolate 只跑一次。用 promise 缓存而非布尔值：
// 首个请求触发后，并发请求 await 同一个 promise，而不是各自重复探测。
let inflight: Promise<MigrateState> | null = null;

/** 幂等：重复调用返回同一个结果，不会重复跑 DDL。 */
export function ensureSchema(env: Env): Promise<MigrateState> {
  if (inflight) return inflight;
  inflight = migrate(env).catch((e): MigrateState => ({
    status: "error",
    error: String(e?.message ?? e),
    created: [],
    added_cols: [],
  }));
  return inflight;
}

/** 仅供测试/运维强制重跑（/panel/api/admin/migrate?force=1）。 */
export function resetSchemaCache(): void {
  inflight = null;
}

async function migrate(env: Env): Promise<MigrateState> {
  const d1 = env.WB2A_DB;
  if (!d1) return { status: "skipped", reason: "WB2A_DB 未绑定" };

  const created: string[] = [];
  const added_cols: string[] = [];

  // 1) 表：DDL 自带 IF NOT EXISTS，直接跑即可。
  for (const sql of SCHEMA_0001) {
    try {
      await d1.prepare(sql).run();
    } catch (e) {
      // 建表失败是硬故障，后面建索引/加列必然也失败，直接抛出
      throw new Error(`DDL 失败: ${firstLine(sql)} → ${msgOf(e)}`);
    }
  }
  // 表清单是固定的，建完即视为已建（首轮）或已存在（后续）；
  // 只在首次真正建出来时上报，便于 healthz 展示。
  const existing = await tableNames(d1);
  created.push(...existing);

  // 2) 列：ADD COLUMN 不支持 IF NOT EXISTS，先探测再补。
  const cols = await columnsOf(d1, "apikeys");
  for (const c of [...COLS_0002, ...COLS_0004]) {
    if (cols.has(c.name)) continue;
    try {
      await d1.prepare(`ALTER TABLE apikeys ADD COLUMN ${c.ddl}`).run();
      added_cols.push(c.name);
    } catch (e) {
      // 竞态：另一个 isolate 抢先加了同名列，不算失败
      if (isDuplicateColumn(e)) continue;
      throw new Error(`加列失败: ${c.name} → ${msgOf(e)}`);
    }
  }

  // 3) 索引
  try {
    await d1.prepare(INDEX_0002).run();
  } catch (e) {
    throw new Error(`建索引失败: idx_apikeys_seq → ${msgOf(e)}`);
  }

  return { status: "ok", created, added_cols };
}

// ---------------------------------------------------------------------------

async function tableNames(d1: D1Database): Promise<string[]> {
  const r = await d1
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>();
  return (r.results ?? []).map((x) => String(x.name));
}

async function columnsOf(d1: D1Database, table: string): Promise<Set<string>> {
  try {
    const r = await d1.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    return new Set((r.results ?? []).map((x) => String(x.name)));
  } catch {
    // 表不存在时 PRAGMA 会抛；调用方按"全部缺失"处理
    return new Set();
  }
}

function isDuplicateColumn(e: unknown): boolean {
  return /duplicate column name/i.test(msgOf(e));
}

function msgOf(e: unknown): string {
  return String((e as any)?.message ?? e ?? "");
}

function firstLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 60);
}
