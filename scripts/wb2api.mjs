#!/usr/bin/env node
// wb2api.mjs — 网关运维 CLI（替代 Go 侧的 cmd/credit、cmd/login、cmd/signin、cmd/trial
// 以及 credit.sh / login.sh / signin.sh）。
//
// 关键差异：Go 版是遍历**本地 auths/ 目录的独立二进制**；Workers 部署下账号池在
// Durable Objects、凭证在 Secrets，没有本地目录可遍历 —— 所以这层退化成瘦客户端，
// 真正的批量能力在服务端（/panel/api/credits、/panel/api/trial、/panel/api/login/*）。
//
// 用法：
//   WB2A_URL=https://your.pages.dev WB2A_API_KEY=xxx node scripts/wb2api.mjs <命令>
//
// 命令：
//   credit [--pretty] [--realm=cn|global]   积分日报（默认 --pretty，对齐 credit.sh）
//   credit -json                            原始 JSON
//   signin                                  批量签到（对齐 signin.sh）
//   trial                                   批量领取 global trial 加油包（对齐 cmd/trial）
//   login [--realm=cn|global]               OAuth 登录，打印授权 URL 后轮询（对齐 login.sh）
//   regions                                 可选登录区域列表
const BASE = (process.env.WB2A_URL || "http://localhost:8788").replace(/\/+$/, "");
const KEY = process.env.WB2A_API_KEY || "";
const UA = { "User-Agent": "wb2api-cli/1.0", Accept: "application/json" };

if (!KEY) {
  console.error("请设置 WB2A_API_KEY（管理员总钥匙）");
  process.exit(2);
}

async function call(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { ...UA, ...(init.headers || {}), Authorization: `Bearer ${KEY}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error?.message || text.slice(0, 200)}`);
  return body;
}

function parseRealmArgs(args) {
  let realm = "";
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--realm") {
      if (i + 1 >= args.length) throw new Error("--realm 需要值");
      realm = String(args[++i]).toLowerCase();
    } else if (a.startsWith("--realm=")) {
      realm = a.slice(8).toLowerCase();
    } else {
      rest.push(a);
    }
  }
  if (realm && realm !== "cn" && realm !== "global") {
    throw new Error(`非法 --realm ${realm}（可选 cn|global）`);
  }
  return { realm, rest };
}

const pad = (s, n) => {
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return String(s) + " ".repeat(Math.max(0, n - w));
};
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n) : String(s));

function renderTable(head, rows, widths) {
  const lines = [head];
  rows.forEach((r, i) => {
    if (i === 0) lines.push(widths.map((w) => "-".repeat(w)).join("-+-"));
    lines.push(widths.map((w, j) => pad(trunc(r[j], w), w)).join(" | "));
  });
  return lines.join("\n");
}

const COMMANDS = {
  async credit(args) {
    const { realm, rest } = parseRealmArgs(args);
    const json = rest.includes("-json") || rest.includes("--json");
    const q = new URLSearchParams();
    if (realm) q.set("realm", realm);
    if (!json) q.set("pretty", "1");
    const r = await call(`/panel/api/credits?${q}`);
    if (json) return console.log(JSON.stringify(r));
    console.log(r.lines.join("\n"));
  },

  async signin(args) {
    const { realm } = parseRealmArgs(args);
    const q = realm ? `?realm=${realm}` : "";
    const r = await call(`/panel/api/signin_report${q}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    console.log(r.table);
    if (r.summary.fail > 0) process.exitCode = 1;
  },

  async trial() {
    const r = await call("/panel/api/trial", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const s = r.summary;
    console.log(
      renderTable(
        "uid                                  | nick        | status  | detail",
        r.accounts.map((a) => [a.uid, a.nickname, a.status, a.detail]),
        [36, 11, 7],
      ),
    );
    console.log(`\ntotal=${s.total} ok=${s.ok} already=${s.already} na=${s.na} fail=${s.fail}`);
    if (s.fail > 0) process.exitCode = 1;
  },

  async login(args) {
    const { realm, rest } = parseRealmArgs(args);
    const useRealm = realm || "cn";
    // start 是公开端点（登录前当然没有钥匙），故不带Authorization。
    const start = await fetch(`${BASE}/panel/api/login/start`, {
      method: "POST",
      headers: { ...UA, "Content-Type": "application/json" },
      body: JSON.stringify({ realm: useRealm }),
    });
    const s0 = await start.json();
    if (!start.ok || !s0.ok || !s0.url) {
      throw new Error(`取授权链接失败：${s0?.error || `HTTP ${start.status}`}`);
    }
    console.log("请在浏览器中打开以下链接完成登录：\n");
    console.log(`  ${s0.url}\n`);
    // 非交互环境（CI/管道）直接退出：拿不到浏览器输入，等价于用户取消。
    if (!process.stdin.isTTY) {
      console.log("非交互环境：已打印授权链接，登录完成后用 --state 轮询。");
      console.log(`  node scripts/wb2api.mjs poll --state ${s0.state}`);
      return;
    }
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question("完成登录后按 y 继续: ")).trim();
    rl.close();
    if (ans !== "y" && ans !== "Y") {
      console.log("已取消");
      process.exit(1);
    }
    console.log("正在获取 token...");
    const r = await call(`/panel/api/login/poll?state=${encodeURIComponent(s0.state)}`);
    if (!r.done) {
      console.log(`登录未完成：${r.error || "waiting for login"}`);
      process.exit(1);
    }
    console.log(`✓ ${r.nickname} (${r.uid}) 余额 ${r.credits}/${r.credits_total}`);
  },

  async poll(args) {
    const i = args.indexOf("--state");
    const state = i >= 0 ? args[i + 1] : "";
    if (!state) throw new Error("需要 --state <state>");
    const r = await call(`/panel/api/login/poll?state=${encodeURIComponent(state)}`);
    console.log(JSON.stringify(r, null, 2));
    if (!r.done) process.exitCode = 1;
  },

  async regions() {
    const r = await fetch(`${BASE}/panel/api/login/regions`, { headers: UA });
    console.log(JSON.stringify(await r.json(), null, 2));
  },

  help() {
    console.log(
      [
        "wb2api CLI —— 网关运维命令",
        "",
        "用法: WB2A_URL=... WB2A_API_KEY=... node scripts/wb2api.mjs <命令>",
        "",
        "  credit [--pretty|--json] [--realm=cn|global]  积分日报",
        "  signin                                       批量签到",
        "  trial                                        批量领取 global trial 加油包",
        "  login [--realm=cn|global]                    OAuth 登录",
        "  poll --state <state>                         轮询登录结果（CI 用）",
        "  regions                                      可选登录区域",
      ].join("\n"),
    );
  },
};

const [cmd, ...args] = process.argv.slice(2);
const fn = COMMANDS[cmd || "help"];
if (!fn) {
  console.error(`未知命令: ${cmd}（用 help 看用法）`);
  process.exit(2);
}
try {
  await fn(args);
} catch (e) {
  console.error("错误:", e?.message ?? e);
  process.exit(1);
}