import { describe, it, expect } from "vitest";
import { aggregateChat, streamChat, sseSplit, extractUsage, dataPayloadOf } from "../src/services/sse";

function ev(data: object): string {
  return "data: " + JSON.stringify(data) + "\n\n";
}

// sseSplit：SSE 切分核心（纯函数，不依赖 TransformStream，沙箱可测）。
// 回归锚点：旧实现在 transform 里 while 循环不更新缓冲——只要上游发出一个
// 完整事件就无限 enqueue 同一帧，Worker 被杀，客户端「200 但无任何回复」。
describe("sseSplit 切分核心", () => {
  it("多事件全部切出且不重复（回归 while 死循环）", () => {
    const r = sseSplit('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n');
    expect(r.events).toHaveLength(3);
    expect(r.rest).toBe("");
  });
  it("跨块拼合：完整事件切出，未完成尾部留缓冲", () => {
    const r1 = sseSplit('data: {"a"');
    expect(r1.events).toHaveLength(0);
    const r2 = sseSplit(r1.rest + ':1}\n\ndata: [DONE]\n\n');
    expect(r2.events).toHaveLength(2);
    expect(r2.events[0]).toBe('data: {"a":1}');
    expect(r2.rest).toBe("");
  });
  it("CRLF 分隔规范化为 LF", () => {
    const r = sseSplit('data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n');
    expect(r.events).toHaveLength(2);
    expect(r.events[0]).toBe('data: {"a":1}');
  });
  it("多行事件（data: + 空行前注释行）整体保留", () => {
    const r = sseSplit(": keepalive\n\ndata: {\"a\":1}\n\n");
    expect(r.events).toHaveLength(2);
    expect(r.events[0]).toBe(": keepalive");
  });
});

// 注：逐块 SSE 透传（SSE 透传管线（TransformStream））在 Cloudflare workerd 原生运行，
// 本沙箱 Node 子进程的 TransformStream 构造会崩溃，故此处覆盖生产关键的「聚合」路径。
describe("sse aggregate", () => {
  it("聚合多帧 delta 为一个 chat.completion", async () => {
    const body = ev({ choices: [{ index: 0, delta: { role: "assistant", content: "你" } }] })
      + ev({ choices: [{ index: 0, delta: { content: "好" } }] })
      + "data: [DONE]\n\n";
    const res = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const out = await aggregateChat(res);
    const j = await out.json();
    expect(j.choices[0].message.content).toBe("你好");
    expect(out.status).toBe(200);
  });

  it("合并 tool_calls（按 index）", async () => {
    const body = ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "f", arguments: "{\"" } }] } }] })
      + ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "x\":1}" } }] } }] })
      + "data: [DONE]\n\n";
    const res = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const out = await aggregateChat(res);
    const j = await out.json();
    expect(j.choices[0].message.tool_calls[0].function.arguments).toBe("{\"x\":1}");
  });

  it("空流 -> 502", async () => {
    const res = new Response("", { headers: { "content-type": "text/event-stream" } });
    const out = await aggregateChat(res);
    expect(out.status).toBe(502);
  });
});

