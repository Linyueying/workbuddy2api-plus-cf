// SSE 流式（替代 internal/upstream/sse.go）。
// 用 ReadableStream/TransformStream 逐块转发，不缓冲；
// 客户端断开时 pipeThrough 自动向上游传播 cancel，清理资源。

function decode(buf: Uint8Array): string {
  return new TextDecoder().decode(buf, { stream: true });
}
function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * sseSplit 从累积缓冲里按空行切出完整 SSE 事件，返回事件数组与剩余缓冲。
 * 独立成纯函数：核心切分逻辑可测（沙箱 Node 的 TransformStream 不稳定，
 * 此前 sseTransform 零覆盖，死循环 bug 直 上生产）。
 * ⚠️ 每切一个事件都要基于「最新 buf」重新找分隔符——旧实现在循环外算一次
 * norm 且循环内不更新，while 永远命中第一个 \n\n，同一帧被无限 enqueue，
 * Worker 内存爆掉被杀，客户端表现为「200 + SSE 头但没有任何回复」。
 */
export function sseSplit(buf: string): { events: string[]; rest: string } {
  const events: string[] = [];
  for (;;) {
    const norm = buf.replace(/\r\n/g, "\n"); // 兼容 \r\n\r\n
    const idx = norm.indexOf("\n\n");
    if (idx < 0) return { events, rest: norm };
    events.push(norm.slice(0, idx));
    buf = norm.slice(idx + 2);
  }
}

