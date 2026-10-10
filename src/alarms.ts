import type { Env } from "../worker-configuration.d.ts";
import type { Config } from "./config";
import type { PoolDO } from "./durable/account-pool";
import {
  runCheckin, runBalanceLogged, runTravel, runActivityLogged, runKeepaliveLogged, runNightOwl, runGrowth,
} from "./services/tasks";

// DO alarm 调度（替代 internal/scheduler.Run）。单实例顺序执行，复用与面板 *_all 同一套逻辑。
// 推荐：外部 cron 每整点 POST /panel/api/checkin_all 等；此处为可选项（部署后 POST /panel/api/scheduler/arm 启动）。

function hourChina(): number {
  return new Date(Date.now() + 8 * 3600_000).getUTCHours();
}
function nextHour(): number {
  const d = new Date(Date.now() + 8 * 3600_000);
  d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
  return d.getTime() - 8 * 3600_000;
}

/**
 * 按当前北京时间判断该跑哪些整点作业。返回实际执行的任务名。
 *
 * 刻意与"触发方式"解耦：DO alarm 自调度和 Workers Cron Triggers 共用这一段，
 * 两边只是谁来调的问题，判定逻辑必须只有一份，否则会出现
 * "alarm 和 cron 跑出不同结果"这种极难排查的偏差。
 *
 * 每个作业独立 try/catch：单个作业失败不得影响其余（比如签到接口挂了，
 * 保活仍应继续）。
 */
export async function runScheduledJobs(env: Env, cfg: Config): Promise<string[]> {
  const h = hourChina();
  const s = cfg.schedule;
  const ran: string[] = [];

  const jobs: [string, boolean, () => Promise<unknown>][] = [
    ["checkin", s.checkin_enabled && s.checkin_hours.includes(h), () => runCheckin(env)],
    ["travel", s.travel_enabled && s.travel_hours.includes(h), () => runTravel(env)],
    // 活跃/保活走 *Logged 版本：成功时无信息量不落日志，只在失败时留下记录。
    ["activity", s.activity_enabled && s.activity_hours.includes(h), () => runActivityLogged(env)],
    ["keepalive", s.keepalive_enabled && s.keepalive_hours.includes(h), () => runKeepaliveLogged(env)],
    ["nightowl", s.blackcat_enabled && s.blackcat_hours.includes(h), () => runNightOwl(env)],
    ["growth", s.growth_enabled && s.growth_hours.includes(h), () => runGrowth(env)],
  ];
  for (const [name, due, fn] of jobs) {
    if (!due) continue;
    try {
      await fn();
      ran.push(name);
    } catch (e) {
      console.error(`[alarm] ${name} 失败:`, String(e));
    }
  }

  // 余额刷新与整点解耦（配置单独开关）
  if (s.balance_refresh_enabled) {
    try {
      await runBalanceLogged(env);
      ran.push("balance");
    } catch (e) {
      console.error("[alarm] balance 失败:", String(e));
    }
  }
  return ran;
}

/** 由 PoolDO.alarm() 或 /internal/alarm 调用（DO 自调度路径）。 */
export async function onAlarm(env: Env, _pool: PoolDO, cfg: Config): Promise<void> {
  await runScheduledJobs(env, cfg);
  // 自调度到下一个整点。Cron Triggers 路径不需要这步——平台会按时触发。
  try {
    await _pool.scheduleNextAlarm();
  } catch {
    /* DO 回收后会由下次请求重新 arm */
  }
}

/** 由 /internal/scheduler/:task 调用。 */
export async function runScheduledTask(env: Env, _pool: PoolDO, task: string, _body: any): Promise<any> {
  switch (task) {
    case "checkin":
      return { task, results: await runCheckin(env) };
    case "travel":
      return { task, results: await runTravel(env) };
    case "activity":
      return { task, results: await runActivityLogged(env) };
    case "keepalive":
      return { task, results: await runKeepaliveLogged(env) };
    case "nightowl":
      return { task, results: await runNightOwl(env) };
    case "growth":
      return { task, results: await runGrowth(env) };
    case "balance":
      return { task, results: await runBalanceLogged(env) };
    default:
      return { task, error: "unknown" };
  }
}
