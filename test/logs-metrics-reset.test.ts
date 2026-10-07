import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildApp } from "../src/router";
import { getConfig, invalidateConfig } from "../src/config";
import type { Env } from "../worker-configuration.d.ts";

// 运行日志页 / 用量重置 的端到端联调：直接打真实 Hono 路由，用一份内存 D1 模拟
// request_logs 表，验证「归一后的字段名」「真实统计概要」「清空重置」三件事。
//
// 之前运行日志空白的根因就在这三层叠加：
//   1) 后端 request_metrics 是写死的 {requests:0} 桩，前端只在 archive.enabled 时
//      才用真实的 request_logs → 整张请求记录表恒空；
//   2) 后端 request_logs 透传原始列（ts/ms/uid/id/credits），而前端按 Go 版口径
//      （time/duration_ms/account/request_id/credit_known）渲染 → 全表渲染成「—」；
//   3) 时间范围参数前端传秒、后端当毫秒比，筛选形同虚设（此处顺带修了 *1000）。
// 这个测试钉住这三处，防止再漂。

function memD1(seed: any[]) {
  const data = { request_logs: seed.slice() };
  const applyTs = (rows: any[], sql: string, p: any[]) => {
    let r = rows;
    if (sql.includes("ts >=")) r = r.filter((x) => x.ts >= Number(p[0]));
    if (sql.includes("ts <=")) {
      const g = sql.indexOf("ts >=");
      r = r.filter((x) => x.ts <= Number(p[g >= 0 ? 1 : 0]));
    }
    return r;
  };
  return {
    prepare: (sql: string) => ({
      bind: (...params: any[]) => ({
        all: async () => {
          if (/^SELECT \* FROM request_logs/.test(sql)) {
            return { results: applyTs(data.request_logs, sql, params).slice().sort((a, b) => b.ts - a.ts) };
          }
          if (/^SELECT ts, uid, model/.test(sql)) {
            return { results: applyTs(data.request_logs, sql, params) };
          }
          if (/^SELECT COUNT\(/.test(sql)) {
            const f = applyTs(data.request_logs, sql, params);
            const completed = f.length;
            const success = f.filter((x) => x.outcome === "success").length;
            const http = f.filter((x) => x.status >= 200 && x.status < 400).length;
            const avg = completed ? f.reduce((s, x) => s + (x.ms || 0), 0) / completed : 0;
            return { results: [{ completed, success, http_success: http, avg_ms: avg }] };
          }
          if (/^SELECT MIN\(ts\)/.test(sql)) return { results: [{ t: data.request_logs[0]?.ts ?? null }] };
          return { results: [] };
        },
        first: async () => {
          if (/^SELECT COUNT\(/.test(sql)) {
            const f = applyTs(data.request_logs, sql, params);
            const completed = f.length;
            const success = f.filter((x) => x.outcome === "success").length;
            const http = f.filter((x) => x.status >= 200 && x.status < 400).length;
            const avg = completed ? f.reduce((s, x) => s + (x.ms || 0), 0) / completed : 0;
            return { completed, success, http_success: http, avg_ms: avg };
          }
          if (/^SELECT MIN\(ts\)/.test(sql)) return { t: data.request_logs[0]?.ts ?? null };
          return null;
        },
        run: async () => {
          if (/^DELETE FROM request_logs/.test(sql)) {
            const n = data.request_logs.length;
            data.request_logs = [];
            return { meta: { changes: n, last_row_id: 0 } };
          }
          return { meta: { changes: 0, last_row_id: 0 } };
        },
      }),
    }),
  };
}

/**
 * 日志行的时间戳一律相对「当下」生成，不能写死绝对时刻。
 *
 * 曾经这里钉的是 1791200000000（2026-10-05），而 /panel/api/request_metrics
 * 的默认窗口是 hours=24 —— 传了 hours 才算范围，from = now-24h 参与 SQL 过滤。
 * 于是只要真实时钟走过那条数据一天，整批行就落到窗口外被滤光，completed 恒 0，
 * 测试随日历必然转红（本地隔天复现、CI 上莫名其妙挂掉，都是这个成因）。
 *
 * 改为 now 前推若干秒/分：三条行仍保持 10s 间隔的先后关系，且恒定落在任一
 * 合理窗口内。断言里改用这些常量而非字面量，避免两处各写一遍又漂移。
 */
const T0 = Date.now() - 60_000; // 一分钟前，稳在 24h / 1h 窗口内
const T1 = T0 + 10_000;
const T2 = T0 + 20_000;

const ROWS = [
  { id: 10, ts: T0, channel: "chat", outcome: "success", model: "cn:hy3", uid: "uid-aaaabbbbcccc1111", status: 200, ms: 1200, prompt_tokens: 100, completion_tokens: 200, credits: 0.5 },
  { id: 11, ts: T1, channel: "chat", outcome: "http_error", model: "cn:hy3", uid: "uid-aaaabbbbcccc1111", status: 502, ms: 300, prompt_tokens: 0, completion_tokens: 0, credits: 0 },
  { id: 12, ts: T2, channel: "sys", outcome: "interrupted", model: null, uid: null, status: 0, ms: 50, prompt_tokens: 0, completion_tokens: 0, credits: 0 },
];

function mkEnv(rows: any[]) {
  const kv = new Map<string, string>();
  return {
    WB2A_CONFIG: {
      put: async (k: string, v: string) => void kv.set(k, v),
      get: async (k: string, opts?: any) => {
        const raw = kv.get(k);
        if (raw == null) return null;
        if (opts?.type === "json") return JSON.parse(raw);
        return raw;
      },
      delete: async (k: string) => void kv.delete(k),
    },
    WB2A_CACHE: { put: async () => {}, get: async () => null, delete: async () => {} },
    WB2A_DB: memD1(rows),
    WB2A_LOGS: {},
    POOL: {
      get: () => ({ fetch: async () => new Response(JSON.stringify([{ uid: "uid-aaaabbbbcccc1111", inFlight: 2 }]), { headers: { "content-type": "application/json" } }) }),
      idFromName: () => ({}),
    },
    ASSETS: { fetch: async () => new Response("ok") },
  } as unknown as Env;
}

function app(): any {
  const a = new Hono<{ Bindings: Env }>();
  buildApp(a as any);
  return a;
}

const bearer = { Authorization: "Bearer k" };

describe("运行日志页：请求记录表字段归一", () => {
  beforeEach(() => invalidateConfig());

  it("request_logs 行被映射成前端口径（time/account/duration_ms/request_id/credit_known）", async () => {
    const env = mkEnv(ROWS);
    await (env as any).WB2A_CONFIG.put("config", JSON.stringify({ api_key: "k" }));
    const res = await app().fetch(new Request("https://x/panel/api/request_logs?limit=50", { headers: bearer }), env);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.entries).toHaveLength(3);
    const e = j.entries.find((x: any) => x.request_id === 10);
    expect(e.time).toBe(T0);
    expect(e.account).toBe("uid-aaaabbbbcccc1111"); // uid → account
    expect(e.duration_ms).toBe(1200); // ms → duration_ms
    expect(e.request_id).toBe(10); // id → request_id
    expect(e.credit).toBe(0.5);
    expect(e.credit_known).toBe(true);
    expect(e.total_tokens).toBe(300); // prompt+completion
    // 原始列名不应再泄露给前端
    expect(e.ts).toBeUndefined();
    expect(e.uid).toBeUndefined();
  });
});

describe("运行日志页：request_metrics 真实概要", () => {
  beforeEach(() => invalidateConfig());

  it("返回已完成/成功率/HTTP 成功率/平均耗时/在途，并标 d1=true", async () => {
    const env = mkEnv(ROWS);
    await (env as any).WB2A_CONFIG.put("config", JSON.stringify({ api_key: "k" }));
    const res = await app().fetch(new Request("https://x/panel/api/request_metrics?hours=24", { headers: bearer }), env);
    expect(res.status).toBe(200);
    const m: any = await res.json();
    expect(m.completed).toBe(3);
    // 业务成功 1/3（仅第一条 outcome=success）；HTTP 成功同样 1/3
    // （status 200 一条，502 与 0 都不算 2xx/3xx）。
    expect(m.success_rate).toBeCloseTo(1 / 3, 5);
    expect(m.http_success_rate).toBeCloseTo(1 / 3, 5);
    expect(m.avg_duration_ms).toBeCloseTo((1200 + 300 + 50) / 3, 5);
    expect(m.in_flight).toBe(2); // 来自 POOL /internal/list
    expect(m.d1).toBe(true);
  });

  it("全部历史预设（不发任何范围参数）仍统计整张表，不退化成近 24h", async () => {
    const env = mkEnv(ROWS);
    await (env as any).WB2A_CONFIG.put("config", JSON.stringify({ api_key: "k" }));
    // 不加 from/to/hours —— 前端「全部历史」预设就是这个样子。
    const res = await app().fetch(new Request("https://x/panel/api/request_metrics", { headers: bearer }), env);
    expect(res.status).toBe(200);
    const m: any = await res.json();
    expect(m.completed).toBe(3);
    expect(m.success_rate).toBeCloseTo(1 / 3, 5);
    expect(m.d1).toBe(true);
  });
});

describe("用量重置：清空 request_logs", () => {
  beforeEach(() => invalidateConfig());

  it("POST /panel/api/usage/reset 清空表，随后请求记录为空", async () => {
    const env = mkEnv(ROWS);
    await (env as any).WB2A_CONFIG.put("config", JSON.stringify({ api_key: "k" }));
    const r = await app().fetch(new Request("https://x/panel/api/usage/reset", { method: "POST", headers: bearer }), env);
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.ok).toBe(true);
    expect(b.deleted).toBe(3);

    const logs = await app().fetch(new Request("https://x/panel/api/request_logs?limit=50", { headers: bearer }), env);
    const j: any = await logs.json();
    expect(j.entries).toHaveLength(0);
  });
});
