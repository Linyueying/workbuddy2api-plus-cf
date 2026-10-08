import type { Env } from "../../worker-configuration.d.ts";

// D1 自动迁移：Worker 启动时自检建表，部署后无需手工跑 db-init。
//
// 存在的理由：Pages 的 Git 集成只负责 build + deploy，不会执行任何数据库迁移。
// 原方案 `npm run db:init:remote` 是一次性手工操作，忘了跑的话部署照样成功、
// 首个写请求才 500，错误埋在很深处。把迁移搬进 Worker 进程内，就可以做到
// "推代码 → 部署 → 直接可用"。
//
// 三条硬约束：
//   1. D1 的 prepare() 一次只能跑一条语句 → 要么逐条跑，要么用 batch() 打包；
//   2. SQLite 的 ALTER TABLE ADD COLUMN **不支持 IF NOT EXISTS**
//      → 加列前必须 PRAGMA table_info 探测，否则重跑必炸 duplicate column；
//   3. 多个 isolate 可能同时首次触发 → ADD COLUMN 存在竞态，
//      必须吞掉 "duplicate column name" 而不是让它冒到调用方。
//
// ---------------------------------------------------------------------------
// 冷启动优化（2026-10）：原先这段是**首 Token 延迟的最大单项**。
//
// 迁移原本跑在每个 API 请求、Hono 之前，且是纯串行的。即便数据库早已是最新
// schema，它仍会老老实实走完 8 条 CREATE + 2 条 PRAGMA + 3 条索引 = **14 次
// 串行 D1 往返**；而它的 promise 缓存是模块级的，isolate 一回收就重新付一遍。
// 这正好解释「冷启动很慢、热启动很快」——热启动根本不用付这笔钱。
//
// 两层优化，组合起来把冷启动的迁移成本压到接近零：
//
//   ① 版本门：迁移成功后把版本号写进 KV。冷启动先花 **1 次 KV 读**（边缘、
//      亚毫秒~几毫秒）确认版本达标，达标就完全跳过 DDL。省掉 14 次 D1 往返。
//   ② batch 压缩：真需要迁移时（首次部署 / 版本号提升），用 d1.batch() 把
//      往返数从 14 压到 3~4（9 条建表索引一批、3 条探测一批、缺列一批）。
//
// 版本门**失效即退化**，绝不成为新的故障源：KV 未绑定、读失败、值非法，
// 一律当作「版本未知」照跑迁移。KV 是最终一致的，但这里只存一个单调递增的
// 版本号，读到旧值最坏情况是多跑一次幂等迁移，读到新值才跳过——不会漏迁移。

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
// Go apikeys.Key.Prefix 存的是**明文前 12 字符**，供列表页显示 `sk-1a2b3c…`，
// 既不落明文也让管理员能认出是哪一把。CF 此前缺这一列，列表那格恒为空。
const COLS_0004: { name: string; ddl: string }[] = [
  { name: "prefix", ddl: "prefix TEXT NOT NULL DEFAULT ''" },
];

// 0005：request_logs 用量列（与 migrations/0005_request_logs_usage_cols.sql 保持同步）。
// 这 4 列在 0001 建表时尚不存在，原本靠首条日志 INSERT 失败时的懒自愈补列
// （见 d1.ts 的 ensureUsageColumns）。但 Pages 零配置起量的新库更应在启动期就把列补好，
// 与 apikeys 的列迁移同一套口径——避免「首个请求先 500 再自愈」的抖动，也兑现本文件
// 开头「运行时 schema 必须与 migrations/*.sql 保持同步」的硬约束。
// 每条都带默认值，保证老行读出来语义不变；这里主动补齐后，懒自愈仅作兜底。
const COLS_REQLOGS: { name: string; ddl: string }[] = [
  { name: "prompt_tokens", ddl: "prompt_tokens INTEGER NOT NULL DEFAULT 0" },
  { name: "completion_tokens", ddl: "completion_tokens INTEGER NOT NULL DEFAULT 0" },
  { name: "credits", ddl: "credits REAL NOT NULL DEFAULT 0" },
  { name: "cache_read_tokens", ddl: "cache_read_tokens INTEGER NOT NULL DEFAULT 0" },
];

const INDEX_0002 = `CREATE INDEX IF NOT EXISTS idx_apikeys_seq ON apikeys(seq DESC)`;

