import type { Env } from "../../worker-configuration.d.ts";
import type { Auth } from "../types";
import { billingJSON, UpstreamError } from "./upstream";

// global 专属「一次性 trial 加油包」领取（替代 internal/upstream/trial.go + cmd/trial）。
//
// 端点 POST {billingBase}/billing/ide/trial，仅 global 账号可用（CN 无此端点）。
// 这是 global 唯一天然的积分增益动作——global 侧无签到、无任务中心。

/** trialPath global trial 加油包端点（Maquer/workbuddy-checkin 实测）。 */
export const TRIAL_PATH = "/billing/ide/trial";

/**
 * trialAlreadyMarkers 幂等码 14051「已领取过」的两种指纹：
 * - "code=14051"：HTTP 200 + 业务 code 非 0 时 doJSON 拼出的 Msg 格式；
 * - `"code":14051`：HTTP ≥400 时 doJSON 把原始 JSON body 直接塞进 Msg。
 *
 * 两种都要认：改上游错误包装就会让"已领过"被当成真失败，日报里平白多一片 FAIL。
 */
export const TRIAL_ALREADY_MARKERS = ["code=14051", `"code":14051`];

/** trialAlreadyErr 判定错误 Msg 是否携带幂等码 14051（已领取过）。 */
export function trialAlreadyErr(msg: string): boolean {
  return TRIAL_ALREADY_MARKERS.some((m) => msg.includes(m));
}

/** TrialStatus 单账号 trial 领取结果状态（对齐 Go trialStatus）。 */
export type TrialStatus = "OK" | "ALREADY" | "N/A" | "FAIL";

export interface TrialOutcome {
  uid: string;
  nickname: string;
  realm: string;
  status: TrialStatus;
  detail: string;
  /** CN 账号不发任何请求（trial 是 global 专属端点）。 */
  skipped?: boolean;
}

/**
 * claimTrial 领取一次性 trial 加油包。
 * 仅 global 账号可调（CN 无此端点）——客户端侧防线，非 global 直接报错，
 * 工具层（runTrial）还会再按isGlobal 拦一道不发请求。
 * 返回 claimed：true=成功新领；false=已领过（幂等，不算失败）。
 */
export async function claimTrial(env: Env, auth: Auth): Promise<{ claimed: boolean; error?: string }> {
  if (!auth || auth.realm !== "global") {
    return { claimed: false, error: "claim trial: only global accounts" };
  }
  try {
    await billingJSON(auth, env, "POST", TRIAL_PATH);
    return { claimed: true };
  } catch (e: any) {
    // 幂等码 14051：已领过，算成功（Go 侧返回 claimed=false, err=nil）。
    if (e instanceof UpstreamError && trialAlreadyErr(e.message)) return { claimed: false };
    return { claimed: false, error: String(e?.message ?? e) };
  }
}

/**
 * classifyTrial 归一化 claimTrial 结果（对齐 Go classifyTrial，纯函数）。
 * error → FAIL；claimed → OK；否则（幂等码已领）→ ALREADY。
 */
export function classifyTrial(
  claimed: boolean,
  error?: string,
): { status: TrialStatus; detail: string } {
  if (error) return { status: "FAIL", detail: error };
  if (claimed) return { status: "OK", detail: "trial granted" };
  return { status: "ALREADY", detail: "already claimed (idempotent)" };
}

/**
 * claimTrialFor 领取单账号 trial 并归一化状态。
 * CN 账号直接短路为 N/A（连 realm 判定都不发请求，对齐 cmd/trial）。
 */
export async function claimTrialFor(env: Env, auth: Auth): Promise<TrialOutcome> {
  const base: TrialOutcome = {
    uid: auth?.uid ?? "",
    nickname: auth?.nickname ?? "",
    realm: auth?.realm ?? "cn",
    status: "FAIL",
    detail: "",
  };
  if (auth?.realm !== "global") {
    return { ...base, status: "N/A", detail: "CN account not applicable", skipped: true };
  }
  const r = await claimTrial(env, auth);
  const c = classifyTrial(r.claimed, r.error);
  return { ...base, status: c.status, detail: c.detail };
}

/** TrialSummary 批量领取的聚合计数（对齐 cmd/trial 结尾的 total/ok/already/na/fail）。 */
export interface TrialSummary {
  total: number;
  ok: number;
  already: number;
  na: number;
  fail: number;
}

/** summarizeTrial 按状态聚合计数。 */
export function summarizeTrial(rows: TrialOutcome[]): TrialSummary {
  const s: TrialSummary = { total: rows.length, ok: 0, already: 0, na: 0, fail: 0 };
  for (const r of rows) {
    if (r.status === "OK") s.ok++;
    else if (r.status === "ALREADY") s.already++;
    else if (r.status === "N/A") s.na++;
    else s.fail++;
  }
  return s;
}