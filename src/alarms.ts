import type { Env } from "../worker-configuration.d.ts";
import type { Config } from "./config";
import type { PoolDO } from "./durable/account-pool";
import { runCheckin, runBalance, runTravel, runActivity, runKeepalive, runNightOwl, runGrowth } from "./services/tasks";

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

/** 由 PoolDO.alarm() 或 /internal/alarm 调用。 */
export async function onAlarm(env: Env, _pool: PoolDO, cfg: Config): Promise<void> {
  const h = hourChina();
  const s = cfg.schedule;
  try {
    if (s.checkin_enabled && s.checkin_hours.includes(h)) await runCheckin(env);
    if (s.travel_enabled && s.travel_hours.includes(h)) await runTravel(env);
    if (s.activity_enabled && s.activity_hours.includes(h)) await runActivity(env);
    if (s.keepalive_enabled && s.keepalive_hours.includes(h)) await runKeepalive(env);
    if (s.blackcat_enabled && s.blackcat_hours.includes(h)) await runNightOwl(env);
    if (s.growth_enabled && s.growth_hours.includes(h)) await runGrowth(env);
  } catch {
    /* 单任务失败不影响其他 */
  }
  // 余额按分钟后台刷新（与整点解耦）
  if (s.balance_refresh_enabled) {
    try {
      await runBalance(env);
    } catch { /* noop */ }
  }
  // 自调度到下一个整点
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
      return { task, results: await runActivity(env) };
    case "keepalive":
      return { task, results: await runKeepalive(env) };
    case "nightowl":
      return { task, results: await runNightOwl(env) };
    case "growth":
      return { task, results: await runGrowth(env) };
    case "balance":
      return { task, results: await runBalance(env) };
    default:
      return { task, error: "unknown" };
  }
}