// 0003 的复合索引（与 migrations/0003_usage_metrics.sql 末两行保持同步）。
//
// 为什么必须补进自动迁移：那两行原本只存在于手工 SQL 文件里，而 Pages 部署根本
// 不会执行它——新环境（零配置起量）永远走不到 `npm run db:init:remote`，于是
// request_logs 上只有 0001 建的单列 idx_reqlogs_ts。用量页的聚合是
// 「按 ts 窗口扫描 + 按 uid/model/realm 分组」，窗口可达 90 天：
//   1) 单列 ts 索引命中后仍要**逐行回表**取 model/realm/uid → 扫多少行算多少行；
//   2) D1 按**扫描行数**计费（不是返回行数），免费套餐 500 万行/天的额度
//      会被几张用量页刷爆。
// 两个复合索引让分组键直接落在索引里（覆盖扫描），缺了它们只是慢，不会报错——
// 所以这个缺口此前一直没被发现。
const INDEX_0003 = [
  `CREATE INDEX IF NOT EXISTS idx_reqlogs_usage ON request_logs(ts DESC, model, realm)`,
  `CREATE INDEX IF NOT EXISTS idx_reqlogs_usage_uid ON request_logs(ts DESC, uid)`,
];

/**
 * DROP_LEGACY 清掉历史遗留的**永不写入**的空表（对应 migrations/0006_drop_unused_tables.sql）。
 *
 * 这两张表由 0001 建出，但全仓从未有任何代码读写它们：
 *   - `usage`       按小时预聚合的旧用量表，唯一的写入函数 recordUsage **从未被调用**，
 *                   用量口径早已迁到 request_logs 实时聚合；
 *   - `task_queue`  任务中心队列，实际任务状态全走 PoolDO 内部存储，D1 这张表从未被碰。
 *
 * 即：任何由本项目建出来的库，这两张表**必定是空的**，DROP 不会丢任何真实数据。
 *
 * ⚠️ 这里刻意与 0003 复合索引共用同一批 batch —— 迁移的往返次数是冷启动的关键指标
 * （真机优化目标 ≤4 次往返，见 test/migrate.test.ts 的 roundTrips 断言），为清理空表
 * 单独发起一次往返等于把优化成果退回去。两者同属「缺了不影响正确性」的非阻塞操作，
 * 合并是自然的。
 */
const DROP_LEGACY = [`DROP TABLE IF EXISTS usage`, `DROP TABLE IF EXISTS task_queue`];

export type MigrateState =
  | { status: "skipped"; reason: string }
  /** via 标明这次「ok」是怎么来的：version_gate = 命中版本门直接跳过（冷启动最优路径）；ddl = 真跑了迁移。 */
  | { status: "ok"; created: string[]; added_cols: string[]; via?: "version_gate" | "ddl" }
  | { status: "error"; error: string; created: string[]; added_cols: string[] };

/** 版本门在 KV 里的键。 */
const SCHEMA_VERSION_KEY = "schema_version";
/**
 * 当前 schema 目标版本 = migrations/ 里最后一个文件的序号（0006 → 6）。
 *
 * ⚠️ 新增迁移文件时**必须**同步把这里 +1，否则版本门会让新迁移永远跑不到
 * （旧版本号已经达标 → 直接跳过）。这是本机制唯一需要人工维护的地方。
 *
 * 0006（清理 usage / task_queue）尤其依赖这一步：已上线实例的 KV 里存的是 5，
 * 只有把目标抬到 6，它们才会在**首个请求**时重跑迁移、把历史空表真正 DROP 掉。
 * 不抬版本号的话，版本门会继续「达标即跳过」，线上残留就永远清不掉。
 */
const SCHEMA_TARGET = 6;

// 每个 isolate 只跑一次。用 promise 缓存而非布尔值：
// 首个请求触发后，并发请求 await 同一个 promise，而不是各自重复探测。
let inflight: Promise<MigrateState> | null = null;

/**
 * bypassGate 下一次 ensureSchema 是否**穿透**版本门。
 *
 * ⚠️ 只由 forceSchemaMigration() 置起，**不要**挂到 resetSchemaCache() 上。
 * 后者是「清空模块级缓存」的通用入口，被测试的 beforeEach 普遍调用——若它也
 * 置起这个标志，版本门在测试里就永远不会被走到，等于没写。
 *
 * 存在理由：运维点「强制重跑迁移」时，如果还去读 KV 版本、发现达标就跳过，
 * 那这个入口就形同虚设了。置起后跑完即清。
 */
let bypassGate = false;

/** 幂等：重复调用返回同一个结果，不会重复跑 DDL。 */
export function ensureSchema(env: Env): Promise<MigrateState> {
  if (inflight) return inflight;
  inflight = guarded(env).catch((e): MigrateState => ({
    status: "error",
    error: String(e?.message ?? e),
    created: [],
    added_cols: [],
  }));
  return inflight;
}

