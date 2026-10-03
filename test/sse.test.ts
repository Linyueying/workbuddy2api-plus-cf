import { describe, it, expect } from "vitest";
import { aggregateChat, sseSplit } from "../src/services/sse";

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