// SSE usage 提取 —— 面板「用量」页 token 恒为 0 的根因回归档。
//
// 旧实现是 `evt.replace(/^data:\s?/, "")` 再 JSON.parse 整个事件串，`^` 只锚定字符串
// 开头，而真实 SSE 帧经常带 event: / id: 行；tap 那边又用 split(/\n\n/) 切帧，不认
// \r\n\r\n。两条路都会让 usage 被静默丢弃，而对话本身照常（SSE 转发管线独立做 CRLF
// 归一化），所以症状特别隐蔽：回复好好的，用量页却一片 0。
// Go 版 parseSSELine（internal/server/logging.go）逐行 HasPrefix 判决，这里锁死对齐后的行为。
describe("SSE usage 提取（用量 Token 全 0 根因回归）", () => {
  const U = { credit: 1.5, prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
  const ju = JSON.stringify(U);

  it("理想形态：单行 data", () => {
    expect(extractUsage(`data: {"usage":${ju}}`)).toEqual(U);
  });

  it("帧带 event: 行 —— 旧实现在这里整帧丢失", () => {
    expect(extractUsage(`event: message\ndata: {"usage":${ju}}`)).toEqual(U);
  });

  it("帧带 id: / retry: / 注释行等噪声，仍能定位 data", () => {
    expect(extractUsage(`:ping\nid: 42\nretry: 100\nevent: message\ndata: {"usage":${ju}}`)).toEqual(U);
  });

  it("CRLF 行尾 + \\r\\n\\r\\n 分隔", () => {
    expect(extractUsage(`event: message\r\ndata: {"usage":${ju}}\r\n`)).toEqual(U);
  });

  it("data: 后无空格也认（RFC 允许紧接内容）", () => {
    expect(extractUsage(`data:{"usage":${ju}}`)).toEqual(U);
  });

  it("多个 data 行按 \\n 拼成一个载荷", () => {
    expect(extractUsage(`event: msg\ndata: {"usage":\ndata: ${ju}}`)).toEqual(U);
  });

  it("[DONE] / 非 data 帧 / 空串一律 null，不抛异常", () => {
    for (const s of ["data: [DONE]", ": keepalive", "event: message", "", "not json at all"]) {
      expect(extractUsage(s)).toBeNull();
    }
  });

  it("usage 缺席或不是对象 → null（不把错类型当用量）", () => {
    expect(extractUsage('data: {"choices":[]}')).toBeNull();
    expect(extractUsage('data: {"usage":123}')).toBeNull();
  });

  it("上游实测字段 prompt_cache_hit_tokens 能读出（cachekey.ts 逆向实证）", () => {
    const u = extractUsage('data: {"usage":{"prompt_cache_hit_tokens":7808,"credit":0.02}}');
    expect(u?.prompt_cache_hit_tokens).toBe(7808);
    expect(u?.credit).toBe(0.02);
  });
});

describe("dataPayloadOf 载荷还原", () => {
  it("无 data 行 → null（纯 event 帧不该产出载荷）", () => {
    expect(dataPayloadOf("event: message")).toBeNull();
  });

  it("CRLF 被归一化为 LF", () => {
    expect(dataPayloadOf("data: {\"a\":1}\r\n")).toBe('{"a":1}');
  });

  it("多行 data 以 \\n 连接，保留载荷内部换行", () => {
    expect(dataPayloadOf("data: line1\ndata: line2")).toBe("line1\nline2");
  });

  it("只剥 data: 后的一个空格，不吃掉正文缩进", () => {
    expect(dataPayloadOf("data:   indented")).toBe("  indented");
  });
});

describe("aggregateChat 在真实帧形态下的聚合", () => {
  const U = { credit: 2.5, prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 };

  it("CRLF + event: 行：内容聚合正确且 usage 不被丢弃", async () => {
    const body =
      "event: message\r\n" +
      'data: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\n' +
      "event: message\r\n" +
      `data: {"choices":[{"delta":{"content":"好"}}],"usage":${JSON.stringify(U)}}\r\n\r\n` +
      "data: [DONE]\r\n\r\n";
    const out = await aggregateChat(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const j = await out.json();
    expect(j.choices[0].message.content).toBe("你好");
    expect(j.usage).toEqual(U);
  });

  it("LF 单行（既有形态）行为不变", async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      `data: {"usage":${JSON.stringify(U)}}\n\ndata: [DONE]\n\n`;
    const out = await aggregateChat(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const j = await out.json();
    expect(j.usage).toEqual(U);
  });

  it("增量聚合：片段攒数组后一次 join，中间态键不泄漏到最终 JSON", async () => {
    // 三个 delta 拼成 "你好呀"，外加 reasoning 与 tool_call 参数同样分段到达。
    const parts = ["你", "好", "呀"];
    const body =
      parts.map((p) => ev({ choices: [{ index: 0, delta: { content: p } }] })).join("") +
      ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "g", arguments: '{"a"' } }] } }] }) +
      ev({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] }) +
      "data: [DONE]\n\n";
    const out = await aggregateChat(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const j = await out.json();
    expect(j.choices[0].message.content).toBe("你好呀");
    expect(j.choices[0].message.tool_calls[0].function.arguments).toBe('{"a":1}');
    expect(j.choices[0].message.tool_calls[0].function.name).toBe("g");
    // 中间态数组键绝不能留在最终对象上（下游按 content 判空回复，漏了就全乱）。
    // 注意不能对整个 JSON 做字符串匹配——"tool_calls" 本身就含 "_c"。
    const msg = j.choices[0].message;
    expect(Object.keys(msg)).not.toContain("_c");
    expect(Object.keys(msg)).not.toContain("_r");
    expect(Object.keys(msg.tool_calls[0].function)).not.toContain("_a");
    expect(Object.keys(msg.tool_calls[0].function)).not.toContain("_n");
  });

  it("增量聚合：末帧无空行终结也照样吃进（切分残留兜底）", async () => {
    const body = ev({ choices: [{ index: 0, delta: { content: "hi" } }] }) + "data: " + JSON.stringify({ usage: U });
    const out = await aggregateChat(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const j = await out.json();
    expect(j.choices[0].message.content).toBe("hi");
    expect(j.usage).toEqual(U);
  });
});

