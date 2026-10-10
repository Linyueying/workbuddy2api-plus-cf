import type { Env } from "../../worker-configuration.d.ts";
import { insertRequestLog } from "./d1";

// 系统日志（channel="sys"）：网关自身的运维事件。
//
// ---------------------------------------------------------------------------
// 为什么需要这个模块
//
// 面板日志视图有 全部/任务/对话/系统 四个频道，分别对应 request_logs.channel 的
// task/chat/sys。但此前只有 proxy.ts 写过日志（硬编码 chat），后又补了 task——
// **sys 从未被写入过**。「系统」频道因此恒空，而这恰恰是最该有东西的一个：
// 它记录的是「网关自己出了什么事」，出故障时最需要它。
//
// panel.ts 里 `ch: e.channel || "sys"` 那个兜底看着像有人写 sys，其实永远不会
// 触发：建表时 `channel TEXT NOT NULL DEFAULT 'chat'`，channel 永不为空。
//
// ---------------------------------------------------------------------------
// 写入策略：只记异常与状态变更（D1 免费额度按扫描行数计费）
//
// 成功且无变化的日常事件不写——「迁移已是最新」这类每秒都可能发生，写进去只会
// 把日志和 D1 额度一起烧掉。真正值得留痕的是三类：
//   ① 迁移真的跑了 DDL（有新表/新列）或迁移失败；
//   ② 账号池状态变更（熔断/解冻/降权/凭证失效）；
//   ③ 定时任务调度异常（作业抛错、调度器不可达）。
//
// ---------------------------------------------------------------------------
// 三个必须守住的约束
//
// 1) **绝不抛错**。日志是观测设施，挂掉不能影响被观测的东西。
//
// 2) **不能和迁移形成循环依赖**。migrate.ts 在 D1 不可用时会失败，而写 sys 日志
//    也要用 D1——迁移失败那一刻 D1 很可能正不可用。所以这里的写失败必须静默吞掉，
//    并且**不能在 migrate 内部 await**（否则 D1 慢会拖长冷启动）。
//
// 3) **不 import migrate**。本模块只依赖 d1.ts，保持依赖方向单一（migrate → syslog
//    而不是互相 import）。

/** SysSeverity 语义级别，映射到 request_logs.outcome。 */
export type SysSeverity = "info" | "warn" | "error";

/**
 * logSystem 写一条系统日志。**永不抛错、永不阻塞调用方**。
 *
 * 返回的 promise 可以直接 await（测试里用），也可以 fire-and-forget——
 * 生产路径上不 await，避免 D1 抖动拖慢真正的工作。
 */
export function logSystem(
  env: Env,
  severity: SysSeverity,
  scope: string,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const detail = extra && Object.keys(extra).length
    ? `${message} ${safeJson(extra)}`
    : message;
  return insertRequestLog(env, {
    ts: Date.now(),
    channel: "sys",
    uid: undefined,
    model: undefined,
    realm: undefined,
    // info/warn 都算 ok（不是失败），只有 error 才是 error——日志行的着色据此变化。
    outcome: severity === "error" ? "error" : "ok",
    // 系统事件没有 HTTP 语义。info=200 / warn=0 都让前端按文本关键词着色，
    // error 走 status=0 同时 outcome=error，两条路都能标红。
    status: severity === "info" ? 200 : 0,
    ms: 0,
    msg: `[${scope}] ${detail}`.slice(0, 400),
  }).then(() => undefined).catch((e: any) => {
    // 静默吞掉，但留一行 console 痕迹：连 console 都没有的话，
    // 「系统频道为什么还是空的」这个问题会再次变得无从下手。
    console.error(`[syslog] 系统日志写入失败（已忽略）: ${String(e?.message ?? e)}`);
  });
}

/** safeJson 序列化附加信息，失败退化为 String()（循环引用等）。 */
function safeJson(o: Record<string, unknown>): string {
  try {
    return JSON.stringify(o);
  } catch {
    return String(o);
  }
}

// ---------------------------------------------------------------------------
// 各调用点的语义化包装。集中在模块内，避免每个调用点自己拼 scope 字符串。
// ---------------------------------------------------------------------------

/** 迁移真跑了 DDL（有新表/新列）。无变化时**不要**调——那是最吵的一类噪音。 */
export function logMigrated(env: Env, created: string[], addedCols: string[]): Promise<void> {
  const parts: string[] = [];
  if (created.length) parts.push(`建表 ${created.join(",")}`);
  if (addedCols.length) parts.push(`加列 ${addedCols.join(",")}`);
  return logSystem(env, "info", "migrate", `schema 已更新：${parts.join("；")}`, {
    version: SCHEMA_HINT,
  });
}

/** 迁移失败。这是最该被看到的一条系统日志。 */
export function logMigrateFailed(env: Env, error: string): Promise<void> {
  return logSystem(env, "error", "migrate", `自动迁移失败：${error}`);
}

/** 账号池状态变更（熔断/解冻/降权/凭证失效）。 */
export function logAccountEvent(
  env: Env,
  severity: SysSeverity,
  uid: string,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  return logSystem(env, severity, "account", `uid=${shortUid(uid)} ${message}`, extra);
}

/** 调度器异常：作业抛错、整点调度不可达。 */
export function logSchedulerEvent(
  env: Env,
  severity: SysSeverity,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  return logSystem(env, severity, "scheduler", message, extra);
}

/** shortUid 日志里只留前 8 位（与 requestLogLine 的 uid 口径一致）。 */
function shortUid(uid: string): string {
  return String(uid || "").slice(0, 8);
}

/** 与 migrate.ts 的 SCHEMA_TARGET 对应，仅供日志展示。不 import 以免循环依赖。 */
const SCHEMA_HINT = 6;