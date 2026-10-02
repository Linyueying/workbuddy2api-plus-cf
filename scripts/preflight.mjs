#!/usr/bin/env node
// preflight.mjs — 部署前体检。逐项检查会静默把生产环境搞坏的东西。
//
// 存在的理由：这三个阻塞项的共同特点是**部署命令照样成功**，问题在几小时后才暴露——
//   1. wrangler.toml 的占位符 ID 没换→ 绑到错误/不存在的资源；
//   2. D1 没建表→ 部署成功，首个写请求才500；
//   3. WB2A_API_KEY Secret 没设 → 部署成功，面板全锁（鉴权恒 401）。
// 逐条 `wrangler pages deploy` 不会拦你任何一条。
//
// 用法：
//   node scripts/preflight.mjs            # 检查本地配置 + 可选探测远端
//   node scripts/preflight.mjs --remote   # 额外检查远端 D1 表与线上健康
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const remote = process.argv.includes("--remote");

const PASS = "✓";
const FAIL = "✗";
const WARN = "!";

let failed = 0;
let warned = 0;
function ok(msg) { console.log(`  ${PASS} ${msg}`); }
function bad(msg) { failed++; console.log(`  ${FAIL} ${msg}`); }
function warn(msg) { warned++; console.log(`  ${WARN} ${msg}`); }

const out = (v) => (Buffer.isBuffer(v) ? v.toString("utf8") : String(v ?? ""));

// ---------------------------------------------------------------------------
// 1. wrangler.toml 占位符
// ---------------------------------------------------------------------------
console.log("\n[1] wrangler.toml 绑定配置");

// 纯网页部署通道：.github/workflows/deploy.yml 会在 CI 里用 GitHub Secrets
// 替换占位符，所以仓库里保留 REPLACE_WITH_* 是**预期状态**，不该报错。
// 只有走本地 CLI / Cloudflare 原生 Git 集成时才需要真实写进文件。
const hasActionsDeploy = existsSync(resolve(root, ".github/workflows/deploy.yml"));

function reportPlaceholders(label, text, file) {
  const ph = [...new Set([...text.matchAll(/REPLACE_WITH_\w+/g)].map((m) => m[0]))];
  if (!ph.length) return true;
  if (hasActionsDeploy) {
    warn(`${label} 有占位符 ${ph.join(", ")} —— 由 GitHub Actions 用 Secrets 注入，无需改文件`);
    return true;
  }
  bad(`${label} 仍有占位符：${ph.join(", ")}`);
  if (file === "wrangler.toml") {
    console.log("     创建真实资源后填入 wrangler.toml：");
    console.log("       npx wrangler kv namespace create WB2A_CONFIG");
    console.log("       npx wrangler kv namespace create WB2A_CACHE");
    console.log("       npx wrangler d1 create workbuddy2api");
    console.log("     或改走纯网页通道，见 DEPLOY-WEB.md 方案 A");
  }
  return false;
}

const toml = readFileSync(resolve(root, "wrangler.toml"), "utf8");
if (reportPlaceholders("wrangler.toml", toml, "wrangler.toml")) {
  ok("绑定配置就绪");
}
if (hasActionsDeploy) {
  ok("检测到 .github/workflows/deploy.yml → 纯网页部署通道可用");
  console.log("     需要填的 Secrets 见 DEPLOY-WEB.md 第 4 步");
}

// R2 桶名是字面量不是占位符，上面的占位符扫描抓不到它。桶不存在时 wrangler
// 会在部署阶段报binding 错误，而 preflight 若不查就会一路绿灯到部署。
console.log("\n[1b] R2 日志桶");
const r2Name = toml.match(/\[\[r2_buckets\]\][^[]*?bucket_name\s*=\s*"([^"]+)"/)?.[1];
if (!r2Name) {
  warn("wrangler.toml 未声明 r2_buckets（请求日志归档将不可用）");
} else {
  try {
    const listOut = out(execFileSync(
      "npx", ["wrangler", "r2", "bucket", "list"], { stdio: ["ignore", "pipe", "pipe"], cwd: root },
    ));
    if (new RegExp(`\\b${r2Name}\\b`).test(listOut)) {
      ok(`R2 桶已存在：${r2Name}`);
    } else {
      bad(`R2 桶不存在：${r2Name} → npx wrangler r2 bucket create ${r2Name}`);
    }
  } catch (e) {
    // 未登录 wrangler 时无法判定，不阻塞本地检查
    warn(`无法列举 R2 桶（wrangler 未登录？）：${(out(e.stderr) || out(e.message)).split("\n")[0]}`);
    console.log(`     生产需确认桶已创建：npx wrangler r2 bucket create ${r2Name}`);
  }
}

// ---------------------------------------------------------------------------
// 2. migrations 文件与代码一致性（静态检查，不连远端）
// ---------------------------------------------------------------------------
console.log("\n[2] D1 迁移");
const migDir = resolve(root, "migrations");
const migs = existsSync(migDir)
  ? readFileSyncSafe(migDir).filter((f) => f.endsWith(".sql")).sort()
  : [];
