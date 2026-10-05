import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  DEFAULT_PROMPT,
  DEGRADED,
  nextMidnightCST,
  rewriteSystemPrompt,
  appendSystemPrompt,
  applyPromptPolicy,
  loadPromptText,
  degradedActive,
  degradedUntil,
  triggerDegrade,
  invalidateDegradeCache,
} from "../src/services/prompt";
import { DEFAULT_CONFIG, normalizePromptMode } from "../src/config";
import { classify } from "../src/services/classify";
import type { Env } from "../worker-configuration.d.ts";

// 降级状态现在是**进程内缓存**的（60s），而单测里每个用例都会重建 memKV。
// 不清理的话上一个用例写进 KV 的降级标记会以缓存形式泄漏到下一个用例——
// 表现为「明明是新环境，degraded 却莫名其妙是 true」。这是测试隔离问题，
// 不是产品问题：真机上一个 isolate 内连续请求共享这份缓存正是设计意图。
beforeEach(() => invalidateDegradeCache());

/** 可读写的内存 KV（get/put/delete 语义齐 Workers KV 子集）。 */
function memKV(seed: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}

function envOf(kv: ReturnType<typeof memKV>): Env {
  return { WB2A_CONFIG: kv as any, WB2A_CACHE: kv as any } as unknown as Env;
}

function cfgWith(prompt: any) {
  return { ...DEFAULT_CONFIG, prompt: { mode: "passthrough", file: "", text: "", ...prompt } };
}

afterEach(() => vi.useRealTimers());

describe("常量", () => {
  it("DEGRADED 是极简中性英文提示词", () => {
    expect(DEGRADED).toBe(
      "You are a helpful assistant. Respond in the user's language, follow the user's instructions, and be direct and concise.",
    );
  });

  it("DEFAULT_PROMPT 保留 Go defaultprompt.md 的六小节结构", () => {
    for (const h of ["# 系统提示词", "## 核心立场", "## 语言与风格", "## 工程行为", "## 任务分解", "## 输出格式", "## 边界"]) {
      expect(DEFAULT_PROMPT).toContain(h);
    }
  });

  it("DEFAULT_PROMPT 里的代码围栏未被反引号提前截断", () => {
    expect(DEFAULT_PROMPT).toContain("```go / ```bash / ```json");
    expect(DEFAULT_PROMPT).toContain("`file:line`");
  });
});

describe("normalizePromptMode", () => {
  it("空串等同 passthrough（Go 口径）", () => {
    expect(normalizePromptMode("")).toBe("passthrough");
    expect(normalizePromptMode("   ")).toBe("passthrough");
    expect(normalizePromptMode(undefined)).toBe("passthrough");
    expect(normalizePromptMode(null)).toBe("passthrough");
  });

  it("大小写与空白容错", () => {
    expect(normalizePromptMode("Custom")).toBe("custom");
    expect(normalizePromptMode("  APPEND  ")).toBe("append");
    expect(normalizePromptMode("passthrough")).toBe("passthrough");
  });

  it("非法值返回 null（不静默当成 off）", () => {
    expect(normalizePromptMode("off")).toBeNull();
    expect(normalizePromptMode("rewrite")).toBeNull();
    expect(normalizePromptMode(123)).toBeNull();
  });

  it("默认配置是 passthrough（对齐 Go Default()）", () => {
    expect(DEFAULT_CONFIG.prompt.mode).toBe("passthrough");
  });
});

