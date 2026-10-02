import type { Env } from "../../worker-configuration.d.ts";
import { getConfig } from "../../src/config";
import { runScheduledJobs } from "../../src/alarms";
import { queryRequestLogs } from "../../src/storage/d1";
import { archiveLogs } from "../../src/storage/r2";

// 定时作业 Worker（Cron Triggers）。
//
// 为什么必须独立：**Pages 项目没有 Cron Triggers**。原方案只能二选一——
// 外部 cron 服务（cron-job.org 之类）每整点来 POST，或靠 PoolDO 的 alarm
// 自调度（DO 被回收后还得手动重新 arm，脆弱）。Workers 原生支持 cron，
// 由平台保证触发，这两条妥协都可以不要了。
//
// 本 Worker 只负责"按时触发"，业务逻辑仍在主项目的 tasks.ts，
// 与面板 *_all 端点、DO alarm 共用同一套（runScheduledJobs）。

/** 归档多少天前的请求日志（留近期数据在 D1 供面板查询）。 */
const ARCHIVE_OLDER_THAN_DAYS = 7;
/** 单次归档上限。受 queryRequestLogs 的 LIMIT 上限（1000）约束，别调更大。 */
const ARCHIVE_BATCH = 1000;

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
      "workbuddy2api-scheduler: cron-only worker. Scheduled jobs run via Cron Triggers.",
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

/** KV 水位键：已归档到的最老时间戳（ms）。 */
const WATERMARK_KEY = "log_archive_watermark";

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
