import type { Env } from "../../worker-configuration.d.ts";
import { getConfig, normalizePromptMode, type PromptMode } from "../config";

// 网关自有系统提示词：内置默认 + 外部覆盖 + 降级中性提示词
// （替代 internal/prompt/prompt.go + internal/server/degrade.go）。
//
// 背景：客户端（Claude Code / Codex 等 CLI）在 system prompt 注入固定模板句，
// 上游内容审核按**逐字精确匹配**误杀合法流量（issue #36 / PR39 的 11128）。
// 方案：网关在出站前用自有系统提示词替换（custom）或叠加（append）客户端的
// system/developer，从源头消灭 system 来源的指纹误报。用户/assistant 消息里
// 的指纹串仍由 sanitize.ts 清洗——两层叠加、互不替代。
//
// 与 Go 的两处环境差异（都是刻意的）：
//   1. `//go:embed defaultprompt.md` → 内联 DEFAULT_PROMPT 常量；
//   2. 降级门 degradeGate 是**进程内存**（重启清零）。Workers 无进程内存且
//      多 isolate 并发，故落 WB2A_CACHE 的 KV 键（最终一致窗口可接受：
//      误报降级是尽力而为的兜底，不参与正确性判定）。

/** DEGRADED 降级提示词：误报处理用，刻意极简中性。
 *
 * 触发场景：passthrough/append 模式下请求被上游内容策略拦截（HTTP 400 + 审核
 * 文案），判定为指纹误报后换此提示词重试一次。非对抗框架——只用于绕开 system
 * 来源的误报，不改变用户指令的合法性语义。
 */
export const DEGRADED =
  "You are a helpful assistant. Respond in the user's language, follow the user's instructions, and be direct and concise.";

/**
 * DEFAULT_PROMPT 内置默认系统提示词（逐字对齐 Go internal/prompt/defaultprompt.md）。
 * file 为空时的回落文本，也是 custom/append 模式的默认文本。
 */
export const DEFAULT_PROMPT = `# 系统提示词

你是一名工程助手，帮助用户完成软件工程任务。以下原则指导你的行为。

## 核心立场
- 你的价值是让用户的工程目标更快达成，而非展示你自己的能力边界。
- 当用户的方向有更优解时，直接指出并给出替代方案；不必逢迎。
- 对不确定的事保持诚实：宁可说"我不确定，需要验证"，也不编造看似合理的答案。

## 语言与风格
- 跟随用户的提问语言：用户用中文则用中文，用英文则用英文。
- 简洁直接，不说废话；不用客套开场与总结，不重复用户已说过的内容。
- 技术术语精确，不为了通俗而牺牲准确性。

## 工程行为
- 先看代码再动手：理解上下文、既有模式与约定，避免破坏一致性。
- 最小改动：只改必要的部分，不做无关重构或风格统一。
- 改动后验证闭环：运行测试或构建确认结果，不假设"应该没问题"。
- 遇到不确定的边界，先确认再执行，不擅自扩大范围或假设需求。
- 修改共享代码前，先看它被谁依赖，避免连锁影响。

## 任务分解
- 复杂任务先拆步骤，按依赖顺序推进；每步可独立验证。
- 给出改动清单与影响面，让用户能判断是否继续。
- 失败时如实报告原因，给出下一步建议，不掩盖、不粉饰。

## 输出格式
- 用 Markdown 组织结构。
- 代码块标注语言（\`\`\`go / \`\`\`bash / \`\`\`json 等）。
- 复杂度与任务匹配：简单问题一句话答完，复杂问题分步骤说明。
- 关键决策给出依据，不堆砌理由；不写你已经知道答案却还要绕的解释。
- 引用代码时用 \`file:line\` 形式，便于用户跳转。

## 边界
- 不臆造未给定的 API、字段或行为；不确定时如实说明并给出验证路径。
- 安全敏感操作（删除、覆盖、发布）先确认，除非已被明确授权。
- 错误与失败如实报告，不为了让结果"好看"而省略或美化。
- 保留对方案的质疑空间：如果用户的方案有明显问题，指出并提供更优替代。
`;

/** 合法 prompt.mode（定义在 config.ts，避免 config↔prompt 循环依赖）。 */
export type { PromptMode };

/**
 * loadPromptText 按配置取提示词文本（对齐 Go prompt.Load）。
 *
 * 优先级：cfg.prompt.text（面板直接写文本）→ cfg.prompt.file 指向的 KV 键
 * → 内置 DEFAULT_PROMPT。
 *
 * 与 Go 的差异：Go 是 `os.ReadFile(file)`，读不到就 fail fast 启动报错。
 * Workers 里每请求读配置，为一个提示词文件把整个网关拖停不划算，且配置
 * 刚被面板改动时短暂读失败本就该「沿用上次可用值」而非全站 5xx。故读失败
 * 静默回落内置默认。
 */
