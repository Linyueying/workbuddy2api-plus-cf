import type { Realm } from "../types";
import { downgradeEffort, effortListing, globalEffortMap } from "./efforts";
import { sanitizeMessages } from "./sanitize";
import { cleanupOrphanToolCalls, repackToolResultBlocks } from "./toolpairing";
import { backfillReasoningContent, injectThinking, lookupDefaultEffort } from "./thinking";

// 出站请求体改写管线（替代 internal/upstream/payload.go 的
// PrepareBodyOptWithEffortsAndDefault + ensureConsoleSystem）。
//
// 顺序与 Go 侧严格一致（顺序有语义，注释指明）：
//   1. stream=true            上游拒绝非流式
//   2. max_completion_tokens → max_tokens（OpenAI 别名 → 上游认的字段）
//   3. stream_options         body 未显式带时补 {include_usage:true}（末帧才有 usage）
//   4. normalizeToolChoice    上游该字段是 string，对象形式 400 code=11101
//   5. normalizeToolPatterns  tools 子树里 `\_` → `_`（上游校验器比主流引擎更严）
//   6. normalizeRoles         developer → system（上游 role 白名单不含 developer）
//   7. normalizeImageURL      字符串形态 → 对象形态（上游只认对象）
//   8. tool 配对两步          先 repack 重排再 cleanup 删孤儿（"让请求通过"的安全网）
//   9. injectThinking         deepseek 思维链开关（先于 10，补入的默认档也要走降级）
//  10. downgradeEffort       按模型 supportedEfforts 降级 reasoning_effort
//  11. backfillReasoning     deepseek 多轮一致性回填 reasoning_content
//  12. sanitizeMessages      指纹脱敏（仅 sanitize=true）
//  13. injectPromptCacheKey  缓存键注入（P0 费用优化，在管线之外单独调）
//  14. ensureConsoleSystem   global realm 兜底 system 注入（管线跑完后统一套用）

export interface EffortTables {
  /** 模型 → 支持档位（远端探测桶）。 */
  efforts: Record<string, string[]>;
  /** 模型 → 默认档（远端解析）。 */
  defaults: Record<string, string>;
}

export interface PrepareOpts {
  realm: Realm;
  /** 指纹脱敏开关（默认 true；false 完全还原）。 */
  sanitize?: boolean;
  /** 该 realm 的 effort 能力表。 */
  tables?: EffortTables;
  /** 出站是否需要 ensureConsoleSystem（global realm）。 */
  globalOn?: boolean;
  /** 改写明细（供日志/排障）。 */
  notes?: string[];
}

/** translateMaxCompletionTokens 把 OpenAI 别名翻译为上游认的 max_tokens。 */
export function translateMaxCompletionTokens(obj: Record<string, any>): void {
  const alias = obj.max_completion_tokens;
  // 无论翻译与否，别名一律删（减少 body 体积与排障噪音）。
  delete obj.max_completion_tokens;
  if (alias === undefined) return;
  if ("max_tokens" in obj) return; // 显式 max_tokens 优先：别名只删不译
  // 非正数值（0/null/负数）不翻译（0/null 语义是「未设置」，负数是非法值）；
  // 非数值别名（字符串等畸形）不翻译（原样透传由上游报 11101）。
  const v = Number(alias);
  if (Number.isFinite(v) && v > 0 && v === Math.floor(v)) obj.max_tokens = Math.floor(v);
}

/** normalizeToolChoice 按上游 Go struct（string 类型）改写 OpenAI tool_choice。 */
export function normalizeToolChoice(obj: Record<string, any>): void {
  if (!("tool_choice" in obj)) return;
  const suppress = () => {
    delete obj.tools;
    delete obj.functions;
  };
  const tc = obj.tool_choice;
  if (typeof tc === "string") {
    if (tc.trim().toLowerCase() === "none") {
      delete obj.tool_choice;
      suppress();
    }
    return;
  }
  if (tc && typeof tc === "object" && !Array.isArray(tc)) {
    const typ = String((tc as any).type ?? "").trim().toLowerCase();
    switch (typ) {
      case "none":
        delete obj.tool_choice;
        suppress();
        return;
      case "auto":
      case "required":
        obj.tool_choice = typ;
        return;
      case "function": {
        const fn = (tc as any).function;
        let name = fn && typeof fn === "object" ? String(fn.name ?? "") : "";
        if (!name) name = String((tc as any).name ?? "");
        name = name.trim();
        obj.tool_choice = name || "auto";
        return;
      }
      default:
        delete obj.tool_choice;
        return;
    }
  }
  // 其他标量 / null / 数组 → 删 tool_choice。
  delete obj.tool_choice;
}

