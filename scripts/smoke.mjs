#!/usr/bin/env node
// smoke.mjs — 部署后冒烟测试。验证「能连上、能鉴权、核心读写通」。
//
// 与 preflight 的分工：preflight 查配置与产物（部署**前**），smoke 打真实
// 端点（部署**后**）。两者都过了才算这次上线真的可用。
//
// 用法：
//   WB2A_URL=https://xxx.pages.dev WB2A_API_KEY=yyy node scripts/smoke.mjs
//   node scripts/smoke.mjs --url=http://127.0.0.1:8788 --key=dev-admin-key
//   node scripts/smoke.mjs --url=... --key=... --with-upstream   # 额外打真实上游（会消耗配额）
const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const URL = (arg("url", process.env.WB2A_URL || "http://127.0.0.1:8788") || "").replace(/\/+$/, "");
const KEY = arg("key", process.env.WB2A_API_KEY || "");
const WITH_UPSTREAM = process.argv.includes("--with-upstream");

let failed = 0;
let passed = 0;
function ok(m) { passed++; console.log(`  ✓ ${m}`); }
function bad(m) { failed++; console.log(`  ✗ ${m}`); }

async function call(path, init = {}) {
  const res = await fetch(URL + path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers || {}),
      ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}

console.log(`[smoke] 目标 ${URL}\n`);

// 1. 静态资源
console.log("[1] 静态资源");
try {
  const res = await fetch(`${URL}/panel/`, { signal: AbortSignal.timeout(20000) });
  if (res.ok) ok(`/panel/ ${res.status}`);
  else bad(`/panel/ ${res.status}（前端未部署？）`);
} catch (e) {
  bad(`/panel/ 不可达：${e.message}`);
}

// 2. 健康 + 就绪
console.log("\n[2] 健康检查");
try {
  const { status, body } = await call("/healthz");
  const checks = body.checks ?? [];
  const badChecks = checks.filter((c) => !c.ok);
  if (body.ready === true) ok(`ready（${checks.length} 项自检全过）`);
  else {
    bad(`not ready（${status}）`);
    for (const c of badChecks) console.log(`      · ${c.name}: ${c.hint ?? "失败"}`);
  }
  // 空池是正常中间态，只提示不失败
  if (body.healthy) ok(`池内可服务账号 ${body.total}`);
  else console.log(`  · 池内暂无可服务账号（新部署正常，导入账号后恢复）`);
} catch (e) {
  bad(`/healthz 不可达：${e.message}`);
}

// 3. 鉴权
console.log("\n[3] 鉴权");
try {
  const noAuth = await fetch(`${URL}/panel/api/overview`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (noAuth.status === 401) ok("无钥匙 → 401");
  else if (noAuth.status === 200) bad("无钥匙竟然 200，鉴权失效，面板形同无锁");
  else bad(`无钥匙返回 ${noAuth.status}（期望 401）`);

  if (!KEY) {
    console.log("  · 未提供key，跳过带钥匙的接口验证");
  } else {
    const { status, body } = await call("/panel/api/overview");
    if (status === 200) ok(`带钥匙 → 200（账号 ${body.total ?? "?"} 个）`);
    else bad(`带钥匙返回 ${status}：${body?.error ?? "?"}`);
  }
} catch (e) {
  bad(`鉴权探测失败：${e.message}`);
}

// 4. 核心读写（D1 通了没）
console.log("\n[4] 核心接口");
if (!KEY) {
  console.log("  · 未提供 key，跳过");
} else {
  // 读
  for (const [name, path] of [
    ["keys（子密钥）", "/panel/api/keys"],
    ["models（模型目录）", "/panel/api/models"],
    ["config（配置）", "/panel/api/config"],
  ]) {
    try {
      const { status, body } = await call(path);
      if (status === 200) ok(`${name} 200`);
      else bad(`${name} ${status}：${body?.error ?? JSON.stringify(body).slice(0, 120)}`);
    } catch (e) {
      bad(`${name} 异常：${e.message}`);
    }
  }
  // 写：建一个临时子密钥再删掉，验证 D1 写路径 + apikeys 表结构完整
  try {
    const { status, body } = await call("/panel/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `smoke-${Date.now()}`, models: [] }),
    });
    if (status === 200 && body?.id) {
      ok(`写：创建子密钥成功`);
      const del = await call(`/panel/api/keys/${encodeURIComponent(body.id)}`, { method: "DELETE" });
      if (del.status === 200) ok("写：删除子密钥成功（D1 读写双向通）");
      else bad(`删除子密钥 ${del.status}`);
    } else {
      bad(`创建子密钥 ${status}：${body?.error ?? JSON.stringify(body).slice(0, 120)}`);
    }
  } catch (e) {
    bad(`写路径异常：${e.message}`);
  }
  // CLI 新增的批量端点
  try {
    const { status, body } = await call("/panel/api/credits?pretty=1");
    if (status === 200) ok(`credits 日报 200（${body.lines?.length ?? 0} 行）`);
    else bad(`credits ${status}`);
  } catch (e) {
    bad(`credits 异常：${e.message}`);
  }
}

// 5. 可选：真实上游
if (WITH_UPSTREAM) {
  console.log("\n[5] 真实上游（--with-upstream）");
  if (!KEY) {
    console.log("  · 未提供 key，跳过");
  } else {
    try {
      const { status, body } = await call("/panel/api/models");
      const n = Array.isArray(body?.data) ? body.data.length : 0;
      if (status === 200) ok(`模型目录 ${n} 个（上游可达）`);
      else bad(`模型目录 ${status}`);
    } catch (e) {
      bad(`上游探测异常：${e.message}`);
    }
  }
} else {
  console.log("\n[5] 真实上游：跳过（加 --with-upstream 开启，会消耗配额）");
}

console.log(
  `\n[smoke] ${failed ? "✗ " + failed + " 项失败" : "✓ 全部通过"}` +
  (passed ? `（${passed} 项）` : ""),
);
process.exit(failed ? 1 : 0);