export async function loadPromptText(env: Env, cfg: any): Promise<string> {
  const inline = typeof cfg?.prompt?.text === "string" ? cfg.prompt.text : "";
  if (inline !== "") return inline;
  const key = typeof cfg?.prompt?.file === "string" ? cfg.prompt.file.trim() : "";
  if (key !== "") {
    const v = await env.WB2A_CACHE.get(key).catch(() => null);
    if (v && v !== "") return v;
  }
  return DEFAULT_PROMPT;
}

/** nextMidnightCST 返回 now 之后最近的 Asia/Shanghai 00:00（epoch ms）。
 *
 * 边界语义（对齐 Go nextMidnightCST）：
 *   - 23:59 → 次日 00:00（几秒后）
 *   - 00:00 → 次日 00:00（刚过 00:00，下个零点是次日）
 * 固定 +08:00 偏移，不依赖运行时时区。
 */
export function nextMidnightCST(now: number): number {
  const cst = now + 8 * 3600_000;
  const midnight = Math.floor(cst / 86_400_000) * 86_400_000 - 8 * 3600_000;
  // 循环而非一次加天：跨夏令时等异常时区偏移下仍收敛（固定偏移实际一次即够）。
  let t = midnight;
  while (t <= now) t += 86_400_000;
  return t;
}

/** 降级状态在 KV 里的键（Workers 无进程内存，见文件头说明）。 */
const DEGRADE_KEY = "prompt:degraded_until";

/**
 * 降级状态的进程内缓存。
 *
 * 存在理由（真机数据驱动）：degradedActive 在**每个请求**的提示词策略里被调用，
 * 原实现直接读一次 KV，实测稳定吃掉 ~100ms——而它读的那个键在绝大多数部署里
 * **根本不存在**（没触发过降级），KV 确认「键不存在」的成本同样要付。
 *
 * 降级是「一天最多触发一次、且本来就是尽力而为的兜底」语义（见文件头：它不参与
 * 正确性判定），因此 60s 的可见性滞后完全可接受，换掉每请求一次 KV 往返很划算。
 */
const DEGRADE_TTL_MS = 60_000;
let degradeCache: { ts: number; until: number } | null = null;

/** invalidateDegradeCache 降级状态变更后调用，让本机立刻看到新值。 */
export function invalidateDegradeCache(): void {
  degradeCache = null;
}

/** degradedActive 当前是否处于降级期（now < until）。 */
export async function degradedActive(env: Env): Promise<boolean> {
  if (degradeCache && Date.now() - degradeCache.ts < DEGRADE_TTL_MS) {
    return degradeCache.until > Date.now();
  }
  // 读失败时记 0（未降级）而非抛错：降级只是兜底，不该因为它让对话请求失败。
  const until = await degradedUntil(env);
  degradeCache = { ts: Date.now(), until };
  return until > Date.now();
}

/** triggerDegrade 触发降级，直到次日 00:00 CST。已在降级期内则**不续期**
 * （保持最早触发点的 00:00 重置语义，对齐 Go degradeGate.Trigger）。 */
export async function triggerDegrade(env: Env): Promise<void> {
  const until = await degradedUntil(env);
  if (until > Date.now()) return; // 已在降级期，不续期
  const next = nextMidnightCST(Date.now());
  // KV 最小 TTL 60s；跨过零点后键自然过期，无需清理。
  const ttl = Math.max(60, Math.ceil((next - Date.now()) / 1000));
  await env.WB2A_CACHE.put(DEGRADE_KEY, String(next), { expirationTtl: ttl }).catch(() => {});
  // 立刻对本机生效：降级是被上游 400 逼出来的，若本 isolate 还按「未降级」继续
  // 用原提示词发下一个请求，会确定性地再撞一次同样的拦截。
  invalidateDegradeCache();
}

/** degradedUntil 读降级截止墙钟（0 = 未降级）。测试与面板用。 */
export async function degradedUntil(env: Env): Promise<number> {
  const raw = await env.WB2A_CACHE.get(DEGRADE_KEY).catch(() => null);
  const until = Number(raw ?? 0);
  return Number.isFinite(until) ? until : 0;
}

