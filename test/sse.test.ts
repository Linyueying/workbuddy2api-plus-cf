import { describe, it, expect } from "vitest";
import { aggregateChat, sseSplit, extractUsage, dataPayloadOf } from "../src/services/sse";

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

// 注：逐块 SSE 透传（sseTransform + TransformStream）在 Cloudflare workerd 原生运行，
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
// \r\n\r\n。两条路都会让 usage 被静默丢弃，而对话本身照常（sseTransform 独立做 CRLF
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
});
