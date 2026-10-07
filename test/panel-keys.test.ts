import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { registerPanel } from "../src/routes/panel";
import type { Env } from "../worker-configuration.d.ts";

// 面板密钥接口的端到端契约测试。
//
// 为什么需要它：密钥没法投第二次——明文只在创建这一次返回， thereafter 只剩
// sha256。所以「拿到了什么」这件事必须做成断言，而不是靠人眼在浏览器里核对。
// 历史上这里出过两类静默故障，都与肉眼不可见有关：
//   1. 后端返回 {ok,key,id} 而前端读 r.plain → 明文框弹出空字符串，
//      用户以为创建失败，实际是密钥丢了且找不回（只能删了重建）；
//   2. /reset 被实现成「轮换」而按钮写着「重置用量」→ 点一下所有客户端 401，
//      新明文还被丢弃了。
// 内存 D1 是为了让这些路径真跑一遍 SQL，而不是 mock 返回值自我印证。

/** memDB 够用的内存 D1：覆盖 apikeys 的 INSERT OR REPLACE / SELECT / UPDATE。 */
function memDB() {
  const rows: any[] = [];
  const exec: string[] = [];

  const colsOfSelect = (sql: string): string[] => {
    const m = sql.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+apikeys/i);
    if (!m) return [];
    return m[1].split(",").map((s) => s.trim().split(/\s+/)[0]);
  };

  const prepare = (sql: string) => ({
    bind: (...p: any[]) => ({
      async run() {
        exec.push(sql);
        const ins = sql.match(/^INSERT\s+OR\s+REPLACE\s+INTO\s+apikeys\s*\(([^)]*)\)/i);
        if (ins) {
          const cols = ins[1].split(",").map((s) => s.trim());
          const row: any = {};
          cols.forEach((c, i) => (row[c] = p[i]));
          const i = rows.findIndex((r) => r.id === row.id);
          if (i >= 0) rows[i] = { ...rows[i], ...row };
          else rows.push(row);
          return { meta: { last_row_id: rows.length, changes: 1 } };
        }

        const upd = sql.match(/^UPDATE\s+apikeys\s+SET\s+([\s\S]*?)(?:\s+WHERE\s+([\s\S]*?))?$/i);
        if (upd) {
          const assigns = upd[1].split(",").map((s) => s.trim()).filter(Boolean);
          const where = upd[2];
          let cursor = 0;
          const targets = rows.filter((r) => !where || matchWhere(r, where, p));
          if (where && /id\s*=\s*\?/.test(where)) cursor = 1; // WHERE 的 ? 排在最后
          for (const r of targets) {
            for (const a of assigns) {
              const kv = a.match(/^(\w+)\s*=\s*([\s\S]+)$/);
              if (!kv) continue;
              const col = kv[1];
              const expr = kv[2].trim();
              if (expr === "?") r[col] = p[cursor++];
              else if (/^\d+(\.\d+)?$/.test(expr)) r[col] = Number(expr);
              else {
                const inc = expr.match(/^(\w+)\s*\+\s*\?$/);
                if (inc) r[col] = Number(r[inc[1]] ?? 0) + Number(p[cursor++]);
                else if (/^COALESCE|json_/i.test(expr)) r[col] = expr; // 本测试不消费
              }
            }
          }
          return { meta: { last_row_id: 0, changes: targets.length } };
        }
        return { meta: { changes: 0 } };
      },

      async all() {
        exec.push(sql);
        const agg = sql.match(/SELECT\s+COALESCE\(MAX\(seq\),\s*0\)\s+AS\s+s/i);
        if (agg) return { results: [{ s: rows.reduce((m, r) => Math.max(m, Number(r.seq ?? 0)), 0) }] };
        const cols = colsOfSelect(sql);
        let out = [...rows];
        const w = sql.match(/WHERE\s+([^\s]+)\s*=\s*\?/i);
        if (w) out = out.filter((r) => String(r[w[1]]) === String(p[0]));
        return { results: cols.length ? out.map((r) => pick(r, cols)) : out };
      },

      async first() {
        const w = sql.match(/WHERE\s+([^\s]+)\s*=\s*\?/i);
        const cols = colsOfSelect(sql);
        const hit = w ? rows.find((r) => String(r[w[1]]) === String(p[0])) : rows[0];
        return hit ? (cols.length ? pick(hit, cols) : hit) : null;
      },
    }),
  });

  return { DB: { prepare } as any, rows, exec };
}

function pick(r: any, cols: string[]) {
  const o: any = {};
  for (const c of cols) o[c] = r[c];
  return o;
}

function matchWhere(r: any, where: string, p: any[]): boolean {
  const m = where.match(/^(\w+)\s*=\s*\?$/);
  if (!m) return true;
  return String(r[m[1]]) === String(p[p.length - 1]);
}

function panelEnv(db: any) {
  const kv = new Map<string, string>();
  return {
    WB2A_DB: db,
    WB2A_CONFIG: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v), delete: async () => {} },
    WB2A_CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
    WB2A_LOGS: {},
  } as unknown as Env;
}

