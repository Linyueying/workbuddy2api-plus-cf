// 把前端静态资源拷贝进 dist/panel/（Pages 构建输出）。
// 前端来自 vendor/frontend（已从原仓库 internal/panel 取得，零改动部署）。
import { mkdirSync, cpSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log("[copy-frontend] 已复制前端到", dest);