// 流式透传：解析与转发已合并成单个 TransformStream（原先是 tap + transform 两级，
// 同一批字节被解码/切分两遍，且每帧无条件 JSON.parse）。这里钉住「合并后语义不变」。
describe("streamChat 单流透传", () => {
  it("正文逐帧转发完整、末帧 usage 捕获、缺 [DONE] 时自动补", async () => {
    const body =
      ev({ choices: [{ index: 0, delta: { content: "你" } }] }) +
      ev({ choices: [{ index: 0, delta: { content: "好" }, finish_reason: "stop" }], usage: { credit: 1.5, total_tokens: 150 } });
    const up = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    let got: any = null;
    const res = streamChat(up, new Request("https://x"), { onEnd: (u) => void (got = u) });
    const text = await res.text();
    expect(text).toContain("你");
    expect(text).toContain("好");
    expect(text).toContain("data: [DONE]"); // 上游没发 → 由 flush 补
    await new Promise((r) => setTimeout(r, 0));
    expect(got?.total_tokens).toBe(150);
    expect(got?.credit).toBe(1.5);
  });

  it("跨 chunk 边界（含 CRLF 跨块）不丢帧也不丢 usage", async () => {
    // 故意把 \r\n\r\n 的 \r 与 \n 切到两个 chunk 里：只处理新块的实现会漏掉这一例。
    const raw =
      "event: message\r\n" +
      'data: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\n' +
      "event: message\r\n" +
      'data: {"choices":[{"delta":{"content":"好"}}],"usage":{"credit":2.5,"total_tokens":280}}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(raw.slice(0, 40)));
        c.enqueue(enc.encode(raw.slice(40, 120)));
        c.enqueue(enc.encode(raw.slice(120)));
        c.close();
      },
    });
    let got: any = null;
    const res = streamChat(new Response(stream, { status: 200 }), new Request("https://x"), {
      onEnd: (u) => void (got = u),
    });
    const text = await res.text();
    expect(text).toContain("你");
    expect(text).toContain("好");
    await new Promise((r) => setTimeout(r, 0));
    expect(got?.total_tokens).toBe(280);
  });

  it("usage 快筛不误伤：正文帧不含 usage 也照常转发", async () => {
    const body = ev({ choices: [{ index: 0, delta: { content: "纯正文帧" } }] }) + "data: [DONE]\n\n";
    const res = streamChat(new Response(body, { status: 200 }), new Request("https://x"), {});
    const text = await res.text();
    expect(text).toContain("纯正文帧");
  });
});

