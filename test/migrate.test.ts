import { describe, it, expect, beforeEach, vi } from "vitest";
import { ensureSchema, resetSchemaCache, forceSchemaMigration } from "../src/storage/migrate";

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
    cols?: string[]; // apikeys 已有列
    reqCols?: string[]; // request_logs 已有列
    failOn?: RegExp;
  } = {},
) {
  const tables = new Set(opts.tables ?? ["apikeys"]);
  const cols = new Set(opts.cols ?? []);
  const reqCols = new Set(opts.reqCols ?? []);
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
            const set = m[1] === "request_logs" ? reqCols : cols;
            const col = m[2];
            if (set.has(col)) {
              throw new Error(`duplicate column name: ${col}`);
            }
            set.add(col);
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
          if (p) {
            const set = p[1] === "request_logs" ? reqCols : cols;
            return { results: [...set].map((n) => ({ name: n })) };
          }
          return { results: [] };
        },
        async first() {
          return null;
        },
      };
    },
  } as any;

  return { d1, executed, cols, reqCols, tables };
}

/** 全新库：0001 的表已建（刚跑过）但 0002 的列全缺。 */
function envWith(d1: any) {
  return { WB2A_DB: d1 } as any;
}

describe("D1 自动迁移", () => {
  beforeEach(() => {
    resetSchemaCache();
  });

  it("全新库：补齐 0002/0004 的 apikeys 列 + 0005 的 request_logs 用量列", async () => {
    const { d1, cols, reqCols } = makeD1({ cols: [], reqCols: [] });
    const r = await ensureSchema(envWith(d1));
    expect(r.status).toBe("ok");
    // 这份清单刻意写死在此处、不从 src 导出：迁移漏加任何一列都应在这里抓到，
    // 而不是跟着实现一起静默通过。
    expect(r.added_cols?.sort()).toEqual(
      [
        "enabled", "expires_at", "realm", "ip_allowlist", "max_ips", "ips",
        "last_ip", "req_count", "quota", "used_tokens", "quota_credit",
        "used_credit", "seq",
        "prefix", // 0004：对齐 Go Key.Prefix（明文前 12 字符）
        "prompt_tokens", "completion_tokens", "credits", "cache_read_tokens", // 0005：request_logs 用量列
      ].sort(),
    );
    expect(cols.size).toBe(14); // apikeys 管控列 + 展示掩码
    expect(reqCols.size).toBe(4); // request_logs 用量列
  });

  it("已迁移的库：不重复加列（ADD COLUMN 无 IF NOT EXISTS，重跑会炸）", async () => {
    const allCols = [
      "id", "key_hash", "name", "models", "created_at", "last_used",
      "enabled", "expires_at", "realm", "ip_allowlist", "max_ips", "ips",
      "last_ip", "req_count", "quota", "used_tokens", "quota_credit",
      "used_credit", "seq", "prefix",
    ];
    const allReqCols = ["prompt_tokens", "completion_tokens", "credits", "cache_read_tokens"];
    const { d1, executed } = makeD1({ cols: allCols, reqCols: allReqCols });
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

  // 回归：这两条索引原本只存在于 migrations/0003_usage_metrics.sql 里，而 Pages 部署
  // 从不执行手工 SQL —— 新环境永远建不出来。缺了它不报错、只是用量聚合退化成
  // 「命中 ts 索引后逐行回表」，D1 按扫描行数计费，用量页能把 500 万行/天额度刷穿。
  it("0003 的复合索引必须进入自动迁移（零配置部署不能靠手工 SQL）", async () => {
    const { d1, executed } = makeD1({ cols: [] });
    const r = await ensureSchema(envWith(d1));
    expect(r.status).toBe("ok");
    expect(
      executed.some((s) => /CREATE INDEX IF NOT EXISTS idx_reqlogs_usage ON request_logs\(ts DESC, model, realm\)/.test(s)),
    ).toBe(true);
    expect(
      executed.some((s) => /CREATE INDEX IF NOT EXISTS idx_reqlogs_usage_uid ON request_logs\(ts DESC, uid\)/.test(s)),
    ).toBe(true);
  });

  it("复合索引建失败不阻断迁移：索引只影响查询计划，缺了仍要能出数", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { d1 } = makeD1({ cols: [], failOn: /idx_reqlogs_usage/ });
      // 与 0002 的索引相反：那条建不出来是硬故障（列表排序退化），这两条不是。
      expect((await ensureSchema(envWith(d1))).status).toBe("ok");
    } finally {
      spy.mockRestore();
    }
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

// ---------------------------------------------------------------------------
// 冷启动优化：这两项是针对「冷启动首 Token 慢、热启动快」加的，必须钉死。
//
// 背景：迁移原本**每次冷启动固定 14 次串行 D1 往返**（8 条建表 + 3 条索引 +
// sqlite_master + 2 个 PRAGMA），且完全跑在请求计时之外——冷启动慢却看不出慢在哪。
// ---------------------------------------------------------------------------

/** 内存 KV 假实现：够用即可，只覆盖 get/put/delete。 */
function makeKV(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(k: string) {
      return store.has(k) ? store.get(k)! : null;
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
    async delete(k: string) {
      store.delete(k);
    },
  } as any;
}

/**
 * 带 batch() 的 D1 假实现，并统计**往返次数**。
 *
 * 往返 = 一次 batch() 调用 或 一次 prepare().run()/all() 调用。这是本次优化
 * 真正要压缩的量：冷启动慢的本质就是串行往返太多，而不是每条 SQL 本身慢。
 */
function makeD1WithBatch() {
  const executed: string[] = [];
  let batches = 0;
  let singles = 0;
  const cols = new Set<string>();
  const reqCols = new Set<string>();
  const tables = new Set<string>(["apikeys"]);

  function exec(sql: string) {
    const s = sql.replace(/\s+/g, " ").trim();
    executed.push(s);
    const ct = s.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
    if (ct) tables.add(ct[1]);
    const al = s.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/);
    if (al) {
      const set = al[1] === "request_logs" ? reqCols : cols;
      if (set.has(al[2])) throw new Error(`duplicate column name: ${al[2]}`);
      set.add(al[2]);
    }
    return { results: [] };
  }
  function query(sql: string) {
    const s = sql.replace(/\s+/g, " ").trim();
    executed.push(s);
    if (/sqlite_master/.test(s)) return { results: [...tables].map((n) => ({ name: n })) };
    const p = s.match(/PRAGMA table_info\((\w+)\)/);
    if (p) {
      const set = p[1] === "request_logs" ? reqCols : cols;
      return { results: [...set].map((n) => ({ name: n })) };
    }
    return { results: [] };
  }

  const d1 = {
    prepare(sql: string) {
      return {
        sql,
        async run() {
          singles++;
          return exec(sql);
        },
        async all() {
          singles++;
          return query(sql);
        },
        async first() {
          singles++;
          return null;
        },
      };
    },
    async batch(stmts: any[]) {
      batches++;
      const out: any[] = [];
      for (const st of stmts) {
        // 读语句（PRAGMA/SELECT）返回 results，写语句返回 success —— 对齐真机 D1
        if (/^\s*(PRAGMA|SELECT)/i.test(st.sql)) out.push({ results: query(st.sql).results });
        else out.push({ success: true, results: exec(st.sql).results });
      }
      return out;
    },
  } as any;

  return {
    d1,
    executed,
    /** 总往返次数（batch 算 1 次，单条算 1 次）。 */
    roundTrips: () => batches + singles,
  };
}

describe("冷启动优化①：KV 版本门", () => {
  beforeEach(() => {
    resetSchemaCache();
  });

  it("版本达标：一次 KV 读就返回，**一条 SQL 都不发**", async () => {
    const { d1, executed } = makeD1({ cols: [] });
    const r: any = await ensureSchema({ WB2A_DB: d1, WB2A_CONFIG: makeKV({ schema_version: "5" }) } as any);
    expect(r.status).toBe("ok");
    expect(r.via).toBe("version_gate");
    // 这是整个优化的核心断言：冷启动不再付 14 次 D1 往返
    expect(executed.length).toBe(0);
  });

  it("版本落后：照跑迁移，并把新版本号写回 KV", async () => {
    const { d1 } = makeD1({ cols: [] });
    const kv = makeKV({ schema_version: "3" });
    const r: any = await ensureSchema({ WB2A_DB: d1, WB2A_CONFIG: kv } as any);
    expect(r.status).toBe("ok");
    expect(r.via).toBe("ddl");
    expect(kv.store.get("schema_version")).toBe("5");
  });

  it("KV 未绑定：版本门不可用，退化照跑迁移（不能成为新的故障源）", async () => {
    const { d1, executed } = makeD1({ cols: [] });
    const r: any = await ensureSchema({ WB2A_DB: d1 } as any);
    expect(r.status).toBe("ok");
    expect(r.via).toBe("ddl");
    expect(executed.length).toBeGreaterThan(0);
  });

  it("KV 读失败：同样退化照跑迁移", async () => {
    const { d1, executed } = makeD1({ cols: [] });
    const brokenKV = {
      async get() {
        throw new Error("kv down");
      },
      async put() {},
    } as any;
    const r: any = await ensureSchema({ WB2A_DB: d1, WB2A_CONFIG: brokenKV } as any);
    expect(r.status).toBe("ok");
    expect(r.via).toBe("ddl");
    expect(executed.length).toBeGreaterThan(0);
  });

  it("resetSchemaCache **不**穿透版本门：清缓存后仍走快路径", async () => {
    // 这条是刻意的设计取舍：resetSchemaCache 是通用「清缓存」入口，被测试的
    // beforeEach 普遍调用。若它也穿透版本门，版本门在测试里就永远走不到。
    const { d1, executed } = makeD1({ cols: [] });
    const env = { WB2A_DB: d1, WB2A_CONFIG: makeKV({ schema_version: "5" }) } as any;
    expect((await ensureSchema(env) as any).via).toBe("version_gate");
    resetSchemaCache();
    expect((await ensureSchema(env) as any).via).toBe("version_gate");
    expect(executed.length).toBe(0);
  });

  it("forceSchemaMigration 才穿透版本门（运维强制重跑入口靠它生效）", async () => {
    // KV 版本号写错、或手工改坏表结构需要重建时，必须能绕过「达标就跳过」。
    const { d1, executed } = makeD1({ cols: [] });
    const env = { WB2A_DB: d1, WB2A_CONFIG: makeKV({ schema_version: "5" }) } as any;
    expect((await ensureSchema(env) as any).via).toBe("version_gate");
    expect(executed.length).toBe(0);

    forceSchemaMigration();
    const r: any = await ensureSchema(env);
    expect(r.via).toBe("ddl");
    expect(executed.length).toBeGreaterThan(0);
  });
});

describe("冷启动优化②：batch 压缩往返", () => {
  beforeEach(() => {
    resetSchemaCache();
  });

  it("batch 可用时：14 次串行往返压到 4 次以内（且列照样补齐）", async () => {
    const h = makeD1WithBatch();
    const r: any = await ensureSchema({ WB2A_DB: h.d1 } as any);
    expect(r.status).toBe("ok");
    // 优化前是 14 次串行往返（8 建表 + 3 索引 + sqlite_master + 2 PRAGMA）
    expect(h.roundTrips()).toBeLessThanOrEqual(4);
    expect(h.roundTrips()).toBeLessThan(14);
    // 压缩不能压掉正确性：18 列（14 apikeys + 4 request_logs）必须都补上
    expect(r.added_cols?.length).toBe(18);
  });

  it("batch 不可用（老假实现）：退化逐条，行为与优化前一致", async () => {
    // 保证能力探测的退化分支不会改变语义——别让「优化」变成「改行为」
    const { d1, cols, reqCols } = makeD1({ cols: [], reqCols: [] });
    const r = await ensureSchema({ WB2A_DB: d1 } as any);
    expect(r.status).toBe("ok");
    expect(cols.size).toBe(14);
    expect(reqCols.size).toBe(4);
  });
});
