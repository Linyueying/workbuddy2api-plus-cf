import type { Env } from "../../worker-configuration.d.ts";
import type { Auth } from "../types";
import {
  basesFor,
  buildHeaders,
  checkinMeterPaths,
  getConfigCached,
  withTimeout,
  UpstreamError,
} from "./upstream";
import { withBillingRetry } from "./credit";

// 每日签到（替代 internal/upstream/client.go 的 DailyCheckin + IsAlreadyCheckin，
// 以及 cmd/signin 的批量遍历报告）。
//
// 与 upstream.dailyCheckin 的差异：**本模块走瞬时错误有界重试**。Go 侧
// DailyCheckin 包在 retryBillingTransient 里（签到后紧接着的 user-resource
// 偶发 500 会让该账号整天漏签）；upstream.dailyCheckin 是裸调用，只被
// OAuth 新号入池那条路径用（那条路径失败不影响任何既有状态，重试意义不大）。

/** alreadyCheckinMarkers「今天已签到」关键词（实测 code=10001/14001 "今天已签到"/"今日已签到"）。 */
export const ALREADY_CHECKIN_MARKERS = ["已签到", "already"];

/**
 * isAlreadyCheckin 判定 err 是否表示"今天已签到"（上游幂等拒绝重复签到）。
 * 只认带分类的 UpstreamError：网络层/解析层错误不得当作幂等成功，否则停机
 * 补签遇到抖动会误记为 already，账号当天实际未签到却被判定正常。
 * 对齐 Go IsAlreadyCheckin。
 */
export function isAlreadyCheckin(e: unknown): boolean {
  if (!(e instanceof UpstreamError)) return false;
  const msg = e.message;
  const low = msg.toLowerCase();
  return ALREADY_CHECKIN_MARKERS.some((m) => msg.includes(m) || low.includes(m.toLowerCase()));
}

/** SigninStatus 单账号签到结果状态（对齐 cmd/signin 的 row.status）。 */
export type SigninStatus = "OK" | "ALREADY" | "FAIL" | "AUTH_INVALID";

export interface SigninOutcome {
  uid: string;
  nickname: string;
  realm: string;
  status: SigninStatus;
  detail: string;
  /** 余额（顺手查，与 cmd/signin 的 remain 列同源）。 */
  remain: number | null;
  creditsTotal: number | null;
}

/**
 * dailyCheckinRetry 执行每日签到，瞬时错误有界重试。
 *
 * 已签到（业务 code 非 0）**不**重试也不抛错——返回 already 状态即成功。
 * 返回 { done, already, message }：done=true 表示签到成功或今日已签。
 */
export async function dailyCheckinRetry(
  env: Env,
  auth: Auth,
): Promise<{ done: boolean; already: boolean; message?: string }> {
  const base = basesFor(auth.realm, env);
  const timeout = getConfigCached(env).upstream.timeout_seconds * 1000;
  const paths = checkinMeterPaths(auth.realm);

  return withBillingRetry(async () => {
    for (const p of paths) {
      const res = await withTimeout(
        new Request(base.billing + p, {
          method: "POST",
          headers: buildHeaders(auth, env, { Accept: "application/json" }),
          body: "{}",
        }),
        timeout,
      );
      if (res.status === 404 && p !== paths[paths.length - 1]) continue;
      const j: any = await res.json().catch(() => ({}));
      const code = Number(j?.code ?? 0);
      const msg = String(j?.msg ?? "");
      if (res.ok && code === 0) return { done: true, already: false, message: msg || undefined };
      // 业务 code 非 0：已签到是幂等成功，其余按失败抛（供上层分类）。
      if (code !== 0) {
        const e = new UpstreamError(code === 14001 ? "already_checkin" : "client", res.status || 200,
          `code=${code} msg=${msg}`);
        throw e;
      }
      if (!res.ok) {
        const e: any = new Error(`http ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return { done: true, already: false, message: msg || undefined };
    }
    const e = new Error("checkin unreachable");
    throw e;
  }).catch((e: any) => {
    if (isAlreadyCheckin(e)) return { done: true, already: true, message: e.message };
    throw e;
  });
}

/**
 * signinOne 单账号签到并归一化状态（永不抛错）。
 * 签到后余额已变，remain/creditsTotal 由调用方按需刷新（runCheckin 已串上）。
 */
export async function signinOne(env: Env, auth: Auth): Promise<SigninOutcome> {
  const base: SigninOutcome = {
    uid: auth?.uid ?? "",
    nickname: auth?.nickname ?? "",
    realm: auth?.realm ?? "cn",
    status: "FAIL",
    detail: "",
    remain: null,
    creditsTotal: null,
  };
  if (!auth?.accessToken) return { ...base, detail: "no accessToken" };
  try {
    const r = await dailyCheckinRetry(env, auth);
    return { ...base, status: r.already ? "ALREADY" : "OK", detail: r.already ? r.message ?? "already" : "" };
  } catch (e: any) {
    const detail = String(e?.message ?? e);
    // 会话已死（刷新令牌也救不回来）单独标记：区别于普通失败，重试无意义。
    const authInvalid = e?.kind === "session_dead" || /refresh_token_failed/.test(detail);
    return { ...base, status: authInvalid ? "AUTH_INVALID" : "FAIL", detail };
  }
}

/** SigninSummary 批量签到的聚合计数（对齐 cmd/signin 结尾的 total/ok/already/fail）。 */
export interface SigninSummary {
  total: number;
  ok: number;
  already: number;
  fail: number;
  authInvalid: number;
}

/** summarizeSignin 按状态聚合计数。 */
export function summarizeSignin(rows: SigninOutcome[]): SigninSummary {
  const s: SigninSummary = { total: rows.length, ok: 0, already: 0, fail: 0, authInvalid: 0 };
  for (const r of rows) {
    if (r.status === "OK") s.ok++;
    else if (r.status === "ALREADY") s.already++;
    else if (r.status === "AUTH_INVALID") s.authInvalid++;
    else s.fail++;
  }
  return s;
}

/**
 * renderSigninTable 渲染对齐 cmd/signin 的文本表格。
 * 渲染归此处而非 CLI：面板要 HTML、脚本要 stdout，展示层不该混进数据层。
 */
export function renderSigninTable(rows: SigninOutcome[]): string {
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
  const short = (s: string) => trunc(s.replace(/\n/g, " "), 60);
  const lines = [
    "uid                                  | nick        | status       | remain | detail",
    "-------------------------------------+-------------+--------------+--------+------------------------------",
  ];
  for (const r of rows) {
    const remain = r.remain === null ? "-" : String(r.remain);
    lines.push(
      `${pad(trunc(r.uid, 36), 36)} | ${pad(trunc(r.nickname, 11), 11)} | ${pad(r.status, 12)} | ${pad(remain, 6)} | ${short(r.detail)}`,
    );
  }
  const s = summarizeSignin(rows);
  lines.push(
    `\ntotal=${s.total} ok=${s.ok} already=${s.already} fail=${s.fail + s.authInvalid}` +
      (s.authInvalid ? ` (auth_invalid=${s.authInvalid})` : ""),
  );
  return lines.join("\n");
}

/** pad 右侧补空格到 n 列（对齐 Go fmt 的 %-Ns）。 */
function pad(s: string, n: number): string {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
}