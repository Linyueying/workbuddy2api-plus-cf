// 冒烟：用真实 miniflare（workerd）跑 dist/_worker.js，打面板核心接口，
// 确认控制面不 500。沙箱里这块长期没覆盖，是「控制台读不到」类回归的盲区。
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";

const mf = new Miniflare({
  modules: true,
  scriptPath: "dist/_worker.js",
  compatibilityDate: "2024-11-01",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { WB2A_DB: "smoke-db" },
  kvNamespaces: ["WB2A_CONFIG", "WB2A_CACHE"],
  durableObjects: { POOL: { className: "PoolDO", useSQLite: true } },
  // ASSETS 用桩：真实 Pages 由平台注入；这里只需让 /panel/* 不至于炸。
  serviceBindings: {
    ASSETS: () => new Response("<html>stub</html>", { headers: { "content-type": "text/html" } }),
  },
  bindings: { WB2A_API_KEY: "dev-admin-key" },
});

const ADMIN = "dev-admin-key";
// 面板鉴权：Authorization: Bearer <api_key>。miniflare 已绑 WB2A_API_KEY=dev-admin-key，
// getConfig 会用 env 覆盖 KV 里的 api_key（config.ts:272），故无需写 KV。

const paths = [
  "/healthz",
  "/status",
  "/panel/api/overview",
  "/panel/api/keys",
  "/panel/api/usage",
  "/panel/api/logs",
  "/panel/api/request_logs",
  "/panel/api/request_metrics",
  "/panel/api/models",
  "/panel/api/config",
  "/panel/api/model_probes",
];

let fail = 0;
for (const p of paths) {
  try {
    const res = await mf.dispatchFetch("http://localhost" + p, {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const body = await res.text();
    const ok = res.status < 400;
    if (!ok) fail++;
    console.log(`${ok ? "OK " : "ERR"} ${String(res.status).padEnd(4)} ${p}  ${body.slice(0, 120).replace(/\s+/g, " ")}`);
  } catch (e) {
    fail++;
    console.log(`THROW    ${p}  ${String(e?.message ?? e).slice(0, 200)}`);
  }
}
console.log(fail ? `\n${fail} 个接口异常` : "\n全部通过");
await mf.dispose();
process.exit(fail ? 1 : 0);
