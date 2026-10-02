// 把 auths/*.json 导入账号池（经 Worker 的 /panel/api/import/auths）。
// 兼容嵌套形 {auth,account} 与扁平形；realm 按 domain 后缀 backfill。
// 用法：
//   WB2A_URL=https://your.pages.dev WB2A_API_KEY=xxx node scripts/import-auths.mjs ./auths
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const url = process.env.WB2A_URL || "http://localhost:8788";
const key = process.env.WB2A_API_KEY;
if (!key) {
  console.error("请设置 WB2A_API_KEY");
  process.exit(1);
}
const dir = process.argv[2] || "./auths";
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error("未找到 auths 目录:", dir);
  process.exit(1);
}

function inferRealm(domain) {
  return domain.endsWith(".workbuddy.ai") ? "global" : "cn";
}
function parseAuth(j) {
  if (j.auth || j.account) {
    const a = j.auth || {};
    const ac = j.account || {};
    const domain = a.domain || j.domain || "";
    const realm = a.realm || ac.realm || inferRealm(domain);
    return {
      accessToken: a.accessToken || "",
      refreshToken: a.refreshToken || "",
      expiresAt: Number(a.expiresAt || Date.now() + 3600_000),
      domain,
      realm,
      uid: String(a.uid ?? ac.uid ?? ""),
      enterpriseId: String(a.enterpriseId ?? ac.enterpriseId ?? ""),
      nickname: String(a.nickname ?? ac.nickname ?? a.uid ?? "unknown"),
      device_token: a.device_token ?? j.device_token,
    };
  }
  const domain = j.domain || "";
  return {
    accessToken: j.accessToken || "",
    refreshToken: j.refreshToken || "",
    expiresAt: Number(j.expiresAt || Date.now() + 3600_000),
    domain,
    realm: j.realm || inferRealm(domain),
    uid: String(j.uid ?? ""),
    enterpriseId: String(j.enterpriseId ?? ""),
    nickname: String(j.nickname ?? j.uid ?? "unknown"),
    device_token: j.device_token,
  };
}

const files = readdirSync(dir).filter((f) => /^workbuddy.*\.json$/.test(f));
const accounts = [];
for (const f of files) {
  try {
    const j = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
    accounts.push(parseAuth(j));
  } catch (e) {
    console.error("跳过", f, e.message);
  }
}
console.log("解析到", accounts.length, "个账号");

const res = await fetch(url + "/panel/api/import/auths", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
  body: JSON.stringify({ accounts }),
});
console.log("status", res.status, await res.text());
