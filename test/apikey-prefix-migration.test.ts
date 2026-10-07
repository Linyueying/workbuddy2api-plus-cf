import { describe, it, expect, beforeEach } from "vitest";
import { PREFIX } from "../src/services/apikeys";
import { purgeLegacyKeys } from "../src/storage/d1";
import { invalidateKeyCache } from "../src/services/apikeys";
import type { Env } from "../worker-configuration.d.ts";

// 子密钥前缀 wbk_ → sk- 的迁移护栏。
//
// 背景：多数 OpenAI 兼容客户端会**在前端校验密钥形状**（只放行 sk- 开头），
// wbk_ 会被本地直接拦下，用户根本发不出请求。改用 sk- 后，库里遗留的旧行
// 在鉴权层已经不可用（只认 sk-），但需要能被显式清理掉。

/** 内存 D1 假实现：只支持 purgeLegacyKeys 用到的那条 DELETE。 */
function memD1(rows: any[]) {
  const state = { rows: rows.slice(), deletes: 0 };
  return {
    __state: state,
    prepare(sql: string) {
      return {
        bind(...params: any[]) {
          return {
            async run() {
              if (/^DELETE FROM apikeys/.test(sql)) {
                const like = String(params[0] ?? "%"); // 形如 "sk-%"
                const keepPrefix = like.replace(/%$/, "");
                const before = state.rows.length;
                state.rows = state.rows.filter(
                  (r) => typeof r.prefix === "string" && r.prefix.length > 0 && r.prefix.startsWith(keepPrefix),
                );
                state.deletes += before - state.rows.length;
                return { meta: { changes: before - state.rows.length } };
              }
              return { meta: { changes: 0 } };
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
    },
  };
}

function envWith(rows: any[]): Env {
  return { WB2A_DB: memD1(rows) } as unknown as Env;
}

describe("子密钥前缀迁移：wbk_ → sk-", () => {
  beforeEach(() => invalidateKeyCache());

  it("PREFIX 现在是 sk-（客户端形状校验必需）", () => {
    expect(PREFIX).toBe("sk-");
    // 回归护栏：改回 wbk_ 会让所有 OpenAI 兼容客户端在本地就拦下密钥
    expect(PREFIX).not.toBe("wbk_");
  });

  it("purgeLegacyKeys 只删旧前缀行，保留当前前缀行", async () => {
    const env = envWith([
      { id: "old1", prefix: "wbk_955e0123" },
      { id: "old2", prefix: "wbk_aaaa5678" },
      { id: "new1", prefix: "sk-1234abcd" },
    ]);
    const removed = await purgeLegacyKeys(env, PREFIX);
    expect(removed).toBe(2);
    expect((env as any).WB2A_DB.__state.rows.map((r: any) => r.id)).toEqual(["new1"]);
  });

  it("prefix 为空/缺失的行一并清掉（更早版本没落掩码）", async () => {
    const env = envWith([
      { id: "empty", prefix: "" },
      { id: "null", prefix: null },
      { id: "new1", prefix: "sk-abcd1234" },
    ]);
    const removed = await purgeLegacyKeys(env, PREFIX);
    expect(removed).toBe(2);
    expect((env as any).WB2A_DB.__state.rows.map((r: any) => r.id)).toEqual(["new1"]);
  });

  it("全是新前缀时返回 0，不动任何行（幂等）", async () => {
    const env = envWith([{ id: "a", prefix: "sk-1" }, { id: "b", prefix: "sk-2" }]);
    expect(await purgeLegacyKeys(env, PREFIX)).toBe(0);
    // 再清一次仍是 0 —— 可安全重复调用
    expect(await purgeLegacyKeys(env, PREFIX)).toBe(0);
    expect((env as any).WB2A_DB.__state.rows).toHaveLength(2);
  });

  it("空表不报错", async () => {
    expect(await purgeLegacyKeys(envWith([]), PREFIX)).toBe(0);
  });

  it("判据跟着 PREFIX 走，不硬编码 wbk_（将来再改前缀无需改清理逻辑）", async () => {
    const env = envWith([{ id: "a", prefix: "sk-1" }, { id: "b", prefix: "zz-2" }]);
    // 传一个假想的第三前缀，应只保留匹配它的行
    expect(await purgeLegacyKeys(env, "zz-")).toBe(1);
    expect((env as any).WB2A_DB.__state.rows.map((r: any) => r.id)).toEqual(["b"]);
  });
});
