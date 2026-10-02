import { describe, it, expect } from "vitest";
import { Chain, IsVirtual, VirtualIDs, Fallbackable, RealmOf, BareOf, NO_HEALTHY_ACCOUNT, type AutoModelConfig } from "../src/services/autoroute";
import { isEmptyCompletion, hourCST, parseRateReset, backoffAfterFor } from "../src/services/proxy";
import { normalizeModelRate, effectiveModelRate } from "../src/services/upstream";
import { extractRates } from "../src/services/rates";

// 模型编排（internal/autoroute/autoroute.go）+ 代理侧辅助的纯函数测试。

const CFG: AutoModelConfig = {
  enabled: true,
  day_primary: "cn:hy3",
  night_primary: "cn:glm-5.2",
  day_start: 8,
  day_end: 23,
  fallback: ["cn:hy4-preview", "global:gpt-5"],
  model_fallback: {},
  virtual_id: "auto",
  override: false,
  on_empty: true,
  fallback_on: [],
};

describe("autoroute 名称解析", () => {
  it("realm 前缀解析（大小写敏感，无前缀回落 cn）", () => {
    expect(RealmOf("cn:hy3")).toBe("cn");
    expect(RealmOf("global:gpt-5")).toBe("global");
    expect(RealmOf("hy3")).toBe("cn");
    expect(RealmOf("CN:hy3")).toBe("cn"); // 非精确枚举 → 当裸名
    expect(BareOf("cn:hy3")).toBe("hy3");
    expect(BareOf("hy3")).toBe("hy3");
    expect(BareOf("foo:bar")).toBe("foo:bar");
  });
});

describe("autoroute 虚拟模型让位", () => {
  it("上游同名模型存在且未开 override → 不接管", () => {
    expect(IsVirtual(CFG, "auto", true)).toBe(false);
    expect(IsVirtual({ ...CFG, override: true }, "auto", true)).toBe(true);
    // 上游没有同名 → 接管。
    expect(IsVirtual(CFG, "auto", false)).toBe(true);
  });

  it("未启用编排时永不接管；非虚拟名不接管", () => {
    expect(IsVirtual({ ...CFG, enabled: false }, "auto", false)).toBe(false);
    expect(IsVirtual(CFG, "cn:hy3", false)).toBe(false);
  });

  it("自定义 virtual_id 生效（避开上游同名冲突）", () => {
    const c = { ...CFG, virtual_id: "auto-router" };
    expect(IsVirtual(c, "auto-router", false)).toBe(true);
    expect(IsVirtual(c, "auto", false)).toBe(false);
  });

  it("VirtualIDs 列出裸名 + 主模型 realm 前缀", () => {
    expect(VirtualIDs(CFG)).toEqual(["auto", "cn:auto"]);
    expect(VirtualIDs({ ...CFG, enabled: false })).toBeNull();
  });
});

