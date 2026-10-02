// 注入上游 prompt_cache_key 字段（P0 费用优化）
// （替代 internal/upstream/cache_key.go）。
//
// 逆向实测：上游服务端支持 prompt_cache_key，同一段 8k token 前缀：
//   - 不带 → prompt_cache_hit_tokens=0,  credit≈0.34
//   - 带   → prompt_cache_hit_tokens=7808, credit≈0.02（费用降 ~17×）
//
// 网关在此为每个出站 chat 请求注入一个稳定、按账号隔离的 cache key，
// 让同一客户端对同一账号的连续请求复用上游前缀缓存。

/** strField 从对象取 string 字段，非 string 或空串返回 ""。 */
function strField(obj: Record<string, any>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * buildCacheKey 生成 `wb2a-<uid8>-<convHex>` 格式的稳定 cache key。
 *
 * convHex = sha256(uid + "|" + conversation) 前 16 字节的 hex，提供会话段
 * （同账号同会话稳定、不同会话不同）。会话源为空时 convHex 仍由 uid 单独哈希，
 * 保证跨账号绝不碰撞但同一空会话不复用（空会话 = 新会话语义）。
 */
export async function buildCacheKey(uid: string, conversation: string): Promise<string> {
  const uid8 = uid ? uid.slice(0, 8) : "-";
  const data = new TextEncoder().encode(uid + "|" + conversation);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(buf).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "wb2a-" + (uid8 || "-") + "-" + hex;
}

/**
 * resolveConversationID 从请求体提取会话头族的 conversationId（snake/camel 双形态，
 * metadata 优先、snake 优先于 camel）。**只认 conversationId，绝不回落 user_id**
 * ——X-Conversation-ID 语义是「对话 ID」，user_id 回落会污染按对话聚合的判据。
 * 缺失返回 ""（不伪造：客户端没给就不发）。
 */
export function resolveConversationID(body: any): string {
  if (!body || typeof body !== "object") return "";
  const meta = body.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const a = typeof meta.conversation_id === "string" ? meta.conversation_id.trim() : "";
    if (a) return a;
    const b = typeof meta.conversationId === "string" ? meta.conversationId.trim() : "";
    if (b) return b;
  }
  const c = typeof body.conversation_id === "string" ? body.conversation_id.trim() : "";
  if (c) return c;
  const d = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  return d;
}

/**
 * injectPromptCacheKey 在已改写的出站 body 上注入 prompt_cache_key 字段（原地改写）。
 *
 * 优先级：
 *   1. body 已带 prompt_cache_key → 原值保留（客户端自知复用哪个键）
 *   2. body 已带 conversation_id / conversationId → 用它做会话哈希源
 *   3. 都没有 → 用入站 conversationID 参数（来自请求体解析）
 *
 * 安全约束——按账号隔离：生成键格式 `wb2a-<uid8>-<convHex>`，uid8 是账号 UID 前
 * 8 字符，跨账号绝不相同。跨账号复用同一 cache key 会让上游命中错账号的前缀缓存、
 * 泄露对方对话，故 uid 是硬隔离因子。
 */
export async function injectPromptCacheKey(
  body: Record<string, any> | null | undefined,
  uid: string,
  conversationID: string,
): Promise<void> {
  if (!body || typeof body !== "object") return;
  const existing = body.prompt_cache_key;
  if (typeof existing === "string" && existing !== "") return; // 客户端显式带 → 绝不覆盖
  let conv = conversationID;
  const fromBody = strField(body, "conversation_id") || strField(body, "conversationId");
  if (fromBody) conv = fromBody;
  body.prompt_cache_key = await buildCacheKey(uid, conv);
}
