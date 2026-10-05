import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { registerPanel, resetUsageCache } from "../src/routes/panel";
import type { Env } from "../worker-configuration.d.ts";

// 用量页的 D1 扫描量守卫。
//
// 为什么单独成测：`/panel/api/usage` 是本项目最贵的一笔账——queryUsageWindow 扫
// 窗口内**全部**日志行（上限 5 万），而 D1 免费额度按**扫描行数**计（500 万行/天，
// 不是返回行数）。前端 60s 轮询，一次刷新 = 一次全窗扫描；没有缓存时额度会以一种
// 极难归因的方式耗尽（症状是某天起用量页集体 500）。
//
// 这里不做「返回内容对不对」的断言（那是 usage.test.ts 的事），只钉住
// 「同样的窗口重复刷新不会重复扫库」——这才是额度问题。

/** 计数型 D1：只关心「扫了几次 request_logs」，不关心返回什么。 */
function countingDB() {
  const scans: string[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        async all() {
          if (/FROM\s+request_logs/i.test(sql)) scans.push(sql);
          return { results: [] };
        },
        async run() {
          return { meta: { last_row_id: 1, changes: 1 } };
        },
        async first() {
          if (/FROM\s+request_logs/i.test(sql)) scans.push(sql);
          return null;
        },
      }),
    }),
  } as any;
  return { db, scans };
}

function envWith(db: any): Env {
  const kv = new Map<string, string>();
  const noopKV = { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async () => {} };
  return {
    WB2A_DB: db,
    WB2A_CONFIG: noopKV,
    WB2A_CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
    WB2A_LOGS: {},
    POOL: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }) }),
    },
  } as unknown as Env;
}

function mkApp() {
  const app = new Hono<{ Bindings: Env }>();
  registerPanel(app as any);
  return app;
}

async function hit(app: any, env: any, qs = "?hours=24") {
  const res = await app.fetch(new Request("https://x/panel/api/usage" + qs), env);
  return res.json().catch(() => null);
}

describe("用量页：重复刷新不得重复扫 D1", () => {
  beforeEach(() => resetUsageCache());

  it("同窗口连续刷新只扫一次（缓存 TTL 必须与轮询间隔错开）", async () => {
    const { db, scans } = countingDB();
    const app = mkApp();
    const env = envWith(db);

    await hit(app, env);
    const after1 = scans.length;
    expect(after1).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) await hit(app, env);
    // 5 次刷新仍然只扫了一次——这正是加缓存的全部意义（60s 轮询 × 全窗扫描
    // 会把 500 万行/天的额度在几天内刷穿）。
    expect(scans.length).toBe(after1);
  });

  it("换窗口才重新扫（缓存键按窗口区分，不能把 1 小时的数据当成 24 小时回）", async () => {
    const { db, scans } = countingDB();
    const app = mkApp();
    const env = envWith(db);

    await hit(app, env, "?hours=24");
    const after1 = scans.length;
    await hit(app, env, "?hours=1");
    expect(scans.length).toBeGreaterThan(after1);
  });

  it("返回的仍是可用视图模型（缓存不能把页面缓存成空壳）", async () => {
    const { db } = countingDB();
    const app = mkApp();
    const env = envWith(db);
    const r: any = await hit(app, env);
    expect(r?.ok).toBe(true);
    expect(Array.isArray(r?.series)).toBe(true);
    expect(Array.isArray(r?.by_model)).toBe(true);
  });
});