describe("autoroute 候选链", () => {
  it("非虚拟模型返回单元素链（零回归）", () => {
    expect(Chain(CFG, "cn:hy3", 12, true)).toEqual(["cn:hy3"]);
  });

  it("白天/夜间主模型轮换", () => {
    expect(Chain(CFG, "auto", 10, false)[0]).toBe("cn:hy3");
    expect(Chain(CFG, "auto", 2, false)[0]).toBe("cn:glm-5.2");
  });

  it("裸 auto：链 = 主模型 + 全部 fallback（无 realm 约束时不剔跨域）", () => {
    // Go filterRealm 口径：want 为空（裸 auto）时原样保留 fallback，
    // 跨域候选由下游选号的 realm 过滤兜住。
    expect(Chain(CFG, "auto", 10, false)).toEqual(["cn:hy3", "cn:hy4-preview", "global:gpt-5"]);
  });

  it("带 realm 前缀的 auto：跨域 fallback 被剔除", () => {
    expect(Chain(CFG, "cn:auto", 10, false)).toEqual(["cn:hy3", "cn:hy4-preview"]);
  });

  it("带 realm 前缀的 auto 只在该域选主模型", () => {
    const c: AutoModelConfig = { ...CFG, day_primary: "global:gpt-5", night_primary: "global:gpt-5" };
    const chain = Chain(c, "global:auto", 10, false);
    expect(chain[0]).toBe("global:gpt-5");
    expect(chain.every((m) => RealmOf(m) === "global")).toBe(true);
  });

  it("跨零点昼夜窗口（22→6）：22:00–06:00 为白天", () => {
    const c: AutoModelConfig = { ...CFG, day_start: 22, day_end: 6 };
    expect(Chain(c, "auto", 23, false)[0]).toBe("cn:hy3"); // 窗口内
    expect(Chain(c, "auto", 3, false)[0]).toBe("cn:hy3"); // 跨零点仍在窗口内
    expect(Chain(c, "auto", 12, false)[0]).toBe("cn:glm-5.2"); // 窗口外 → 夜间主模型
  });

  it("day_start == day_end 视为全天白天", () => {
    const c: AutoModelConfig = { ...CFG, day_start: 0, day_end: 0 };
    expect(Chain(c, "auto", 3, false)[0]).toBe("cn:hy3");
  });

  it("model_fallback 递归展开（去重、限深 3）", () => {
    const c: AutoModelConfig = {
      ...CFG,
      model_fallback: { "cn:hy3": ["cn:a", "cn:b"], "cn:a": ["cn:c", "cn:hy3"] },
    };
    const chain = Chain(c, "cn:hy3", 10, true);
    expect(chain[0]).toBe("cn:hy3");
    expect(chain).toContain("cn:a");
    expect(chain).toContain("cn:b");
    expect(chain).toContain("cn:c");
    // 去重：hy3 只出现一次（成环不重复展开）。
    expect(chain.filter((m) => m === "cn:hy3").length).toBe(1);
  });

  it("model_fallback 限深 3", () => {
    const c: AutoModelConfig = {
      ...CFG,
      model_fallback: { m0: ["m1"], m1: ["m2"], m2: ["m3"], m3: ["m4"] },
    };
    const chain = Chain(c, "m0", 10, true);
    expect(chain).toEqual(["m0", "m1", "m2", "m3"]);
  });

  it("链长封顶 8（防配置成环导致请求放大）", () => {
    const mf: Record<string, string[]> = {};
    for (let i = 0; i < 20; i++) mf["m" + i] = ["m" + (i + 1)];
    const chain = Chain({ ...CFG, model_fallback: mf }, "m0", 10, true);
    expect(chain.length).toBeLessThanOrEqual(8);
  });

  it("虚拟名在上游存在且未 override → 单元素链（让位）", () => {
    expect(Chain(CFG, "auto", 10, true)).toEqual(["auto"]);
  });
});

describe("autoroute 降级类别", () => {
  it("默认可降级类别：换号解决不了的那几个", () => {
    for (const k of ["soft_rate", "hard_credit", "model_blocked", "server", "account_fault", "not_found", NO_HEALTHY_ACCOUNT]) {
      expect(Fallbackable(CFG, k)).toBe(true);
    }
  });

  it("请求本身的问题不降级（换任何模型都一样撞墙）", () => {
    for (const k of ["content_blocked", "bad_params", "prompt_too_long", "image_invalid", "client", ""]) {
      expect(Fallbackable(CFG, k)).toBe(false);
    }
  });

  it("fallback_on 显式配置覆盖默认集合", () => {
    const c = { ...CFG, fallback_on: ["soft_rate"] };
    expect(Fallbackable(c, "soft_rate")).toBe(true);
    expect(Fallbackable(c, "server")).toBe(false);
  });
});