/** unescapePatternLiteralEscapes 递归改写 schema 树里 `\_` → `_`。 */
function unescapePatternLiteralEscapes(node: any): void {
  if (Array.isArray(node)) {
    for (const v of node) unescapePatternLiteralEscapes(v);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.pattern === "string" && node.pattern.includes("\\_")) {
    node.pattern = node.pattern.split("\\_").join("_");
  }
  const props = node.patternProperties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const fixed: Record<string, any> = {};
    let rebuilt = false;
    for (const [k, v] of Object.entries(props)) {
      const nk = k.includes("\\_") ? k.split("\\_").join("_") : k;
      if (nk !== k) rebuilt = true;
      fixed[nk] = v;
    }
    if (rebuilt) node.patternProperties = fixed;
  }
  for (const v of Object.values(node)) unescapePatternLiteralEscapes(v);
}

/**
 * normalizeToolPatterns 归一化 tools 子树里 pattern 的非标准转义 `\_`（→ `_`）。
 *
 * 上游对 tools[].function.parameters 做严格 JSON Schema/正则文法校验，pattern 含
 * `\_` 会整体拒收：400 code=11129。`\_` 不是任何正则文法的合法转义，但所有主流
 * 引擎（RE2/PCRE/JS Annex B）都宽容地视为 `_` 本身——上游校验器比它们全部更严。
 * 归一无损，只动 tools 子树（消息正文里的 `\_` 如 Windows 路径不碰）。
 */
export function normalizeToolPatterns(obj: Record<string, any>): void {
  const rawTools = obj.tools;
  if (!Array.isArray(rawTools)) return;
  for (const tool of rawTools) {
    if (!tool || typeof tool !== "object") continue;
    const fn = (tool as any).function;
    if (fn && typeof fn === "object") unescapePatternLiteralEscapes(fn.parameters);
    unescapePatternLiteralEscapes((tool as any).parameters);
  }
}

/**
 * normalizeRoles 把 messages 里的 developer 角色归一为 system。
 *
 * 上游对 role 做白名单校验，developer 不在白名单内 → HTTP 400 code=11128。
 * developer 是 OpenAI 新规范里 system 的别名（Codex / Cursor 用它承载 system 级
 * 指令），改写为 system 不丢语义。这是「协议兼容」不是「内容脱敏」，故与
 * sanitize 开关解耦。
 *
 * 只认 developer 这一个值：其余 role 一律原样保留，不合并/不重排/不删除。
 */
export function normalizeRoles(obj: Record<string, any>): void {
  const msgs = obj.messages;
  if (!Array.isArray(msgs)) return;
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.role === "string" && m.role.trim().toLowerCase() === "developer") m.role = "system";
  }
}

/**
 * normalizeImageURL 兼容 OpenAI chat 多模态内容的两种 image_url 写法。
 *
 * 规范用对象形态 {"url":"...","detail":"..."}，部分客户端（及 Responses→Chat
 * 转换器）发字符串形态。上游只接受对象形态，字符串会 400 code=11101。
 *
 * 只做形状转换：字符串 → {"url": 原值}；已有对象及其中 url/detail 原样保留；
 * 空字符串/缺失值不补默认值，让上游返回真实错误。
 */
export function normalizeImageURL(obj: Record<string, any>): void {
  const msgs = obj.messages;
  if (!Array.isArray(msgs)) return;
  for (const msg of msgs) {
    if (!msg || typeof msg !== "object") continue;
    const parts = msg.content;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object" || (part as any).type !== "image_url") continue;
      const imageURL = (part as any).image_url;
      if (typeof imageURL !== "string" || imageURL === "") continue;
      (part as any).image_url = { url: imageURL };
    }
  }
}

/**
 * ensureConsoleSystem global realm 兜底 system 注入（防 console 域上游
 * code 11-128）：首条消息非 system 时在 messages 最前补一条 fallback system。
 * 首条已是 system 则不注入（不重复）。
 */
export function ensureConsoleSystem(obj: Record<string, any>): Record<string, any> {
  const msgs = obj.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return obj;
  const first = msgs[0];
  if (first && typeof first === "object" && String((first as any).role ?? "").trim().toLowerCase() === "system") {
    return obj;
  }
  obj.messages = [{ role: "system", content: "You are a helpful assistant." }, ...msgs];
  return obj;
}

