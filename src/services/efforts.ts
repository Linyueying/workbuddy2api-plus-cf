import type { Realm } from "../types";

// 推理档位（reasoning effort）产品级静态兜底表 + 降级管线
// （替代 internal/upstream/effort_catalog.go + payload.go 的 normalizeReasoningEffort）。
//
// 三级来源（远端优先）：
//   1. 上游模型目录已解析的 reasoning.supportedEfforts / defaultEffort（权威）；
//   2. 本文件按 realm 分开的产品级静态兜底表；
//   3. 皆无 → 不在 /v1/models 输出 effort 字段（omitted，不是空数组）。
//
// 按 realm 分表是硬要求：deepseek-v4.1-flash 在 CN 面是三档 ['low','high','max']，
// 在 global 面**只有 ['high']** —— 往 WorkBuddy 上游发 low/max 是 400（issue #84）。

export interface EffortCap {
  efforts: string[];
  defaultEffort?: string;
}

/** effortRank 档位从低到高。 */
export const EFFORT_RANK: Record<string, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/** cnEffortFallback CN / CodeBuddy 面静态兜底表。 */
export const CN_EFFORT_FALLBACK: Record<string, EffortCap> = {
  "deepseek-v4-flash": { efforts: ["low", "high", "max"] },
  "deepseek-v4.1-flash": { efforts: ["low", "high", "max"], defaultEffort: "high" },
  "deepseek-v4-pro": { efforts: ["low", "high", "xhigh"], defaultEffort: "high" },
  "hy4-preview": { efforts: ["high"], defaultEffort: "high" },
  "hy4-preview-x": { efforts: ["high"] },
  hy3: { efforts: ["low", "high"], defaultEffort: "high" },
  "hy3-x": { efforts: ["low", "high"], defaultEffort: "high" },
  "glm-5.3": { efforts: ["low", "high", "max"], defaultEffort: "high" },
  "glm-5.3-flash": { efforts: ["low", "high", "max"], defaultEffort: "high" },
  "glm-5.2": { efforts: ["high", "xhigh"], defaultEffort: "high" },
  "glm-5.1": { efforts: ["medium"] },
  "glm-5v-turbo": { efforts: ["medium"] },
  "kimi-k3-1": { efforts: ["medium"] },
  "kimi-k2.7": { efforts: ["medium"] },
  "kimi-k2.6": { efforts: ["medium"] },
  "minimax-m3": { efforts: ["medium"] },
};

