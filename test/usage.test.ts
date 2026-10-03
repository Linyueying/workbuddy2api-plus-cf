import { describe, it, expect } from "vitest";
import { buildUsageSnapshot, seriesOf, isoLocal, bucketOf } from "../src/services/usage-agg";
import { dryUsage } from "../src/services/proxy";
import type { UsageRow } from "../src/storage/d1";

// 用量聚合回归档。
//
// 背景：面板「用量/积分消耗」长期全空，第一层原因是 recordUsage 零调用点（表从未
// 被写），第二层、也更致命的是**后端响应与前端契约完全不匹配**——后端返回
// {rows:[{hour,model,realm,tokens,cnt}]}，前端 renderUsage 读的是 totals/series/
// by_account/credit_by_model。字段全对不上，就算表有数据页面也只会是一片 "-"。
// 这里锁死的是第二类错误：任何字段名漂移都应该在这里炸，而不是让用户看空面板。

const H = 3600_000;

function row(p: Partial<UsageRow> = {}): UsageRow {
  return {
    ts: 1000 * H,
    uid: "uid-a",
    model: "claude-sonnet-4",
    realm: "global",
    outcome: "ok",
    status: 200,
    ms: 1000,
    prompt_tokens: 100,
    completion_tokens: 50,
    credits: 0.01,
    cache_read_tokens: 0,
    ...p,
  };
}

/** 前端契约要求的全部顶层键。缺任何一个，页面就是空的或半空的。 */
const REQUIRED_KEYS = [
  "window_from", "window_to", "since", "buckets", "totals",
  "series", "by_account", "by_model", "by_realm",
  "credit_by_account", "credit_by_model",
];

