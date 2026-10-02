// 上游错误分类（替代 upstream.Classify 十二类，严格保序）。
// 顺序即优先级：错误码一旦命中立即停止，否则会误罚号。

export interface Classified {
  kind: string;
  /**
   * kindName 降级类别名（对齐 Go upstream.ErrKind.String()：soft_rate /
   * hard_credit / model_blocked / server / account_fault / not_found …）。
   * 模型编排的 Fallbackable 按这个名字判定，与 pool 的 note 动作名同命名空间。
   */
  kindName: string;
  status: number;
  code: string;
  message: string;
  hint?: string;
  /** 给账号池的惩罚动作（对应 account-pool.applyNote 的 kind）。 */
  note: string;
  /** 是否应透传原文（不轮转）。 */
  passthrough: boolean;
  /** 是否应继续轮转换号。 */
  rotate: boolean;
}

interface UpErr {
  code?: string | number;
  message?: string;
  type?: string;
  errcode?: string | number;
}

/**
 * CONTENT_BLOCKED_MARKERS 内容策略拦截文案（对齐 Go upstream.contentBlockedMarkers）。
 * 判在通用 4xx 兜底之前——落 ErrClient 的代价是「换号不罚」，而内容拦截换任何
 * 账号都会撞同一审核，轮转纯属浪费。
 */
const CONTENT_BLOCKED_MARKERS = ["blocked by security policy", "unapproved channel", "illegal api invocation"];

function parse(body: string): UpErr {
  try {
    return JSON.parse(body) as UpErr;
  } catch {
    return {};
  }
}

export function classify(status: number, bodyText: string): Classified {
  const e = parse(bodyText);
  const code = String(e.code ?? e.errcode ?? "");
  const msg = (e.message ?? bodyText ?? "").slice(0, 500);
  const has = (s: string) => (bodyText + " " + msg).includes(s);
  // 小写副本：文案 marker 一律按小写比对（对齐 Go 的 lower 变量），
  // 否则上游返回 "Blocked by security policy" 这类大写形态会漏判。
  const low = (bodyText + " " + msg).toLowerCase();
  const hasLow = (s: string) => low.includes(s);

  // 0. 11102「该后端无此模型」：语义最具体，最先判（只看 400/404；
  //     429 带 11102 属限流语义，落到第 2 层）。
  if ((status === 400 || status === 404) && isModelBlocked(bodyText)) {
    return err("ErrModelBlocked", 400, "model_blocked", msg, "model_blocked", false, true, "model_blocked");
  }
  // 1. 硬积分耗尽 -> 冷却到次日 4 点
  if (status === 402 || code === "upstream_credits_exhausted" || code === "14018") {
    return err("ErrHardCredit", 402, "upstream_credits_exhausted", msg, "hard_credit", false, true, "hard_credit");
  }
  // 2. 软限流（6004 模型级走模型豁免）
  if (status === 429 || code === "rate_limit_exceeded" || code === "6004") {
    return err("ErrSoftRate", 429, "rate_limit_exceeded", msg, "soft_rate", false, true, "soft_rate");
  }
  // 3. 会话失效 12153 -> 禁用
  if (code === "12153" || has("12153") || (status === 401 && has("session"))) {
    return err("ErrSessionDead", 401, "session_dead", msg, "session_dead", true, false, "session_dead");
  }
  // 4. WAF 拦截（403 无业务信封）-> 账号软冷却 + 抖动，IP 级 fail-fast
  if (status === 403 && !e.code) {
    return err("ErrWafBlock", 403, "waf_blocked", msg, "waf_block", false, false, "waf_block");
  }
  // 5. 404 未找到 -> 短冷却
  if (status === 404) {
    return err("ErrNotFound", 404, "not_found", msg, "not_found", false, true, "not_found");
  }
  // 6. 5xx 服务端 -> 熔断计数
  if (status >= 500) {
    return err("ErrServer", 503, "upstream_error", msg, "server", false, true, "server");
  }
  // 7. 内容被拦截 -> 不罚号，降级重试
  //    marker 三条与 Go upstream.contentBlockedMarkers 逐字一致。上游**不**返回
  //    code="content_blocked"，只回审核文案；早前这里按 code 判等于永不命中，
  //    降级重试路径（prompt.Degraded）形同虚设。保留 code 形态兼容自定义网关。
  if (code === "content_blocked" || CONTENT_BLOCKED_MARKERS.some(hasLow)) {
    return err("ErrContentBlocked", 400, "content_blocked", msg, "none", false, true, "content_blocked");
  }
  // 8. 参数错误 11101 -> 不罚号，仍轮转
  if (code === "11101" || has("11101")) {
    return err("ErrBadParams", 400, "bad_params", msg, "none", false, true, "bad_params");
  }
  // 9. 提示词过长 11115 -> 不罚号，不轮转，透传
  if (code === "11115" || has("11115")) {
    return err("ErrPromptTooLong", 400, "prompt_too_long", msg, "none", true, false, "prompt_too_long");
  }
  // 10. 图片非法 11135 -> 不罚号，不轮转
  if (code === "11135" || has("11135")) {
    return err("ErrImageInvalid", 400, "image_invalid", msg, "none", true, false, "image_invalid");
  }
  // 11. 模型被封 11102（非 400/404 形态的兜底）-> (账号,模型) 负缓存
  if (code === "11102" || has("11102")) {
    return err("ErrModelBlocked", 400, "model_blocked", msg, "model_blocked", false, true, "model_blocked");
  }
  // 12. 账号故障 11140/14017
  if (code === "11140" || has("11140")) {
    return err("ErrAccountFault", 403, "account_fault", msg, "account_fault_11140", true, false, "account_fault");
  }
  if (code === "14017" || has("14017")) {
    return err("ErrAccountFault", 403, "account_fault", msg, "account_fault", false, true, "account_fault");
  }
  // 13. 客户端错误 -> 只换号不罚，并喂连败计数
  if (status >= 400) {
    return err("ErrClient", 503, "upstream_error", msg, "failures", false, true, "client");
  }
  return err("ErrClient", 503, "upstream_error", msg, "failures", false, true, "client");
}

/** isModelBlocked body 是否是「该后端无此模型」(11102) 的确定性答复。 */
export function isModelBlocked(body: string): boolean {
  if (!body) return false;
  const low = body.toLowerCase();
  if (!body.includes("11102") && !low.includes("service info not found")) return false;
  let root: any;
  try {
    root = JSON.parse(body);
  } catch {
    return false;
  }
  const nodes: any[] = [root];
  if (root?.error && typeof root.error === "object") nodes.push(root.error);
  let code = "";
  let msg = "";
  for (const node of nodes) {
    for (const k of ["code", "errCode", "error_code"]) {
      const v = node?.[k];
      if (v != null && code === "") code = String(v).trim();
    }
    for (const k of ["msg", "message"]) {
      const v = node?.[k];
      if (typeof v === "string" && v !== "" && msg === "") msg = v.trim();
    }
  }
  if (code === "11102") return true;
  return msg.toLowerCase().includes("service info not found");
}

function err(
  kind: string,
  status: number,
  code: string,
  message: string,
  note: string,
  passthrough: boolean,
  rotate: boolean,
  kindName: string,
): Classified {
  return { kind, kindName, status, code, message, note, passthrough, rotate, hint: "gateway classified " + kind };
}