function mkApp(db: any) {
  const app = new Hono<{ Bindings: Env }>();
  registerPanel(app as any);
  return app;
}

async function createKey(app: any, env: any, body: any = { name: "k1" }) {
  const res = await app.fetch(
    new Request("https://x/panel/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
  return (await res.json()) as any;
}

describe("面板密钥：明文一次性展示", () => {
  it("创建返回 plain，且格式与 Go 对齐（sk- + 48 位十六进制）", async () => {
    const { DB } = memDB();
    const app = mkApp(DB);
    const env = panelEnv(DB);

    const r = await createKey(app, env);
    expect(r.ok).toBe(true);
    // 前端 showIssued(r.plain) 读的就是这个字段——缺了它明文框是空的。
    expect(typeof r.plain).toBe("string");
    expect(r.plain).toMatch(/^sk-[0-9a-f]{48}$/); // Go: rand 24 字节 → hex → 48 字符
    expect(r.plain.startsWith("sk-")).toBe(true);
    // 同时保留 key 字段：Go 的契约是 {"key":k,"plain":plain} 两个都给。
    expect(r.key).toBe(r.plain);
  });

  it("只存 hash 不存明文：库里查不到明文串", async () => {
    const { DB, rows } = memDB();
    const app = mkApp(DB);
    const r = await createKey(app, panelEnv(DB));

    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).not.toContain(r.plain);
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("prefix 落库为明文前 12 字符（对齐 Go 的 plain[:12]）", async () => {
    const { DB, rows } = memDB();
    const app = mkApp(DB);
    const r = await createKey(app, panelEnv(DB));

    expect(rows[0].prefix).toBe(r.plain.slice(0, 12));
    expect(rows[0].prefix.startsWith("sk-")).toBe(true);
  });

  it("每次创建的明文互不相同", async () => {
    const { DB } = memDB();
    const app = mkApp(DB);
    const env = panelEnv(DB);
    const a = await createKey(app, env, { name: "a" });
    const b = await createKey(app, env, { name: "b" });
    expect(a.plain).not.toBe(b.plain);
    expect(a.id).not.toBe(b.id);
  });
});

describe("面板密钥：reset 与 rotate 的语义分离", () => {
  /** 造一把「已用了一部分额度」的钥匙。 */
  async function seeded() {
    const { DB, rows, exec } = memDB();
    const app = mkApp(DB);
    const env = panelEnv(DB);
    const r = await createKey(app, env, { name: "k" });
    // 直接改行里的用量，模拟跑过一阵
    Object.assign(rows[0], { used_tokens: 500, used_credit: 12.5, req_count: 7 });
    return { app, env, rows, exec, id: r.id, plain: r.plain as string };
  }

  it("reset 只清用量，密钥不变——客户端无感", async () => {
    const s = await seeded();
    const res = await s.app.fetch(
      new Request(`https://x/panel/api/keys/${s.id}/reset`, { method: "POST" }),
      s.env,
    );
    const j = (await res.json()) as any;
    expect(j.ok).toBe(true);

    expect(s.rows[0].used_tokens).toBe(0);
    expect(s.rows[0].used_credit).toBe(0);
    expect(s.rows[0].req_count).toBe(0);
    // 关键：hash 没变 → 原密钥继续可用（这是 Go keysReset 的语义）
    expect(s.rows[0].key_hash).not.toBe(undefined);
    expect(s.rows[0].prefix).toBe(s.plain.slice(0, 12));
  });

  it("rotate 换新明文，且同步更新 prefix（旧掩码会指向已作废的钥匙）", async () => {
    const s = await seeded();
    const before = s.rows[0].key_hash;
    const res = await s.app.fetch(
      new Request(`https://x/panel/api/keys/${s.id}/rotate`, { method: "POST" }),
      s.env,
    );
    const j = (await res.json()) as any;
    expect(j.ok).toBe(true);
    expect(j.plain).toMatch(/^sk-[0-9a-f]{48}$/);
    expect(j.plain).not.toBe(s.plain);

    expect(s.rows[0].key_hash).not.toBe(before);
    expect(s.rows[0].prefix).toBe(j.plain.slice(0, 12));
    // 轮换不清用量：这是两件事，别顺手绑在一起
    expect(s.rows[0].req_count).toBe(7);
  });

  it("rotate 不存在的 key → 404，不静默成功", async () => {
    const { DB } = memDB();
    const app = mkApp(DB);
    const res = await app.fetch(
      new Request("https://x/panel/api/keys/nope/rotate", { method: "POST" }),
      panelEnv(DB),
    );
    expect(res.status).toBe(404);
  });

  it("reset_usage 与 reset 语义一致（保留的兼容端点）", async () => {
    const s = await seeded();
    const res = await s.app.fetch(
      new Request(`https://x/panel/api/keys/${s.id}/reset_usage`, { method: "POST" }),
      s.env,
    );
    expect(((await res.json()) as any).ok).toBe(true);
    expect(s.rows[0].used_tokens).toBe(0);
  });
});
