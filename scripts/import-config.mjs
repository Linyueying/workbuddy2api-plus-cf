// 把 config.json 导入 KV（经 Worker 的 /panel/api/import/config）。
// 用法：
//   WB2A_URL=https://your.pages.dev WB2A_API_KEY=xxx node scripts/import-config.mjs ./config.json
// 本地：WB2A_API_KEY=dev-admin-key node scripts/import-config.mjs ./config.json
import { readFileSync } from "node:fs";

const url = process.env.WB2A_URL || "http://localhost:8788";
const key = process.env.WB2A_API_KEY;
if (!key) {
  console.error("请设置 WB2A_API_KEY");
  process.exit(1);
}
const path = process.argv[2] || "./config.json";
const cfg = JSON.parse(readFileSync(path, "utf8"));

const res = await fetch(url + "/panel/api/import/config", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
  body: JSON.stringify(cfg),
});
console.log("status", res.status, await res.text());