/**
 * resetSchemaCache 清空模块级 promise 缓存，下次 ensureSchema 重新走一遍判定。
 *
 * 注意它**不**穿透版本门：清完缓存后若 KV 版本仍达标，照样跳过（这才是冷启动
 * 想要的行为）。要强制真跑迁移请用 forceSchemaMigration()。
 */
export function resetSchemaCache(): void {
  inflight = null;
}

/**
 * forceSchemaMigration 强制重跑一次迁移（穿透版本门）。
 *
 * 给运维兜底入口用（如 /panel/api/admin/migrate?force=1）：KV 版本号写错、
 * 或手工改坏了表结构需要重建时，必须能绕过「版本达标就跳过」这条快路径。
 */
export function forceSchemaMigration(): void {
  inflight = null;
  bypassGate = true;
}

/**
 * guarded 版本门包装：命中达标版本就跳过全部 DDL。
 *
 * 这里而不是在 migrate() 内部判，是为了让「跳过」这件事本身也是一个合法的
 * MigrateState（via: "version_gate"），调用方（/healthz）能看出迁移是靠门跳过的
 * 还是真跑过的。
 */
async function guarded(env: Env): Promise<MigrateState> {
  const d1 = env.WB2A_DB;
  if (!d1) return { status: "skipped", reason: "WB2A_DB 未绑定" };

  if (!bypassGate) {
    const v = await readSchemaVersion(env);
    if (v !== null && v >= SCHEMA_TARGET) {
      return { status: "ok", created: [], added_cols: [], via: "version_gate" };
    }
  }
  bypassGate = false;

  const r = await migrate(env);
  // 只有真跑成功才写版本号：失败的话下次还得重试。
  if (r.status === "ok") await writeSchemaVersion(env, SCHEMA_TARGET);
  return r;
}

