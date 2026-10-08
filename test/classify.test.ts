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

  // 回归守卫：11101 原为 `rotate:true / passthrough:false`（"不罚号，仍轮转"）。
  // 但参数是**请求本身**的属性，同一份 body 打到任何账号，上游都会确定性回同一个
  // 11101，换号不可能变成功；而 proxy 的循环里只有 passthrough:true 才立即返回，
  // rotate 仅决定是否 sleep 退避——于是那组取值会让一次参数错误的请求反复重选账号、
  // 重打上游，白白烧掉多个账号的上游往返与在途名额。故与同类请求级错误 11115 对齐。
  it("参数错误 11101 -> 不轮转透传（避免换号白烧上游往返）", () => {
    const c = classify(400, JSON.stringify({ code: "11101" }));
    expect(c.kind).toBe("ErrBadParams");
    expect(c.passthrough).toBe(true);
    expect(c.rotate).toBe(false);
  });

  // 内容能否通过审核由请求内容决定，换任何账号都会撞同一条审核规则，跨账号轮转纯浪费。
  // （proxy 里的"降级重试"是同一账号换系统提示词再试一次，不经过这里的 rotate。）
  it("内容被拦截 -> 不罚号且不跨账号轮转", () => {
    const c = classify(400, JSON.stringify({ msg: "Request blocked by security policy" }));
    expect(c.kind).toBe("ErrContentBlocked");
    expect(c.note).toBe("none");
    expect(c.rotate).toBe(false);
  });

  it("5xx -> 熔断计数且轮转", () => {
    const c = classify(503, "upstream down");
    expect(c.kind).toBe("ErrServer");
    expect(c.note).toBe("server");
    expect(c.rotate).toBe(true);
  });
});
