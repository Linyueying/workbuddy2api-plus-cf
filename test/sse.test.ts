import { describe, it, expect } from "vitest";
import { aggregateChat } from "../src/services/sse";

function ev(data: object): string {
  return "data: " + JSON.stringify(data) + "\n\n";
}

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
