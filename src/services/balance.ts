import type { Env } from "../../worker-configuration.d.ts";
import type { Auth } from "../types";
import { fetchUserResourceSafe, type CreditAccount } from "./credit";
import { poolRPC } from "../durable/account-pool";

// 外部客户端（APP / 余额插件）消费的余额接口支撑逻辑。
//
// 与 credit.ts 的分工：
// - credit.ts 出的是**运营口径**的全池日报（remain/used/size + 失败清单），
//   服务「余额还够不够 / 哪个号快见底」，走 /panel/api/credits（admin 密钥）。
// - 本模块出的是**客户端口径**的简化余额视图，走 /v1/credits（调用密钥 / 子密钥），
//   回答「我现在还剩多少积分」，并把逐账号清单渲染成 `<名字>: <余额>` 行。
//
// 之所以单独开文件而不是塞进 credit.ts：那已是 236 行的运营聚合模块，而这里
// 面向的调用方、鉴权层级、输出形态三者都不同，混在一起会让两边都难改。

/** AccountBalance 单账号的客户端视角余额（amount=null 表示该号查询失败）。 */
export interface AccountBalance {
  /** 账号标识：优先昵称，缺失时退回 uid 前 8 位。 */
  name: string;
  uid: string;
  realm: string;
  /** 剩余积分；查询失败为 null（区别于「余额恰好为 0」）。 */
  amount: number | null;
  ok: boolean;
  error?: string;
}

/** BalanceView 返回给客户端的余额视图。 */
export interface BalanceView {
  /** 全部账号剩余量之和（只计查询成功的号）。 */
  total: number;
  /** 查询成功的账号数。 */
  ok: number;
  /** 账号总数。 */
  count: number;
  accounts: AccountBalance[];
}

/**
 * displayName 生成账号的展示名。
 *
 * 优先昵称；无昵称时用 uid 前 8 位——与 prettyReport 的取名口径保持一致，
 * 面板、日报、本接口三处对同一个号显示同一个名字，用户才能对上号。
 */
export function displayName(nickname: string, uid: string): string {
  if (nickname) return nickname;
  return uid.length >= 8 ? uid.slice(0, 8) : uid;
}

/**
 * toAccountBalance 把 credit.ts 的 CreditAccount 转成客户端视图。
 *
 * remain 为 null（查询失败）时 amount 也为 null，**不折算成 0**——否则
 * 前端无法区分「这个号没钱了」和「这个号查询失败」，会把失败静默当成空号。
 */
export function toAccountBalance(a: CreditAccount): AccountBalance {
  return {
    name: displayName(a.nickname, a.uid),
    uid: a.uid,
    realm: a.realm,
    amount: a.ok ? (a.remain ?? 0) : null,
    ok: a.ok,
    ...(a.error ? { error: a.error } : {}),
  };
}

/**
 * summarizeBalance 汇总逐账号结果为视图（total 只累加成功的号）。
 *
 * 对齐 aggregateCredits 的口径：失败账号的 null 不计入 total，
 * 否则总数会因一次上游抖动而静默变小，用户却以为余额真的掉了。
 */
export function summarizeBalance(accounts: AccountBalance[]): BalanceView {
  let total = 0;
  let ok = 0;
  for (const a of accounts) {
    if (!a.ok) continue;
    ok++;
    total += a.amount ?? 0;
  }
  return { total, ok, count: accounts.length, accounts };
}

/**
 * balanceLines 把视图渲染成 `名字: 余额` 行数组（用户要求的格式）。
 *
 * 成功账号给两位小数（积分计算本就按分计）；失败账号给 `— (原因)`，
 * 保留失败可见性——只列成功号会让「少了一个号」看起来像没查询过。
 */
export function balanceLines(view: BalanceView): string[] {
  return view.accounts.map((a) =>
    a.ok ? `${a.name}: ${(a.amount ?? 0).toFixed(2)}` : `${a.name}: — (${a.error ?? "查询失败"})`,
  );
}

/**
 * fetchAccountBalances 并发查全池账号余额（受控并发，避免一次打爆上游）。
 *
 * 为什么不复用 tasks.ts 的 forEachAccount：那个是**串行** for 循环，全池几十个号
 * 逐个查会把响应时间拉到分钟级；而余额查询是低频、只读、彼此独立的操作，
 * 适合并发。这里用 workers 并发池，数量与新增用量一致（3）。
 *
 * 单个账号失败不中断整体（fetchUserResourceSafe 永不抛错），保证接口恒定可用。
 */
export async function fetchAccountBalances(
  env: Env,
  realm?: string,
  concurrency = 3,
): Promise<AccountBalance[]> {
  const list = ((await poolRPC(env, "/internal/list").catch(() => [])) as any[]) ?? [];
  const targets = realm ? list.filter((a) => a.realm === realm) : list;

  const out: (AccountBalance | null)[] = new Array(targets.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const a = targets[i];
      const auth = (a?.auth ?? {}) as Auth;
      const row = await fetchUserResourceSafe(env, auth);
      out[i] = toAccountBalance(row);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, worker));
  return out.filter((x): x is AccountBalance => x !== null);
}