/** readSchemaVersion 读 KV 里的迁移版本号；拿不到返回 null（= 版本未知，照跑迁移）。 */
async function readSchemaVersion(env: Env): Promise<number | null> {
  const ns = env.WB2A_CONFIG as unknown as KVNamespace | undefined;
  if (!ns || typeof ns.get !== "function") return null;
  try {
    const raw = await ns.get(SCHEMA_VERSION_KEY);
    if (raw === null || raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // KV 读失败不该阻断迁移——退化到老路径而已
  }
}

/** writeSchemaVersion 写版本号。写失败无所谓，最坏是下次多跑一次幂等迁移。 */
async function writeSchemaVersion(env: Env, v: number): Promise<void> {
  const ns = env.WB2A_CONFIG as unknown as KVNamespace | undefined;
  if (!ns || typeof ns.put !== "function") return;
  try {
    await ns.put(SCHEMA_VERSION_KEY, String(v));
  } catch {
    /* 静默：版本号只是加速手段，不是正确性依赖 */
  }
}

async function migrate(env: Env): Promise<MigrateState> {
  const d1 = env.WB2A_DB;
  if (!d1) return { status: "skipped", reason: "WB2A_DB 未绑定" };

  const created: string[] = [];
  const added_cols: string[] = [];

  // 1) 表 + 0002 索引：全部带 IF NOT EXISTS，天然幂等，打包成一批（1 次往返）。
  //    建表失败是硬故障，后面建索引/加列必然也失败，直接抛出。
  await runStatements(d1, [...SCHEMA_0001, INDEX_0002]);

  // 2) 探测：表清单 + 两张表的列清单，打包成一批（1 次往返）。
  //    原先这里是 3 次串行往返（sqlite_master + 2 个 PRAGMA）。
  const [tableRows, apikeysCols, reqlogsCols] = await runQueries(d1, [
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    "PRAGMA table_info(apikeys)",
    "PRAGMA table_info(request_logs)",
  ]);
  // 表清单是固定的，建完即视为已建（首轮）或已存在（后续）；
  // 只在首次真正建出来时上报，便于 healthz 展示。
  created.push(...tableRows.map((x: any) => String(x?.name)));
  const cols = new Set(apikeysCols.map((x: any) => String(x?.name)));
  const reqCols = new Set(reqlogsCols.map((x: any) => String(x?.name)));

  // 3) 列：ADD COLUMN 不支持 IF NOT EXISTS，只补缺失的，打包成一批（0 或 1 次往返）。
  const needApikeys = [...COLS_0002, ...COLS_0004].filter((c) => !cols.has(c.name));
  const needReqlogs = COLS_REQLOGS.filter((c) => !reqCols.has(c.name));
  if (needApikeys.length || needReqlogs.length) {
    await runAlters(d1, needApikeys, needReqlogs, added_cols);
  }

  // 4) 0003 的复合索引 + 0006 的历史空表清理：都带 IF (NOT) EXISTS，老库重跑是 no-op。
  //    两者都失败不阻断启动（索引只影响查询计划，遗留空表不影响任何查询），故只告警不抛。
  try {
    await runStatements(d1, [...INDEX_0003, ...DROP_LEGACY]);
  } catch (e) {
    console.error(`[migrate] 建索引/清理历史空表失败（跳过，不影响正确性）: ${msgOf(e)}`);
  }

  return { status: "ok", created, added_cols, via: "ddl" };
}

// ---------------------------------------------------------------------------
// 执行器：优先 batch()（一次往返跑多条），不可用时退化逐条。
//
// 为什么要做能力探测而不是直接用 batch：本仓库的单测用了一个只实现 prepare()
// 的 D1 假实现，直接调 batch 会让 642 个测试全炸。真机 D1 一定有 batch，
// 所以探测只是为了让「测试环境」和「生产环境」走同一份代码而不互相迁就。
// ---------------------------------------------------------------------------

/** runStatements 执行一批写语句（建表/建索引），失败即抛。 */
async function runStatements(d1: any, sqls: string[]): Promise<void> {
  if (typeof d1.batch === "function") {
    try {
      await d1.batch(sqls.map((s) => d1.prepare(s)));
      return;
    } catch (e) {
      // batch 不告知是哪一条失败，只能把原始错误抛出去（真机 D1 的报错里
      // 通常带 SQL 文本，够定位；不值得为此退化回逐条再跑一遍）。
      throw new Error(`DDL 失败: ${msgOf(e)}`);
    }
  }
  for (const sql of sqls) {
    try {
      await d1.prepare(sql).run();
    } catch (e) {
      throw new Error(`DDL 失败: ${firstLine(sql)} → ${msgOf(e)}`);
    }
  }
}

/** runQueries 执行一批读语句，按入参顺序返回结果行数组。 */
async function runQueries(d1: any, sqls: string[]): Promise<any[][]> {
  if (typeof d1.batch === "function") {
    try {
      const rs = await d1.batch(sqls.map((s) => d1.prepare(s)));
      return rs.map((r: any) => r?.results ?? []);
    } catch {
      // batch 失败（典型：某张表还不存在，PRAGMA 直接抛）→ 退化逐条，
      // 逐条版本对每条独立 try/catch，缺哪张表就按「列全部缺失」处理。
    }
  }
  const out: any[][] = [];
  for (const sql of sqls) {
    try {
      const r = await d1.prepare(sql).all();
      out.push(r?.results ?? []);
    } catch {
      out.push([]);
    }
  }
  return out;
}

/**
 * runAlters 补缺失的列。
 *
 * 竞态处理是这里唯一的难点：多个 isolate 可能同时探测到「某列缺失」，
 * 都去 ADD COLUMN，后到的必然撞 duplicate column name——这不算失败。
 * batch 是「一条失败整批失败」，所以撞了就退化到逐条，逐条里逐列吞重复。
 */
async function runAlters(
  d1: any,
  needApikeys: { name: string; ddl: string }[],
  needReqlogs: { name: string; ddl: string }[],
  added_cols: string[],
): Promise<void> {
  const stmts = [
    ...needApikeys.map((c) => ({ sql: `ALTER TABLE apikeys ADD COLUMN ${c.ddl}`, name: c.name, label: c.name })),
    ...needReqlogs.map((c) => ({
      sql: `ALTER TABLE request_logs ADD COLUMN ${c.ddl}`,
      name: c.name,
      label: `request_logs.${c.name}`,
    })),
  ];

  if (typeof d1.batch === "function") {
    try {
      await d1.batch(stmts.map((s) => d1.prepare(s.sql)));
      added_cols.push(...stmts.map((s) => s.name));
      return;
    } catch {
      // 整批失败，退化逐条（下面会吞掉 duplicate column）
    }
  }

  for (const s of stmts) {
    try {
      await d1.prepare(s.sql).run();
      added_cols.push(s.name);
    } catch (e) {
      if (isDuplicateColumn(e)) continue; // 另一个 isolate 抢先加过，不算失败
      throw new Error(`加列失败: ${s.label} → ${msgOf(e)}`);
    }
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