describe("nextMidnightCST", () => {
  it("23:59 CST → 次日 00:00（几秒后）", () => {
    // 2026-03-05 23:59:00 +08:00
    const now = Date.UTC(2026, 2, 5, 15, 59, 0);
    expect(nextMidnightCST(now)).toBe(Date.UTC(2026, 2, 5, 16, 0, 0));
  });

  it("刚过 00:00 → 次日 00:00（不是当天零点）", () => {
    const now = Date.UTC(2026, 2, 5, 16, 0, 1); // 2026-03-06 00:00:01 +08
    expect(nextMidnightCST(now)).toBe(Date.UTC(2026, 2, 6, 16, 0, 0));
  });

  it("正午 → 当日 24 点（即次日零点）", () => {
    const now = Date.UTC(2026, 2, 5, 4, 0, 0); // 12:00 +08
    expect(nextMidnightCST(now)).toBe(Date.UTC(2026, 2, 5, 16, 0, 0));
  });

  it("恰好 00:00:00 也要推到次日（边界：!After 而非 >=）", () => {
    const now = Date.UTC(2026, 2, 5, 16, 0, 0);
    expect(nextMidnightCST(now)).toBe(Date.UTC(2026, 2, 6, 16, 0, 0));
  });

  it("结果永远严格晚于 now", () => {
    for (const now of [0, 1, 1e12, Date.UTC(2026, 11, 31, 23, 59, 59), Date.UTC(2027, 0, 1, 0, 0, 0)]) {
      expect(nextMidnightCST(now)).toBeGreaterThan(now);
    }
  });
});

describe("rewriteSystemPrompt", () => {
  it("删除全部 system/developer 并在头部插入单条 system", () => {
    const out = rewriteSystemPrompt(
      {
        model: "cn:hy3",
        messages: [
          { role: "system", content: "S1" },
          { role: "developer", content: "D1" },
          { role: "user", content: "U" },
          { role: "system", content: "S2" },
          { role: "assistant", content: "A" },
        ],
      },
      "GW",
    );
    expect(out.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(out.messages[0].content).toBe("GW");
    expect(out.messages[1].content).toBe("U");
  });

  it("user/assistant/tool 消息逐字不动（含 tool_calls 与多模态 content）", () => {
    const toolCall = { id: "c1", type: "function", function: { name: "f", arguments: "{}" } };
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "http://x" } }] },
        { role: "assistant", content: null, tool_calls: [toolCall] },
        { role: "tool", tool_call_id: "c1", content: "res" },
      ],
    };
    const out = rewriteSystemPrompt(body, "GW");
    expect(out.messages[1]).toEqual(body.messages[0]);
    expect(out.messages[2]).toBe(body.messages[1]);
    expect(out.messages[3]).toBe(body.messages[2]);
  });

  it("非 system/developer 的其他角色一律保留", () => {
    const out = rewriteSystemPrompt(
      { messages: [{ role: "user", content: "u" }, { role: "tool", content: "t" }, { role: "function", content: "f" }] },
      "GW",
    );
    expect(out.messages.map((m: any) => m.role)).toEqual(["system", "user", "tool", "function"]);
  });

  it("无 messages 字段 → 插入单条 system，其余字段保留", () => {
    const out = rewriteSystemPrompt({ model: "cn:hy3", temperature: 0.3 }, "GW");
    expect(out.messages).toEqual([{ role: "system", content: "GW" }]);
    expect(out.model).toBe("cn:hy3");
    expect(out.temperature).toBe(0.3);
  });

  it("messages 类型不符（对象/字符串）→ 视为无 messages", () => {
    expect(rewriteSystemPrompt({ messages: "oops" }, "GW").messages).toEqual([{ role: "system", content: "GW" }]);
    expect(rewriteSystemPrompt({ messages: 42 }, "GW").messages).toEqual([{ role: "system", content: "GW" }]);
  });

  it("空 systemPrompt → 原样返回同一引用（绝不失败）", () => {
    const body = { messages: [{ role: "system", content: "S" }] };
    expect(rewriteSystemPrompt(body, "")).toBe(body);
  });

  it("非对象 body（null/数组/字符串）→ 原样返回", () => {
    expect(rewriteSystemPrompt(null, "GW")).toBeNull();
    expect(rewriteSystemPrompt(undefined, "GW")).toBeUndefined();
    expect(rewriteSystemPrompt([1, 2], "GW")).toEqual([1, 2]);
    expect(rewriteSystemPrompt("str", "GW")).toBe("str");
  });

  it("入参 body 不被污染（新对象 + 新数组）", () => {
    const body: any = { messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] };
    const out = rewriteSystemPrompt(body, "GW");
    expect(body.messages).toHaveLength(2);
    expect(out).not.toBe(body);
    expect(out.messages).not.toBe(body.messages);
  });

  it("非对象元素（字符串/数字/null）原样保留", () => {
    const out = rewriteSystemPrompt({ messages: ["str", 1, null, { role: "user", content: "u" }] }, "GW");
    expect(out.messages).toEqual([{ role: "system", content: "GW" }, "str", 1, null, { role: "user", content: "u" }]);
  });
});

