import { describe, it, expect } from "vitest";
import {
  hasFingerprint,
  sanitizeText,
  sanitizeMessages,
  sanitizeContent,
  sanitizeToolCalls,
} from "../src/services/sanitize";
import {
  repackToolResultBlocks,
  cleanupOrphanToolCalls,
} from "../src/services/toolpairing";
import {
  isDeepSeekModel,
  injectThinking,
  backfillReasoningContent,
  ensureDeepSeekEffort,
  DEFAULT_DEEPSEEK_EFFORT,
} from "../src/services/thinking";
import {
  translateMaxCompletionTokens,
  normalizeToolChoice,
  normalizeToolPatterns,
  normalizeRoles,
  normalizeImageURL,
  ensureConsoleSystem,
  prepareBody,
  cloneBody,
} from "../src/services/payload";
import {
  downgradeEffort,
  effortListing,
  globalEffortMap,
  staticEffortCap,
  EFFORT_RANK,
} from "../src/services/efforts";
import { buildCacheKey, resolveConversationID, injectPromptCacheKey } from "../src/services/cachekey";

describe("指纹脱敏（sanitize）", () => {
  it("预检：普通请求零命中", () => {
    expect(hasFingerprint("帮我写个快排")).toBe(false);
    expect(sanitizeText("帮我写个快排")).toBe("帮我写个快排");
  });

  it("身份句改写（不带结尾标点，CLI 与桌面版一并覆盖）", () => {
    expect(sanitizeText("You are Claude Code, Anthropic's official CLI for Claude."))
      .toBe("You are Claude Code, Anthropic's official CLI tool for Claude.");
    expect(sanitizeText("You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."))
      .toBe("You are Claude Code, Anthropic's official CLI tool for Claude, running within the Claude Agent SDK.");
  });

  it("Main branch → Default branch", () => {
    expect(sanitizeText("Main branch (you will usually use this for PRs)"))
      .toBe("Default branch (you will usually use this for PRs)");
  });

  it("Codex instructions 首段改写", () => {
    expect(sanitizeText("You are a coding agent running in the Codex CLI, a terminal-based coding assistant."))
      .toBe("You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.");
  });

  it("反馈整句改写（give → provide）", () => {
    const out = sanitizeText("To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues");
    expect(out).toBe("To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues");
  });

  it("裸数字 11128 → 11-128（相邻码放行）", () => {
    expect(sanitizeText("code=11128")).toBe("code=11-128");
    expect(sanitizeText("错误码 11128")).toBe("错误码 11-128");
    expect(sanitizeText("11148")).toBe("11148");
    expect(sanitizeText("99999")).toBe("99999");
  });

  it("header 键值形态整段删除", () => {
    expect(sanitizeText("aa x-anthropic-billing-header: abc123; bb")).toBe("aa bb");
  });

  it("裸键名（无冒号）做最小缩写 header→hdr", () => {
    expect(sanitizeText("see `X-Anthropic-Billing-Header` here")).toBe("see `x-anthropic-billing-hdr` here");
  });

  it("尾随裸 kv 循环清到不动点（预检需先命中 cc_entrypoint=）", () => {
    // 与 Go 同口径：预检特征只列 cc_entrypoint=，纯 cc_a= 不触发整段净化。
    expect(sanitizeText("cc_version=1.2; cc_entrypoint=cli; tail")).toBe("tail");
    expect(sanitizeText("cc_entrypoint=cli; cc_a=1; cc_b=2; cc_c=3; x")).toBe("x");
  });

  it("非预检特征的裸 kv 不触发净化（零分配路径）", () => {
    expect(sanitizeText("cc_a=1; cc_b=2; x")).toBe("cc_a=1; cc_b=2; x");
  });

  it("多模态数组只动 text part，image part 不动", () => {
    const parts = [
      { type: "text", text: "Main branch (you will usually use this for PRs)" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ];
    const [out, changed] = sanitizeContent(parts);
    expect(changed).toBe(true);
    expect((out[0] as any).text).toBe("Default branch (you will usually use this for PRs)");
    expect((out[1] as any).image_url).toEqual({ url: "data:image/png;base64,AAA" });
  });

  it("tool_calls.arguments（字符串化 JSON）被净化 —— content 为 null 的工具轮也不漏", () => {
    const msgs = [
      { role: "assistant", content: null, tool_calls: [{ function: { arguments: "Main branch (you will usually use this for PRs)" } }] },
    ];
    expect(sanitizeMessages(msgs)).toBe(true);
    expect((msgs[0] as any).tool_calls[0].function.arguments)
      .toBe("Default branch (you will usually use this for PRs)");
  });

  it("reasoning_content 与 content 同等净化", () => {
    const msgs = [{ role: "assistant", content: "ok", reasoning_content: "11128" }];
    expect(sanitizeMessages(msgs)).toBe(true);
    expect(msgs[0].reasoning_content).toBe("11-128");
  });

  it("无工具流量时零改动", () => {
    expect(sanitizeToolCalls(undefined)).toBe(false);
    expect(sanitizeMessages([{ role: "user", content: "hi" }])).toBe(false);
  });
});

describe("tool 配对（toolpairing）", () => {
  it("孤儿 tool_call（无结果）被剔除 tool_calls 键", () => {
    const msgs = [
      { role: "assistant", tool_calls: [{ id: "c1" }, { id: "c2" }] },
      { role: "tool", tool_call_id: "c1" },
    ];
    const [out, changed] = cleanupOrphanToolCalls(msgs);
    expect(changed).toBe(true);
    expect(out[0].tool_calls).toEqual([{ id: "c1" }]);
  });

  it("批内部分配对：按 id 对称裁剪，不整批删（避免半截配对）", () => {
    const msgs = [
      { role: "assistant", tool_calls: [{ id: "c1" }, { id: "c2" }] },
      { role: "tool", tool_call_id: "c1" },
    ];
    const [out] = cleanupOrphanToolCalls(msgs);
    // 调用侧保留 c1（不是整批删除），否则会出现「无 tool_calls 的 assistant + 孤儿 tool」
    expect(out[0].tool_calls).toHaveLength(1);
    expect(out[0].tool_calls[0].id).toBe("c1");
    expect(out).toHaveLength(2);
  });

  it("孤儿 tool 结果整条删除", () => {
    const msgs = [
      { role: "assistant", content: "x" },
      { role: "tool", tool_call_id: "orphan" },
    ];
    const [out, changed] = cleanupOrphanToolCalls(msgs);
    expect(changed).toBe(true);
    expect(out).toHaveLength(1);
  });

  it("完整配对零改动零分配", () => {
    const msgs = [
      { role: "assistant", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1" },
    ];
    const [out, changed] = cleanupOrphanToolCalls(msgs);
    expect(changed).toBe(false);
    expect(out).toBe(msgs);
  });

  it("repack：插在 tool 结果中间的非 tool 消息挪到整组之后", () => {
    const msgs = [
      { role: "assistant", tool_calls: [{ id: "c00" }, { id: "c01" }] },
      { role: "tool", tool_call_id: "c00" },
      { role: "developer", content: "<image_resize_notice>" },
      { role: "tool", tool_call_id: "c01" },
    ];
    const [out, changed] = repackToolResultBlocks(msgs);
    expect(changed).toBe(true);
    expect(out.map((m: any) => m.role)).toEqual(["assistant", "tool", "tool", "developer"]);
    expect(out[1].tool_call_id).toBe("c00");
    expect(out[2].tool_call_id).toBe("c01");
  });

  it("repack：组头被后续非 tool 消息打断时，本组结果重排到插入物之前", () => {
    // Go 语义：changed 仅在「已见非 tool 消息之后又收到本组 tool 结果」时置位。
    // 这里 c00 在 notice 之前收到（不计 changed），c01 在之后 → 触发重排。
    const msgs = [
      { role: "assistant", tool_calls: [{ id: "c00" }, { id: "c01" }] },
      { role: "tool", tool_call_id: "c00" },
      { role: "developer", content: "<image_resize_notice>" },
      { role: "assistant", content: "mid" },
      { role: "tool", tool_call_id: "c01" },
    ];
    const [out, changed] = repackToolResultBlocks(msgs);
    expect(changed).toBe(true);
    // 结果连续在组头之后，插入物挪到整组之后
    expect(out[0].tool_calls.map((c: any) => c.id)).toEqual(["c00", "c01"]);
    expect(out[1].tool_call_id).toBe("c00");
    expect(out[2].tool_call_id).toBe("c01");
    expect(out[3].content).toBe("<image_resize_notice>");
    expect(out[4].content).toBe("mid");
  });

  it("repack：组头被下一组 assistant 打断时，零改动（原样返回）", () => {
    // 收 c00 时还没见到非 tool 消息 → changed 不置位；c01 属下一组不被收。
    const msgs = [
      { role: "assistant", tool_calls: [{ id: "c00" }, { id: "c01" }] },
      { role: "tool", tool_call_id: "c00" },
      { role: "developer", content: "<image_resize_notice>" },
      { role: "assistant", tool_calls: [{ id: "c02" }] },
      { role: "tool", tool_call_id: "c01" },
    ];
    const [out, changed] = repackToolResultBlocks(msgs);
    expect(changed).toBe(false);
    expect(out).toBe(msgs);
  });

  it("repack：assistant 后无 tool 结果时立刻 break，插入物不被误吞", () => {
    const msgs = [
      { role: "assistant", tool_calls: [{ id: "c1" }] },
      { role: "developer", content: "x" },
      { role: "assistant", tool_calls: [{ id: "c2" }] },
      { role: "tool", tool_call_id: "c2" },
    ];
    const [out, changed] = repackToolResultBlocks(msgs);
    expect(changed).toBe(false);
    expect(out).toBe(msgs);
    expect(out[0].tool_calls[0].id).toBe("c1");
    expect(out[2].tool_calls[0].id).toBe("c2");
  });

  it("repack：无插入消息时零改动", () => {
    const msgs = [
      { role: "assistant", tool_calls: [{ id: "c1" }] },
      { role: "tool", tool_call_id: "c1" },
    ];
    const [out, changed] = repackToolResultBlocks(msgs);
    expect(changed).toBe(false);
    expect(out).toBe(msgs);
  });
});

describe("deepseek thinking（thinking.ts）", () => {
  it("isDeepSeekModel 前缀匹配不区分大小写", () => {
    expect(isDeepSeekModel("deepseek-v4.1-flash")).toBe(true);
    expect(isDeepSeekModel("DeepSeek-R1")).toBe(true);
    expect(isDeepSeekModel("glm-5.2")).toBe(false);
    expect(isDeepSeekModel("hy3")).toBe(false);
  });

  it("裸 deepseek 请求注入 thinking.type=enabled + 默认档", () => {
    const obj: any = { model: "deepseek-v4.1-flash" };
    injectThinking(obj, "");
    expect(obj.thinking).toEqual({ type: "enabled" });
    expect(obj.reasoning_effort).toBe(DEFAULT_DEEPSEEK_EFFORT);
  });

  it("用模型声明的默认档（defaultEffort）而非硬编码", () => {
    const obj: any = { model: "deepseek-v4.1-flash" };
    injectThinking(obj, "low");
    expect(obj.reasoning_effort).toBe("low");
  });

  it("显式 disabled：删 reasoning_effort（snake/camel 双字段）", () => {
    const obj: any = { model: "deepseek-v4.1-flash", thinking: { type: "disabled" }, reasoning_effort: "high", reasoningEffort: "high" };
    injectThinking(obj, "low");
    expect(obj.reasoning_effort).toBeUndefined();
    expect(obj.reasoningEffort).toBeUndefined();
    expect(obj.thinking.type).toBe("disabled");
  });

  it("显式 enabled 缺 effort → 补默认档", () => {
    const obj: any = { model: "deepseek-v4.1-flash", thinking: { type: "enabled" } };
    injectThinking(obj, "high");
    expect(obj.reasoning_effort).toBe("high");
  });

  it("已有 reasoning_effort 一律不覆盖（降级交给 downgradeEffort）", () => {
    const obj: any = { model: "deepseek-v4.1-flash", reasoning_effort: "max" };
    injectThinking(obj, "high");
    expect(obj.reasoning_effort).toBe("max");
  });

  it("非 deepseek 模型零改动", () => {
    const obj: any = { model: "glm-5.2" };
    injectThinking(obj, "high");
    expect(obj.thinking).toBeUndefined();
    expect(obj.reasoning_effort).toBeUndefined();
  });

  it("ensureDeepSeekEffort：camel 存在也算已有", () => {
    const obj: any = { reasoningEffort: "max" };
    ensureDeepSeekEffort(obj, "high");
    expect(obj.reasoning_effort).toBeUndefined();
  });

  it("backfill：enabled 时每条 assistant 保证 reasoning_content 是 string", () => {
    const obj: any = {
      model: "deepseek-v4.1-flash",
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    };
    backfillReasoningContent(obj);
    expect(typeof obj.messages[1].reasoning_content).toBe("string");
    expect(obj.messages[1].reasoning_content).toBe("");
    // 镜像：reasoning 也补非空占位（上游校验 len(reasoning)>0，空串 400）
    expect(obj.messages[1].reasoning).toBe(" ");
  });

  it("backfill：reasoning 非空时复制到 reasoning_content 并镜像", () => {
    const obj: any = {
      model: "deepseek-v4.1-flash",
      thinking: { type: "enabled" },
      messages: [{ role: "assistant", reasoning: "思考过程" }],
    };
    backfillReasoningContent(obj);
    expect(obj.messages[0].reasoning_content).toBe("思考过程");
    expect(obj.messages[0].reasoning).toBe("思考过程");
  });

  it("backfill：rc 已是 string 不覆盖（原有语义保留）", () => {
    const obj: any = {
      model: "deepseek-v4.1-flash",
      thinking: { type: "enabled" },
      messages: [{ role: "assistant", reasoning_content: "orig", reasoning: "other" }],
    };
    backfillReasoningContent(obj);
    expect(obj.messages[0].reasoning_content).toBe("orig");
  });

  it("backfill：rc 为 null 不算「已有」（官方 string!=typeof 语义）", () => {
    const obj: any = {
      model: "deepseek-v4.1-flash",
      thinking: { type: "enabled" },
      messages: [{ role: "assistant", reasoning_content: null }],
    };
    backfillReasoningContent(obj);
    expect(obj.messages[0].reasoning_content).toBe("");
  });

  it("backfill：disabled + 无痕迹 → 零改动", () => {
    const obj: any = {
      model: "deepseek-v4.1-flash",
      thinking: { type: "disabled" },
      messages: [{ role: "assistant", content: "a" }],
    };
    backfillReasoningContent(obj);
    expect("reasoning_content" in obj.messages[0]).toBe(false);
  });

  it("backfill：disabled + 有痕迹 → 照补（官方 hasTrace 半边）", () => {
    const obj: any = {
      model: "deepseek-v4.1-flash",
      thinking: { type: "disabled" },
      messages: [{ role: "assistant", content: "a", reasoning: "x" }],
    };
    backfillReasoningContent(obj);
    expect(obj.messages[0].reasoning_content).toBe("x");
  });

  it("backfill：非 deepseek 零改动", () => {
    const obj: any = { model: "glm-5.2", messages: [{ role: "assistant", content: "a" }] };
    backfillReasoningContent(obj);
    expect("reasoning_content" in obj.messages[0]).toBe(false);
  });
});

describe("effort 降级（efforts.ts）", () => {
  it("支持档位 → 零改动", () => {
    const obj: any = { model: "m", reasoning_effort: "high" };
    expect(downgradeEffort(["low", "high", "max"], "m", obj)).toBeNull();
    expect(obj.reasoning_effort).toBe("high");
  });

  it("不支持档位 → 降到 ≤请求档的最高支持档", () => {
    // 请求 xhigh(5)，支持档 low(2)/high(4)/max(6)：≤5 的最高是 high(4)，max(6) 高于请求档不可用
    const obj: any = { model: "m", reasoning_effort: "xhigh" };
    const r = downgradeEffort(["low", "high", "max"], "m", obj);
    expect(r).toEqual({ effort: "high", from: "xhigh", why: "downgraded" });
    expect(obj.reasoning_effort).toBe("high");
  });

  it("请求档低于全部支持档时 floored 到最低支持档", () => {
    // off(0) 不在支持档内，≤off 无候选 → 走 floored 分支取最低支持档 low(2)
    const obj2: any = { model: "m", reasoning_effort: "off" };
    const r2 = downgradeEffort(["low", "high", "max"], "m", obj2);
    expect(r2).toEqual({ effort: "low", from: "off", why: "floored" });
    expect(obj2.reasoning_effort).toBe("low");
  });

  it("支持档全部高于请求档 → 取最低支持档（floored）", () => {
    const obj: any = { model: "m", reasoning_effort: "low" };
    const r = downgradeEffort(["high", "xhigh"], "m", obj);
    expect(r).toEqual({ effort: "high", from: "low", why: "floored" });
  });

  it("camel 字段兼容", () => {
    const obj: any = { model: "m", reasoningEffort: "max" };
    downgradeEffort(["high"], "m", obj);
    expect(obj.reasoningEffort).toBe("high");
    expect(obj.reasoning_effort).toBeUndefined();
  });

  it("未知模型/未知档位/未携带 → 透传", () => {
    expect(downgradeEffort(undefined, "m", { reasoning_effort: "max" })).toBeNull();
    expect(downgradeEffort(["high"], "", { reasoning_effort: "max" })).toBeNull();
    expect(downgradeEffort(["high"], "m", { reasoning_effort: "ultra" })).toBeNull();
    expect(downgradeEffort(["high"], "m", { model: "m" })).toBeNull();
    expect(downgradeEffort(["high"], "m", { reasoning_effort: 5 })).toBeNull();
  });

  it("EFFORT_RANK 档位序", () => {
    expect(EFFORT_RANK.off).toBeLessThan(EFFORT_RANK.minimal);
    expect(EFFORT_RANK.minimal).toBeLessThan(EFFORT_RANK.low);
    expect(EFFORT_RANK.low).toBeLessThan(EFFORT_RANK.medium);
    expect(EFFORT_RANK.medium).toBeLessThan(EFFORT_RANK.high);
    expect(EFFORT_RANK.high).toBeLessThan(EFFORT_RANK.xhigh);
    expect(EFFORT_RANK.xhigh).toBeLessThan(EFFORT_RANK.max);
  });

  it("静态表按 realm 分表：deepseek-v4.1-flash CN 三档 / global 单档", () => {
    expect(staticEffortCap("cn", "deepseek-v4.1-flash")!.efforts).toEqual(["low", "high", "max"]);
    expect(staticEffortCap("global", "deepseek-v4.1-flash")!.efforts).toEqual(["high"]);
  });

  it("effortListing：远端优先，缺失落静态表，皆无返回 null", () => {
    // 远端非空即权威（不回落到静态表）；defaultEffort 命中 efforts 才宣称
    expect(effortListing("cn", "hy3", ["ultra"], "ultra")).toEqual({ efforts: ["ultra"], defaultEffort: "ultra" });
    expect(effortListing("cn", "hy3", ["low", "high", "ultra"], "ultra")).toEqual({
      efforts: ["low", "high", "ultra"],
      defaultEffort: "ultra",
    });
    expect(effortListing("cn", "hy3", null, "")).toEqual({ efforts: ["low", "high"], defaultEffort: "high" });
    expect(effortListing("cn", "unknown-model", null, "")).toBeNull();
  });

  it("effortListing：defaultEffort 不在 efforts 内则不宣称", () => {
    expect(effortListing("cn", "m", ["low"], "high")).toEqual({ efforts: ["low"], defaultEffort: "" });
  });

  it("effortListing：远端 defaultEffort 空串不回落静态默认档（不跨源拼接）", () => {
    expect(effortListing("cn", "hy3", ["low", "high", "ultra"], "")).toEqual({
      efforts: ["low", "high", "ultra"],
      defaultEffort: "",
    });
  });

  it("globalEffortMap：静态为基、远端覆盖", () => {
    const { efforts, defaults } = globalEffortMap({ "gpt-5.5": ["low"] }, { "gpt-5.5": "low" });
    expect(efforts["gpt-5.5"]).toEqual(["low"]); // 远端覆盖静态四档
    expect(defaults["gpt-5.5"]).toBe("low");
    expect(efforts["deepseek-v4.1-flash"]).toEqual(["high"]); // 静态兜底仍在
    expect(efforts["hy3"]).toEqual(["low", "high"]);
  });
});

describe("prompt_cache_key（cachekey.ts）", () => {
  it("键格式 wb2a-<uid8>-<convHex32>，uid8 是账号硬隔离因子", async () => {
    const k = await buildCacheKey("user-12345678-abcdef", "conv-1");
    expect(k.startsWith("wb2a-user-123-")).toBe(true);
    expect(k).toMatch(/^wb2a-.+-[0-9a-f]{32}$/);
    expect(k.slice(-32)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("uid8 截断到 8 字符（uid 更长时）", async () => {
    const k = await buildCacheKey("0123456789abcdef", "c");
    expect(k.startsWith("wb2a-01234567-")).toBe(true);
  });

  it("跨账号绝不碰撞（uid 是隔离因子）", async () => {
    const a = await buildCacheKey("acct-aaaa", "same-conv");
    const b = await buildCacheKey("acct-bbbb", "same-conv");
    expect(a).not.toBe(b);
  });

  it("同账号同会话稳定、不同会话不同", async () => {
    expect(await buildCacheKey("u1", "c1")).toBe(await buildCacheKey("u1", "c1"));
    expect(await buildCacheKey("u1", "c1")).not.toBe(await buildCacheKey("u1", "c2"));
  });

  it("空会话 → 仍保留账号隔离段，但同账号两次相同（空会话语义）", async () => {
    const a = await buildCacheKey("u1", "");
    const b = await buildCacheKey("u1", "");
    expect(a).toBe(b);
    expect(a).not.toBe(await buildCacheKey("u2", ""));
  });

  it("uid 为空 → 占位段（三横线，与 Go 同口径）", async () => {
    expect(await buildCacheKey("", "c")).toMatch(/^wb2a---[0-9a-f]{32}$/);
  });

  it("convHex 段恒 32 hex", async () => {
    const k = await buildCacheKey("u1", "c1");
    expect(k.slice(-32)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("resolveConversationID：metadata 优先、snake 优先于 camel", () => {
    expect(resolveConversationID({ metadata: { conversation_id: "m1" }, conversation_id: "top" })).toBe("m1");
    expect(resolveConversationID({ metadata: { conversationId: "m2" } })).toBe("m2");
    expect(resolveConversationID({ conversation_id: "top" })).toBe("top");
    expect(resolveConversationID({ conversationId: "camel" })).toBe("camel");
  });

  it("resolveConversationID：绝不回落 user_id；缺失返回空串", () => {
    expect(resolveConversationID({ user_id: "u1" })).toBe("");
    expect(resolveConversationID({})).toBe("");
    expect(resolveConversationID(null)).toBe("");
  });

  it("injectPromptCacheKey：客户端已显式带 key → 绝不覆盖", async () => {
    const body: any = { prompt_cache_key: "mine" };
    await injectPromptCacheKey(body, "u1", "c1");
    expect(body.prompt_cache_key).toBe("mine");
  });

  it("injectPromptCacheKey：body 内 conversation_id 优先于入参", async () => {
    const body: any = { conversation_id: "from-body" };
    await injectPromptCacheKey(body, "u1", "from-arg");
    expect(body.prompt_cache_key).toBe(await buildCacheKey("u1", "from-body"));
  });

  it("injectPromptCacheKey：两者都空 → 用入参", async () => {
    const body: any = {};
    await injectPromptCacheKey(body, "u1", "arg-only");
    expect(body.prompt_cache_key).toBe(await buildCacheKey("u1", "arg-only"));
  });

  it("injectPromptCacheKey：非对象原样返回（不抛）", async () => {
    await injectPromptCacheKey(null, "u1", "c");
    expect(true).toBe(true);
  });
});

describe("出站归一化（payload.ts 各步）", () => {
  it("translateMaxCompletionTokens：别名翻译为 max_tokens 并删别名", () => {
    const obj: any = { max_completion_tokens: 128000 };
    translateMaxCompletionTokens(obj);
    expect(obj.max_tokens).toBe(128000);
    expect("max_completion_tokens" in obj).toBe(false);
  });

  it("translateMaxCompletionTokens：显式 max_tokens 优先，别名只删不译", () => {
    const obj: any = { max_tokens: 100, max_completion_tokens: 200 };
    translateMaxCompletionTokens(obj);
    expect(obj.max_tokens).toBe(100);
    expect("max_completion_tokens" in obj).toBe(false);
  });

  it("translateMaxCompletionTokens：0/null/负数/小数/非数值不翻译", () => {
    for (const v of [0, null, -5, 1.5, "abc"]) {
      const obj: any = { max_completion_tokens: v };
      translateMaxCompletionTokens(obj);
      expect(obj.max_tokens).toBeUndefined();
    }
  });

  it("translateMaxCompletionTokens：无别名时不动", () => {
    const obj: any = { max_tokens: 7 };
    translateMaxCompletionTokens(obj);
    expect(obj.max_tokens).toBe(7);
  });

  it("normalizeToolChoice：none 删 tool_choice + 删 tools/functions", () => {
    for (const tc of ["none", { type: "none" }]) {
      const obj: any = { tool_choice: tc, tools: [1], functions: [2] };
      normalizeToolChoice(obj);
      expect(obj.tool_choice).toBeUndefined();
      expect(obj.tools).toBeUndefined();
      expect(obj.functions).toBeUndefined();
    }
  });

  it("normalizeToolChoice：auto/required 对象 → 字符串", () => {
    const obj: any = { tool_choice: { type: "AUTO" } };
    normalizeToolChoice(obj);
    expect(obj.tool_choice).toBe("auto");
  });

  it("normalizeToolChoice：function 对象 → 名字字符串；缺名回落 auto", () => {
    const obj: any = { tool_choice: { type: "function", function: { name: " get " } } };
    normalizeToolChoice(obj);
    expect(obj.tool_choice).toBe("get");
    const obj2: any = { tool_choice: { type: "function" } };
    normalizeToolChoice(obj2);
    expect(obj2.tool_choice).toBe("auto");
  });

  it("normalizeToolChoice：非标对象/数组/null → 删 tool_choice", () => {
    for (const tc of [{ type: "weird" }, [1, 2], null, 5]) {
      const obj: any = { tool_choice: tc };
      normalizeToolChoice(obj);
      expect(obj.tool_choice).toBeUndefined();
    }
  });

  it("normalizeToolPatterns：`\\_` → `_`（上游严格文法会 400 code=11129）", () => {
    const obj: any = {
      tools: [
        { function: { parameters: { properties: { id: { pattern: "^agent\\_run\\_" } }, patternProperties: { "^x\\_": { type: "string" } } } } },
        { parameters: { pattern: "a\\_b" } },
      ],
    };
    normalizeToolPatterns(obj);
    expect(obj.tools[0].function.parameters.properties.id.pattern).toBe("^agent_run_");
    expect(Object.keys(obj.tools[0].function.parameters.patternProperties)).toEqual(["^x_"]);
    expect(obj.tools[1].parameters.pattern).toBe("a_b");
  });

  it("normalizeToolPatterns：消息正文里的 `\\_`（Windows 路径）不碰", () => {
    const obj: any = { messages: [{ role: "user", content: "C:\\_x" }] };
    normalizeToolPatterns(obj);
    expect(obj.messages[0].content).toBe("C:\\_x");
  });

  it("normalizeRoles：developer → system（上游 role 白名单不含 developer）", () => {
    const obj: any = { messages: [{ role: "DEVELOPER" }, { role: "user" }, { role: "weird" }] };
    normalizeRoles(obj);
    expect(obj.messages[0].role).toBe("system");
    expect(obj.messages[1].role).toBe("user");
    expect(obj.messages[2].role).toBe("weird"); // 其余原样保留，不合并不删除
  });

  it("normalizeImageURL：字符串 → 对象；已有对象与空值不动", () => {
    const obj: any = {
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: "data:image/png;base64,AAA" }] },
        { role: "user", content: [{ type: "image_url", image_url: { url: "u", detail: "high" } }] },
        { role: "user", content: [{ type: "image_url", image_url: "" }] },
      ],
    };
    normalizeImageURL(obj);
    expect(obj.messages[0].content[0].image_url).toEqual({ url: "data:image/png;base64,AAA" });
    expect(obj.messages[1].content[0].image_url).toEqual({ url: "u", detail: "high" });
    expect(obj.messages[2].content[0].image_url).toBe("");
  });

  it("ensureConsoleSystem：首条非 system 才注入；已是 system 不重复", () => {
    const a: any = { messages: [{ role: "user", content: "q" }] };
    ensureConsoleSystem(a);
    expect(a.messages[0].role).toBe("system");
    expect(a.messages).toHaveLength(2);
    const b: any = { messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }] };
    ensureConsoleSystem(b);
    expect(b.messages).toHaveLength(2);
  });

  it("cloneBody：深拷贝会被改写的节点，不改原对象", () => {
    const src = {
      stream: false,
      messages: [{ role: "developer", content: [{ type: "text", text: "t" }], tool_calls: [{ function: { arguments: "a" } }] }],
    };
    const out = cloneBody(src);
    out.messages[0].role = "system";
    out.messages[0].content[0].text = "changed";
    out.messages[0].tool_calls[0].function.arguments = "changed";
    expect(src.stream).toBe(false);
    expect(src.messages[0].role).toBe("developer");
    expect(src.messages[0].content[0].text).toBe("t");
    expect(src.messages[0].tool_calls[0].function.arguments).toBe("a");
  });
});

describe("prepareBody 完整管线", () => {
  it("强制 stream=true + 补 stream_options", () => {
    const out = prepareBody({ model: "hy3", messages: [] }, { realm: "cn" });
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it("显式 stream_options 不覆盖", () => {
    const out = prepareBody({ model: "hy3", messages: [], stream_options: { include_usage: false } }, { realm: "cn" });
    expect(out.stream_options).toEqual({ include_usage: false });
  });

  it("不改调用方的 body（stream 标志不被污染）", () => {
    const src = { model: "hy3", messages: [{ role: "developer", content: "x" }] };
    prepareBody(src, { realm: "cn" });
    expect(src.stream).toBeUndefined();
    expect(src.messages[0].role).toBe("developer");
  });

  it("完整管线顺序：别名翻译 + role 归一 + tool 归一一次跑完", () => {
    const out = prepareBody(
      {
        model: "hy3",
        max_completion_tokens: 2000,
        tool_choice: { type: "auto" },
        messages: [
          { role: "developer", content: "sys" },
          { role: "assistant", tool_calls: [{ id: "c1" }] },
          { role: "user", content: [{ type: "image_url", image_url: "http://x" }] },
        ],
      },
      { realm: "cn" },
    );
    expect(out.max_tokens).toBe(2000);
    expect(out.tool_choice).toBe("auto");
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[1].tool_calls).toBeUndefined(); // 孤儿被清
    expect(out.messages[2].content[0].image_url).toEqual({ url: "http://x" });
  });

  it("deepseek：注入 thinking + 默认档，然后按支持档降级", () => {
    const out = prepareBody({ model: "deepseek-v4.1-flash", messages: [] }, {
      realm: "cn",
      tables: { efforts: { "deepseek-v4.1-flash": ["low", "high", "max"] }, defaults: {} },
    });
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.reasoning_effort).toBe("high"); // 默认档 high 在支持档内 → 不降级
  });

  it("effort 表未就绪 → 透传不降级", () => {
    const out = prepareBody({ model: "deepseek-v4.1-flash", messages: [], reasoning_effort: "max" }, { realm: "cn" });
    expect(out.reasoning_effort).toBe("max");
  });

  it("sanitize=true 脱敏并记 notes；sanitize=false 完全还原", () => {
    const src = { model: "hy3", messages: [{ role: "user", content: "Main branch (you will usually use this for PRs)" }] };
    const n1: string[] = [];
    const on = prepareBody(src, { realm: "cn", notes: n1 });
    expect(on.messages[0].content).toBe("Default branch (you will usually use this for PRs)");
    expect(n1).toContain("sanitized");
    const n2: string[] = [];
    const off = prepareBody(src, { realm: "cn", sanitize: false, notes: n2 });
    expect(off.messages[0].content).toBe("Main branch (you will usually use this for PRs)");
    expect(n2).not.toContain("sanitized");
  });

  it("globalOn：注入兜底 system", () => {
    const out = prepareBody({ model: "gpt-5.5", messages: [{ role: "user", content: "q" }] }, { realm: "global", globalOn: true });
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("非对象 body 原样返回（坏 body 不二次错误化）", () => {
    expect(prepareBody(null, { realm: "cn" })).toBeNull();
    expect(prepareBody("str", { realm: "cn" })).toBe("str");
    expect(prepareBody([1], { realm: "cn" })).toEqual([1]);
  });

  it("tool 配对清理记 note", () => {
    const notes: string[] = [];
    prepareBody(
      { model: "hy3", messages: [{ role: "assistant", tool_calls: [{ id: "c1" }] }, { role: "user", content: "q" }] },
      { realm: "cn", notes },
    );
    expect(notes).toContain("tool_pairing_cleaned");
  });

  it("effort 降级记 note", () => {
    const notes: string[] = [];
    const out = prepareBody({ model: "hy3", messages: [], reasoning_effort: "max" }, {
      realm: "cn",
      tables: { efforts: { hy3: ["low", "high"] }, defaults: {} },
      notes,
    });
    expect(out.reasoning_effort).toBe("high");
    expect(notes).toContain("reasoning_effort_downgraded:max->high");
  });

  it("effort floored 记 note（支持档全高于请求档）", () => {
    const notes: string[] = [];
    const out = prepareBody({ model: "hy3", messages: [], reasoning_effort: "low" }, {
      realm: "cn",
      tables: { efforts: { hy3: ["high", "xhigh"] }, defaults: {} },
      notes,
    });
    expect(out.reasoning_effort).toBe("high");
    expect(notes).toContain("reasoning_effort_floored:low->high");
  });
});
