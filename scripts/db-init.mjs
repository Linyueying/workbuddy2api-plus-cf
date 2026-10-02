#!/usr/bin/env node
// db-init.mjs — 初始化 D1 schema（执行 migrations/*.sql，按序号顺序）。
//
// Pages 不会自动跑迁移：Worker 部署成功后如果没建表，首个写请求（记日志/写子密钥/
// 记用量）才会炸 500，且报错点在深处不易定位。故建表必须是部署流程的显式一步。
//
// 用法：
//   node scripts/db-init.mjs                      # 默认 --local（本地 miniflare 的 D1）
//   node scripts/db-init.mjs --remote             # 真实 D1（生产部署用这个）
//   node scripts/db-init.mjs --remote --force     # 忽略「表已存在」直接重跑
//   node scripts/db-init.mjs --remote --dry-run   # 只打印将执行的 SQL，不落地
//
// 幂等：所有 DDL 都是 CREATE TABLE/INDEX IF NOT EXISTS，重复执行安全。
// 0002 是 ALTER TABLE ADD COLUMN——**不可重复执行**（SQLite 会报 duplicate column），
// 故对 0002 单独探测列是否已存在，已存在则跳过。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migDir = resolve(root, "migrations");

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const flag = remote ? "--remote" : "--local";

// 没有 --remote 时必须显式 --local 之外无歧义；这里只提示本地模式容易被误以为已上线。
if (!remote) {
  console.log("[db-init] 本地模式（miniflare 的本地 D1）。生产请加 --remote。");
} else {
  console.log("[db-init] 远程模式：操作真实 D1。");
}
if (dryRun) console.log("[db-init] --dry-run：只打印，不执行。");

if (!args.every((a) => ["--remote", "--local", "--dry-run", "--force"].includes(a))) {
  const unknown = args.filter((a) => !["--remote", "--local", "--dry-run", "--force"].includes(a));
  console.error("[db-init] 未知参数:", unknown.join(" "));
  process.exit(2);
}

/** 迁移文件名按序号升序（0001_ < 0002_），文件名排序即执行顺序。 */
function migrations() {
  return readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** wrangler 的 stdio pipe 回来是 Buffer；统一解成字符串再输出，否则打出一堆字节码。 */
function outToString(v) {
  if (v === undefined || v === null) return "";
  return Buffer.isBuffer(v) ? v.toString("utf8") : String(v);
}

/**
 * 写临时 SQL 文件并用 `--file` 执行，失败时打印 wrangler 的原始输出。
 *
 * 不用 `--command`：它只接受**单条**语句，传多行 SQL 时其中的 `--` 注释行会被
 * 当成独立 token（实测报 "Unknown arguments: workbuddy2api-pages D1 schema"），
 * 而迁移文件恰恰全是带注释的多行 DDL。
 */
function d1Execute(sql, label) {
  if (dryRun) {
    console.log(`\n===== ${label} =====\n${sql.trim()}`);
    return;
  }
  const tmp = resolve(root, `.wrangler/tmp-db-init-${Date.now()}.sql`);
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, sql);
  try {
    execFileSync("npx", ["wrangler", "d1", "execute", "WB2A_DB", flag, "--file", tmp], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: root,
    });
    console.log(`  ✓ ${label}`);
  } catch (e) {
    const out = (outToString(e.stdout) + outToString(e.stderr)).trim();
    console.error(`  ✗ ${label}\n${out}`);
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * 单条 SQL 探测（表/列是否存在）——这里用 `--command` 是安全的：无注释单语句。
 *
 * 注意 `wrangler d1 execute --json` 在 SQL 失败时**仍以 exit code 0 退出**，把
 * `{"error":{...}}` 打到 stdout。所以不能只看进程是否成功，必须解析 JSON 里有无
 * `error` 字段——否则"列不存在"会被误判成"列存在"。
 */
function d1Query(sql) {
  let out = "";
  try {
    out = outToString(
      execFileSync(
        "npx",
        ["wrangler", "d1", "execute", "WB2A_DB", flag, "--json", "--command", sql],
        { stdio: ["ignore", "pipe", "pipe"], cwd: root },
      ),
    );
  } catch {
    return "";
  }
  try {
    const j = JSON.parse(out.slice(out.indexOf("[")));
    if (Array.isArray(j) && j.some((r) => r && r.success === false)) return "";
    return JSON.stringify(j);
  } catch {
    // 非 JSON 输出：保守当作"查不到"，让上层走建表分支而不是误跳过。
    return "";
  }
}

/**
 * columnsOf 读表当前列名（小写）。返回 null = 表不存在（全新库的正常路径）。
 *
 * 用 `PRAGMA table_info` 一次拿全——比逐列 SELECT 快，且逐列 SELECT 会在首个
 * 缺失列就整体报错，无法区分"缺哪几列"。
 */
function columnsOf(tbl) {
  const out = d1Query(`PRAGMA table_info(${tbl})`);
  if (!out) return null; // 表不存在
  try {
    const j = JSON.parse(out);
    return (j[0]?.results ?? []).map((r) => String(r.name ?? "").toLowerCase());
  } catch {
    return null;
  }
}

let applied = 0;
let skipped = 0;

for (const file of migrations()) {
  const sql = readFileSync(resolve(migDir, file), "utf8");
  console.log(`\n[db-init] ${file}`);
  const isAlter = /ALTER\s+TABLE/i.test(sql);

  if (isAlter && !force) {
    // ALTER TABLE ADD COLUMN 不可重复执行，先探测该表已有列。
    const tbl = sql.match(/ALTER\s+TABLE\s+(\w+)/i)?.[1];
    const cols = [...sql.matchAll(/ADD\s+COLUMN\s+(\w+)/gi)].map((m) => m[1]);
    const existing = tbl ? columnsOf(tbl) : null;
    // existing === null → 表还不存在，直接跑（全新库的正确路径）。
    // existing 非 null → 比对列：全齐则跳过，部分齐则报明确错（见下）。
    if (existing) {
      const have = new Set(existing);
      const missing = cols.filter((c) => !have.has(c.toLowerCase()));
      if (!missing.length) {
        console.log(`  = ${file} 的 ${cols.length} 个列已全部存在，跳过（--force 可强制重跑）`);
        skipped++;
        continue;
      }
      // 全新库走这里：0001 刚建的表只有 6 列，0002 要加 13 列 —— 这是**正常**的
      // 迁移序列（同批 migrations 天然依赖），必须执行。
      // 真冲突只有一种：部分列已存在（>=1 且不全），说明上次迁移中途失败。
      if (missing.length === cols.length) {
        console.log(`  → ${file} 待新增 ${cols.length} 列（全缺，正常迁移）`);
      } else {
        console.error(
          `  ! ${file}：表 ${tbl} 已有 ${cols.length - missing.length}/${cols.length} 列，` +
          `\n    说明上次迁移中途失败。SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，` +
          `\n    本脚本无法安全续跑。缺失列：${missing.join(", ")}` +
          `\n      请在 D1 控制台手工执行 ${file} 中剩余的 ADD COLUMN 语句` +
          `\n      （或 DROP TABLE ${tbl} 后重建——会丢该表数据）。`,
        );
        process.exit(1);
      }
    }
  }

  d1Execute(sql, file);
  applied++;
}

console.log(
  `\n[db-init] 完成：新执行 ${applied} 个，跳过 ${skipped} 个。` +
    (remote ? "（远程 D1）" : "（本地 D1）"),
);
if (!remote && !dryRun) {
  console.log("[db-init] 提醒：本地库与远程是两份数据，生产还需再跑一次 --remote。");
}