import type { Env } from "../../worker-configuration.d.ts";
import type { Auth } from "../types";
import {
  billingMeterPaths,
  packageRemainUsed,
  postBillingResource,
  resourceAccounts,
  resourceBody,
  resourceTotalDosage,
} from "./upstream";

// WorkBuddy 积分日报聚合（替代 cmd/credit + internal/upstream 的余额聚合）。
//
// 与面板 /panel/api/packages 的区别：这里出的是**全池汇总 + used/packages 计数**，
// 服务的是「余额还够不够 / 哪个号快见底」这类判断，而不是逐包构成明细。
// cmd/credit 的 TotalDosage 下限口径在此保留（见 applyDosageFloor）。

/** 单账号余额（对齐 Go accountResult）。remain/used/size 为 null 表示查询失败。 */
export interface CreditAccount {
  uid: string;
  nickname: string;
  realm: string;
  remain: number | null;
  used: number | null;
  size: number | null;
  packages: number;
  ok: boolean;
  error?: string;
}

export interface CreditReport {
  service: "workbuddy";
  ts: number;
  total: {
    remain: number;
    used: number;
    size: number;
    accounts: number;
    ok: number;
    failed: number;
  };
  accounts: CreditAccount[];
}

/** RETRY_DELAY_MS 瞬时错误重试基准间隔（Go billingRetryDelay = 2s）。 */
const RETRY_DELAY_MS = 2000;
const RETRY_EXTRA = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * isTransient 判定「瞬时错误」：上游 5xx，或网络层失败（无 HTTP 状态）。
 * 业务错误（code!=0 的已签到/参数错、4xx、限流）不重试——重试只会原样再失败一次。
 * 对齐 Go isTransientBillingErr（该实现判 ue.Kind == ErrServer，非 *Error 即传输失败）。
 *
 * 「无状态码的传输失败」在 Workers 下没有 *Error 可依赖，只能靠指纹：真传输失败
 * 的msg 不含 `code=`（那是业务信封）/ `http NNN`（那是 HTTP 层），且必须排除
 * 永久性本地失败（refresh_token_failed、路径穿越拒绝等）——那些重试 100 次也一样。
 */
export function isTransient(msg: string, status: number): boolean {
  if (status >= 500) return true;
  // 永久性失败白名单：命中即不重试。
  if (/refresh_token_failed/.test(msg)) return false;
  if (/parse failed/.test(msg)) return false;
  return !/\bcode=\d/.test(msg) && !/^http \d{3}/.test(msg) && !/^http_error/.test(msg);
}

/**
 * withBillingRetry 对签到/余额这类低频维护调用做瞬时错误有界重试：
 * 最多补打 2 次（间隔 2s、4s），首次成功或非瞬时错误立即返回。
 * chat 热路径不用本策略——它有自己的换号轮转语义，重试会放大在途请求。
 */
export async function withBillingRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  try {
    return await fn();
  } catch (e: any) {
    last = e;
    const msg = String(e?.message ?? e);
    const status = Number(e?.status ?? 0);
    if (!isTransient(msg, status)) throw e;
  }
  for (let i = 1; i <= RETRY_EXTRA; i++) {
    await sleep(i * RETRY_DELAY_MS);
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const msg = String(e?.message ?? e);
      const status = Number(e?.status ?? 0);
      if (!isTransient(msg, status)) throw e;
    }
  }
  throw last;
}

/**
 * applyDosageFloor 用上游 TotalDosage 兜底校正 size/used。
 *
 * 上游逐包求和有时小于自己声明的总消耗量（脏数据/分页口径差）。Go 侧
 * `cmd/credit` 的口径是 TotalDosage 作 size 下限、size 抬升后再用
 * size-remain 反推 used 下限。不做这步校正会让"总量已用"被低估。
 */
export function applyDosageFloor(
  remain: number,
  used: number,
  size: number,
  dosage: number,
): { remain: number; used: number; size: number } {
  let u = used;
  let s = size;
  if (s > 0) {
    const derived = s - remain;
    if (derived > u) u = derived;
  }
  if (dosage > s) {
    s = dosage;
    const derived = s - remain;
    if (derived > u) u = derived;
  }
  return { remain, used: u, size: s };
}