describe("appendSystemPrompt", () => {
  it("在开头连续 system/developer 块之后插入（issue #129）", () => {
    const out = appendSystemPrompt(
      {
        messages: [
          { role: "system", content: "S1" },
          { role: "developer", content: "D1" },
          { role: "user", content: "U" },
        ],
      },
      "GW",
    );
    expect(out.messages.map((m: any) => m.content)).toEqual(["S1", "D1", "GW", "U"]);
  });

  it("开头块长 0 → 插到最前", () => {
    const out = appendSystemPrompt({ messages: [{ role: "user", content: "U" }] }, "GW");
    expect(out.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
  });

  it("中途的 system 不参与边界判定（遇第一条非 system 即停）", () => {
    const body = {
      messages: [
        { role: "system", content: "S1" },
        { role: "user", content: "U" },
        { role: "system", content: "S-mid" },
      ],
    };
    const out = appendSystemPrompt(body, "GW");
    expect(out.messages.map((m: any) => m.content)).toEqual(["S1", "GW", "U", "S-mid"]);
  });

  it("非对象元素中断开头块扫描", () => {
    const out = appendSystemPrompt({ messages: [{ role: "system", content: "S" }, "raw", { role: "system", content: "S2" }] }, "GW");
    expect(out.messages[1]).toEqual({ role: "system", content: "GW" });
    expect(out.messages[2]).toBe("raw");
  });

  it("无 role 字段的消息也中断扫描", () => {
    const out = appendSystemPrompt({ messages: [{ role: "system", content: "S" }, { content: "norole" }] }, "GW");
    expect(out.messages[1]).toEqual({ role: "system", content: "GW" });
  });

  it("所有既有消息逐字不动（同一引用），只加一条", () => {
    const s = { role: "system", content: "S" };
    const u = { role: "user", content: "U" };
    const out = appendSystemPrompt({ messages: [s, u] }, "GW");
    expect(out.messages[0]).toBe(s);
    expect(out.messages[2]).toBe(u);
    expect(out.messages).toHaveLength(3);
  });

  it("插入的是 system 而非 developer（上游 role 白名单不含 developer）", () => {
    const out = appendSystemPrompt({ messages: [{ role: "user", content: "U" }] }, "GW");
    expect(out.messages[0].role).toBe("system");
  });

  it("无 messages → 插入单条 system", () => {
    expect(appendSystemPrompt({ model: "cn:hy3" }, "GW").messages).toEqual([{ role: "system", content: "GW" }]);
  });

  it("空 systemPrompt / 非对象 body → 原样返回", () => {
    const body = { messages: [{ role: "user", content: "U" }] };
    expect(appendSystemPrompt(body, "")).toBe(body);
    expect(appendSystemPrompt(null, "GW")).toBeNull();
  });

  it("空 messages → 插入后长度为 1", () => {
    expect(appendSystemPrompt({ messages: [] }, "GW").messages).toEqual([{ role: "system", content: "GW" }]);
  });
});

describe("loadPromptText", () => {
  it("默认（text/file 均空）→ 内置 DEFAULT_PROMPT", async () => {
    const env = envOf(memKV());
    expect(await loadPromptText(env, cfgWith({}))).toBe(DEFAULT_PROMPT);
  });

  it("text 优先于 file", async () => {
    const kv = memKV({ "prompt:custom": "FROM_FILE" });
    const env = envOf(kv);
    expect(await loadPromptText(env, cfgWith({ text: "INLINE", file: "prompt:custom" }))).toBe("INLINE");
  });

  it("file 指向 WB2A_CACHE 键", async () => {
    const env = envOf(memKV({ "prompt:custom": "FROM_FILE" }));
    expect(await loadPromptText(env, cfgWith({ file: "prompt:custom" }))).toBe("FROM_FILE");
  });

  it("file 键不存在 → 静默回落内置（Workers 不能为提示词把网关拖停）", async () => {
    const env = envOf(memKV());
    expect(await loadPromptText(env, cfgWith({ file: "missing" }))).toBe(DEFAULT_PROMPT);
  });

  it("file 是空白串 → 视为未配置", async () => {
    const env = envOf(memKV());
    expect(await loadPromptText(env, cfgWith({ file: "   " }))).toBe(DEFAULT_PROMPT);
  });
});

describe("降级门（degradeGate on KV）", () => {
  it("未触发时 not active", async () => {
    expect(await degradedActive(envOf(memKV()))).toBe(false);
    expect(await degradedUntil(envOf(memKV()))).toBe(0);
  });

  it("trigger 后 active，until 为次日 00:00 CST", async () => {
    const env = envOf(memKV());
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 2, 5, 4, 0, 0)); // 12:00 +08
    await triggerDegrade(env);
    expect(await degradedActive(env)).toBe(true);
    expect(await degradedUntil(env)).toBe(Date.UTC(2026, 2, 5, 16, 0, 0));
  });

  it("已在降级期 → 不续期（保持最早触发点的 00:00）", async () => {
    const kv = memKV();
    const env = envOf(kv);
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 2, 5, 4, 0, 0));
    await triggerDegrade(env);
    const first = await degradedUntil(env);
    vi.setSystemTime(Date.UTC(2026, 2, 5, 5, 0, 0)); // 13:00 +08
    await triggerDegrade(env);
    expect(await degradedUntil(env)).toBe(first);
  });

  it("已过期后再 trigger → 续到新的次日零点", async () => {
    const kv = memKV();
    const env = envOf(kv);
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 2, 5, 4, 0, 0));
    await triggerDegrade(env);
    vi.setSystemTime(Date.UTC(2026, 2, 5, 16, 0, 1)); // 次日 00:00:01 +08
    expect(await degradedActive(env)).toBe(false);
    await triggerDegrade(env);
    expect(await degradedUntil(env)).toBe(Date.UTC(2026, 2, 6, 16, 0, 0));
  });

  it("KV 里是脏值 → 不 active，until 归 0", async () => {
    expect(await degradedActive(envOf(memKV({ "prompt:degraded_until": "not-a-number" })))).toBe(false);
    expect(await degradedUntil(envOf(memKV({ "prompt:degraded_until": "not-a-number" })))).toBe(0);
  });
});