export function sseTransform(): TransformStream<Uint8Array, Uint8Array> {
  let buf = "";
  let seenDone = false;
  return new TransformStream({
    transform(chunk, controller) {
      buf += decode(chunk);
      const { events, rest } = sseSplit(buf);
      buf = rest;
      for (const evt of events) {
        if (/\[DONE\]/.test(evt)) seenDone = true;
        controller.enqueue(encode(evt + "\n\n"));
      }
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
  /** Anthropic 风格字段名（上游可能用这套）。 */
  input_tokens?: number;
  output_tokens?: number;
  /**
   * prompt_cache_hit_tokens 前缀缓存**读命中** Token。
   *
   * 上游（/v2/chat/completions）实测就叫这个名字——见 services/cachekey.ts 顶部的
   * 逆向注记「带 key → prompt_cache_hit_tokens=7808, credit≈0.02」。此前本文件只认
   * OpenAI 口径的 prompt_tokens_details.cached_tokens / cache_read_input_tokens，
   * 结果上游唯一真在返回的字段被整个忽略，命中率维度恒为 0。
   */
  prompt_cache_hit_tokens?: number;
  /**
   * prompt_cache_miss_tokens 前缀缓存**未命中** Token。
   *
   * ⚠️ 目前只声明、不消费：request_logs 只有 cache_read_tokens 一列（见 migrations
   * /0003_usage_metrics.sql），未命中无处落库，由 usage-agg 按 prompt - hit 推导，
   * 与 Go 版 CacheTokens 的口径一致。留在这里是为了让上游 usage 的原貌可读可调，
   * 将来若加列再改为直接采信。
   */
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * dataPayloadOf 从一条 SSE 事件文本里还原 data 载荷（无 data 行则 null）。
 *
 * ⚠️ 必须**逐行**扫描，不能对整个事件串做 `replace(/^data:\s?/, "")`：SSE 事件允许
 * 多行（`event:` / `id:` / `retry:` / 注释行），而 `^` 只锚定字符串开头——一旦首行
 * 不是 data（最常见的情形就是上游发 `event: message`），整块 JSON.parse 直接失败、
 * usage 被静默丢弃，最终表现为「用量页 token 恒为 0」。
 *
 * Go 版 parseSSELine（internal/server/logging.go）正是逐行 HasPrefix("data: ") 判决，
 * 这里对齐它的语义，并额外兼容无空格写法（`data:{...}`）与多条 data 行的拼接
 * （SSE 规范：多 data 行以 \n 连接成一个载荷）。
 */
export function dataPayloadOf(evt: string): string | null {
  const lines = String(evt ?? "").replace(/\r\n/g, "\n").split("\n");
  const payload: string[] = [];
  for (const raw of lines) {
    if (!raw.startsWith("data:")) continue;
    // `data:` 后的单个空格可选（RFC 允许紧接内容）；只剥一个，别吃掉正文里的缩进。
    payload.push(raw.slice(5).replace(/^ /, ""));
  }
  if (!payload.length) return null;
  // 只剥尾部空白（行尾残留），**不能用 trim()**：那会把首行 data 内容的前导空格一起
  // 吃掉，让「只剥一个空格」的承诺落空。空载荷（data: 后面什么都没有）在此判为 null。
  return payload.join("\n").replace(/\s+$/, "") || null;
}

/** extractUsage 从一条 SSE 事件文本里取 usage（无则 null）。 */
export function extractUsage(evt: string): Usage | null {
  const payload = dataPayloadOf(evt);
  if (!payload || payload === "[DONE]") return null;
  try {
    const j = JSON.parse(payload);
    const u = j?.usage;
    return u && typeof u === "object" ? (u as Usage) : null;
  } catch {
    return null;
  }
}

export interface StreamOpts {
  /** 流结束（正常或异常）回调，收到末帧捕获的 usage，用于成本台账记账。 */
  onEnd?: (usage: Usage | null) => void;
  /**
   * onUsageRaw 调试用：收到任意一帧原始 usage（JSON 文本）时回调，便于在日志里
   * 记录上游真实返回的 usage 结构（排查「有日志但 token 全 0」时最关键的一环）。
   */
  onUsageRaw?: (raw: string) => void;
}

/** hasTokens usage 是否带真实 token 字段（用于跳过空对象 {} / 占位帧）。 */
function hasTokens(u: any): boolean {
  if (!u || typeof u !== "object") return false;
  const n = (v: any) => Number(v) > 0;
  return (
    n(u.prompt_tokens) ||
    n(u.completion_tokens) ||
    n(u.total_tokens) ||
    n(u.input_tokens) ||
    n(u.output_tokens) ||
    n(u.credit) ||
    n(u.cache_read_input_tokens) ||
    n(u.prompt_cache_hit_tokens) ||
    n(u.prompt_tokens_details?.cached_tokens)
  );
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
      // ⚠️ 必须先把 CRLF 规范化再切分：上游若以 \r\n\r\n 分隔，`split(/\n\n/)` 永远
      // 切不开（\r 夹在两个 \n 中间），所有帧会堆进 tail、flush 时整块 JSON.parse
      // 失败 → usage 全丢。而下游的 sseTransform 独立做了同样的规范化，用户侧对话
      // 依旧正常——于是症状就是「回复好好的、用量页却全 0」。
      // 归一化的对象必须是**累积后的整串**而非单个 chunk：\r\n 可能正好跨在
      // 两个 chunk 的边界上，只处理新块会漏掉那一例。
      tail = (tail + decode(chunk)).replace(/\r\n/g, "\n");
      const parts = tail.split(/\n\n/);
      tail = parts.pop() ?? "";
      for (const p of parts) {
        const u = extractUsage(p);
        if (!u) continue;
        // 记录原始 usage 文本（调试：面板日志 msg 里能看到上游到底回了什么）。
        if (hasTokens(u)) opts.onUsageRaw?.(JSON.stringify(u));
        // ⚠️ 取「最后一个带真实 token 的 usage」，而不是第一个：上游可能在中途帧
        // 先给一个全 0 / 空的 usage（如首帧快照），旧实现 `if (usage) return` 会
        // 让首个空对象把真正的末帧 usage 挡在外面 → token 恒为 0。
        if (hasTokens(u)) usage = u;
        else if (!usage) usage = u; // 全是空对象时至少留个占位，flush 再兜底
      }
    },
    flush() {
      // 流末尾最后一帧常常没有空行终结，会留在 tail 里；它位置最晚，理应优先于
      // transform 期间捕获到的任何一帧。这里逐帧扫（而非对整个 tail 直接 JSON.parse），
      // 免得异常残留多帧时整块解析失败、把末帧用量吞掉。
      let last = usage;
      for (const p of tail.split(/\n\n/)) {
        const u = extractUsage(p);
        if (!u) continue;
        if (hasTokens(u)) last = u;
        else if (!last) last = u;
      }
      opts.onEnd?.(last);
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
  // 与流式 tap 同理：CRLF 先归一化，否则 \r\n\r\n 分隔的上游响应切不出任何事件，
  // 整条流被当成一坨、聚合结果与 usage 一并丢失。
  const events = text
    .replace(/\r\n/g, "\n")
    .split(/\n\n/)
    .map((e) => e.trim())
    .filter(Boolean);
  let merged: any = null;
  for (const ev of events) {
    if (/\[DONE\]/.test(ev)) continue;
    // 逐行取 data 载荷——不能用 replace(/^data:/)：它锚定整个事件的开头，帧里只要
    // 先出现 `event:` / `id:` 行就会使 JSON.parse 失败，把这一帧连同 usage 一起丢掉。
    const payload = dataPayloadOf(ev);
    if (!payload) continue;
    try {
      const j = JSON.parse(payload);
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
