// SSE 流式（替代 internal/upstream/sse.go）。
// 用 ReadableStream/TransformStream 逐块转发，不缓冲；
// 客户端断开时 pipeThrough 自动向上游传播 cancel，清理资源。

function decode(buf: Uint8Array): string {
  return new TextDecoder().decode(buf, { stream: true });
}
function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function sseTransform(): TransformStream<Uint8Array, Uint8Array> {
  let buf = "";
  let seenDone = false;
  return new TransformStream({
    transform(chunk, controller) {
      buf += decode(chunk);
      let idx: number;
      // 以 \n\n 切分事件（兼容 \r\n\r\n）
      const norm = buf.replace(/\r\n/g, "\n");
      while ((idx = norm.indexOf("\n\n")) >= 0) {
        const evt = norm.slice(0, idx);
        buf = norm.slice(idx + 2);
        if (/\[DONE\]/.test(evt)) seenDone = true;
        controller.enqueue(encode(evt + "\n\n"));
      }
      // 暂存未完成的尾部
      // (上面已消费 buf，剩余尾部在下次或 flush 处理)
      void buf;
    },
    flush(controller) {
      const tail = buf.trim();
      if (tail) controller.enqueue(encode(tail.endsWith("\n") ? tail : tail + "\n"));
      if (!seenDone) controller.enqueue(encode("data: [DONE]\n\n"));
    },
  });
}

/** Usage 上游 usage 对象（末帧携带 credit / total_tokens）。 */
export interface Usage {
  credit?: number;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** extractUsage 从一条 SSE 事件文本里取 usage（无则 null）。 */
export function extractUsage(evt: string): Usage | null {
  const line = evt.replace(/^data:\s?/, "").trim();
  if (!line || line === "[DONE]") return null;
  try {
    const j = JSON.parse(line);
    const u = j?.usage;
    return u && typeof u === "object" ? (u as Usage) : null;
  } catch {
    return null;
  }
}

export interface StreamOpts {
  /** 流结束（正常或异常）回调，收到末帧捕获的 usage，用于成本台账记账。 */
  onEnd?: (usage: Usage | null) => void;
}

/** 逐块规范化透传上游 SSE；客户端断开清理上游；旁路捕获 usage 供成本记账。 */
export function streamChat(upstreamRes: Response, request: Request, opts: StreamOpts = {}): Response {
  const body = upstreamRes.body as ReadableStream<Uint8Array>;
  // 旁路 tap：只读不改，独立于主流消费；不干扰背压与取消语义。
  let usage: Usage | null = null;
  let tail = "";
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (usage) return;
      tail += decode(chunk);
      const parts = tail.split(/\n\n/);
      tail = parts.pop() ?? "";
      for (const p of parts) {
        const u = extractUsage(p);
        if (u) {
          usage = u;
          return;
        }
      }
    },
    flush() {
      opts.onEnd?.(usage ?? extractUsage(tail));
    },
  });
  // tap 的 flush 需在主流读完后触发：用主流的取消/结束都无法直接拿到 tap 的 flush，
  // 故此处把 tap 串在主流之后，由 pipeThrough 链自然驱动。
  const reader = body.pipeThrough(tap).pipeThrough(sseTransform());
  request.signal.addEventListener("abort", () => {
    body.cancel().catch(() => {});
  });
  return new Response(reader, {
    status: upstreamRes.status || 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/** 非流式：聚合上游 SSE 为单个 chat.completion。 */
export async function aggregateChat(upstreamRes: Response): Promise<Response> {
  if (!upstreamRes.body) {
    return errorBody("empty stream", 502, "empty_stream");
  }
  const text = await upstreamRes.text();
  const events = text.split(/\n\n/).map((e) => e.trim()).filter(Boolean);
  let merged: any = null;
  for (const ev of events) {
    if (/\[DONE\]/.test(ev)) continue;
    const line = ev.replace(/^data:\s?/, "");
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      if (!merged) merged = j;
      mergeDelta(merged, j);
    } catch {
      /* 跳过非 JSON 行 */
    }
  }
  if (!merged) return errorBody("empty stream", 502, "empty_stream");
  return new Response(JSON.stringify(merged), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function mergeDelta(merged: any, delta: any): void {
  if (!merged.choices) merged.choices = delta.choices ?? [];
  for (const d of delta.choices ?? []) {
    const i = d.index ?? 0;
    if (!merged.choices[i]) merged.choices[i] = { index: i, message: { role: "assistant", content: "" }, finish_reason: null };
    const mc = merged.choices[i].message ?? (merged.choices[i].message = { role: "assistant", content: "" });
    const dd = d.delta ?? {};
    if (dd.content) mc.content = (mc.content ?? "") + dd.content;
    if (dd.reasoning_content) mc.reasoning_content = (mc.reasoning_content ?? "") + dd.reasoning_content;
    if (dd.tool_calls) {
      mc.tool_calls = mc.tool_calls ?? [];
      for (const tc of dd.tool_calls) {
        const idx = tc.index ?? 0;
        mc.tool_calls[idx] = mc.tool_calls[idx] ?? { index: idx, function: { name: "", arguments: "" } };
        if (tc.function?.name) mc.tool_calls[idx].function.name += tc.function.name;
        if (tc.function?.arguments) mc.tool_calls[idx].function.arguments += tc.function.arguments;
      }
    }
    if (d.finish_reason) merged.choices[i].finish_reason = d.finish_reason;
  }
  if (delta.usage) merged.usage = delta.usage;
}

function errorBody(message: string, status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "api_error", code } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
