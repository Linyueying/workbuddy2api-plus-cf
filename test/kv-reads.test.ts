import { describe, it, expect, beforeEach } from "vitest";
import { rateLookup, storeModelRates, invalidateRateLookup } from "../src/services/rates";
import { modelsSnapshot, invalidateModelsSnapshot } from "../src/services/models-snapshot";
import { realModelExists } from "../src/services/resolveModel";
import type { Env } from "../worker-configuration.d.ts";

// KV 读次数守卫。
//
// 为什么单独成测：KV 免费额度是 10 万次**读**/天，而"多读一次"在本地跑起来毫无
// 体感（内存 Map 与真机 KV 都是微秒级），只有额度账单会说话。能抓到它的方法只有一个
// ——数调用次数。这几处都是**每请求**必走的路径，一次多余读 × 请求量 = 额度。

function countingEnv(seed: Record<string, any> = {}) {
  const store = new Map<string, any>(Object.entries(seed));
  const reads: string[] = [];
  const kv = {
    get: async (k: string) => {
      reads.push(String(k));
      return store.has(k) ? store.get(k) : null;
    },
    put: async (k: string, v: any) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
  return {
    env: { WB2A_CONFIG: kv, WB2A_CACHE: kv, WB2A_DB: {} } as unknown as Env,
    reads,
    store,
  };
}

describe("KV 读放大", () => {
  beforeEach(() => {
    invalidateRateLookup();
    invalidateModelsSnapshot();
  });

  it("rateLookup：连续取号复用同一份快照，不重复读 KV", async () => {
    const { env, reads } = countingEnv();
    // 首次装载：cn + global 两域各读一次。
    const f1 = await rateLookup(env);
    expect(f1("cn", "hy3")).toBe("");
    expect(reads).toHaveLength(2);
    // 后续每次 pick 都调 rateLookup —— 不能每次再付 2 次读。
    for (let i = 0; i < 10; i++) await rateLookup(env);
    expect(reads).toHaveLength(2);
  });

  it("rateLookup：目录刷新后立刻失效，不拿旧倍率判「该模型是否收费」", async () => {
    const { env, reads } = countingEnv();
    await rateLookup(env);
    await storeModelRates(env, "cn", [{ id: "hy3", price: { rate: "2.5" } }]);
    const f = await rateLookup(env);
    expect(reads.length).toBeGreaterThan(2); // 失效后重新装载
    expect(typeof f("cn", "hy3")).toBe("string");
  });

  it("模型目录：realModelExists 连续调用只读一次 KV（同请求内 effort 表还要读同一份）", async () => {
    const { env, reads } = countingEnv();
    await realModelExists(env, "cn:hy3");
    const after1 = reads.length;
    expect(after1).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) await realModelExists(env, "cn:hy3");
    expect(reads).toHaveLength(after1);
  });

  it("模型目录：两域共享一次装载，且目录刷新后立刻可见", async () => {
    const { env, reads, store } = countingEnv();
    expect(await modelsSnapshot(env, "cn")).toEqual([]);
    expect(await modelsSnapshot(env, "global")).toEqual([]);
    expect(reads).toHaveLength(2); // 一次装载读两个域，之后都是内存命中
    // 刷新（模拟 listModels 落盘）后必须失效，否则新目录要等 60s 才生效。
    store.set("models:cn", [{ id: "cn:hy3" }]);
    invalidateModelsSnapshot();
    expect(await modelsSnapshot(env, "cn")).toEqual([{ id: "cn:hy3" }]);
  });
});