describe("proxy 辅助", () => {
  it("isEmptyCompletion：无 choices / 空 content 判空；带 tool_calls 不判空", () => {
    expect(isEmptyCompletion({})).toBe(true);
    expect(isEmptyCompletion({ choices: [] })).toBe(true);
    expect(isEmptyCompletion({ choices: [{ message: { content: "  " } }] })).toBe(true);
    expect(isEmptyCompletion({ choices: [{ message: { content: "hi" } }] })).toBe(false);
    expect(isEmptyCompletion({ choices: [{ message: { content: "", tool_calls: [{ id: "1" }] } }] })).toBe(false);
    expect(isEmptyCompletion({ choices: [{ message: { content: "", reasoning_content: "thinking" } }] })).toBe(false);
    // 形态未知 → 不判空（宁可不降级，也不误吞正常响应）。
    expect(isEmptyCompletion({ choices: ["weird"] })).toBe(false);
  });

  it("parseRateReset：CN 文案与 global 英文文案都解析（固定 UTC+8）", () => {
    const cn = parseRateReset('{"message":"请求过于频繁，将在 2026-01-02 03:04:05 重置"}');
    expect(cn).toBe(Date.UTC(2026, 0, 2, 3, 4, 5) - 8 * 3600_000);
    const en = parseRateReset("rate limited, will reset at 2026-01-02 03:04:05 UTC+8");
    expect(en).toBe(Date.UTC(2026, 0, 2, 3, 4, 5) - 8 * 3600_000);
    expect(parseRateReset("no reset info")).toBe(0);
  });

  it("hourCST 返回 0-23", () => {
    const h = hourCST();
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(23);
  });

  it("轮转退避：指数增长、封顶 8s、带 ±25% 抖动", () => {
    const d0 = backoffAfterFor(0);
    expect(d0).toBeGreaterThanOrEqual(375);
    expect(d0).toBeLessThanOrEqual(625);
    const d3 = backoffAfterFor(3);
    expect(d3).toBeGreaterThanOrEqual(3000);
    expect(d3).toBeLessThanOrEqual(8000);
    const d20 = backoffAfterFor(20);
    expect(d20).toBeLessThanOrEqual(10_000);
    expect(d20).toBeGreaterThanOrEqual(6000);
  });
});

describe("模型倍率规范化（积分保底目录兜底的数据源）", () => {
  it("normalizeModelRate 兼容 x0.05 / 0.50x / 0.05 credits", () => {
    expect(normalizeModelRate("x0.05")).toBe("0.05");
    expect(normalizeModelRate("0.50x")).toBe("0.5");
    expect(normalizeModelRate("0.05 credits")).toBe("0.05");
    expect(normalizeModelRate("X1.62")).toBe("1.62");
    expect(normalizeModelRate("")).toBe("");
    expect(normalizeModelRate("abc")).toBe("abc"); // 无法数值化不编造
  });

  it("effectiveModelRate：有机器可读优惠取折扣价，否则牌价", () => {
    expect(effectiveModelRate({ credits: "x1", promoFactor: 0, promoCredits: "0x" })).toBe("0");
    expect(effectiveModelRate({ credits: "x1", promoFactor: 0.5, promoCredits: "0.50x" })).toBe("0.5");
    // factor 有但 discountedCredits 缺 → 回落牌价（不编造折扣价）。
    expect(effectiveModelRate({ credits: "x1", promoFactor: 0.5, promoCredits: "" })).toBe("1");
    // 错峰类只有标签无 discount → 牌价。
    expect(effectiveModelRate({ credits: "x1.62" })).toBe("1.62");
  });

  it("extractRates 跳过未知倍率", () => {
    const rates = extractRates([
      { id: "hy3", credits: "x1" },
      { id: "free", credits: "", promoFactor: 0, promoCredits: "0x" },
      { id: "nomodels" },
      { name: "x" },
    ]);
    expect(rates).toEqual({ hy3: "1", free: "0" });
  });
});
