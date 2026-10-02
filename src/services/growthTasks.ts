import type { Env } from "../../worker-configuration.d.ts";
import type { Auth } from "../types";
import { basesFor, billingHeaders, doJSON, growthJSON, growthJSONMP, UpstreamError, MP_PLATFORM } from "./upstream";

// growth 域「任务」接口（替代 internal/upstream/tasks.go）：
// 列表 / 接受 / 领取奖励。默认口径与小程序口径（mp 头）双通道。
//
// 端点（chatBase，BillingHeaders）：
//   - GET  {chatBase}/v2/activity/growth/tasks              默认任务列表
//   - GET  {chatBase}/v2/activity/growth/tasks+mp头         小程序口径列表
//   - POST {chatBase}/v2/activity/growth/tasks/accept       {"task_codes":[...]}
//   - POST {webBase}/activity/growth/tasks/{code}/claim     Web 领奖（任务码在路径）
//   - POST {chatBase}/activity/growth/tasks/{code}/claim+mp 小程序领奖（400 时降级 Web）
//
// 语义：accept 是报名不产生进度；进度由服务端行为事件点亮；claim 幂等（重复领返回业务错误）。

export const TASKS_LIST_PATH = "/v2/activity/growth/tasks";
export const TASKS_ACCEPT_PATH = "/v2/activity/growth/tasks/accept";

/** Task 单个任务的对外视图（字段与上游 JSON 对齐）。 */
export interface Task {
  task_code: string;
  title?: string;
  description?: string;
  task_desc?: string;
  credit?: number;
  energy?: number;
  has_reward?: boolean;
  reward_buddy?: boolean;
  task_type?: string;
  tag?: string;
  jump_url?: string;
  locked?: boolean;
  target: number;
  current: number;
  accept_status?: string;
  status?: string;
  claimable?: boolean;
  claimed?: boolean;
}

/** ListTasks 拉取全量任务列表（默认口径，无端标记头）。 */
export function ListTasks(auth: Auth, env: Env): Promise<Task[]> {
  return growthJSON(auth, env, "GET", TASKS_LIST_PATH).then((d) => parseGrowthTasks(d));
}

/** ListTasksMP 拉取小程序口径任务列表（mp 头；默认列表不出现的 mp 专属任务在此）。 */
export function ListTasksMP(auth: Auth, env: Env): Promise<Task[]> {
  return growthJSONMP(auth, env, "GET", TASKS_LIST_PATH).then((d) => parseGrowthTasks(d));
}

/** parseGrowthTasks 解析 data.tasks[]（progress 可能是 {current,target} 或平铺）。 */
function parseGrowthTasks(data: any): Task[] {
  const tasks = data?.tasks ?? [];
  const out: Task[] = [];
  for (const t of tasks) {
    let cur = Number(t.current ?? 0);
    let tgt = Number(t.target ?? 0);
    const pr = t.progress;
    if (pr && typeof pr === "object" && (Number(pr.target) > 0 || Number(pr.current) > 0)) {
      cur = Number(pr.current ?? 0);
      tgt = Number(pr.target ?? 0);
    }
    const acceptStatus = t.accept_status ?? "";
    const claimed = acceptStatus === "claimed";
    out.push({
      task_code: t.task_code,
      title: t.title,
      description: t.description,
      task_desc: t.task_desc,
      credit: Number(t.reward_credit ?? 0),
      energy: Number(t.reward_energy ?? 0),
      has_reward: !!t.has_reward,
      reward_buddy: !!t.reward_buddy,
      task_type: t.task_type,
      tag: t.tag,
      jump_url: t.jump_url,
      locked: !!t.locked,
      target: tgt,
      current: cur,
      accept_status: acceptStatus,
      status: t.status,
      claimable: !claimed && tgt > 0 && cur >= tgt,
      claimed,
    });
  }
  return out;
}

/** AcceptTasks 接受任务（幂等：已 accepted 上游返回成功或业务提示，均不视为致命）。 */
export async function AcceptTasks(auth: Auth, env: Env, taskCodes: string[]): Promise<void> {
  await growthJSON(auth, env, "POST", TASKS_ACCEPT_PATH, { task_codes: taskCodes });
}

/** AcceptTasksMP 接受小程序限定任务（mp 头；缺头实测 task not found）。 */
export async function AcceptTasksMP(auth: Auth, env: Env, taskCodes: string[]): Promise<void> {
  await growthJSONMP(auth, env, "POST", TASKS_ACCEPT_PATH, { task_codes: taskCodes });
}

function parseClaimReward(data: any): { credit: number; energy: number } {
  return { credit: Number(data?.credit ?? 0), energy: Number(data?.energy ?? 0) };
}

/**
 * ClaimReward 领取单个任务奖励（Web 端）。
 * POST {webBase}/activity/growth/tasks/{code}/claim，任务码在路径、无body，带 web 平台头。
 * 返回本次到账奖励（已领取过时为 0）。
 */
export async function ClaimReward(auth: Auth, env: Env, taskCode: string): Promise<{ credit: number; energy: number }> {
  const base = basesFor(auth.realm, env);
  const h = billingHeaders(auth, env, {
    "x-client-platform": "web",
    Origin: base.web,
    Referer: base.web + "/profile/growth-center",
  });
  const data = await doJSON(
    new Request(`${base.web}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`, { method: "POST", headers: h }),
  );
  if (data?.already_claimed) return { credit: 0, energy: 0 };
  return parseClaimReward(data);
}

/**
 * ClaimRewardMP 领取小程序限定任务奖励：chat 域 /activity/growth/tasks/{code}/claim
 * + mp 头；chat 域 400 时降级 Web 域 ClaimReward（已实测可领）。
 */
export async function ClaimRewardMP(auth: Auth, env: Env, taskCode: string): Promise<{ credit: number; energy: number }> {
  const base = basesFor(auth.realm, env);
  const h = billingHeaders(auth, env, { "X-Client-Platform": MP_PLATFORM });
  try {
    const data = await doJSON(
      new Request(`${base.chat}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`, { method: "POST", headers: h }),
    );
    return parseClaimReward(data);
  } catch (e) {
    if (e instanceof UpstreamError && e.status === 400) return ClaimReward(auth, env, taskCode);
    throw e;
  }
}