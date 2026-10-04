#!/usr/bin/env node
// 构建前生成 src/generated/build-info.ts（当前 HEAD 短提交号）。
//
// 被 esbuild 打进 worker bundle，/panel/api/overview 以 commit 字段透出，
// 面板左上角品牌块显示「版本 · 提交号」。文件已提交进仓库作为兜底：
// 脚本在任何非 git 环境静默跳过（保留现有文件 / 首次写 dev），绝不因
// 生成失败断掉 npm run build。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "generated", "build-info.ts");

function shortHead() {
  try {
    const s = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return s || "dev";
  } catch {
    return "dev"; // 非 git 环境（源码包直接部署等）
  }
}

const commit = shortHead();
const content = `// 由 scripts/gen-commit.mjs 在构建时生成——不要手改。\nexport const BUILD_COMMIT = "${commit}";\n`;

if (existsSync(OUT) && readFileSync(OUT, "utf8") === content) {
  process.exit(0); // 内容未变不重写，避免扰动增量构建
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, content);
console.log(`[gen-commit] BUILD_COMMIT = ${commit}`);