if (!migs.length) {
  bad("migrations/ 下没有 .sql 文件");
} else {
  ok(`migrations/: ${migs.join(", ")}`);
  // 代码实际查询的表必须都在某个迁移里建过
  const d1Src = readFileSync(resolve(root, "src/storage/d1.ts"), "utf8");
  // 排除 SQL 关键字与函数名：UPDATE x SET / FROM(SELECT ...)、INSERT ... VALUES 等。
  const SQL_KW = new Set([
    "SELECT", "SET", "VALUES", "WHERE", "ORDER", "GROUP", "LIMIT", "OFFSET",
    "AND", "OR", "NOT", "AS", "ON", "BY", "CASE", "WHEN", "THEN", "ELSE", "END",
  ]);
  const tables = [...new Set(
    [...d1Src.matchAll(/\b(?:FROM|INTO|UPDATE)\s+(\w+)/gi)]
      .map((m) => m[1])
      .filter((t) => !SQL_KW.has(t.toUpperCase())),
  )];
  const allSql = migs.map((f) => readFileSync(resolve(migDir, f), "utf8")).join("\n");
  const created = new Set(
    [...allSql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)].map((m) => m[1]),
  );
  const missing = tables.filter((t) => !created.has(t));
  if (missing.length) {
    bad(`代码用到但迁移未建表：${missing.join(", ")}`);
  } else {
    ok(`代码引用的表均已建：${tables.join(", ")}`);
  }
}