/**
 * rewriteSystemPrompt 用网关提示词替换客户端的 system/developer：
 *   - 删除 messages 中所有 role 为 system/developer 的消息；
 *   - 在 messages 头部插入一条 {role:"system", content:systemPrompt}；
 *   - 其余字段与 user/assistant/tool 消息逐字不动。
 *
 * 绝不失败：body 非对象 / messages 非数组 / systemPrompt 为空 → 原样返回。
 * 这是出站改写的关键路径，任何异常都不该阻塞请求转发。
 */
export function rewriteSystemPrompt(body: any, systemPrompt: string): any {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if (!systemPrompt) return body;
  const msgs = body.messages;
  if (!Array.isArray(msgs)) {
    // 无 messages 字段或类型不符 → 插入单条 system，其余字段原样保留。
    return { ...body, messages: [{ role: "system", content: systemPrompt }] };
  }
  const kept = msgs.filter((m: any) => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return true;
    const role = m.role;
    return role !== "system" && role !== "developer";
  });
  return { ...body, messages: [{ role: "system", content: systemPrompt }, ...kept] };
}

/**
 * appendSystemPrompt 在「开头连续 system/developer 块」之后插入一条网关自有
 * system 提示词（issue #129 append 模式）：
 *   - 开头连续块 = 从 messages[0] 起向后 role 为 system/developer（与 rewrite
 *     的删除口径一致）的消息；遇第一条非 system/developer 消息（含非对象
 *     消息、无 role 消息）即停；
 *   - 插入点 = 连续块末尾之后（块长 0 时即 messages 最前）；
 *   - 所有既有消息（含开头块、中途 system、user/assistant/tool）逐字不动
 *     ——客户端项目规范/工具约定与网关提示词并用。
 *
 * 边界判定须显式同时匹配 system 与 developer：归一（developer→system）在
 * 下游 payload 管线执行，append 跑在它之前，此刻开头块里的 developer 还是
 * developer。网关消息角色用 system 而非 developer——上游 role 白名单不含
 * developer，插 developer 等于制造一次必然归一与多余的 11128 风险窗口。
 */
export function appendSystemPrompt(body: any, systemPrompt: string): any {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  if (!systemPrompt) return body;
  const msgs = body.messages;
  if (!Array.isArray(msgs)) {
    return { ...body, messages: [{ role: "system", content: systemPrompt }] };
  }
  let insertAt = 0;
  for (const m of msgs) {
    if (!m || typeof m !== "object" || Array.isArray(m)) break;
    if (m.role !== "system" && m.role !== "developer") break;
    insertAt++;
  }
  const rewritten = [...msgs.slice(0, insertAt), { role: "system", content: systemPrompt }, ...msgs.slice(insertAt)];
  return { ...body, messages: rewritten };
}

export interface PromptDecision {
  /** 改写后的 body（同一引用表示无需改写）。 */
  body: any;
  /** 本次是否应用了降级中性提示词（降级重试的「只重试一次」门）。 */
  degraded: boolean;
}

/**
 * applyPromptPolicy 按 prompt.mode + 降级期裁决出站 body
 * （对齐 Go handler.go 的四分支，**必须**在 prepareBody 之前、轮转之前调用）。
 *
 *   - custom：用自有提示词替换客户端 system/developer（源头消灭 system 指纹）。
 *   - append：开头连续 system/developer 块后插自有提示词，既有消息逐字不动。
 *   - passthrough + 降级期：换 Degraded 中性提示词直达，不再先撞 400。
 *   - passthrough / append 非降级期：透传客户端原始 system（append 则再插一条）。
 *
 * 降级裁决：append 在降级期退化为 replace（rewrite(Degraded)）——append 带
 * 指纹原文重试是确定性再撞墙，replace 是一次性最小抢救（issue #129 设计 §4）。
 * custom 模式不进降级路径（提示词本就是网关自有的，无误报来源）。
 */
export async function applyPromptPolicy(env: Env, body: any, cfg?: any): Promise<PromptDecision> {
  const c = cfg ?? (await getConfig(env));
  const mode = normalizePromptMode(c?.prompt?.mode) ?? "passthrough";
  const degradedOn = mode === "passthrough" || mode === "append" ? await degradedActive(env) : false;

  if (mode === "custom") {
    const text = await loadPromptText(env, c);
    if (!text) return { body, degraded: false };
    return { body: rewriteSystemPrompt(body, text), degraded: false };
  }
  if (mode === "append" && !degradedOn) {
    const text = await loadPromptText(env, c);
    if (!text) return { body, degraded: false };
    return { body: appendSystemPrompt(body, text), degraded: false };
  }
  if (degradedOn) {
    return { body: rewriteSystemPrompt(body, DEGRADED), degraded: true };
  }
  return { body, degraded: false };
}
