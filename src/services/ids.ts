// 会话/请求 ID 生成（替代 internal/session/ids.go + upstream/streak.go 的 clientToken）。
//
// 事件链（autotask）要求 requestId 是**服务端返回的真实 id**（cmb-xxxx / 32hex），
// 自造 UUID 不计数；但客户端自用的 conversationId / 本地 traceId 需稳定可复现。
// 这里提供：
//   - clientToken()：前端 randomUUID 同款语义（8-4-4-4-12 hex），用于本地事件 id。
//   - newMessageID()：32 位 hex（UUID v4 去横线），对齐官方 X-Request-ID。
//   - deriveStable()：sha256(盐|键) 前 16 字节 hex——纯派生、按 key 稳定，用于
//     "同一会话键稳定复用同一聚合 ID"（后台按X-Conversation-Request-ID 聚合）。

const enc = new TextEncoder();

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** clientToken 幂等令牌（前端 randomUUID 同款 8-4-4-4-12 形态）。 */
export function clientToken(): string {
  const b = randomBytes(16);
  return [
    toHex(b.slice(0, 4)),
    toHex(b.slice(4, 6)),
    toHex(b.slice(6, 8)),
    toHex(b.slice(8, 10)),
    toHex(b.slice(10, 16)),
  ].join("-");
}

/** newMessageID 32 位 hex（官方 X-Request-ID / B3 TraceId 形态）。 */
export function newMessageID(): string {
  return toHex(randomBytes(16));
}

// deriveSalt isolate 级随机盐：对稳定聚合 ID 的纯派生统一加盐，使派生值无法按
// 外部可控键内容被预计算。语义等价 Go 的进程级盐。
//
// **惰性初始化**：Workers 禁止在全局作用域做异步 I/O / 取随机值（模块顶层执行
// newMessageID 会让整个 Worker 启动即崩：Disallowed operation called within global
// scope）。故首次 deriveStable 调用时才生成，每个 isolate 仍只有一份。
let _deriveSalt: string | null = null;
function deriveSalt(): string {
  if (!_deriveSalt) _deriveSalt = newMessageID();
  return _deriveSalt;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return toHex(new Uint8Array(digest));
}

/**
 * deriveStable 由 key 稳定派生 32 位 hex 聚合 ID（纯派生，无缓存、内存有界）。
 * - 同 key：恒同值；- 异 key：独立；- 空 key：回落随机（无会话则无"会话内稳定"语义）。
 */
export async function deriveStable(key: string): Promise<string> {
  if (!key) return newMessageID();
  const hex = await sha256Hex(deriveSalt() + "|" + key);
  return hex.slice(0, 32);
}

/** serverRequestIdRegex 服务端 requestId 形状（cmb- 前缀 32hex 或裸 32hex）。 */
const SERVER_ID_RE = /^(cmb-)?[0-9a-f]{32}$/;

/** isServerRequestId 判定是否为服务端真实 requestId（JOIN 事件必须用它）。 */
export function isServerRequestId(id: string): boolean {
  return SERVER_ID_RE.test(id);
}

/**
 * extractServerRequestId 从 SSE 文本流中抓取首个匹配 `"id":"<32hex|cmb-...>"` 的 id。
 * 对齐 desktop.go 的 searchFrom 推进逻辑：消息 id 等字段也可能命中 `"id":"`，
 * 须推进偏移避免重复命中同一位置导致读满仍误报"未找到"。
 * 返回 "" 表示未找到。
 */
export function extractServerRequestId(sseText: string): string {
  const needle = '"id":"';
  let from = 0;
  for (;;) {
    const i = sseText.indexOf(needle, from);
    if (i < 0) return "";
    const abs = i;
    const rest = sseText.slice(abs + needle.length);
    const end = rest.indexOf('"');
    if (end > 0) {
      const id = rest.slice(0, end);
      if (isServerRequestId(id)) return id;
      from = abs + 1;
    } else {
      return "";
    }
  }
}

/** msNow 当前 epoch 毫秒（与Go time.Now().UnixMilli() 对齐）。 */
export function msNow(): number {
  return Date.now();
}

/** wbConvID 生成事件链用本地 conversationId（wb2api-conv-<ns>）。 */
export function wbConvID(): string {
  return "wb2api-conv-" + Date.now() * 1000 + Math.floor(Math.random() * 1000);
}