/**
 * fetchUserResource 查单账号余额聚合（对齐 Go cmd/credit 的 fetchUserResource）。
 * 返回 remain/used/size/packs；失败抛错（由调用方归类为该账号 error）。
 */
export async function fetchUserResource(
  env: Env,
  auth: Auth,
): Promise<{ remain: number; used: number; size: number; packs: number }> {
  const body = resourceBody(Date.now());
  const paths = billingMeterPaths(auth.realm);

  const once = async () => {
    // 与 getCreditsDetailed 共用同一条探测链路：非 2xx 抛带 status/detail 的错误
    const env_ = await postBillingResource(env, auth, paths, body, "credit");
    const accounts = resourceAccounts(env_);
    let remain = 0;
    let used = 0;
    let size = 0;
    for (const a of accounts) {
      const r = packageRemainUsed(a);
      remain += r.remain;
      used += r.used;
      size += r.size;
    }
    const fixed = applyDosageFloor(remain, used, size, resourceTotalDosage(env_));
    return { ...fixed, packs: accounts.length };
  };

  return withBillingRetry(once);
}

/**
 * fetchUserResourceSafe 单账号余额查询，永不抛错（失败写进 error 字段）。
 * 日报要的是「全池账目」，一个号查不到不能拖垮整份报表。
 */
export async function fetchUserResourceSafe(env: Env, auth: Auth): Promise<CreditAccount> {
  const row: CreditAccount = {
    uid: auth?.uid ?? "",
    nickname: auth?.nickname ?? "",
    realm: auth?.realm ?? "cn",
    remain: null,
    used: null,
    size: null,
    packages: 0,
    ok: false,
  };
  if (!auth?.accessToken) return { ...row, error: "no accessToken" };
  try {
    const r = await fetchUserResource(env, auth);
    return {
      ...row,
      remain: r.remain,
      used: r.used,
      size: r.size,
      packages: r.packs,
      ok: true,
    };
  } catch (e: any) {
    // 带上上游响应片段：日报里要能一眼看出是 401（token/请求头问题）
    // 还是 5xx（上游抽风），光一个 "http 401" 有时不够定位。
    return { ...row, error: String(e?.message ?? e) + (e?.detail ? ` | ${e.detail}` : "") };
  }
}

/**
 * aggregateCredits 把逐账号结果汇总成日报（对齐 Go main 的 total 段）。
 * 只累加 ok 的账号 —— 失败账号的 null 不能当 0 计入，否则总数会静默变小。
 */
export function aggregateCredits(accounts: CreditAccount[]): CreditReport["total"] {
  let remain = 0;
  let used = 0;
  let size = 0;
  let ok = 0;
  for (const a of accounts) {
    if (!a.ok) continue;
    ok++;
    remain += a.remain ?? 0;
    used += a.used ?? 0;
    size += a.size ?? 0;
  }
  return { remain, used, size, accounts: accounts.length, ok, failed: accounts.length - ok };
}

/** summarizeReport 打包完整日报（含 ts 与 service 标识，对齐 Go 输出结构）。 */
export function summarizeReport(accounts: CreditAccount[], now = Date.now()): CreditReport {
  return {
    service: "workbuddy",
    ts: Math.floor(now / 1000),
    total: aggregateCredits(accounts),
    accounts,
  };
}

/**
 * prettyReport 人类可读日报：四行汇总 + 失败账号清单（对齐 Go printPretty）。
 * 返回行数组而非直接打印 —— 渲染归调用方（面板给 HTML / CLI 给 stdout）。
 */
export function prettyReport(report: CreditReport): string[] {
  const withBalance = report.accounts.filter((a) => a.ok && (a.remain ?? 0) > 0).length;
  const pct = report.total.size > 0 ? Math.floor((report.total.remain * 100) / report.total.size) : 0;
  const lines = [
    "📊 WorkBuddy 积分日报",
    `账号: ${withBalance}/${report.total.accounts}`,
    `总计: ${report.total.remain}/${report.total.size}`,
    `剩余: ${pct}%`,
  ];
  for (const a of report.accounts) {
    if (a.ok) continue;
    const name = a.nickname || (a.uid.length >= 8 ? a.uid.slice(0, 8) : a.uid);
    lines.push(`⚠️ ${name} ${a.error ?? "unknown"}`);
  }
  return lines;
}