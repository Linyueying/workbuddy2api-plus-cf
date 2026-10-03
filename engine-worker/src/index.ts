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
import { queryRequestLogs, deleteRequestLogsBefore } from "../../src/storage/d1";
import { archiveLogs } from "../../src/storage/r2";
import { PoolDO } from "../../src/durable/account-pool";

export { PoolDO };

/** 归档多少天前的请求日志（留近期数据在 D1 供面板查询）。 */
const ARCHIVE_OLDER_THAN_DAYS = 7;
/** 单次归档上限。受 queryRequestLogs 的 LIMIT 上限（1000）约束，别调更大。 */
const ARCHIVE_BATCH = 1000;
/** KV 水位键：已归档到的最老时间戳（ms）。 */
const WATERMARK_KEY = "log_archive_watermark";

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
 * 把 N 天前的请求日志从 D1 搬到 R2。
 *
 * 存在理由：D1 日志只增不减，长期会顶到容量上限；R2 便宜得多，适合放冷数据。
 * 此前 archiveLogs 写了却无任何调用点（死代码），R2 桶绑定了却从不写入。
 *
 * 为什么需要水位：queryRequestLogs 固定 `ORDER BY ts DESC LIMIT 1000`，
 * 且不删 D1 源数据——若每轮都按同一个条件查，会反复归档同一批。
 * 所以记一个水位，每轮从水位继续向更早推进。
 *
 * 刻意**不删 D1 源数据**：归档是只读副本，误删无法恢复。清理留给人工。
 */
async function archiveRequestLogs(env: Env): Promise<void> {
  // R2 是可选绑定：没桶时不归档，但**不能什么都不做**——否则 D1 的
  // request_logs 只增不减，长期顶到容量上限。改为到期直接从 D1 清理，
  // 保留天数语义不变，代价是没有冷备份（不用 R2 的必然取舍）。
  if (!env.WB2A_LOGS) {
    const cutoff = Date.now() - ARCHIVE_OLDER_THAN_DAYS * 86400_000;
    try {
      const n = await deleteRequestLogsBefore(env, cutoff);
      console.log(
        `[scheduler] 未绑定 R2：改为清理 D1 ${ARCHIVE_OLDER_THAN_DAYS} 天前日志，删除 ${n} 行`,
      );
    } catch (e: any) {
      console.log(`[scheduler] 日志清理失败：${String(e?.message ?? e)}`);
    }
    return;
  }
  try {
    const cutoff = Date.now() - ARCHIVE_OLDER_THAN_DAYS * 86400_000;
    const raw = await env.WB2A_CONFIG.get(WATERMARK_KEY).catch(() => null);
    const wm = Number(raw) || 0;
    // 水位存在时以它为准（向更早推进），否则从 cutoff 开始
    const upper = wm > 0 ? Math.min(wm, cutoff) : cutoff;

    const rows = await queryRequestLogs(env, { to: upper, limit: ARCHIVE_BATCH });
    if (!rows?.length) {
      console.log("[scheduler] 无可归档日志（水位=" + (wm || "无") + "）");
      return;
    }

    const stamps = rows.map((r) => Number(r.ts) || 0).filter((t) => t > 0);
    const oldest = Math.min(...stamps);
    const day = new Date(oldest).toISOString().slice(0, 10);

    await archiveLogs(env, rows, day);
    await env.WB2A_CONFIG.put(WATERMARK_KEY, String(oldest)).catch(() => {});
    console.log(
      `[scheduler] 已归档 ${rows.length} 条 → logs/${day}.jsonl` +
        `（最老 ${new Date(oldest).toISOString()}，新水位 ${oldest}）`,
    );
  } catch (e) {
    console.error("[scheduler] 日志归档失败:", String(e));
  }
}