describe("applyPromptPolicy", () => {
  it("passthrough 非降级期 → body 原引用透传", async () => {
    const env = envOf(memKV());
    const body = { messages: [{ role: "system", content: "客户端原文" }] };
    const r = await applyPromptPolicy(env, body, cfgWith({ mode: "passthrough" }));
    expect(r.body).toBe(body);
    expect(r.degraded).toBe(false);
  });

  it("passthrough 降级期 → rewrite(DEGRADED)", async () => {
    const kv = memKV();
    const env = envOf(kv);
    await triggerDegrade(env);
    const r = await applyPromptPolicy(env, { messages: [{ role: "system", content: "客户端原文" }, { role: "user", content: "U" }] }, cfgWith({ mode: "passthrough" }));
    expect(r.degraded).toBe(true);
    expect(r.body.messages).toEqual([
      { role: "system", content: DEGRADED },
      { role: "user", content: "U" },
    ]);
  });

  it("custom → 用配置 text 替换客户端 system", async () => {
    const env = envOf(memKV());
    const r = await applyPromptPolicy(env, { messages: [{ role: "system", content: "客户端原文" }, { role: "user", content: "U" }] }, cfgWith({ mode: "custom", text: "MY PROMPT" }));
    expect(r.degraded).toBe(false);
    expect(r.body.messages[0]).toEqual({ role: "system", content: "MY PROMPT" });
    expect(r.body.messages).toHaveLength(2);
  });

  it("custom 无 text/file → 用内置 DEFAULT_PROMPT", async () => {
    const env = envOf(memKV());
    const r = await applyPromptPolicy(env, { messages: [{ role: "user", content: "U" }] }, cfgWith({ mode: "custom" }));
    expect(r.body.messages[0].content).toBe(DEFAULT_PROMPT);
  });

  it("append → 开头连续块后插客户端原文 + 网关提示词并用", async () => {
    const env = envOf(memKV());
    const r = await applyPromptPolicy(
      env,
      { messages: [{ role: "system", content: "客户端规范" }, { role: "user", content: "U" }] },
      cfgWith({ mode: "append", text: "GW" }),
    );
    expect(r.degraded).toBe(false);
    expect(r.body.messages.map((m: any) => m.content)).toEqual(["客户端规范", "GW", "U"]);
  });

  it("append 在降级期退化为 replace（带原文重试是确定性再撞墙）", async () => {
    const kv = memKV();
    const env = envOf(kv);
    await triggerDegrade(env);
    const r = await applyPromptPolicy(
      env,
      { messages: [{ role: "system", content: "指纹原文" }, { role: "user", content: "U" }] },
      cfgWith({ mode: "append", text: "GW" }),
    );
    expect(r.degraded).toBe(true);
    expect(r.body.messages.map((m: any) => m.content)).toEqual([DEGRADED, "U"]);
  });

  it("custom 不进降级路径（提示词本就是网关自有的，无误报来源）", async () => {
    const kv = memKV();
    const env = envOf(kv);
    await triggerDegrade(env);
    const r = await applyPromptPolicy(env, { messages: [{ role: "user", content: "U" }] }, cfgWith({ mode: "custom", text: "GW" }));
    expect(r.degraded).toBe(false);
    expect(r.body.messages[0].content).toBe("GW");
  });

  it("非法 mode → 按 passthrough 处理（不静默变成 no-op）", async () => {
    const env = envOf(memKV());
    const body = { messages: [{ role: "user", content: "U" }] };
    const r = await applyPromptPolicy(env, body, cfgWith({ mode: "off" }));
    expect(r.body).toBe(body);
  });

  it("降级期读 KV 失败 → 当作未降级（尽力而为的兜底，不阻塞转发）", async () => {
    const env = {
      WB2A_CONFIG: { get: async () => null, put: async () => {} },
      WB2A_CACHE: {
        get: async () => {
          throw new Error("kv down");
        },
        put: async () => {},
      },
    } as unknown as Env;
    const body = { messages: [{ role: "user", content: "U" }] };
    const r = await applyPromptPolicy(env, body, cfgWith({ mode: "passthrough" }));
    expect(r.body).toBe(body);
    expect(r.degraded).toBe(false);
  });
});

describe("classify:内容拦截 marker（降级重试的触发前提）", () => {
  const cases = ["blocked by security policy", "unapproved channel", "illegal api invocation"];
  for (const marker of cases) {
    it(`"${marker}" → ErrContentBlocked`, () => {
      const c = classify(400, JSON.stringify({ code: 400, msg: `Request ${marker}` }));
      expect(c.kind).toBe("ErrContentBlocked");
      expect(c.kindName).toBe("content_blocked");
      expect(c.note).toBe("none"); // 不罚账号
    });

    it(`"${marker}" 大小写变体同样命中（对齐 Go lower 比对）`, () => {
      const c = classify(400, JSON.stringify({ code: 400, msg: marker.toUpperCase() }));
      expect(c.kind).toBe("ErrContentBlocked");
    });
  }

  it("保留 code=content_blocked 形态（自定义网关兼容）", () => {
    expect(classify(400, JSON.stringify({ code: "content_blocked" })).kind).toBe("ErrContentBlocked");
  });

  it("普通 400 不误判为内容拦截", () => {
    const c = classify(400, JSON.stringify({ code: 11101, msg: "Unmarshal chat params failed" }));
    expect(c.kind).toBe("ErrBadParams");
  });
});