// 思维链增量合并（deep thinking）。
//
// 上游按**词**下发思考：{"reasoning_content":"the"}、{"reasoning_content":"user"}
// 各占一帧。逐帧透传时客户端把每帧当成一条独立思考条目渲染，界面上出现
//     深度思考: the
//     深度思考: user
// 而正确形态是「深度思考: the user」。这里钉住合并行为与它的各个边界。
describe("streamChat 思维链增量合并", () => {
  /** 解析下发帧，返回每帧的类型与内容，便于断言帧边界。 */
  function parseFrames(text: string): Array<{ kind: string; text?: string }> {
    return text
      .split("\n\n")
      .filter((f) => f.trim())
      .map((f) => {
        const p = f.replace(/^data: /, "");
        if (p === "[DONE]") return { kind: "done" };
        const j = JSON.parse(p);
        const ch = j.choices?.[0];
        const d = ch?.delta ?? {};
        const hasReason = d.reasoning_content != null;
        const hasContent = d.content != null;
        // 混合帧（同时带 reasoning 与 content）单列一类：它不参与合并，
        // 断言时必须能把它与「纯思考帧」区分开，否则辅助函数自己就把两种情况
        // 混成一种，测试等于没测。
        if (hasReason && hasContent) return { kind: "mixed" };
        if (hasReason) return { kind: "reason", text: d.reasoning_content };
        if (hasContent) return { kind: "content", text: d.content };
        return { kind: "other" };
      });
  }

  it("相邻思考片段被并成一帧（逐词 → 整句）", async () => {
    const body =
      ev({ choices: [{ index: 0, delta: { reasoning_content: "the" } }] }) +
      ev({ choices: [{ index: 0, delta: { reasoning_content: " " } }] }) +
      ev({ choices: [{ index: 0, delta: { reasoning_content: "user" } }] }) +
      ev({ choices: [{ index: 0, delta: { content: "Hello" } }] }) +
      "data: [DONE]\n\n";
    const res = streamChat(new Response(body, { status: 200 }), new Request("https://x"), {});
    const fs = parseFrames(await res.text());
    // 关键断言：思考只占**一帧**，且内容是整句而不是逐词。
    expect(fs.filter((f) => f.kind === "reason")).toHaveLength(1);
    expect(fs[0]).toEqual({ kind: "reason", text: "the user" });
    expect(fs.some((f) => f.kind === "content" && f.text === "Hello")).toBe(true);
  });

  it("思考与正文的边界不被跨越：两段思考分开，正文夹在中间", async () => {
    const body =
      ev({ choices: [{ index: 0, delta: { reasoning_content: "A1" } }] }) +
      ev({ choices: [{ index: 0, delta: { reasoning_content: "A2" } }] }) +
      ev({ choices: [{ index: 0, delta: { content: "X" } }] }) +
      ev({ choices: [{ index: 0, delta: { reasoning_content: "B1" } }] }) +
      ev({ choices: [{ index: 0, delta: { content: "Y" } }] }) +
      "data: [DONE]\n\n";
    const res = streamChat(new Response(body, { status: 200 }), new Request("https://x"), {});
    const fs = parseFrames(await res.text());
    expect(fs).toEqual([
      { kind: "reason", text: "A1A2" },
      { kind: "content", text: "X" },
      { kind: "reason", text: "B1" },
      { kind: "content", text: "Y" },
      { kind: "done" },
    ]);
  });

  it("混合帧（reasoning 与 content 同帧）不参与合并", async () => {
    const body =
      ev({ choices: [{ index: 0, delta: { reasoning_content: "T", content: "C" } }] }) + "data: [DONE]\n\n";
    const res = streamChat(new Response(body, { status: 200 }), new Request("https://x"), {});
    const fs = parseFrames(await res.text());
    // 该帧原样放行：仍是一帧同时带两个字段的形态，不能被拆开、也不能被吞掉。
    expect(fs).toEqual([{ kind: "mixed" }, { kind: "done" }]);
  });

  it("reasoning 字段名（非 reasoning_content）同样合并", async () => {
    const body =
      ev({ choices: [{ index: 0, delta: { reasoning: "R1" } }] }) +
      ev({ choices: [{ index: 0, delta: { reasoning: "R2" } }] }) +
      "data: [DONE]\n\n";
    const res = streamChat(new Response(body, { status: 200 }), new Request("https://x"), {});
    // 该字段名不在识别列表里 → 逐帧透传，内容不丢（宁可不多合，也不能吞）。
    const text = await res.text();
    expect(text).toContain("R1");
    expect(text).toContain("R2");
  });

  it("末尾思考在 [DONE] 之前被冲出（不丢内容）", async () => {
    // 上游最后几帧挤在同一块、且没有空行终结：flush 路径必须把攒着的思考发出去。
    const body = ev({ choices: [{ index: 0, delta: { reasoning_content: "末尾思考" } }] });
    const res = streamChat(new Response(body, { status: 200 }), new Request("https://x"), {});
    const fs = parseFrames(await res.text());
    expect(fs[0]).toEqual({ kind: "reason", text: "末尾思考" });
    expect(fs[fs.length - 1]).toEqual({ kind: "done" });
  });

  it("usage 帧不被合并吞掉（记账依赖末帧）", async () => {
    const body =
      ev({ choices: [{ index: 0, delta: { reasoning_content: "T" } }] }) +
      ev({ choices: [{ index: 0, delta: { content: "Z" } }] }) +
      ev({ usage: { credit: 9, total_tokens: 99 } }) +
      "data: [DONE]\n\n";
    let got: any = null;
    const res = streamChat(new Response(body, { status: 200 }), new Request("https://x"), {
      onEnd: (u) => void (got = u),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual({ credit: 9, total_tokens: 99 });
  });

  it("coalesceReasoning:false 回落逐帧透传（排障开关）", async () => {
    const body =
      ev({ choices: [{ index: 0, delta: { reasoning_content: "x" } }] }) +
      ev({ choices: [{ index: 0, delta: { reasoning_content: "y" } }] }) +
      "data: [DONE]\n\n";
    const res = streamChat(new Response(body, { status: 200 }), new Request("https://x"), {
      coalesceReasoning: false,
    });
    const fs = parseFrames(await res.text());
    expect(fs.filter((f) => f.kind === "reason")).toHaveLength(2);
  });

  it("帧结构完整：合并帧自带 data: 前缀与空行终结（回归裸文本 bug）", async () => {
    // 曾经把合并结果当裸文本塞进流里（漏 data: 前缀与 JSON 包装），
    // 客户端解析失败、整段思考表现为凭空消失。这里逐帧断言可解析。
    const body =
      ev({ choices: [{ index: 0, delta: { reasoning_content: "a" } }] }) +
      ev({ choices: [{ index: 0, delta: { reasoning_content: "b" } }] }) +
      ev({ choices: [{ index: 0, delta: { content: "out" } }] }) +
      "data: [DONE]\n\n";
    const res = streamChat(new Response(body, { status: 200 }), new Request("https://x"), {});
    const text = await res.text();
    for (const f of text.split("\n\n").filter((x) => x.trim())) {
      expect(f.startsWith("data: ")).toBe(true); // 没有裸文本混入
    }
    expect(text.split("\n\n").filter((x) => x.trim())).toHaveLength(3); // 思考 + 正文 + DONE
  });
});
