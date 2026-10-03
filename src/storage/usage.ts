import type { Env } from "../../worker-configuration.d.ts";
import { oldestRequestLogTs, queryUsageWindow } from "./d1";
import { buildUsageSnapshot, type UsageSnapshot } from "../services/usage-agg";

// 用量读取（替代 internal/usage/*）。
//
// 数据源是 request_logs —— 唯一真实在被写的请求表，带上 0003 迁移加的 token/credit
// 列就够了。0001 那张 usage 表不再参与：它按小时预聚合且没有 uid，面板要的逐账号
// 维度出不来；而它的写入函数 recordUsage 从未有人调用，建成至今一直是空的。

export interface UsageOptions {
  from: number;
  to: number;
  /** nicknames uid → 昵称（明细表润色用；不给就显示 uid 前 8 位，前端自兜底）。 */
  nicknames?: Record<string, string>;
}

/** getUsage 读一个时间窗内的用量，聚合成面板「用量」页的视图模型。 */
export async function getUsage(env: Env, opts: UsageOptions): Promise<UsageSnapshot> {
  // 窗口查询与「数据自何时起」互不相干，并行省一次往返。
  const [rows, since] = await Promise.all([
    queryUsageWindow(env, opts.from, opts.to),
    oldestRequestLogTs(env).catch(() => 0),
  ]);
  return buildUsageSnapshot(rows, { ...opts, since });
}

export { buildUsageSnapshot };
export type { UsageSnapshot };
