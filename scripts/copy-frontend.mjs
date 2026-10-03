// 把前端静态资源拷贝进 dist/panel/（Pages 构建输出）。
// 前端来自 vendor/frontend（已从原仓库 internal/panel 取得，零改动部署）。
import { mkdirSync, cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const src = process.env.FRONTEND_SRC
  ? resolve(root, process.env.FRONTEND_SRC)
  : resolve(root, "vendor/frontend");
const dest = resolve(root, "dist/panel");

if (!existsSync(src)) {
  console.error("[copy-frontend] 未找到前端源目录:", src);
  process.exit(0); // 允许无前端构建
}

// 前端 JS 语法自检：后端有 tsc 把关，前端此前完全裸奔——一个括号错位
// （如 Edit 插函数时吞掉上一个函数的头 → Illegal return）会让整个面板
// 白屏，却照样构建成功、部署上线。这里用 node --check 在构建期拦下。
function checkJsSyntax(file) {
  const p = join(src, file);
  if (!existsSync(p)) return;
  try {
    execFileSync(process.execPath, ["--check", p], { stdio: "pipe" });
  } catch (e) {
    const out = String(e?.stderr ?? e?.stdout ?? e?.message ?? e);
    console.error(`[copy-frontend] ❌ 前端 ${file} 语法错误，构建中止：\n${out}`);
    process.exit(1);
  }
}
checkJsSyntax("app.js");

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

// 复检产物（拷贝后仍是同一个文件，但挡住"拷错目录"这类低级错误）。
checkJsSyntax("app.js");
console.log("[copy-frontend] 已复制前端到", dest);