/** globalEffortFallback global / WorkBuddy 国际版面静态兜底表。 */
export const GLOBAL_EFFORT_FALLBACK: Record<string, EffortCap> = {
  "fast-model": { efforts: ["medium"] },
  "balanced-model": { efforts: ["medium"] },
  "primary-model": { efforts: ["high"] },
  "hy4-preview-f": { efforts: ["high"], defaultEffort: "high" },
  hy3: { efforts: ["low", "high"], defaultEffort: "high" },
  // 国际版**只有 ['high']**（实测 IDE 缓存），与 CN 面三档刻意不同。
  "deepseek-v4.1-flash": { efforts: ["high"] },
  "gpt-6-astra": { efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  "gpt-5.6-sol": { efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  "gpt-5.6-terra": { efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  "gpt-5.6-luna": { efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  "gpt-5.5": { efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
  "gpt-5.4": { efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
  "gpt-5.3-codex": { efforts: ["medium"] },
  "gemini-3.5-flash": { efforts: ["medium"] },
  "glm-5.3": { efforts: ["low", "high", "max"], defaultEffort: "high" },
  "glm-5.2": { efforts: ["high", "xhigh"], defaultEffort: "high" },
  "kimi-k3": { efforts: ["medium"] },
  "kimi-k2.6": { efforts: ["medium"] },
};

/** staticEffortCap 按 realm 取静态兜底条目；未命中返回 undefined。 */
export function staticEffortCap(realm: Realm, model: string): EffortCap | undefined {
  return (realm === "global" ? GLOBAL_EFFORT_FALLBACK : CN_EFFORT_FALLBACK)[model];
}

/**
 * effortListing 计算模型在 /v1/models 应暴露的 effort 能力（三级查找 + 默认档防御）。
 *
 * remoteEfforts 非空时以其为权威（不回落到静态表）；否则落静态兜底表；皆无 → null
 * （调用方省略字段，不输出空数组）。
 *
 * defaultEffort 仅在「efforts 非空且 default 命中 efforts」时才返回——不宣称
 * 不支持的默认档。remoteDefault 空串**不**回落到静态默认档：默认档随档位表同源，
 * 避免跨源拼出「档位是静态、默认档是 remote」的矛盾组合。
 */
export function effortListing(
  realm: Realm,
  model: string,
  remoteEfforts?: string[] | null,
  remoteDefault?: string,
): { efforts: string[]; defaultEffort: string } | null {
  let src: EffortCap | undefined;
  if (remoteEfforts && remoteEfforts.length) src = { efforts: remoteEfforts, defaultEffort: remoteDefault };
  else src = staticEffortCap(realm, model);
  if (!src || !src.efforts.length) return null;
  const efforts = [...src.efforts];
  const def = src.defaultEffort && efforts.includes(src.defaultEffort) ? src.defaultEffort : "";
  return { efforts, defaultEffort: def };
}

/**
 * globalEffortMap global 域降级用的 effort 能力表：静态兜底为基，远端桶覆盖（权威优先）。
 *
 * global 上游可能不下发 supportedEfforts —— 此时也必须按产品静态表降级，否则
 * 客户端传 low/max 必 400。
 */
export function globalEffortMap(
  remoteEfforts: Record<string, string[]>,
  remoteDefaults: Record<string, string>,
): { efforts: Record<string, string[]>; defaults: Record<string, string> } {
  const efforts: Record<string, string[]> = {};
  const defaults: Record<string, string> = {};
  for (const [id, cap] of Object.entries(GLOBAL_EFFORT_FALLBACK)) {
    efforts[id] = [...cap.efforts];
    if (cap.defaultEffort) defaults[id] = cap.defaultEffort;
  }
  for (const [id, v] of Object.entries(remoteEfforts)) {
    if (v.length) efforts[id] = v;
  }
  for (const [id, v] of Object.entries(remoteDefaults)) {
    if (v) defaults[id] = v;
  }
  return { efforts, defaults };
}

export interface EffortDowngrade {
  /** 改写后的档位（与原请求不同才返回）。 */
  effort: string;
  /** 原请求档位。 */
  from: string;
  /** 降级原因，供日志/排障。 */
  why: "downgraded" | "floored";
}

/**
 * downgradeEffort 按模型 supportedEfforts 降级 reasoning_effort（snake/camel 双字段兼容）。
 *   - 请求档位模型支持 → 原样透传（返回 null）；
 *   - 请求档位不支持 → 改为 ≤请求档位的最高支持档（downgraded）；
 *   - 支持档全部高于请求档 → 取最低支持档（floored，偏离最小）；
 *   - 未知模型 / 未知档位 / 未携带字段 → null（透传）。
 */
export function downgradeEffort(
  supported: string[] | undefined,
  model: string,
  obj: Record<string, any>,
): EffortDowngrade | null {
  if (!supported?.length || !model) return null;
  let key = "";
  if ("reasoning_effort" in obj) key = "reasoning_effort";
  else if ("reasoningEffort" in obj) key = "reasoningEffort";
  else return null;
  const raw = obj[key];
  if (typeof raw !== "string") return null;
  const req = raw.trim().toLowerCase();
  const reqIdx = EFFORT_RANK[req];
  if (reqIdx === undefined) return null;
  // 在 ≤请求档位的支持档里选最高档。
  let best = "";
  let bestIdx = -1;
  for (const s of supported) {
    const idx = EFFORT_RANK[s.trim().toLowerCase()];
    if (idx !== undefined && idx <= reqIdx && idx > bestIdx) {
      best = s;
      bestIdx = idx;
    }
  }
  if (best) {
    if (best.toLowerCase() === req) return null;
    obj[key] = best;
    return { effort: best, from: req, why: "downgraded" };
  }
  // 支持档全部高于请求档：取最低支持档。
  let lowest = "";
  let lowestIdx = 1 << 30;
  for (const s of supported) {
    const idx = EFFORT_RANK[s.trim().toLowerCase()];
    if (idx !== undefined && idx < lowestIdx) {
      lowest = s;
      lowestIdx = idx;
    }
  }
  if (lowest) {
    obj[key] = lowest;
    return { effort: lowest, from: req, why: "floored" };
  }
  return null;
}