describe("用量快照：前端契约完整性", () => {
  const snap = buildUsageSnapshot([row()], { from: 0, to: 24 * H, since: 0 });

  it("前端 renderUsage 需要的顶层字段一个都不能少", () => {
    for (const k of REQUIRED_KEYS) {
      expect(snap, `缺字段 ${k}`).toHaveProperty(k);
    }
  });

  it("totals 的字段名与前端卡片一一对应", () => {
    const t = snap.totals;
    // usStats 六张卡 + usCreditStats 五张卡，全靠这些字段。
    for (const k of [
      "requests", "errors", "prompt_tokens", "completion_tokens", "total_tokens",
      "avg_latency_ms", "avg_tokens_per_second",
      "credits", "credit_tokens", "credit_samples", "credits_per_1m_tokens",
      "cache_hit_tokens", "cache_miss_tokens",
    ]) {
      expect(t, `totals 缺 ${k}`).toHaveProperty(k);
      expect(typeof t[k as keyof typeof t]).toBe("number");
    }
  });

  it("窗口shr 可能为atsby、也不能是数字——Series-T源源不断的就是<｜hy_place▁holder▁no▁813｜>", () => {
    // 前端用 replace('T',' ') + slice(0,16) 直接当字符串用，传数字会抛。
    expect(typeof snap.window_from).toBe("string");
    expect(snap.window_from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("by_account 行带 uid 分组所需 realm/extra，by_model/by_realm 带 key", () => {
    expect(snap.by_account[0].key).toBe("uid-a");
    expect(snap.by_account[0]).toHaveProperty("realm");
    expect(snap.by_account[0]).toHaveProperty("extra");
    expect(snap.by_model[0]).toHaveProperty("key");
    expect(snap.by_realm[0].key).toBe("global");
  });
});

describe("用量聚合数值口径", () => {
  it("token 与请求数对齐，失败计入 errors", () => {
    const s = buildUsageSnapshot(
      [row(), row({ outcome: "error", status: 429, prompt_tokens: 0, completion_tokens: 0, credits: 0 })],
      { from: 0, to: 24 * H, since: 0 },
    );
    expect(s.totals.requests).toBe(2);
    expect(s.totals.errors).toBe(1);
    expect(s.totals.total_tokens).toBe(150);
  });

  it("平均延迟按总耗时/总请求，不是逐个平均（辛普森悖论）", () => {
    const s = buildUsageSnapshot([row({ ms: 1000 }), row({ ms: 3000 })], { from: 0, to: 24 * H, since: 0 });
    expect(s.totals.avg_latency_ms).toBe(2000);
  });

  it("速率按总 token/总秒，避免长请求被稀释", () => {
    const s = buildUsageSnapshot([row({ ms: 2000, prompt_tokens: 100, completion_tokens: 100 })], {
      from: 0, to: 24 * H, since: 0,
    });
    expect(s.totals.avg_tokens_per_second).toBeCloseTo(100); // 200 tok / 2s
  });

  it("credits 为 0 的行不计入 credit_tokens/samples（不伪造性价比）", () => {
    const s = buildUsageSnapshot(
      [row({ credits: 0.02, prompt_tokens: 1000 }), row({ credits: 0, prompt_tokens: 500 })],
      { from: 0, to: 24 * H, since: 0 },
    );
    expect(s.totals.credits).toBeCloseTo(0.02);
    // credit_tokens 只算有 credit 那行的 total_tokens（1000+50）——另一行的 550 不计入
    // 「匹配 Token」，但 total_tokens 是全局口径，两行的 1050+550 都要算。
    expect(s.totals.credit_tokens).toBe(1050);
    expect(s.totals.credit_samples).toBe(1);
    expect(s.totals.total_tokens).toBe(1600);
  });

  it("credits_per_1m_tokens 折算正确", () => {
    const s = buildUsageSnapshot([row({ credits: 0.5, prompt_tokens: 1_000_000 })], { from: 0, to: 24 * H, since: 0 });
    expect(s.totals.credits_per_1m_tokens).toBeCloseTo(0.5);
  });

  it("缓存：未命中 = prompt 扣掉读命中；数据不自洽时不给负值", () => {
    const ok = buildUsageSnapshot([row({ prompt_tokens: 100, cache_read_tokens: 30 })], { from: 0, to: 24 * H, since: 0 });
    expect(ok.totals.cache_hit_tokens).toBe(30);
    expect(ok.totals.cache_miss_tokens).toBe(70);

    const weird = buildUsageSnapshot([row({ prompt_tokens: 10, cache_read_tokens: 50 })], { from: 0, to: 24 * H, since: 0 });
    expect(weird.totals.cache_miss_tokens).toBe(0);
  });

  it("空数据不炸，产出全零快照与零填充时序", () => {
    const s = buildUsageSnapshot([], { from: 0, to: 2 * H, since: 0 });
    expect(s.totals.requests).toBe(0);
    expect(s.totals.total_tokens).toBe(0);
    expect(s.series.length).toBeGreaterThan(0);
    expect(s.credit_by_account).toEqual([]);
  });

  it("credit 全为 0 时积分两张表为空而不是塞满 0（前端已有「暂无记录」文案）", () => {
    const s = buildUsageSnapshot([row({ credits: 0 })], { from: 0, to: 24 * H, since: 0 });
    expect(s.credit_by_account).toHaveLength(0);
    expect(s.credit_by_model).toHaveLength(0);
    // 但主用量表仍应有数据——不能因为没积分就把 token 也抹了。
    expect(s.by_account).toHaveLength(1);
  });

  it("NULL/空 uid 收敛到同一个 unknown 组，不被 String(null) 拆成 \"null\"", () => {
    const s = buildUsageSnapshot(
      [row({ uid: null as any }), row({ uid: "" as any })],
      { from: 0, to: 24 * H, since: 0 },
    );
    expect(s.by_account).toHaveLength(1);
    expect(s.by_account[0].key).toBe("unknown");
  });

  it("model 缺失同样收敛，且不影响其他行的分组", () => {
    const s = buildUsageSnapshot(
      [row({ model: null as any }), row()],
      { from: 0, to: 24 * H, since: 0 },
    );
    expect(s.by_model.map((g) => g.key).sort()).toEqual(["claude-sonnet-4", "unknown"]);
  });

  it("昵称与 realm 回填到账号行", () => {
    const s = buildUsageSnapshot([row({ uid: "abc123456789" })], {
      from: 0, to: 24 * H, since: 0, nicknames: { abc123456789: "小明的号" },
    });
    expect(s.by_account[0].extra).toBe("小明的号");
    expect(s.by_account[0].realm).toBe("global");
  });
});

describe("时序分桶", () => {
  it("短窗口用小时桶（前端按 HH:00 显示），长窗口自动切日桶", () => {
    expect(bucketOf(24 * H).scope).toBe("hour");
    expect(bucketOf(90 * 24 * H).scope).toBe("day");
  });

  it("小时桶 t 是 13 字符，日桶是 10 字符——前端 parsePointTime 严格按长度补", () => {
    const h = seriesOf([row()], 0, 3 * H);
    expect(h[0].t).toHaveLength(13);
    expect(h[0].scope).toBe("hour");
    const d = seriesOf([row()], 0, 90 * 24 * H);
    expect(d[0].t).toHaveLength(10);
    expect(d[0].scope).toBe("day");
  });

  it("窗口内无请求的桶也出现（零填充），否则图上一个孤零零的柱子看不出全貌", () => {
    const s = seriesOf([row({ ts: 0 })], 0, 3 * H);
    expect(s.length).toBe(4);
    expect(s[0].requests).toBe(1);
    expect(s[1].requests).toBe(0);
    expect(s.every((p) => p.total_tokens === p.prompt_tokens + p.completion_tokens)).toBe(true);
  });

  it("桶边界按北京时间切（否则每天的桶会在 08:00 断一刀）", () => {
    // isoLocal 把 UTC epoch 转成北京时间字符串：0 → 1970-01-01T08:00
    expect(isoLocal(0)).toBe("1970-01-01T08:00");
  });
});

describe("dryUsage 字段收敛", () => {
  it("取 OpenAI 口径的 prompt/completion", () => {
    expect(dryUsage({ prompt_tokens: 10, completion_tokens: 20, credit: 1.5 })).toEqual({
      prompt_tokens: 10, completion_tokens: 20, credits: 1.5, cache_read_tokens: 0,
    });
  });

  it("缓存读命中两种字段名都认", () => {
    expect(dryUsage({ prompt_tokens_details: { cached_tokens: 7 } } as any).cache_read_tokens).toBe(7);
    expect(dryUsage({ cache_read_input_tokens: 9 } as any).cache_read_tokens).toBe(9);
  });

  it("undefined / 脏值一律收敛为 0，不产生 NaN", () => {
    for (const u of [undefined, null, {}, { prompt_tokens: NaN }, { prompt_tokens: "x" as any }]) {
      const d = dryUsage(u as any);
      for (const v of Object.values(d)) expect(Number.isNaN(v)).toBe(false);
    }
  });

  it("Anthropic 风格 input/output_tokens 也能识别（上游字段名不统一）", () => {
    expect(dryUsage({ input_tokens: 30, output_tokens: 12, credit: 2 } as any)).toEqual({
      prompt_tokens: 30, completion_tokens: 12, credits: 2, cache_read_tokens: 0,
    });
  });

  it("上游只给 total_tokens 不给拆分 → 兜底记到 prompt 侧，合计不为 0", () => {
    // 回归：真机「有日志但 prompt/completion 全 0」。上游若只回 total_tokens，
    // 旧实现会全丢，面板显示 0。
    const d = dryUsage({ total_tokens: 150, credit: 1 } as any);
    expect(d.prompt_tokens).toBe(150);
    expect(d.completion_tokens).toBe(0);
    expect(d.credits).toBe(1);
  });

  it("给了 prompt/total 缺 completion → 用 total 反推补齐", () => {
    const d = dryUsage({ prompt_tokens: 100, total_tokens: 150 } as any);
    expect(d.prompt_tokens).toBe(100);
    expect(d.completion_tokens).toBe(50);
  });

  it("只给输出侧与总量 → 输入侧按差值反推，不再显示 0", () => {
    const d = dryUsage({ completion_tokens: 50, total_tokens: 150 } as any);
    expect(d.prompt_tokens).toBe(100);
    expect(d.completion_tokens).toBe(50);
  });

  it("识别上游实测的 prompt_cache_hit_tokens（旧实现整列忽略 → 命中率恒 0）", () => {
    // services/cachekey.ts 顶部逆向实证：/v2/chat/completions 只会回这个名字
    // 「带 key → prompt_cache_hit_tokens=7808, credit≈0.02」。
    expect(dryUsage({ prompt_cache_hit_tokens: 7808, credit: 0.02 } as any).cache_read_tokens).toBe(7808);
  });

  it("多种命中写法并存时以上游实测字段为准", () => {
    expect(dryUsage({ prompt_cache_hit_tokens: 12, cache_read_input_tokens: 99 } as any).cache_read_tokens).toBe(12);
  });

  it("命中显式为 0 时不回落到其它兜底字段（0 是有效值，不是缺失）", () => {
    expect(dryUsage({ prompt_cache_hit_tokens: 0, cache_read_input_tokens: 99 } as any).cache_read_tokens).toBe(0);
  });
});