function readFileSyncSafe(dir) {
  try {
    return execFileSync("ls", [dir], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 2b. 账号池 Worker（Pages 无法自带 DO，PoolDO 必须独立部署且先于 Pages）
// ---------------------------------------------------------------------------
console.log("\n[2b] 账号池 Worker（PoolDO 独立部署）");
const poolTomlPath = resolve(root, "pool-worker/wrangler.toml");
if (!existsSync(poolTomlPath)) {
  bad("缺 pool-worker/wrangler.toml —— PoolDO 无处可部署");
} else {
  const poolToml = readFileSync(poolTomlPath, "utf8");
  const poolName = poolToml.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? "";
  const hasMigrations = /\[\[migrations\]\]/.test(poolToml);
  // Pages 侧 script_name 必须指向这个 Worker 的名字，否则运行时找不到 DO
  const scriptName = toml.match(/script_name\s*=\s*"([^"]+)"/)?.[1] ?? "";
  if (!hasMigrations) {
    bad("pool-worker/wrangler.toml 缺 [[migrations]]：DO 类不会被注册");
  } else if (!poolName) {
    bad("pool-worker/wrangler.toml 未声明 name");
  } else if (scriptName !== poolName) {
    bad(
      `Pages 的 script_name="${scriptName}" 与 pool worker 的 name="${poolName}" 不一致` +
        ` → 运行时找不到 DO。改 wrangler.toml 的 script_name`,
    );
  } else {
    ok(`script_name 与 pool worker 名一致：${poolName}`);
  }
  // 产物是否已构建
  if (!existsSync(resolve(root, "pool-worker/dist/index.js"))) {
    warn("pool-worker 未构建 → 部署前跑 npm run build:pool");
    console.log("     部署顺序：npm run deploy:pool（先）→ Pages 部署（后）");
  } else {
    ok("pool-worker/dist/index.js 已构建");
  }
  reportPlaceholders("pool-worker/wrangler.toml", poolToml, "pool-worker/wrangler.toml");
}

// ---------------------------------------------------------------------------
// 2c. 定时作业 Worker（Pages 无 Cron Triggers，调度必须放 Workers）
// ---------------------------------------------------------------------------
console.log("\n[2c] 定时作业 Worker（Cron）");
const schedTomlPath = resolve(root, "scheduler-worker/wrangler.toml");
if (!existsSync(schedTomlPath)) {
  warn("缺 scheduler-worker/wrangler.toml —— 定时作业需外部 cron 或 DO alarm 兜底");
} else {
  const st = readFileSync(schedTomlPath, "utf8");
  const crons = st.match(/crons\s*=\s*\[([^\]]*)\]/)?.[1] ?? "";
  if (!/crons\s*=/.test(st)) {
    bad("scheduler-worker 未配置 [triggers] crons —— 不会有任何定时触发");
  } else {
    ok(`crons: ${crons.replace(/\s+/g, " ").trim()}`);
  }
  const sName = st.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? "";
  if (!sName) bad("scheduler-worker/wrangler.toml 未声明 name");
  else ok(`scheduler worker: ${sName}`);
  reportPlaceholders("scheduler-worker/wrangler.toml", st, "scheduler-worker/wrangler.toml");
  if (!existsSync(resolve(root, "scheduler-worker/dist/index.js"))) {
    warn("scheduler-worker 未构建 → 部署前跑 npm run build:scheduler");
  } else {
    ok("scheduler-worker/dist/index.js 已构建");
  }
}

// ---------------------------------------------------------------------------
// 3. API key（本地 Secret 文件）
// ---------------------------------------------------------------------------
console.log("\n[3] 管理员密钥");
const devVars = resolve(root, ".dev.vars");
const envKey = process.env.WB2A_API_KEY;
if (existsSync(devVars) && /WB2A_API_KEY\s*=\s*\S+/.test(readFileSync(devVars, "utf8"))) {
  ok(".dev.vars 已设 WB2A_API_KEY（本地）");
} else if (envKey) {
  ok("环境变量 WB2A_API_KEY 已设");
} else {
  warn("本地未设 WB2A_API_KEY");
  console.log("     这本身不影响部署，但意味着你无法验证鉴权路径。");
  console.log("     生产必须设置（否则面板全锁）：");
  console.log("       npx wrangler pages secret put WB2A_API_KEY --project-name <name>");
}

// ---------------------------------------------------------------------------
// 4. 构建产物
// ---------------------------------------------------------------------------
console.log("\n[4] 构建产物");
const worker = resolve(root, "dist/_worker.js");
if (existsSync(worker)) {
  const kb = Math.round((readFileSync(worker).length / 1024) * 10) / 10;
  if (kb > 1000) warn(`dist/_worker.js ${kb}KB，接近 Pages 免费额度上限（1MB）`);
  else ok(`dist/_worker.js ${kb}KB`);
} else {
  bad("dist/_worker.js 不存在（先 npm run build）");
}
const panel = resolve(root, "dist/panel/index.html");
if (existsSync(panel)) ok("dist/panel/index.html 已就位");
else bad("dist/panel/index.html 不存在（前端未拷贝，先 npm run build）");

// ---------------------------------------------------------------------------
// 5. 远端检查（--remote）
// ---------------------------------------------------------------------------
if (remote) {
  console.log("\n[5] 远端 D1 表（--remote）");
  try {
    const o = out(execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "WB2A_DB", "--remote", "--json",
       "--command", "SELECT name FROM sqlite_master WHERE type='table'"],
      { stdio: ["ignore", "pipe", "pipe"], cwd: root },
    ));
    const remoteTables = [...o.matchAll(/"name":\s*"(\w+)"/g)].map((m) => m[1]);
    const need = ["apikeys", "request_logs", "usage", "task_queue"];
    const absent = need.filter((t) => !remoteTables.includes(t));
    if (absent.length) {
      bad(`远端缺表：${absent.join(", ")} → 先跑 node scripts/db-init.mjs --remote`);
    } else {
      ok(`远端表齐：${remoteTables.join(", ")}`);
    }
    // apikeys 的 15 个管控列
    const o2 = out(execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "WB2A_DB", "--remote", "--json", "--command", "PRAGMA table_info(apikeys)"],
      { stdio: ["ignore", "pipe", "pipe"], cwd: root },
    ));
    const cols = new Set([...o2.matchAll(/"name":\s*"(\w+)"/g)].map((m) => m[1]));
    const needCols = ["enabled", "expires_at", "realm", "quota", "used_tokens", "seq"];
    const missCols = needCols.filter((c) => !cols.has(c));
    if (missCols.length) {
      bad(`远端 apikeys 缺列：${missCols.join(", ")} → 跑 node scripts/db-init.mjs --remote`);
    } else {
      ok("远端 apikeys 管控列齐");
    }
  } catch (e) {
    bad("远端 D1 查询失败（占位符 ID 未替换或未登录？）");
    console.log("  " + (out(e.stderr) || out(e.message)).split("\n").slice(0, 3).join("\n  "));
  }

  console.log("\n[6] 线上健康（填入 WB2A_URL 或 --url=<pages 域名>）");
  const urlArg = process.argv.find((a) => a.startsWith("--url="));
  const url = urlArg?.slice(6) || process.env.WB2A_URL;
  if (!url) {
    warn("未提供线上地址，跳过健康探测（加 --url=https://xxx.pages.dev）");
  } else {
    try {
      const h = await fetch(`${url.replace(/\/+$/, "")}/healthz`, { signal: AbortSignal.timeout(15000) });
      if (h.ok) ok(`/healthz ${h.status}`);
      else bad(`/healthz ${h.status}`);
    } catch (e) {
      bad(`/healthz 不可达：${e.message}`);
    }
    // 鉴权：空钥匙应 401，若200 说明鉴权失效
    try {
      const a = await fetch(`${url.replace(/\/+$/, "")}/panel/api/overview`, { signal: AbortSignal.timeout(15000) });
      if (a.status === 401) ok("鉴权生效（无钥匙 401）");
      else if (a.status === 200) bad("鉴权失效：空钥匙竟然 200，面板形同无锁");
      else warn(`/panel/api/overview 返回 ${a.status}（非 401/200，需人工确认）`);
    } catch (e) {
      warn(`鉴权探测失败：${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log(
  `\n[preflight] ${failed ? "✗ 有阻塞项" : "✓ 无阻塞项"}` +
  (warned ? `，${warned} 项提醒` : "") + "。",
);
process.exit(failed ? 1 : 0);