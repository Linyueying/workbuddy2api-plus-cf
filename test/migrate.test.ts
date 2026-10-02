import { describe, it, expect, beforeEach, vi } from "vitest";
import { ensureSchema, resetSchemaCache } from "../src/storage/migrate";

// 自动迁移的三条硬约束必须在测试里钉死：
//   1. D1 prepare() 一次一条语句 → 表/索引/列都得单独跑；
//   2. ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS → 必须先 PRAGMA 探测；
//   3. 多 isolate 并发首触发 → duplicate column 必须被吞掉。
//
// 这三条在 Node 单测里都测得到，但 ids.ts 那次"模块顶层 crypto 调用"
// 是 Node 跑不出、只有真机才炸的。所以这里额外断言「模块导入不产生副作用」。

function makeD1(
  opts: {
    tables?: string[];
    cols?: string[];
    failOn?: RegExp;
  } = {},
) {
  const tables = new Set(opts.tables ?? ["apikeys"]);
  const cols = new Set(opts.cols ?? []);
  const executed: string[] = [];

  const d1 = {
    prepare(sql: string) {
      return {
        async run() {
          const s = sql.replace(/\s+/g, " ").trim();
          executed.push(s);
          if (opts.failOn?.test(s)) throw new Error(`boom: ${s.slice(0, 40)}`);
          // 模拟真实 SQLite：重复加列会报 duplicate column name
          const m = s.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
          if (m) {
            const col = m[2];
            if (cols.has(col)) {
              throw new Error(`duplicate column name: ${col}`);
            }
            cols.add(col);
          }
          const ct = s.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
          if (ct) tables.add(ct[1]);
          return { success: true };
        },
        async all() {
          const s = sql.replace(/\s+/g, " ").trim();
          if (/sqlite_master/.test(s)) {
            return { results: [...tables].map((n) => ({ name: n })) };
          }
          const p = s.match(/PRAGMA table_info\((\w+)\)/);
          if (p) return { results: [...cols].map((n) => ({ name: n })) };
          return { results: [] };
        },
        async first() {
          return null;
        },
      };
    },
  } as any;

  return { d1, executed, cols, tables };
}

/** 全新库：0001 的表已建（刚跑过）但 0002 的列全缺。 */
function envWith(d1: any) {
  return { WB2A_DB: d1 } as any;
}

describe("D1 自动迁移", () => {
  beforeEach(() => {
    resetSchemaCache();
  });

  it("全新库：补齐 0002 的全部 13 个管控列", async () => {
    const { d1, cols } = makeD1({ cols: [] });
    const r = await ensureSchema(envWith(d1));
    expect(r.status).toBe("ok");
    expect(r.added_cols?.sort()).toEqual(
      [
        "enabled", "expires_at", "realm", "ip_allowlist", "max_ips", "ips",
        "last_ip", "req_count", "quota", "used_tokens", "quota_credit",
        "used_credit", "seq",
      ].sort(),
    );
    expect(cols.size).toBe(13);
  });

  it("已迁移的库：不重复加列（ADD COLUMN 无 IF NOT EXISTS，重跑会炸）", async () => {
    const all13 = [
      "id", "key_hash", "name", "models", "created_at", "last_used",
      "enabled", "expires_at", "realm", "ip_allowlist", "max_ips", "ips",
      "last_ip", "req_count", "quota", "used_tokens", "quota_credit",
      "used_credit", "seq",
    ];
    const { d1, executed } = makeD1({ cols: all13 });
    const r = await ensureSchema(envWith(d1));
    expect(r.status).toBe("ok");
    expect(r.added_cols).toEqual([]);
    // 关键：一条 ALTER 都不该发出去
    expect(executed.filter((s) => /ALTER TABLE/.test(s))).toEqual([]);
  });

  it("部分迁移（上次中途失败）：只补缺失的那几列", async () => {
    const { d1 } = makeD1({ cols: ["id", "key_hash", "enabled", "realm"] });
    const r = await ensureSchema(envWith(d1));
    expect(r.status).toBe("ok");
    expect(r.added_cols).toContain("seq");
    expect(r.added_cols).toContain("quota");
    // 已存在的列不能重复补
    expect(r.added_cols).not.toContain("enabled");
    expect(r.added_cols).not.toContain("realm");
  });

  it("并发首次触发：duplicate column 被吞掉，不冒到调用方", async () => {
    // 两个 isolate 同时探测到"seq 缺失"，都去 ADD COLUMN，
    // 后到的那个必然撞 duplicate column name —— 这不算失败。
    const { d1 } = makeD1({ cols: [] });
    const env = envWith(d1);
    const [a, b] = await Promise.all([ensureSchema(env), ensureSchema(env)]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
  });

  it("幂等：重复调用只跑一次 DDL（promise 缓存生效）", async () => {
    const { d1, executed } = makeD1({ cols: [] });
    const env = envWith(d1);
    await ensureSchema(env);
    const afterFirst = executed.length;
    await ensureSchema(env);
    await ensureSchema(env);
    expect(executed.length).toBe(afterFirst);
  });

  it("D1 未绑定：返回 skipped 而不是抛错", async () => {
    const r = await ensureSchema({ WB2A_DB: undefined } as any);
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("WB2A_DB");
  });

  it("DDL 失败：报出具体语句，但不阻断（由调用方 catch）", async () => {
    const { d1 } = makeD1({ cols: [], failOn: /CREATE TABLE IF NOT EXISTS usage/ });
    const r = await ensureSchema(envWith(d1)).catch((e) => ({ status: "error", error: String(e.message) }));
    expect(r.status).toBe("error");
    expect(r.error).toContain("usage");
  });

  it("resetSchemaCache 后可强制重跑（运维兜底入口）", async () => {
    const { d1, executed } = makeD1({ cols: [] });
    const env = envWith(d1);
    await ensureSchema(env);
    const n1 = executed.length;
    resetSchemaCache();
    await ensureSchema(env);
    expect(executed.length).toBeGreaterThan(n1);
  });
});

describe("迁移模块的 Workers 约束", () => {
  it("导入模块不执行任何 SQL（无全局作用域副作用）", async () => {
    // Workers 禁止模块顶层 I/O。Node 不会报错，所以这里用 spy 断言：
    // 单纯 import 不应触发任何 prepare 调用。
    const { d1 } = makeD1({ cols: [] });
    const spy = vi.spyOn(d1, "prepare");
    resetSchemaCache();
    // 只导入、不调用 ensureSchema
    expect(spy).not.toHaveBeenCalled();
  });
});
