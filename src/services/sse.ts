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
 * 此前透传管线零覆盖，死循环 bug 直 上生产）。
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

/**
 * usageOf 取一帧的 usage；先做字符串快筛再 JSON.parse。
 *
 * 为什么需要快筛：一条流式回复是几百到几千帧，其中**只有最后一帧**带 usage。
 * 原实现对每一帧都 JSON.parse（正文帧同样解析），等于把整条回复的 JSON 又完整
 * 解析了一遍——解析成本随回复长度线性增长，而它唯一的用途是找那一帧 usage。
 * `indexOf('"usage"')` 是 O(n) 的裸扫描、无对象分配，绝大多数帧在这里就被挡掉。
 */
function usageOf(evt: string): Usage | null {
  if (evt.indexOf('"usage"') < 0) return null;
  return extractUsage(evt);
}

/** pickUsage 按「最后一个带真实 token 的 usage 优先」更新当前 usage。 */
function pickUsage(cur: Usage | null, u: Usage | null): Usage | null {
  if (!u) return cur;
  // ⚠️ 取「最后一个带真实 token 的 usage」，而不是第一个：上游可能在中途帧
  // 先给一个全 0 / 空的 usage（如首帧快照），旧实现 `if (usage) return` 会
  // 让首个空对象把真正的末帧 usage 挡在外面 → token 恒为 0。
  if (hasTokens(u)) return u;
  return cur ?? u; // 全是空对象时至少留个占位，flush 再兜底
}