/**
 * cloneBody 出站 body 的结构性深拷贝（只拷贝会被改写的节点）。
 *
 * prepareBody 原地改写，若直接改调用方的 body 会造成两个真实故障：
 *   1. 顶层 `stream` 被强制为 true → 代理层用它判断「客户端要流式还是聚合」，
 *      原判断会被污染，非流式客户端被当流式处理；
 *   2. messages 里的 role / text / image_url 被归一化 → 换号重试时对已改写的
 *      body 再改写一次，虽多数步骤幂等但语义不再可预期。
 */
export function cloneBody(src: any): any {
  if (!src || typeof src !== "object" || Array.isArray(src)) return src;
  const out: Record<string, any> = { ...src };
  if (Array.isArray(src.messages)) {
    out.messages = src.messages.map((m: any) => {
      if (!m || typeof m !== "object" || Array.isArray(m)) return m;
      const c: Record<string, any> = { ...m };
      if (Array.isArray(m.content)) c.content = m.content.map((p: any) => (p && typeof p === "object" && !Array.isArray(p) ? { ...p } : p));
      if (Array.isArray(m.tool_calls)) {
        c.tool_calls = m.tool_calls.map((t: any) => {
          if (!t || typeof t !== "object") return t;
          const fn = (t as any).function;
          return { ...t, ...(fn && typeof fn === "object" ? { function: { ...fn } } : {}) };
        });
      }
      return c;
    });
  }
  if (Array.isArray(src.tools)) out.tools = src.tools.map((t: any) => (t && typeof t === "object" ? { ...t } : t));
  return out;
}

/**
 * prepareBody 完整出站改写管线（返回新对象，不改调用方的 body）。 */
export function prepareBody(src: any, opts: PrepareOpts): any {
  const input = cloneBody(src);
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const obj = input as Record<string, any>;
  const notes = opts.notes ?? [];
  const sanitize = opts.sanitize !== false;

  // 1) 强制流式：上游拒绝非流式。
  obj.stream = true;
  // 2) 别名翻译。
  translateMaxCompletionTokens(obj);
  // 3) stream_options：仅当 body 未显式带时补（上游据此在末帧返回 usage）。
  if (!("stream_options" in obj)) obj.stream_options = { include_usage: true };
  // 4-7) 协议兼容归一化。
  normalizeToolChoice(obj);
  normalizeToolPatterns(obj);
  normalizeRoles(obj);
  normalizeImageURL(obj);
  // 8) tool 配对两步：先重排再清理，所有模型一律执行（独立于 sanitize 开关）。
  if (Array.isArray(obj.messages)) {
    const [repacked] = repackToolResultBlocks(obj.messages);
    const [cleaned, removed] = cleanupOrphanToolCalls(repacked);
    // 无改动时两步都返回原数组，回写等于零操作；任一步重排/删除（哪怕后续步骤零改动）
    // 也必须落到 obj——不能只在「最后一步改动」时回写，否则 repack 单独生效的
    // 结果会被原数组覆盖丢失。
    obj.messages = cleaned;
    if (removed) notes.push("tool_pairing_cleaned");
  }
  // effort 表：global 域用「静态兜底为基 + 远端覆盖」，其余用远端桶。
  let tables: EffortTables = opts.tables ?? { efforts: {}, defaults: {} };
  if (opts.realm === "global") {
    tables = globalEffortMap(tables.efforts, tables.defaults);
  }
  const model = String(obj.model ?? "");
  // 9) deepseek 思维链开关（先于 10：补入的默认档也要走降级管线）。
  injectThinking(obj, lookupDefaultEffort(tables.defaults, model));
  // 10) effort 降级。
  const dg = downgradeEffort(tables.efforts[model], model, obj);
  if (dg) notes.push(`reasoning_effort_${dg.why}:${dg.from}->${dg.effort}`);
  // 11) deepseek 多轮一致性回填。
  backfillReasoningContent(obj);
  // 12) 指纹脱敏。
  if (sanitize && Array.isArray(obj.messages) && sanitizeMessages(obj.messages)) {
    notes.push("sanitized");
  }
  // 14) global 兜底 system（在管线跑完后统一套用）。
  if (opts.globalOn) ensureConsoleSystem(obj);
  return obj;
}

export { effortListing };
