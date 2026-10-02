import { describe, it, expect } from "vitest";
import { classify } from "../src/services/classify";

describe("classify", () => {
  it("硬积分耗尽 -> 402 + hard_credit 惩罚", () => {
    const c = classify(402, JSON.stringify({ code: "upstream_credits_exhausted" }));
    expect(c.kind).toBe("ErrHardCredit");
    expect(c.status).toBe(402);
    expect(c.note).toBe("hard_credit");
    expect(c.rotate).toBe(true);
  });

  it("软限流 429 -> soft_rate", () => {
    const c = classify(429, JSON.stringify({ code: "rate_limit_exceeded" }));
    expect(c.kind).toBe("ErrSoftRate");
    expect(c.note).toBe("soft_rate");
  });

  it("会话失效 12153 -> 禁用", () => {
    const c = classify(401, JSON.stringify({ code: "12153" }));
    expect(c.kind).toBe("ErrSessionDead");
    expect(c.note).toBe("session_dead");
    expect(c.rotate).toBe(false);
  });

  it("WAF 403 无业务信封 -> waf_block fail-fast", () => {
    const c = classify(403, "<html>forbidden</html>");
    expect(c.kind).toBe("ErrWafBlock");
    expect(c.note).toBe("waf_block");
    expect(c.rotate).toBe(false);
  });

  it("提示词过长 11115 -> 不轮转透传", () => {
    const c = classify(400, JSON.stringify({ code: "11115" }));
    expect(c.kind).toBe("ErrPromptTooLong");
    expect(c.passthrough).toBe(true);
    expect(c.rotate).toBe(false);
  });

  it("5xx -> 熔断计数且轮转", () => {
    const c = classify(503, "upstream down");
    expect(c.kind).toBe("ErrServer");
    expect(c.note).toBe("server");
    expect(c.rotate).toBe(true);
  });
});
