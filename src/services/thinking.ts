// DeepSeek 思维链开关：出站请求体注入 thinking:{type:"enabled"} + 默认档位
// （替代 internal/upstream/thinking.go）。
//
// 根因（issue #43，逆向官方客户端 codebuddy.js 已确认）：官方客户端对 deepseek 系
// 模型标记 thinkingFormat:"deepseek" + requiresReasoningContentOnAssistantMessages，
// 发请求时「开思考」必须显式带 thinking:{type:"enabled"}，否则上游默认按不思考应答
// （思维链不返回）。glm/kimi/qwen 走其他 thinkingFormat 所以正常。
//
// 打回修复（#43 验收实测）：thinking.type=enabled 单一字段不足——真实上游
// deepseek-v4-flash 对「不带 reasoning_effort」的裸请求仍按不思考应答
// （reasoning_content 长度 0），带 reasoning_effort:high 才有思维链。官方「开思考」
// = thinking.type:enabled + 某档 effort；默认档来自 reasoning.defaultEffort ?? 兜底 "high"。

/** defaultDeepSeekEffort 官方客户端默认档兜底（configure thinking 无来源时 fallback 到 high）。 */
export const DEFAULT_DEEPSEEK_EFFORT = "high";

/** isDeepSeekModel 模型名以 deepseek 为前缀（不区分大小写）。 */
export function isDeepSeekModel(model: string): boolean {
  return String(model ?? "").trim().toLowerCase().startsWith("deepseek");
}

/** lookupDefaultEffort 从模型目录缓存的 defaultEfforts 表按模型名查默认档。 */
export function lookupDefaultEffort(defaultEfforts: Record<string, string> | undefined, model: string): string {
  if (!defaultEfforts || !model) return "";
  return defaultEfforts[model] ?? "";
}

/**
 * injectThinking 按 DeepSeek 思维链开关规则改写请求体。非 deepseek 零改动。
 *
 *   - 显式 thinking.type 非空 → 客户端显式控制：enabled 缺 effort 时补默认档；
 *     disabled 尊重并删 reasoning_effort（snake/camel 双字段）。
 *   - 无 thinking / type 空 / 已有 reasoning_effort → 注入 enabled 并补默认档
 *     （已有 effort 不覆盖）。
 *   - 显式 reasoning_effort 一律不覆盖、不降级（降级交给 downgradeEffort）。
 */
export function injectThinking(obj: Record<string, any>, defaultEffort: string): void {
  const model = String(obj.model ?? "");
  if (!isDeepSeekModel(model)) return;
  const th = obj.thinking;
  const isObj = !!th && typeof th === "object" && !Array.isArray(th);
  const typ = isObj ? String((th as any).type ?? "").trim() : "";
  // 显式控制分支：type 非空（enabled/disabled 均为明确意图）→ 不改 type。
  if (typ) {
    if (typ.toLowerCase() === "disabled") {
      delete obj.reasoning_effort;
      delete obj.reasoningEffort;
      return;
    }
    ensureDeepSeekEffort(obj, defaultEffort);
    return;
  }
  // 无 thinking（或 thinking 是非法非对象值）或 type 缺失/为空：注入 enabled。
  if (isObj) (th as any).type = "enabled";
  else obj.thinking = { type: "enabled" };
  ensureDeepSeekEffort(obj, defaultEffort);
}

/**
 * ensureDeepSeekEffort 缺 effort 档位时补默认档（snake 优先，camel 兜底）。
 * 已有任一 effort → 不覆盖（显式档位不做任何改写，降级交给 downgradeEffort）。
 */
export function ensureDeepSeekEffort(obj: Record<string, any>, defaultEffort: string): void {
  if ("reasoning_effort" in obj) return;
  if ("reasoningEffort" in obj) return;
  obj.reasoning_effort = defaultEffort || DEFAULT_DEEPSEEK_EFFORT;
}

/**
 * backfillReasoningContent DeepSeek 多轮一致性：保证每条 assistant 消息带
 * reasoning_content 字段且值为 string，并镜像保证 reasoning 字段存在且非空。
 *
 * 门控（对齐官方 ReasoningContentBackfillRule：thinkingEnabled || hasTrace）：
 *   - 非 deepseek → 零改动；
 *   - deepseek + enabled（含注入后）→ 每条 assistant 保证 reasoning_content 是
 *     string：已有 string 原样保留；reasoning 是非空 string 且 rc 非 string →
 *     复制 reasoning 值；两者皆无 → 补空串；
 *   - deepseek + disabled + 无痕迹 → 零改动；
 *   - deepseek + disabled + 有痕迹 → 照补（官方 hasTrace 半边）。
 *
 * 归一化对齐官方 `"string" != typeof` 语义：reasoning_content 为 null/数字等非
 * string 值时不算「已有」。
 */
export function backfillReasoningContent(obj: Record<string, any>): void {
  const model = String(obj.model ?? "");
  if (!isDeepSeekModel(model)) return;
  const msgs = obj.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return;
  // thinkingEnabled 半边：读注入后的 thinking.type（与官方 el.thinkingEnabled 对应）。
  let thinkingEnabled = false;
  const th = obj.thinking;
  if (th && typeof th === "object" && !Array.isArray(th)) {
    thinkingEnabled = String((th as any).type ?? "").trim().toLowerCase() === "enabled";
  }
  // hasTrace 半边：任一消息带非空 reasoning 或已有 reasoning_content 字段。
  let hasTrace = false;
  for (const mm of msgs) {
    if (!mm || typeof mm !== "object") continue;
    if (typeof mm.reasoning === "string" && mm.reasoning !== "") {
      hasTrace = true;
      break;
    }
    if ("reasoning_content" in mm) {
      hasTrace = true;
      break;
    }
  }
  if (!thinkingEnabled && !hasTrace) return;
  for (const mm of msgs) {
    if (!mm || typeof mm !== "object" || mm.role !== "assistant") continue;
    let rc: string;
    if (typeof mm.reasoning_content === "string") {
      rc = mm.reasoning_content; // 已有 string → 不覆盖（原有语义保留）
    } else if (typeof mm.reasoning === "string") {
      rc = mm.reasoning;
      mm.reasoning_content = rc;
    } else {
      rc = "";
      mm.reasoning_content = rc;
    }
    // 镜像：reasoning 缺失/null/空串 → 归一化（非空 rc 优先，皆无补 " "）。
    // 部分账号/租户对 thinking 形态校验 len(reasoning)>0：缺失/null/空串 400，
    // 空白串 200（上游不 trim）——空白串占位是该字段透传校验位、非内容消费位。
    if (typeof mm.reasoning === "string" && mm.reasoning !== "") continue;
    mm.reasoning = rc !== "" ? rc : " ";
  }
}