/** 逐块规范化透传上游 SSE；客户端断开清理上游；旁路捕获 usage 供成本记账。 */
export function streamChat(upstreamRes: Response, request: Request, opts: StreamOpts = {}): Response {
  const body = upstreamRes.body as ReadableStream<Uint8Array>;
  let usage: Usage | null = null;
  let buf = "";
  let seenDone = false;
  // 解析与转发合在**单个** TransformStream 里。
  //
  // 原实现是两级管道：`tap`（decode → 切分 → 每帧 JSON.parse）再串
  // `sseTransform`（已移除，职责并入此处：再 decode 一次 → 再切分 → encode）。同一批字节被解码两遍、
  // 切分两遍，多一次 TransformStream 也就多一次队列与一次 enqueue/dequeue 传递。
  // 两级的职责本来就不冲突（一个旁路取 usage、一个规范化转发），合并后每帧只
  // 解码一次、只编码一次。切分仍走 sseSplit——它内部会做 CRLF 归一化，这是
  // 「\r\n\r\n 分隔的上游」不丢用量与不丢正文的关键。
  const pass = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += decode(chunk);
      const { events, rest } = sseSplit(buf);
      buf = rest;
      for (const evt of events) {
        const u = usageOf(evt);
        if (u) {
          // 记录原始 usage 文本（调试：面板日志 msg 里能看到上游到底回了什么）。
          if (hasTokens(u)) opts.onUsageRaw?.(JSON.stringify(u));
          usage = pickUsage(usage, u);
        }
        if (/\[DONE\]/.test(evt)) seenDone = true;
        controller.enqueue(encode(evt + "\n\n"));
      }
    },
    flush(controller) {
      // 流末尾最后一帧常常没有空行终结，会留在 buf 里；它位置最晚，理应优先于
      // transform 期间捕获到的任何一帧。这里逐帧扫（而非对整个残留直接 JSON.parse），
      // 免得异常残留多帧时整块解析失败、把末帧用量吞掉。
      for (const p of buf.split(/\n\n/)) {
        const u = usageOf(p);
        if (u) usage = pickUsage(usage, u);
      }
      const tail = buf.trim();
      if (tail) controller.enqueue(encode(tail.endsWith("\n") ? tail : tail + "\n"));
      if (!seenDone) controller.enqueue(encode("data: [DONE]\n\n"));
      opts.onEnd?.(usage);
    },
  });
  const reader = body.pipeThrough(pass);
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
  // 增量聚合，不再 `await upstreamRes.text()` 整段缓冲。
  //
  // 原实现的峰值内存是「整条响应 × 3」：text() 一份完整字符串 → replace(/\r\n/g)
  // 又复制一份 → split(/\n\n/) 再切出一堆子串引用。Workers 的内存上限是 128MB，
  // 而长回复 / 大 tool_call 参数很容易把这条路径顶到几十 MB。改成读一块、切一块、
  // 丢一块，峰值只与单个 chunk 相关。
  //
  // 切分仍复用 sseSplit：CRLF 归一化的坑（上游以 \r\n\r\n 分隔时一帧都切不出来、
  // 聚合结果与 usage 一并丢失）由它统一兜住，与流式同源。
  let merged: any = null;
  let buf = "";
  const reader = upstreamRes.body.getReader();
  const drain = (events: string[]) => {
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
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    buf += decode(value);
    const { events, rest } = sseSplit(buf);
    buf = rest;
    drain(events);
  }
  // 末帧常常没有空行终结，会留在 buf 里。
  drain(buf ? [buf] : []);
  if (!merged) return errorBody("empty stream", 502, "empty_stream");
  finalizeMerged(merged);
  return new Response(JSON.stringify(merged), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * mergeDelta 把增量帧并进聚合对象。
 *
 * ⚠️ 文本片段一律**先攒进数组、最后 join**，不做 `str += frag` 的反复拼接：
 * 一条长回复是几百到几千个 delta，每次 `+=` 都要新建一个更长的字符串（V8 的
 * rope 只在部分情形下摊平，反复拼接会触发多次摊平拷贝），总拷贝量随片段数
 * 增长。数组 push 是均摊 O(1)，join 只做一次分配。
 * 数组挂在 `_c/_r/_a/_n` 上，由 finalizeMerged 收口——中间态不出现在对外 JSON 里。
 */
function mergeDelta(merged: any, delta: any): void {
  if (!merged.choices) merged.choices = delta.choices ?? [];
  for (const d of delta.choices ?? []) {
    const i = d.index ?? 0;
    if (!merged.choices[i]) merged.choices[i] = { index: i, message: { role: "assistant", content: "" }, finish_reason: null };
    const mc = merged.choices[i].message ?? (merged.choices[i].message = { role: "assistant", content: "" });
    const dd = d.delta ?? {};
    if (dd.content) (mc._c ?? (mc._c = [])).push(dd.content);
    if (dd.reasoning_content) (mc._r ?? (mc._r = [])).push(dd.reasoning_content);
    if (dd.tool_calls) {
      mc.tool_calls = mc.tool_calls ?? [];
      for (const tc of dd.tool_calls) {
        const idx = tc.index ?? 0;
        mc.tool_calls[idx] = mc.tool_calls[idx] ?? { index: idx, function: { name: "", arguments: "" } };
        const fn = mc.tool_calls[idx].function;
        if (tc.function?.name) (fn._n ?? (fn._n = [])).push(tc.function.name);
        if (tc.function?.arguments) (fn._a ?? (fn._a = [])).push(tc.function.arguments);
      }
    }
    if (d.finish_reason) merged.choices[i].finish_reason = d.finish_reason;
  }
  if (delta.usage) merged.usage = delta.usage;
}

/** finalizeMerged 把攒下的片段数组收口成最终字符串，并抹掉中间态键。 */
function finalizeMerged(merged: any): void {
  for (const c of merged?.choices ?? []) {
    const mc = c?.message;
    if (!mc) continue;
    if (Array.isArray(mc._c)) {
      mc.content = mc._c.join("");
      delete mc._c;
    }
    if (Array.isArray(mc._r)) {
      mc.reasoning_content = mc._r.join("");
      delete mc._r;
    }
    for (const tc of mc.tool_calls ?? []) {
      const fn = tc?.function;
      if (!fn) continue;
      if (Array.isArray(fn._n)) {
        fn.name = fn._n.join("");
        delete fn._n;
      }
      if (Array.isArray(fn._a)) {
        fn.arguments = fn._a.join("");
        delete fn._a;
      }
    }
  }
}

function errorBody(message: string, status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "api_error", code } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
