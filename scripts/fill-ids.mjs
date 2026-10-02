#!/usr/bin/env node
// =============================================================================
// 把真实资源 ID 填进三个 wrangler.toml
// -----------------------------------------------------------------------------
// 存在的理由：
//   Pages 项目的 wrangler.toml 是配置的**唯一真源**——只要它在，Dashboard 里的
//   绑定就是只读、点不动的。所以资源 ID 没法靠网页点击填，只能写进文件。
//   本脚本让这件事变成「在 Dashboard 配几个环境变量」，而不是「改仓库文件」：
//
//     Pages / Workers Builds 的 Build command 里加一段：
//       npm install && npm run build && node scripts/fill-ids.mjs
//
//   构建机在 checkout 之后、部署之前跑它，用构建环境变量替换占位符。
//   仓库里的 wrangler.toml 永远保持 REPLACE_WITH_* 原样，ID 不进版本库。
//
// 用法：
//   CF_KV_CONFIG_ID=xxx CF_KV_CACHE_ID=yyy CF_D1_ID=zzz node scripts/fill-ids.mjs
//   node scripts/fill-ids.mjs --lenient     # 缺哪个就跳过哪个，不报错
//   node scripts/fill-ids.mjs --dry-run     # 只打印，不写文件
//
// 幂等：占位符已经没了再跑一次也不会动文件。
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = new Set(process.argv.slice(2));
const lenient = args.has("--lenient");
const dryRun = args.has("--dry-run");

// 占位符 -> 依次尝试的环境变量名（前者是 CI 用的，后者是本地惯用名）
const MAP = {
  REPLACE_WITH_CONFIG_KV_ID: ["CF_KV_CONFIG_ID", "WB2A_CONFIG_KV_ID"],
  REPLACE_WITH_CACHE_KV_ID: ["CF_KV_CACHE_ID", "WB2A_CACHE_KV_ID"],
  REPLACE_WITH_D1_ID: ["CF_D1_ID", "WB2A_D1_ID"],
};

// R2 是**可选**资源。桶不存在时 wrangler 部署会硬失败：
//   R2 bucket 'xxx' not found ... [code: 10085]
// 而建 R2 桶通常要绑支付方式，很多人不想开。所以默认**不绑 R2**——
// 只有显式配置 CF_R2_BUCKET 时才保留 [[r2_buckets]] 段。
// 代价：请求日志归档功能关闭，其他一切照常。
const R2_DEFAULT = "workbuddy2api-logs";
const R2_BUCKET = (process.env.CF_R2_BUCKET || process.env.WB2A_R2_BUCKET || "").trim();
const R2_ENABLED = R2_BUCKET.length > 0;

const TARGETS = [
  "wrangler.toml",
  "engine-worker/wrangler.toml",
];

/**
 * 把某个 TOML section 整体注释掉（保留行序，便于人工核对）。
 * 用于"可选绑定没启用"时把它从部署配置里摘掉。
 */
function disableSection(text, header) {
  const out = [];
  let inSection = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === header) {
      inSection = true;
      out.push(`# ${line}   # ← 未配置 CF_R2_BUCKET，已由 fill-ids 禁用`);
      continue;
    }
    if (inSection) {
      // 下一个 section 开始 → 本段结束
      if (t.startsWith("[[") || /^\[[^\]]+\]$/.test(t)) {
        inSection = false;
        out.push(line);
        continue;
      }
      out.push(t && !t.startsWith("#") ? `# ${line}` : line);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// 解析每个占位符的实际取值；取不到返回 null
function resolveValues() {
  const values = {};
  const missing = [];
  for (const [placeholder, envNames] of Object.entries(MAP)) {
    let v = "";
    for (const name of envNames) {
      if (process.env[name]) { v = process.env[name].trim(); break; }
    }
    if (v) values[placeholder] = v;
    else missing.push(`${placeholder}（环境变量 ${envNames.join(" 或 ")}）`);
  }
  return { values, missing };
}

const { values, missing } = resolveValues();

if (missing.length) {
  console.error(`[fill-ids] 缺少 ${missing.length} 个资源 ID：`);
  for (const m of missing) console.error(`  - ${m}`);
  console.error(
    "\n在 Cloudflare Dashboard 的 Settings > Environment variables 里添加：\n" +
    "  CF_KV_CONFIG_ID  = KV 命名空间 wb2api-config 的 ID\n" +
    "  CF_KV_CACHE_ID   = KV 命名空间 wb2api-cache 的 ID\n" +
    "  CF_D1_ID         = D1 数据库 workbuddy2api 的 ID\n" +
    "（可选 CF_R2_BUCKET = 桶名；不配则不绑 R2，仅关闭日志归档）\n",
  );
  if (!lenient) process.exit(1);
  console.error("[fill-ids] --lenient：跳过缺失项继续\n");
}

let touched = 0;
for (const rel of TARGETS) {
  const path = resolve(root, rel);
  if (!existsSync(path)) {
    console.error(`[fill-ids] 跳过（不存在）：${rel}`);
    continue;
  }
  let text = readFileSync(path, "utf8");
  const before = text;

  for (const [placeholder, value] of Object.entries(values)) {
    text = text.split(placeholder).join(value);
  }
  // R2：配了桶名就换桶名，没配就把整个绑定段摘掉（否则部署会因找不到桶而失败）
  if (R2_ENABLED) {
    if (R2_BUCKET !== R2_DEFAULT) text = text.split(R2_DEFAULT).join(R2_BUCKET);
  } else {
    text = disableSection(text, "[[r2_buckets]]");
  }

  if (text === before) {
    console.log(`[fill-ids] ${rel}: 无需改动（已是真实 ID 或无对应占位符）`);
    continue;
  }
  if (dryRun) {
    console.log(`[fill-ids] ${rel}: 将写入（--dry-run，未落盘）`);
    touched++;
    continue;
  }
  writeFileSync(path, text);
  console.log(`[fill-ids] ${rel}: 已写入`);
  touched++;
}

// 兜底自检：写完后不该还有占位符残留
if (!lenient && !dryRun) {
  for (const rel of TARGETS) {
    const path = resolve(root, rel);
    if (!existsSync(path)) continue;
    const left = [...readFileSync(path, "utf8").matchAll(/REPLACE_WITH_\w+/g)].map((m) => m[0]);
    if (left.length) {
      console.error(`[fill-ids] ${rel} 仍有残留占位符：${[...new Set(left)].join(", ")}`);
      process.exit(1);
    }
  }
}

if (!R2_ENABLED) {
  console.log(
    "[fill-ids] R2 未配置（无 CF_R2_BUCKET）→ 已摘掉 [[r2_buckets]] 绑定段\n" +
    "           日志归档功能关闭，其余功能不受影响。想开启就配 CF_R2_BUCKET=<桶名>",
  );
}
console.log(`[fill-ids] 完成，改动 ${touched} 个文件`);
