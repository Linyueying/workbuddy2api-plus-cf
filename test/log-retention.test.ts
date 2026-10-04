import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deleteRequestLogsByIds } from "../src/storage/d1";

// 请求日志保留链路的守卫。
//
// 背景：D1 的 request_logs 只增不减，归档/清理是唯一的容量闸门。旧实现有两
// 个致命缺陷——绑了 R2 就只归档不删（"清理留给人工"但并无入口），以及靠 KV
// 水位向更早推进、归档完后每轮重复 append 同一批。现在改成「归档即删除」：
// 已搬走的行从 D1 消失，下轮取到的必然是未归档的，水位因此被废弃。
//
// 这里锁死三件事：删除必须真的发生、按 id 精确删（不能按时间段误删未归档的）、
// 保留天数必须读配置。

const root = resolve(__dirname, "..");
const engineSrc = readFileSync(resolve(root, "engine-worker/src/index.ts"), "utf8");

/** 假 D1：记录每条 SQL 与每次 bind 的参数个数。 */
function makeD1() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const d1 = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        async run() {
          calls.push({ sql, params: bound });
          return { success: true, meta: { changes: bound.length } };
        },
        async all() {
          return { results: [] };
        },
        async first() {
          return null;
        },
      };
    },
  };
  return { d1, calls };
}

describe("日志保留：按 id 精确删除已归档行", () => {
  it("分批删除，单条 SQL 的绑定参数不得超过 D1 上限 100", async () => {
    const { d1, calls } = makeD1();
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const removed = await deleteRequestLogsByIds({ WB2A_DB: d1 } as any, ids);

    // 250 个 id → 3 批（100/100/50）
    expect(calls.length, "必须按 100 切块，否则会撞 D1 参数上限").toBe(3);
    for (const c of calls) {
      expect(c.params.length, "单批参数超过 100").toBeLessThanOrEqual(100);
    }
    expect(calls.every((c) => /DELETE FROM request_logs WHERE id IN/.test(c.sql))).toBe(true);
    expect(removed).toBe(250);
  });

  it("非法 id（0/NaN/undefined）不得拼进 SQL", async () => {
    const { d1, calls } = makeD1();
    await deleteRequestLogsByIds({ WB2A_DB: d1 } as any, [1, 0, NaN, undefined as any, 2]);
    expect(calls.length).toBe(1);
    expect(calls[0].params).toEqual([1, 2]);
  });

  it("空数组不产生任何 SQL", async () => {
    const { d1, calls } = makeD1();
    await deleteRequestLogsByIds({ WB2A_DB: d1 } as any, []);
    expect(calls.length).toBe(0);
  });
});

describe("日志保留链路（静态守卫）", () => {
  it("绑了 R2 也必须删 D1——不能回到「只归档、清理留给人工」", () => {
    // 旧实现的注释就写着"刻意不删 D1 源数据"，结果绑桶的部署反而先撑爆 D1。
    expect(engineSrc, "归档分支必须调用 deleteRequestLogsByIds").toMatch(/deleteRequestLogsByIds\(/);
    expect(engineSrc, "无 R2 / 开关关闭时也必须清理").toMatch(/deleteRequestLogsBefore\(/);
  });

  it("归档失败不得删除——宁可 D1 多留几天，也不能删掉没进 R2 的数据", () => {
    const fn = engineSrc.slice(engineSrc.indexOf("async function archiveRequestLogs"));
    // 取最后一个 catch：函数里第一个 catch 属于「无 R2 → 直接清理」分支，
    // 只有末尾这个才是归档失败的兜底。
    const catchBody = fn.slice(fn.lastIndexOf("} catch"));
    expect(catchBody, "归档失败分支不得再调删除").not.toMatch(/delete/);
    expect(catchBody).toMatch(/本轮不删除/);
  });

  it("保留天数必须读配置，不得只用硬编码常量", () => {
    expect(engineSrc).toMatch(/request_retention_days/);
    // 光有 retentionDays 函数不够——必须真的在算 cutoff 时被调用，
    // 否则改回 ARCHIVE_OLDER_THAN_DAYS 硬编码也不报错。
    expect(engineSrc).toMatch(/const days = retentionDays\(cfg\)/);
    expect(engineSrc).toMatch(/cutoff = Date\.now\(\) - days \*/);
  });

  it("水位机制已废弃——不得再写 WATERMARK_KEY（去重靠删除，不靠水位）", () => {
    expect(engineSrc, "水位会让归档完后重复 append 同一批").not.toMatch(/WATERMARK_KEY/);
  });
});
