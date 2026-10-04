// 独立 Worker，承担两件事：
//
//   1. 承载账号池 Durable Object（PoolDO）
//   2. 跑定时作业（Cron Triggers）
//
// ---------------------------------------------------------------------------
// 为什么这两件事都必须放在 Pages 之外
// ---------------------------------------------------------------------------
// 1) PoolDO：Pages 项目的 wrangler.toml **不支持 [[migrations]]**（云端构建直接
//    报 "does not support migrations"），而 Durable Object 类没有 migrations
//    声明就不会被注册——实测删掉该字段后本地 DO 调用即挂起。所以 Pages 无法
//    自带 DO，PoolDO 必须有独立宿主。
// 2) Cron：Pages 项目**没有 Cron Triggers**。原方案只能二选一——外部 cron 服务
//    （cron-job.org 之类）每整点来 POST，或靠 PoolDO 的 alarm 自调度（DO 被
//    回收后还得手动重新 arm，脆弱）。Workers 原生支持 cron，平台保证触发。
//
// ---------------------------------------------------------------------------
// 为什么这两件事又合在同一个 Worker 里
// ---------------------------------------------------------------------------
// 一个 Worker 完全可以同时导出 DO 类、scheduled() 和 fetch()，也可以同时声明
// [[migrations]] 与 [triggers] crons——没有任何冲突。合并的好处很实在：
//   - 少一个部署单元，少配一遍构建变量；
//   - 定时作业访问 PoolDO 从「跨 Worker 远程调用」变成本地绑定，少一跳；
//   - PoolDO 与调度逻辑同生命周期，不存在「DO 在、调度器没部署上」的错位。
//
// 注意：POOL 绑定在这里指向**自己**（不写 script_name），Pages 侧才需要
// script_name = "workbuddy2api-engine" 做远程引用。

import type { Env } from "../../worker-configuration.d.ts";
import { getConfig } from "../../src/config";
import { runScheduledJobs } from "../../src/alarms";
import { queryRequestLogs, deleteRequestLogsBefore, deleteRequestLogsByIds } from "../../src/storage/d1";
import { archiveLogs } from "../../src/storage/r2";
import { PoolDO } from "../../src/durable/account-pool";
import type { RequestLogEntry } from "../../src/types";

export { PoolDO };

/** 保留天数回落值（配置缺失时用，与 config.ts 默认值一致）。 */
const ARCHIVE_OLDER_THAN_DAYS = 7;
/** 单轮归档上限。受 queryRequestLogs 的 LIMIT 上限（1000）约束，别调更大。 */
const ARCHIVE_BATCH = 1000;
/** 单次 cron 最多跑几轮（crons 每天一次，积压过多时次日继续搬）。 */
const ARCHIVE_MAX_ROUNDS = 5;

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // 两条 cron 各司其职，用 event.cron 区分（见 wrangler.toml 的 triggers.crons）
    if (event.cron === "0 * * * *") {
      ctx.waitUntil(runHourlyJobs(env));
      return;
    }
    if (event.cron === "30 17 * * *") {
      // UTC 17:30 = 北京时间次日 01:30，低峰
      ctx.waitUntil(archiveRequestLogs(env));
      return;
    }
    console.warn(`[scheduler] 未知 cron: ${event.cron}`);
  },

  async fetch(): Promise<Response> {
    return new Response(
      "workbuddy2api-engine: Durable Object host + cron scheduler. " +
        "No HTTP API here; reach the pool via the POOL binding from the Pages project.",
      { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};

async function runHourlyJobs(env: Env): Promise<void> {
  try {
    const cfg = await getConfig(env);
    const ran = await runScheduledJobs(env, cfg);
    if (ran.length) console.log(`[scheduler] 已执行: ${ran.join(", ")}`);
  } catch (e) {
    // cron 里抛出也不会重试，记日志足够；下一整点会再来
    console.error("[scheduler] 整点作业失败:", String(e));
  }
}

/**
 * 把 N 天前的请求日志从 D1 搬走（有 R2 就搬到 R2，没有就直接删）。
 *
 * 存在理由：D1 日志只增不减，长期会顶到容量上限。
 *
 * ── 为什么废弃水位（旧实现靠 KV 记「已归档到的最老 ts」）───────────────
 * 旧实现归档后**不删 D1**，靠水位（upper = min(wm, cutoff)）向更早推进。
 * 一旦某个 cutoff 之前的日志全部归档完，水位就停在那个最老值不再前进，
 * 于是每轮都查到同一批、反复 append 进同一个 R2 分片——文件无限重复累积；
 * 更要命的是 D1 里的数据从来没被删过。
 *
 * 新实现让「删除」本身充当水位：已归档的行从 D1 消失，下轮取到的必然是
 * 还没归档的。水位、重复归档、以及「绑了 R2 就永不清理」三个问题一并消失。
 */
async function archiveRequestLogs(env: Env): Promise<void> {
  const cfg = await getConfig(env).catch(() => null);
  const days = retentionDays(cfg);
  const cutoff = Date.now() - days * 86400_000;

  // 归档开关关掉 / 没绑 R2：直接删。没有冷备份是不用 R2 的必然取舍，
  // 但容量保护不能停——否则 D1 只增不减，迟早顶到配额。
  const archiveOn = !!env.WB2A_LOGS && cfg?.logging?.request_archive_enabled !== false;
  if (!archiveOn) {
    try {
      const n = await deleteRequestLogsBefore(env, cutoff);
      console.log(`[scheduler] 日志清理（保留 ${days} 天，无冷备份）：删除 ${n} 行`);
    } catch (e: any) {
      console.error(`[scheduler] 日志清理失败：${String(e?.message ?? e)}`);
    }
    return;
  }

  try {
    let archived = 0;
    let removed = 0;
    for (let round = 0; round < ARCHIVE_MAX_ROUNDS; round++) {
      const rows = await queryRequestLogs(env, { to: cutoff, limit: ARCHIVE_BATCH });
      if (!rows?.length) break;

      // 按日志自身日期分片：一批 1000 条往往跨好几天，整批塞进「最老那天」
      // 的分片会让文件名与内容日期不符，事后无法按日期定位。
      const byDay = new Map<string, RequestLogEntry[]>();
      for (const r of rows) {
        const day = new Date(Number(r.ts) || Date.now()).toISOString().slice(0, 10);
        const list = byDay.get(day);
        if (list) list.push(r);
        else byDay.set(day, [r]);
      }
      for (const [day, list] of byDay) await archiveLogs(env, list, day);

      // 只删确认已写入 R2 的行（按 id 精确删），漏删最多是下轮重搬，误删就是真丢。
      const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n) && n > 0);
      removed += await deleteRequestLogsByIds(env, ids);
      archived += rows.length;
      if (rows.length < ARCHIVE_BATCH) break; // 该 cutoff 之前的都搬完了
    }
    console.log(
      `[scheduler] 日志归档（保留 ${days} 天）：归档 ${archived} 条 → R2，D1 删除 ${removed} 行`,
    );
  } catch (e: any) {
    // 归档失败**不删**：宁可 D1 多留几天，也不能删掉没进 R2 的数据。下一轮重试。
    console.error(`[scheduler] 日志归档失败，本轮不删除：${String(e?.message ?? e)}`);
  }
}

/** retentionDays 保留天数：读配置，缺失或非法回落 7 天（与 config.ts 默认值一致）。 */
function retentionDays(cfg: { logging?: { request_retention_days?: number } } | null): number {
  const n = Number(cfg?.logging?.request_retention_days);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ARCHIVE_OLDER_THAN_DAYS;
}
