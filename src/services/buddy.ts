import type { Env } from "../../worker-configuration.d.ts";
import type { Auth } from "../types";
import { growthJSON, chatStream, UpstreamError } from "./upstream";

// 猫猫旅行 / 领养 / 连登（替代 internal/upstream/travel.go）+ 夜猫子（blackcat.go）。

// ---- travel.go ----
export const TRAVEL_STATUS_PATH = "/activity/growth/buddy/travel/status";
export const TRAVEL_DEPART_PATH = "/activity/growth/buddy/travel/depart";
export const TRAVEL_CLAIM_PATH = "/activity/growth/buddy/travel/claim";
export const BUDDY_FIRST_PATH = "/activity/growth/buddy/first";
export const BUDDY_AGREEMENT_PATH = "/activity/growth/buddy/agreement";
export const STREAK_PATH = "/activity/growth/streak";

/** TravelState 猫猫旅行状态。 */
export interface TravelState {
  state: string; // idle / traveling / arrived
  daily_limit_reached: boolean;
  record_id: number;
  reward_credit: number;
}

/** TravelStatus 查询猫猫旅行状态。 */
export async function TravelStatus(auth: Auth, env: Env): Promise<TravelState> {
  const d = await growthJSON(auth, env, "GET", TRAVEL_STATUS_PATH);
  return { state: d?.state ?? "idle", daily_limit_reached: !!d?.daily_limit_reached, record_id: Number(d?.record_id ?? 0), reward_credit: Number(d?.reward_credit ?? 0) };
}

/** TravelDepart 派出猫旅行；locationID 实测 1~4。 */
export async function TravelDepart(auth: Auth, env: Env, locationID: number): Promise<void> {
  await growthJSON(auth, env, "POST", TRAVEL_DEPART_PATH, { location_id: locationID });
}

/** TravelClaim 领取到站奖励，返回 reward_credit（字段缺失按 0，不视为失败）。 */
export async function TravelClaim(auth: Auth, env: Env, recordID: number): Promise<number> {
  const d = await growthJSON(auth, env, "POST", TRAVEL_CLAIM_PATH, { record_id: recordID });
  return Number(d?.reward_credit ?? 0);
}

/** BuddyFirst 领养第一只猫。门槛未达返回 400（IsBuddyTaskIncomplete 判定），调用方静默跳过。 */
export async function BuddyFirst(auth: Auth, env: Env): Promise<void> {
  await growthJSON(auth, env, "POST", BUDDY_FIRST_PATH, {});
}

/** BuddyAgreement 同意协议（幂等）。 */
export async function BuddyAgreement(auth: Auth, env: Env): Promise<void> {
  await growthJSON(auth, env, "POST", BUDDY_AGREEMENT_PATH, { agree: true });
}

/** GrowthStreak 查询连登天数（0 即"上报 200 但静默丢弃"告警信号）。 */
export async function GrowthStreak(auth: Auth, env: Env): Promise<number> {
  const d = await growthJSON(auth, env, "GET", STREAK_PATH);
  return Number(d?.streak?.days ?? 0);
}

/** IsBuddyTaskIncomplete 判定「领养门槛未达标」：HTTP 400 + first_buddy 关键词。 */
export function IsBuddyTaskIncomplete(e: unknown): boolean {
  return e instanceof UpstreamError && e.status === 400 && /first_buddy task not completed yet/i.test(e.message);
}

// ---- blackcat.go 夜猫子 ----

/** InNightWindow 当前是否处于夜猫子计数窗口（23:00–08:00 本地时区）。 */
export function InNightWindow(d: Date = new Date()): boolean {
  const h = d.getHours();
  return h >= 23 || h < 8;
}

/**
 * BlackcatNeed 查 black_cat 剩余差额。需 tasks 模块（避免循环依赖，调用方传入 task 列表查）。
 * 任务不存在/已达标返回 0。
 */
export function BlackcatNeedFromTasks(tasks: { task_code: string; claimed?: boolean; current: number; target: number }[]): number {
  const t = tasks.find((x) => x.task_code === "black_cat");
  if (!t) return 0;
  if (t.claimed || t.current >= t.target) return 0;
  return t.target - t.current;
}

/**
 * RunNightChats 夜猫子：发 need 次 glm-5.2 真实对话（读干流）并上报事件链。
 * 对话内容极短（1+1），消耗可忽略。返回成功次数。
 */
export async function RunNightChats(auth: Auth, env: Env, need: number, reportModel: (auth: Auth, env: Env, conv: string, rid: string, mid: string, mname: string) => Promise<void>): Promise<number> {
  let ok = 0;
  for (let i = 0; i < need; i++) {
    const res = await chatStream(env, auth, "glm-5.2", { messages: [{ role: "user", content: "1+1等于几？直接回答。" }], stream: true }, new Headers());
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`第 ${i + 1} 次对话失败: http=${res.status} body=${t.slice(0, 120)}`);
    }
    // 读干 SSE 流（上限 1MB，避免残留连接）。
    const reader = res.body?.getReader();
    if (reader) {
      const dec = new TextDecoder();
      let read = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        read += value?.length ?? 0;
        if (read > (1 << 20)) break;
      }
      void dec;
    }
    await reportModel(auth, env, `wb2api-night-${Date.now()}-${i}`, "", "glm-5.2", "GLM-5.2");
    ok++;
    await sleep(4000);
  }
  return ok;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}