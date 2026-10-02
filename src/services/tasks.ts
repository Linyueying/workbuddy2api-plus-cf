import type { Env } from "../../worker-configuration.d.ts";
import type { Auth } from "../types";
import { poolRPC } from "../durable/account-pool";
import { basesFor, chatStream, dailyCheckin, getCreditsDetailed, type Credits } from "./upstream";
import { dailyCheckinRetry } from "./checkin";
import { claimTrialFor, type TrialOutcome, type TrialSummary, summarizeTrial } from "./trial";
import {
  fetchUserResourceSafe,
  summarizeReport,
  prettyReport,
  type CreditAccount,
  type CreditReport,
} from "./credit";
import { getConfig } from "../config";
import {
  AcceptTasks, AcceptTasksMP, ClaimReward, ClaimRewardMP, ListTasks, ListTasksMP,
  type Task,
} from "./growthTasks";
import { ReportChatActivity, ReportChatActivityModel } from "./report";
import {
  DesktopAutomationCreateEvent, DesktopBuddyAppSequence, DesktopChatSequence, DesktopChatWithExpert,
  DesktopDesignCanvasSequence, DesktopExpertActualUseEvent, DesktopExpertActualUseLocal,
  DesktopExpertSummonSequence, DesktopPlaybookPromptSequence, DesktopTemplateUseSequence,
  MarketExpertList, ReportDesktopEvent, ReportWebEvent, SetAppearanceTheme,
  type DesktopEvent, type MarketExpert,
} from "./desktop";
import {
  MiniChatModelEvent, MiniExpertUseEvent, MiniPlaybookEvents, ReportMPEvent,
  SchoolChatTimesEvents, SchoolSeasonChatEvent,
} from "./school";
import {
  BuddyAgreement, BuddyFirst, InNightWindow, IsBuddyTaskIncomplete, RunNightChats,
  TravelClaim, TravelDepart, TravelStatus,
} from "./buddy";

// 任务中心 / 自动任务（替代 internal/panel/autotask.go + taskcenter.go + scheduler 的 Run*）。
// 本模块承载**完整 22 个任务码的事件链编排**：mp 查询 → accept（带登记回读验证）→
// 判据事件上报（按差额补）→ 异步计分有界回读 → 达标自动领奖。全部动作幂等：
// 已 claimed / 已达标直接跳过，不重复消耗上游配额。

export interface TaskOutcome {
  uid: string;
  realm: string;
  ok: boolean;
  error?: string;
  data?: any;
}

/** 遍历全部账号（或指定 realm）执行 fn。 */
export async function forEachAccount(env: Env, fn: (auth: Auth) => Promise<any>, realm?: string): Promise<TaskOutcome[]> {
  const list = (await poolRPC(env, "/internal/list")) as any[];
  const out: TaskOutcome[] = [];
  for (const a of list) {
    if (realm && a.realm !== realm) continue;
    try {
      const data = await fn(a.auth as Auth);
      out.push({ uid: a.uid, realm: a.realm, ok: true, data });
    } catch (e: any) {
      out.push({ uid: a.uid, realm: a.realm, ok: false, error: String(e?.message ?? e) });
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 取单账号 auth（uid → Auth），失败返回 null。 */
async function single(env: Env, uid: string): Promise<Auth | null> {
  const r = await poolRPC(env, "/internal/auth/" + encodeURIComponent(uid)).catch(() => null);
  return r?.accessToken ? (r as Auth) : null;
}

/**
 * refreshCredits 查余额并回写账号池（对齐 Go ReenableIfCredits + SetCreditsDetailed）。
 *
 * 池内 `credits` 是成本台账内插扣减、选号 credits 权重、积分保底（credit_floor）
 * 三处的唯一数据源，只靠面板读不回写会让三者全部失真。窗口取
 * `pool.expiring_soon`（小时），0 = 禁用快过期分桶。
 */
export async function refreshCredits(env: Env, auth: Auth): Promise<Credits> {
  const cfg = await getConfig(env);
  const soonMs = Math.max(0, cfg.pool.expiring_soon || 0) * 3600_000;
  const cr = await getCreditsDetailed(env, auth, soonMs);
  await poolRPC(env, "/internal/credits", "POST", {
    uid: auth.uid,
    credits: cr.credits,
    creditsTotal: cr.creditsTotal,
    expiring: cr.expiring,
    earliestExpiry: cr.earliestExpiry,
    earliestRemaining: cr.earliestRemaining,
  }).catch(() => null);
  return cr;
}

// ---------------------------------------------------------------------------
// 小程序口径专属任务码（默认列表不出现，accept/claim 需 mp 头）
// ---------------------------------------------------------------------------
const mpTaskCodes = new Set<string>([
  "school_season",
  "Sequential_Tasks_1",
  "Sequential_Tasks_2",
  "Sequential_Tasks_3",
  "Sequential_Tasks_4",
  "Sequential_Tasks_5",
  "Sequential_Tasks_6",
  "Sequential_Tasks_7",
]);
const isMPTaskCode = (code: string) => mpTaskCodes.has(code);

/** taskByCode 拉取任务并定位单个任务；未找到返回 null。双口径：mp 专属码回落 mp 列表。 */
async function taskByCode(auth: Auth, env: Env, code: string): Promise<Task | null> {
  const tasks = await ListTasks(auth, env);
  const hit = tasks.find((t) => t.task_code === code);
  if (hit) return hit;
  if (isMPTaskCode(code)) return (await ListTasksMP(auth, env)).find((t) => t.task_code === code) ?? null;
  return null;
}

/** 异步计分回读轮询参数：上游计分延迟数秒才刷新，一次回读会误判"未达标"。 */
const CLAIM_POLL_ATTEMPTS = 4;
const CLAIM_POLL_GAP = 3000;

/** taskByCodeWaiting 回读任务，未达标则有界轮询等待（异步计分）。 */
async function taskByCodeWaiting(auth: Auth, env: Env, code: string): Promise<Task | null> {
  let t = await taskByCode(auth, env, code);
  if (!t || t.claimable || t.claimed) return t;
  for (let i = 1; i < CLAIM_POLL_ATTEMPTS; i++) {
    await sleep(CLAIM_POLL_GAP);
    const t2 = await taskByCode(auth, env, code).catch(() => null);
    if (t2) {
      t = t2;
      if (t.claimable || t.claimed) return t;
    }
  }
  return t;
}

/** mp 任务写动作间隔（accept/上报/领奖之间，防频控）。 */
const MP_ACTION_GAP = 2000;

/**
 * acceptWithVerifyMP accept 并回读验证登记生效：上游存在 200+OK 但accept 未真正
 * 登记的形态（此时上报事件不归账，任务永远点不亮）。未生效重试一次。
 */
async function acceptWithVerifyMP(auth: Auth, env: Env, code: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await AcceptTasksMP(auth, env, [code]);
    } catch {
      continue;
    }
    await sleep(MP_ACTION_GAP);
    const t = await taskByCode(auth, env, code).catch(() => null);
    const s = t?.accept_status;
    if (s && s !== "not_accepted") return true;
  }
  return false;
}

/**
 * mpChatEventGap mp 对话事件真人节奏间隔（秒）。上游对 Sequential_Tasks_3「5 次
 * 有效对话」有反作弊：数秒级连发先计数后被判定无效整体回滚。实测 45s 间隔全存活。
 */
const MP_CHAT_EVENT_GAP_MS = 45_000;

/**
 * runMPMiniChatTask mp 小程序限定任务通用闭环：mp 查询 → accept（带登记验证）→
 * mini chat 事件上报（withActivityId 决定是否带 activityId）→ 回读 → 达标领奖。
 */
async function runMPMiniChatTask(auth: Auth, env: Env, code: string, withActivityId: boolean): Promise<string> {
  let t = (await ListTasksMP(auth, env)).find((x) => x.task_code === code);
  if (!t) return "mp 口径未下发该任务（活动可能已结束）";
  if (t.claimed) return "已领取";
  if (t.accept_status === "not_accepted" || !t.accept_status) {
    if (!(await acceptWithVerifyMP(auth, env, code))) {
      return "accept 未登记生效（上游 200+OK 但未落账形态），待下次重试";
    }
    // accept 后回读拿真实 target/current（accept 前 target 为 null）。
    const t2 = (await ListTasksMP(auth, env).catch(() => null))?.find((x) => x.task_code === code);
    if (t2) t = t2;
  }
  const target = t.target > 0 ? t.target : 1;
  if (t.current >= target || t.accept_status === "completed") {
    const { credit, energy } = await ClaimRewardMP(auth, env, code);
    return `已领取奖励（+${credit}c +${energy}e）`;
  }
  const need = target - t.current;
  for (let i = 0; i < need; i++) {
    // 每条前 sleep gap + 抖动，连发会被反作弊判无效。
    await sleep(MP_CHAT_EVENT_GAP_MS + Math.floor(Math.random() * 10_000));
    const conv = `wb2api-mp-${Date.now()}-${i}`;
    const ev = withActivityId ? SchoolSeasonChatEvent(conv) : SchoolChatTimesEvents(conv);
    try {
      await ReportMPEvent(auth, env, [ev]);
    } catch (e) {
      return `完成 ${i}/${need} 次上报后中断: ${e}`;
    }
  }
  for (let i = 0; i < 2; i++) {
    await sleep(CLAIM_POLL_GAP);
    const t2 = (await ListTasksMP(auth, env).catch(() => null))?.find((x) => x.task_code === code);
    if (t2) {
      t = t2;
      if (t.claimable || t.claimed || t.current >= target) break;
    }
  }
  if (t.claimed) return "本轮已入账（claimed）";
  if (t.current < target) return `已上报 ${need} 次但进度未达 ${t.current}/${target}（异步计分未归账，下次重试）`;
  const { credit, energy } = await ClaimRewardMP(auth, env, code);
  return `任务点亮并领取奖励（+${credit}c +${energy}e）`;
}

/** runSequentialEventTask Sequential 链预留任务通用骨架：mp 查询 → accept（验证）→
 *  判据事件上报（primary；未点亮且 fallback 非空补一轮）→ 回读 → 达标领奖。
 *  每日零点解锁一环：locked 期间 accept 不落账，返回等下次调度。 */
async function runSequentialEventTask(
  auth: Auth, env: Env, code: string,
  primary: () => Promise<void>, fallback?: (() => Promise<void>) | null,
): Promise<string> {
  let t = (await ListTasksMP(auth, env)).find((x) => x.task_code === code);
  if (!t) return "mp 口径未下发该任务（前置任务未完成或活动未开始）";
  if (t.claimed) return "已领取";
  const target = t.target > 0 ? t.target : 1;
  if (t.current >= target || t.accept_status === "completed") {
    const { credit, energy } = await ClaimRewardMP(auth, env, code);
    return `已领取奖励（+${credit}c +${energy}e）`;
  }
  if (t.accept_status === "not_accepted" || !t.accept_status) {
    if (!(await acceptWithVerifyMP(auth, env, code))) {
      return "accept 未登记生效（任务可能处于每日锁定窗口，等解锁后自动重试）";
    }
  }
  try {
    await primary();
  } catch (e) {
    return `判据上报失败: ${e}`;
  }
  for (let round = 0; round < 2; round++) {
    await sleep(CLAIM_POLL_GAP);
    const t2 = (await ListTasksMP(auth, env).catch(() => null))?.find((x) => x.task_code === code);
    if (t2) {
      t = t2;
      if (t.claimable || t.claimed || t.current >= target) break;
      if (round === 0 && fallback) {
        try {
          await fallback();
        } catch (e) {
          return `备选判据上报失败: ${e}`;
        }
      }
    }
  }
  if (t.claimed) return "本轮已入账（claimed）";
  if (t.current < target) return "已上报但进度未点亮（判据形态待解锁后校正，下次重试）";
  const { credit, energy } = await ClaimRewardMP(auth, env, code);
  return `任务点亮并领取奖励（+${credit}c +${energy}e）`;
}

// ---------------------------------------------------------------------------
// 自动任务动作表（顺序即执行顺序：先解锁依赖项）
// ---------------------------------------------------------------------------
interface AutoAction {
  taskCode: string;
  desc: string;
  attempt?: boolean;
  run: (auth: Auth, env: Env) => Promise<string>;
}

const REPORT_GAP = 1050;

/** chat_5：按差额上报 chat_request_send。 */
async function runChat5(auth: Auth, env: Env): Promise<string> {
  const t = await taskByCode(auth, env, "chat_5");
  if (!t) throw new Error("任务不存在");
  const target = t.target > 0 ? t.target : 5;
  const need = target - t.current;
  if (need <= 0) return "进度已达标，无需上报";
  for (let i = 0; i < need; i++) {
    await ReportChatActivity(auth, env, `wb2api-chat5-${Date.now()}-${i}`, "");
    if (i < need - 1) await sleep(REPORT_GAP);
  }
  return `已补报 ${need} 条对话事件`;
}

/** first_buddy：report（解锁前置）→ agreement → first。 */
async function runFirstBuddy(auth: Auth, env: Env): Promise<string> {
  try {
    await ReportChatActivity(auth, env, `wb2api-adopt-${Date.now()}`, "");
  } catch (e) {
    throw new Error("前置上报: " + e);
  }
  await sleep(REPORT_GAP);
  try {
    await BuddyAgreement(auth, env);
  } catch (e) {
    throw new Error("同意协议: " + e);
  }
  try {
    await BuddyFirst(auth, env);
  } catch (e) {
    if (IsBuddyTaskIncomplete(e)) return "前置已上报，但领养门槛未过（上游要求当日活跃），请稍后重试";
    throw new Error("领取 Buddy: " + e);
  }
  return "已领取 Buddy（+300 分 +8 能量）";
}

/** Model_chat_GLM5.2：accept → 真实对话一次 → 对齐模型上报。 */
async function runModelChat(auth: Auth, env: Env): Promise<string> {
  const code = "Model_chat_GLM5.2";
  const modelID = "glm-5.2";
  try {
    await AcceptTasks(auth, env, [code]); // 失败不阻塞——行为事件才是判据
  } catch { /* noop */ }
  await sleep(REPORT_GAP);
  // 真实对话一次（判据的最直接证据）
  const res = await chatStream(env, auth, modelID, { messages: [{ role: "user", content: "hi，请回复一句话" }], stream: true }, new Headers());
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`对话失败 http=${res.status}: ${t.slice(0, 160)}`);
  }
  // 读干 SSE（不读完会残留连接）
  const reader = res.body?.getReader();
  if (reader) for (;;) { const { done } = await reader.read(); if (done) break; }
  await sleep(REPORT_GAP);
  // 对齐模型的上报（触发进度）
  try {
    await ReportChatActivityModel(auth, env, `wb2api-glm52-${Date.now()}`, "", modelID, "GLM-5.2");
  } catch (e) {
    return "对话已完成，但进度上报失败：" + e;
  }
  return "已完成 glm-5.2 对话并上报";
}

/** RichMeow_Chat：桌面指纹完整对话事件链上报。 */
async function runRichMeow(auth: Auth, env: Env): Promise<string> {
  const ms = Date.now();
  const conv = `wb2api-rm-${ms}`;
  const req = `wb2api-rm-req-${ms}`;
  const msg = `req-${ms}-user`;
  await ReportDesktopEvent(auth, env, DesktopChatSequence(conv, req, msg, "fast-model", "fast-model"));
  return "已按桌面端指纹上报完整对话事件链（agent_task_created→chat_response）";
}

/** Buddy_App / Buddy_App_QQ：buddyapp 五连事件（共用本 run）。 */
async function runBuddyApp(auth: Auth, env: Env): Promise<string> {
  await ReportDesktopEvent(auth, env, DesktopBuddyAppSequence("cb_y5Dy46tPQGGWtueMxXbe", "企鹅教师助手"));
  return "已上报 buddyapp 进入五连事件（同时覆盖 Buddy_App 与 Buddy_App_QQ）";
}

/** automation_1：automated_task_create_suc 事件。 */
async function runAutomationCreate(auth: Auth, env: Env): Promise<string> {
  await ReportDesktopEvent(auth, env, [DesktopAutomationCreateEvent("wb2api 自动化")]);
  return "已上报定时任务创建事件";
}

/** Library_read：web 域 web_element_click(library_doc_intro_click)。 */
async function runLibraryRead(auth: Auth, env: Env): Promise<string> {
  const docURL = "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm";
  await ReportWebEvent(auth, env, "web_element_click", docURL, "library_doc_intro_click", "WorkBuddy资料库介绍");
  return "已上报资料库介绍阅读事件";
}

/** black_cat：夜猫子 23:00–08:00 窗口内 glm-5.2 对话补足。 */
async function runBlackCat(auth: Auth, env: Env): Promise<string> {
  if (!InNightWindow()) {
    return "当前不在 23:00–08:00 计数窗口，行为不计分；网关会在每日 23 点自动补足";
  }
  const tasks = await ListTasks(auth, env);
  const t = tasks.find((x) => x.task_code === "black_cat");
  const need = !t || t.claimed || t.current >= t.target ? 0 : t.target - t.current;
  if (need <= 0) return "进度已达标，无需补足";
  try {
    const ok = await RunNightChats(auth, env, need, ReportChatActivityModel);
    return `已完成 ${ok} 次夜间对话并上报`;
  } catch (e) {
    return `补足中断: ${e}`;
  }
}

/** skill_1：真实对话 + skill_info 技能加载事件。 */
async function runSkillFresh(auth: Auth, env: Env): Promise<string> {
  const { conversationID: conv, requestID: req } = await DesktopChatWithExpert(auth, env, "");
  const msgID = "msg-" + req.slice(-8);
  const events = DesktopChatSequence(conv, req, msgID, "fast-model", "fast-model");
  for (const ev of events) {
    if (ev.eventCode === "chat_message_response") ev.finishReason = "tool_calls";
  }
  events.push({
    eventCode: "skill_info", id: "润泽小馆·日报撰写",
    skillId: "skill_2097350077599879168", skillVersion: "1.0.0",
    toolStatus: "success", fileCount: 56, source: "workbuddy-desktop",
    conversationId: conv, requestId: req, messageId: msgID,
    requestModelId: "fast-model", requestModelName: "fast-model", traceId: req,
  });
  await ReportDesktopEvent(auth, env, events);
  return "已上报真实对话 + skill_info 技能加载事件";
}

/** Expert_lighthouse：轻量云专家召唤+使用（has_expert:true + mode LOCAL）。 */
async function runExpertLighthouse(auth: Auth, env: Env): Promise<string> {
  const lhID = "ex_2cvvUZQhDyeJ";
  let lh: MarketExpert = {
    expert_id: lhID, expert_type: "agent",
    display_name_zh: "腾讯轻量云专家", profession_zh: "腾讯轻量云专家", version: "1.0.2",
  };
  const experts = await MarketExpertList(auth, env, "agent").catch(() => []);
  const hit = experts.find((x) => x.expert_id === lhID);
  if (hit) lh = hit;
  await ReportDesktopEvent(auth, env, DesktopExpertSummonSequence(lh));
  const { conversationID: conv, requestID: req } = await DesktopChatWithExpert(auth, env, lh.expert_id);
  const events = DesktopChatSequence(conv, req, "msg-" + req.slice(-8), "fast-model", "fast-model");
  for (const ev of events) {
    if (ev.eventCode === "agent_task_created") {
      ev.has_expert = true;
      ev.expert_id = lh.expert_id;
      ev.expert_name = lh.display_name_zh;
      ev.expert_industry_id = "";
    }
  }
  const useEv = DesktopExpertActualUseLocal(lh, conv, req);
  useEv.type = "";
  useEv.cost = 0;
  events.push(useEv);
  await ReportDesktopEvent(auth, env, events);
  return "已上报轻量云专家召唤+使用链（真实对话 requestId）";
}

/** Hp_Appearance：设置主题 API + 皮肤生效事件。 */
async function runAppearance(auth: Auth, env: Env): Promise<string> {
  const themeKey = "theme-tkmw7j"; // 和平精英激战金秋
  await SetAppearanceTheme(auth, env, themeKey);
  await sleep(2000);
  await ReportDesktopEvent(auth, env, [{
    eventCode: "appearance_skin_apply", action: "apply", source: "settings_close",
    id: themeKey, vipLevel: 0, series: "", type: "unknown",
  }]);
  return "已设置主题并上报皮肤生效事件";
}

/** template_5：template_used 事件组 ×5。 */
async function runTemplateUse(auth: Auth, env: Env): Promise<string> {
  const templates = [["1", "深度研究"], ["2", "周报生成"], ["3", "竞品分析"], ["4", "活动策划"], ["5", "代码评审"]];
  for (let i = 0; i < templates.length; i++) {
    const ms = Date.now();
    const conv = `wb2api-tpl-${ms}-${i}`;
    const req = `wb2api-tpl-req-${ms}-${i}`;
    await ReportDesktopEvent(auth, env, DesktopTemplateUseSequence(conv, req, templates[i][0], templates[i][1]));
    await sleep(300);
  }
  return "已上报 template_used ×5";
}

/** playbook_prompt：灵感案例 Dialog 发送 Prompt。 */
async function runPlaybookPrompt(auth: Auth, env: Env): Promise<string> {
  const ms = Date.now();
  const conv = `wb2api-pb-${ms}`;
  const req = `wb2api-pb-req-${ms}`;
  await ReportDesktopEvent(auth, env, DesktopPlaybookPromptSequence(conv, req, "pm-gtm-launch-plan", "新产品上市 GTM 发布计划一页纸"));
  return "已上报 playbook_cta_click + playbook_prompt_send";
}

/** create_canvas：wbx_design_canvas 事件组。 */
async function runCreateCanvas(auth: Auth, env: Env): Promise<string> {
  const ms = Date.now();
  const conv = `wb2api-canvas-${ms}`;
  const req = `wb2api-canvas-req-${ms}`;
  await ReportDesktopEvent(auth, env, DesktopDesignCanvasSequence(conv, req));
  return "已上报 wbx_design_canvas_task_create/open";
}

const EXPERT_SUMMON_GAP = 6000;

/** 专家召唤+使用的公共实现（expert_5 / Expert_team_use_3）。失败逐个继续。 */
async function runExpertBatch(auth: Auth, env: Env, expertType: string, count: number): Promise<string> {
  const experts = await MarketExpertList(auth, env, expertType);
  if (!experts.length) throw new Error("专家市场列表为空");
  let ok = 0;
  for (let i = 0; i < experts.length && ok < count; i++) {
    const e = experts[i];
    try {
      await ReportDesktopEvent(auth, env, DesktopExpertSummonSequence(e));
      const { conversationID: conv, requestID: req } = await DesktopChatWithExpert(auth, env, e.expert_id);
      const events: DesktopEvent[] = DesktopChatSequence(conv, req, "msg-" + req.slice(-8), "fast-model", "fast-model");
      events.push(DesktopExpertActualUseEvent(e, conv, req));
      await ReportDesktopEvent(auth, env, events);
      ok++;
    } catch {
      continue;
    }
    if (i < experts.length - 1) await sleep(EXPERT_SUMMON_GAP);
  }
  return `已对 ${ok} 位真实专家完成召唤+使用链（类型 ${expertType}）`;
}

async function runExpertUse(auth: Auth, env: Env): Promise<string> {
  return runExpertBatch(auth, env, "agent", 5);
}
async function runExpertTeamUse(auth: Auth, env: Env): Promise<string> {
  return runExpertBatch(auth, env, "team", 3);
}

const autoActions: AutoAction[] = [
  { taskCode: "chat_5", desc: "上报 5 条对话活跃事件（自动补足差额）", run: runChat5 },
  { taskCode: "first_buddy", desc: "上报解锁 → 同意协议 → 领取第一只 Buddy（+300 分）", run: runFirstBuddy },
  { taskCode: "Model_chat_GLM5.2", desc: "接受任务 → glm-5.2 真实对话一次 → 对齐模型上报", run: runModelChat },
  { taskCode: "RichMeow_Chat", desc: "桌面指纹事件链上报（已验证：纯 API 可点亮）", run: runRichMeow },
  { taskCode: "Buddy_App", desc: "上报「进入 Buddy 应用」事件链（已验证：纯 API 可点亮）", run: runBuddyApp },
  { taskCode: "Buddy_App_QQ", desc: "上报「进入企鹅教师助手」事件链（已验证：纯 API 可点亮）", run: runBuddyApp },
  { taskCode: "automation_1", desc: "上报「定时任务创建」事件（已验证：纯 API 可点亮）", run: runAutomationCreate },
  { taskCode: "Library_read", desc: "上报「读资料库介绍」事件（已验证：纯 API 可点亮）", run: runLibraryRead },
  { taskCode: "template_5", desc: "上报「使用模板创建任务」事件组 ×5（已验证）", run: runTemplateUse },
  { taskCode: "playbook_prompt", desc: "上报「灵感案例做同款发送 Prompt」事件组（已验证）", run: runPlaybookPrompt },
  { taskCode: "create_canvas", desc: "上报「设计创意画布创建」事件组（已验证，+300 分）", run: runCreateCanvas },
  { taskCode: "expert_5", desc: "真实专家召唤+使用链 ×5（已验证）", run: runExpertUse },
  { taskCode: "Expert_team_use_3", desc: "真实专家团召唤+使用链 ×3（已验证）", run: runExpertTeamUse },
  { taskCode: "Hp_Appearance", desc: "设置主题 API + 皮肤生效事件（已验证）", run: runAppearance },
  { taskCode: "skill_1", desc: "真实对话 + skill_info 技能加载事件（已验证）", run: runSkillFresh },
  { taskCode: "Expert_lighthouse", desc: "真实轻量云专家召唤+使用链（chat 链带 has_expert，已验证）", run: runExpertLighthouse },
  { taskCode: "black_cat", desc: "夜猫子：23:00–08:00 窗口内 glm-5.2 对话补足（窗口外提示稍后再试）", attempt: true, run: runBlackCat },
  // —— 小程序口径（mp 头）——
  { taskCode: "school_season", desc: "校园日：accept → mini 对话+activityId 上报 → 领奖（+100c+5e）", run: (a, e) => runMPMiniChatTask(a, e, "school_season", true) },
  { taskCode: "Sequential_Tasks_1", desc: "小程序首对话：accept → mini 对话上报 → 领奖（+100c+5e）", run: (a, e) => runMPMiniChatTask(a, e, "Sequential_Tasks_1", false) },
  { taskCode: "Sequential_Tasks_2", desc: "小程序选专家对话：市场专家 id → accept → expert_actual_use 上报 → 领奖（+200c+5e）", run: runMiniExpert },
  { taskCode: "Sequential_Tasks_3", desc: "小程序五次对话：accept → mini 对话上报 ×5 → 领奖（+300c+5e）", run: (a, e) => runMPMiniChatTask(a, e, "Sequential_Tasks_3", false) },
  { taskCode: "Sequential_Tasks_4", desc: "小程序定时任务（预留，每日零点解锁一环）：PC 同源定时任务创建事件 → 领奖", run: runSequentialAutomation },
  { taskCode: "Sequential_Tasks_5", desc: "小程序使用 GLM5.2（预留）：带模型字段的 mini 对话上报 → 领奖", run: runSequentialModelChat },
  { taskCode: "Sequential_Tasks_6", desc: "小程序十次对话（预留）：mini 对话上报 ×target（自动补差额）→ 领奖", run: (a, e) => runMPMiniChatTask(a, e, "Sequential_Tasks_6", false) },
  { taskCode: "Sequential_Tasks_7", desc: "体验灵感功能（预留）：灵感事件组（PC+mp 双形态）→ 领奖", run: runSequentialPlaybook },
];

/** Sequential_Tasks_2：mp 指纹 expert_actual_use（专家 id 必须市场真实，accept 前先解析）。 */
async function runMiniExpert(auth: Auth, env: Env): Promise<string> {
  const code = "Sequential_Tasks_2";
  let t = (await ListTasksMP(auth, env)).find((x) => x.task_code === code);
  if (!t) return "mp 口径未下发该任务（活动可能已结束）";
  if (t.claimed) return "已领取";
  const target = t.target > 0 ? t.target : 1;
  if (t.current >= target || t.accept_status === "completed") {
    const { credit, energy } = await ClaimRewardMP(auth, env, code);
    return `已领取奖励（+${credit}c +${energy}e）`;
  }
  // 判据载体前置（accept 之前）：市场真实专家 id。
  const experts = await MarketExpertList(auth, env, "").catch(() => []);
  if (!experts.length) return "专家市场不可用，跳过以防半程态";
  const e = experts[0];
  const name = e.display_name_zh || e.profession_zh;
  if (t.accept_status === "not_accepted" || !t.accept_status) {
    if (!(await acceptWithVerifyMP(auth, env, code))) {
      return "accept 未登记生效（上游 200+OK 但未落账形态），待下次重试";
    }
  }
  try {
    await ReportMPEvent(auth, env, [MiniExpertUseEvent(e.expert_id, name, e.expert_type)]);
  } catch (err) {
    return `上报 expert_actual_use 失败: ${err}`;
  }
  for (let i = 0; i < 2; i++) {
    await sleep(CLAIM_POLL_GAP);
    const t2 = (await ListTasksMP(auth, env).catch(() => null))?.find((x) => x.task_code === code);
    if (t2) {
      t = t2;
      if (t.claimable || t.claimed || t.current >= target) break;
    }
  }
  if (t.claimed) return "本轮已入账（claimed）";
  if (t.current < target) return "已上报但进度未归账（异步计分，下次重试）";
  const { credit, energy } = await ClaimRewardMP(auth, env, code);
  return `任务点亮并领取奖励（+${credit}c +${energy}e）`;
}

/** Sequential_Tasks_4：定时任务创建（判据疑PC 口径，复用 automation_1 同源事件）。 */
async function runSequentialAutomation(auth: Auth, env: Env): Promise<string> {
  return runSequentialEventTask(auth, env, "Sequential_Tasks_4", async () => {
    await ReportDesktopEvent(auth, env, [DesktopAutomationCreateEvent("wb2api 自动化")]);
  }, null);
}

/** Sequential_Tasks_5：使用 GLM5.2（primary mp 带模型对话；fallback PC 域模型上报）。 */
async function runSequentialModelChat(auth: Auth, env: Env): Promise<string> {
  return runSequentialEventTask(auth, env, "Sequential_Tasks_5", async () => {
    await ReportMPEvent(auth, env, [MiniChatModelEvent(`wb2api-mp-glm-${Date.now()}`, "glm-5.2", "GLM-5.2")]);
  }, async () => {
    await ReportChatActivityModel(auth, env, `wb2api-mp-glm-${Date.now()}`, "", "glm-5.2", "GLM-5.2");
  });
}

/** Sequential_Tasks_7：体验灵感功能（primary PC 灵感事件组；fallback mp 灵感事件组）。 */
async function runSequentialPlaybook(auth: Auth, env: Env): Promise<string> {
  const ms = Date.now();
  return runSequentialEventTask(auth, env, "Sequential_Tasks_7", async () => {
    await ReportDesktopEvent(auth, env, DesktopPlaybookPromptSequence(`wb2api-pb-${ms}`, `wb2api-pb-req-${ms}`, "pm-gtm-launch-plan", "新产品上市 GTM 发布计划一页纸"));
  }, async () => {
    await ReportMPEvent(auth, env, MiniPlaybookEvents("pm-gtm-launch-plan", "新产品上市 GTM 发布计划一页纸"));
  });
}

function taskProgressText(t?: Task | null): string {
  if (!t) return "?";
  if (t.target > 0) return `${t.current}/${t.target}`;
  if (t.claimed) return "claimed";
  return t.accept_status ?? "";
}

/** accountTaskAuto 一键完成单个任务（执行动作 → 回读进度 → 达标自动领奖）。 */
export async function accountTaskAuto(env: Env, uid: string, taskCode: string): Promise<any> {
  const auth = await single(env, uid);
  if (!auth) return { ok: false, error: "账号不存在" };
  const act = autoActions.find((a) => a.taskCode === taskCode.trim());
  if (!act) {
    return { ok: false, status: 501, error: "该任务需要客户端内交互（无对应接口），无法自动完成；请按任务说明在官方客户端操作" };
  }
  const before = await taskByCode(auth, env, act.taskCode).catch(() => null);
  if (!before) return { ok: false, status: 404, error: "该账号没有此任务" };
  if (before.claimed) return { ok: true, skipped: true, message: "该任务已领取过奖励" };

  const isMP = isMPTaskCode(act.taskCode);
  let msg: string;
  try {
    msg = await act.run(auth, env);
  } catch (e) {
    return { ok: false, status: 502, error: "执行失败: " + e };
  }
  // 回读验证：上报 200 ≠ 计分（异步），用有界轮询等落定。
  const after = isMP
    ? await (async () => (await ListTasksMP(auth, env).catch(() => null))?.find((x) => x.task_code === act.taskCode) ?? null)()
    : await taskByCodeWaiting(auth, env, act.taskCode);
  const progressBefore = taskProgressText(before);
  const progressAfter = taskProgressText(after);
  const claimable = !!after?.claimable;
  const resp: any = {
    ok: true, message: msg,
    progress_before: progressBefore, progress_after: progressAfter,
    claimable, attempt: !!act.attempt, verify_supported: true,
  };
  // 达标即自动领奖（把"完成→领奖"收敛成一步）。
  if (claimable) {
    try {
      const { credit, energy } = isMP ? await ClaimRewardMP(auth, env, act.taskCode) : await ClaimReward(auth, env, act.taskCode);
      resp.claimed = true;
      resp.credit = credit;
      resp.energy = energy;
      resp.message = msg + (credit > 0 || energy > 0 ? `；已自动领奖 +${credit} 分 +${energy} 能` : "；奖励此前已领取");
    } catch (e) {
      resp.claim_error = String(e);
      resp.message = msg + "；达标但领奖失败，可在任务列表手动点「领取」重试";
    }
  }
  return resp;
}

/** runAutoAll 对单账号依次执行所有可自动化任务，返回逐项结果。单项失败不影响后续。 */
export async function runAutoAll(env: Env, auth: Auth): Promise<any[]> {
  const out: any[] = [];
  // 阶段 0：批量接受尚未接受的任务（失败不阻塞——行为事件才是进度唯一判据）。
  try {
    const tasks = await ListTasks(auth, env);
    const codes = tasks.filter((t) => !t.claimed && !t.locked && t.accept_status !== "accepted" && t.accept_status !== "completed").map((t) => t.task_code);
    if (codes.length) {
      try {
        await AcceptTasks(auth, env, codes);
        out.push({ task_code: "(批量接受)", status: "done", message: `已接受 ${codes.length} 个任务` });
        await sleep(REPORT_GAP);
      } catch (e) {
        out.push({ task_code: "(批量接受)", status: "error", message: "接受任务失败（不阻塞后续）: " + e });
      }
    }
  } catch { /* noop */ }

  // 阶段 0b：小程序口径任务单独接受（默认列表不含 mp 码）。
  try {
    const mpTasks = await ListTasksMP(auth, env);
    const mpCodes = mpTasks.filter((t) => !t.claimed && !t.locked && t.accept_status !== "accepted" && t.accept_status !== "completed").map((t) => t.task_code);
    if (mpCodes.length) {
      try {
        await AcceptTasksMP(auth, env, mpCodes);
        out.push({ task_code: "(批量接受-mp)", status: "done", message: `已接受 ${mpCodes.length} 个小程序任务` });
        await sleep(REPORT_GAP);
      } catch (e) {
        out.push({ task_code: "(批量接受-mp)", status: "error", message: "接受小程序任务失败（不阻塞后续）: " + e });
      }
    }
  } catch { /* noop */ }

  for (const act of autoActions) {
    const item: any = { task_code: act.taskCode, desc: act.desc };
    const before = await taskByCode(auth, env, act.taskCode).catch(() => null);
    if (!before) {
      item.status = "skipped"; item.message = "该账号无此任务";
      out.push(item);
      continue;
    }
    if (before.claimed || (before.target > 0 && before.current >= before.target)) {
      item.status = "skipped"; item.message = "已完成（" + taskProgressText(before) + "）";
      out.push(item);
      continue;
    }
    let msg: string;
    try {
      msg = await act.run(auth, env);
    } catch (e) {
      item.status = "error"; item.message = String(e);
      out.push(item);
      continue;
    }
    const isMP = isMPTaskCode(act.taskCode);
    const after = isMP
      ? await (async () => (await ListTasksMP(auth, env).catch(() => null))?.find((x) => x.task_code === act.taskCode) ?? null)()
      : await taskByCodeWaiting(auth, env, act.taskCode);
    item.status = "done";
    item.message = msg;
    item.progress_after = taskProgressText(after);
    if (after?.claimable) {
      item.claimable = true;
      try {
        const { credit, energy } = isMP ? await ClaimRewardMP(auth, env, act.taskCode) : await ClaimReward(auth, env, act.taskCode);
        item.claimed = true; item.credit = credit; item.energy = energy;
        item.message = msg + (credit > 0 || energy > 0 ? `；已自动领奖 +${credit} 分 +${energy} 能` : "；奖励此前已领取");
      } catch (e) {
        item.claim_error = String(e);
        item.message = msg + "；达标但领奖失败（可在列表手动重试）";
      }
    }
    out.push(item);
    await sleep(REPORT_GAP); // 项间节流
  }
  return out;
}

/** accountTaskAutoAll 一键完成该账号全部可自动任务。 */
export async function accountTaskAutoAll(env: Env, uid: string): Promise<any> {
  const auth = await single(env, uid);
  if (!auth) return { ok: false, error: "账号不存在" };
  const results = await runAutoAll(env, auth);
  return { ok: true, results };
}

// ---------------------------------------------------------------------------
// 任务中心（单账号，供面板展示/手动接受/领取）
// ---------------------------------------------------------------------------
export async function accountTasks(env: Env, uid: string): Promise<{ tasks: Task[] }> {
  const auth = await single(env, uid);
  if (!auth) return { tasks: [] };
  // 双口径合并（mp 列表是默认超集，仍按 task_code 去重）。
  const def = await ListTasks(auth, env).catch(() => []);
  const mp = await ListTasksMP(auth, env).catch(() => []);
  const map = new Map<string, Task>();
  for (const t of def) map.set(t.task_code, t);
  for (const t of mp) if (!map.has(t.task_code)) map.set(t.task_code, t);
  return { tasks: [...map.values()] };
}

export async function acceptTask(env: Env, uid: string, taskCode: string): Promise<any> {
  const auth = await single(env, uid);
  if (!auth) return { ok: false };
  try {
    if (isMPTaskCode(taskCode)) await AcceptTasksMP(auth, env, [taskCode]);
    else await AcceptTasks(auth, env, [taskCode]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function claimTask(env: Env, uid: string, taskCode: string): Promise<any> {
  const auth = await single(env, uid);
  if (!auth) return { ok: false };
  try {
    const r = isMPTaskCode(taskCode) ? await ClaimRewardMP(auth, env, taskCode) : await ClaimReward(auth, env, taskCode);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---- 兼容旧调用名：autoTasks(env, uid) 走全量一键完成 ----
export async function autoTasks(env: Env, uid: string): Promise<any> {
  return accountTaskAutoAll(env, uid);
}

// ---------------------------------------------------------------------------
// 定时任务（scheduler 的 Run*，由 alarms / *_all 触发）
// ---------------------------------------------------------------------------
export function runCheckin(env: Env): Promise<TaskOutcome[]> {
  return forEachAccount(env, async (auth) => {
    // 走 checkin.dailyCheckinRetry（带瞬时错误有界重试，对齐 Go retryBillingTransient）：
    // upstream.dailyCheckin 是裸调用，签到后偶发 500 会让该账号整天漏签。
    const ci = await dailyCheckinRetry(env, auth);
    // 签到后立刻查余额：签到成功的账号余额已变，池内台账必须同步（否则成本台账
    // 的内插扣减基于过期余额，积分保底也会误判触底）。已签（14001）同样刷新。
    const cr = await refreshCredits(env, auth);
    return { ...ci, credits: cr.credits, creditsTotal: cr.creditsTotal };
  });
}
export function runBalance(env: Env): Promise<TaskOutcome[]> {
  return forEachAccount(env, async (auth) => {
    const cr = await refreshCredits(env, auth);
    return { credits: cr.credits, creditsTotal: cr.creditsTotal };
  });
}
export async function runTravel(env: Env): Promise<TaskOutcome[]> {
  return forEachAccount(env, async (auth) => {
    const st = await TravelStatus(auth, env);
    if (st.state === "arrived" && st.record_id) {
      const credit = await TravelClaim(auth, env, st.record_id);
      return { action: "claim", credit };
    }
    if (!st.daily_limit_reached && st.state === "idle") {
      await TravelDepart(auth, env, 1);
      return { action: "depart" };
    }
    return { action: "skip", state: st.state };
  });
}
export function runActivity(env: Env): Promise<TaskOutcome[]> {
  return forEachAccount(env, (auth) => ReportChatActivity(auth, env, `wb2api-activity-${Date.now()}`, ""));
}
export function runKeepalive(env: Env): Promise<TaskOutcome[]> {
  return forEachAccount(env, async (auth) => {
    const base = basesFor(auth.realm, env);
    const res = await fetch(base.chat + "/v2/plugin/auth/keepalive", { headers: { Authorization: "Bearer " + auth.accessToken } });
    return { status: res.status };
  });
}
export function runNightOwl(env: Env): Promise<TaskOutcome[]> {
  // 夜猫子：用 glm-5.2 发极小对话补足活跃（窗口外跳过）。
  if (!InNightWindow()) return Promise.resolve([]);
  return forEachAccount(env, async (auth) => {
    const tasks = await ListTasks(auth, env);
    const t = tasks.find((x) => x.task_code === "black_cat");
    const need = !t || t.claimed || t.current >= t.target ? 0 : t.target - t.current;
    if (need <= 0) return { skipped: true };
    const ok = await RunNightChats(auth, env, need, ReportChatActivityModel);
    return { done: ok };
  });
}
export function runGrowth(env: Env): Promise<TaskOutcome[]> {
  // 成长任务队列：逐项执行 mp + PC 可自动化任务（夜间队列驱动）。
  return forEachAccount(env, (auth) => runAutoAll(env, auth));
}

// ---------------------------------------------------------------------------
// CLI 能力的服务端化（cmd/credit / cmd/signin / cmd/trial）
//
// Go 侧这三个命令是「遍历本地 auths/ 目录的独立二进制」。Workers 下账号池在
// Durable Objects 里、凭证在 Secrets，没有本地目录可遍历 —— 于是能力上移为
// 服务端批量操作 + 瘦客户端调HTTP，行为与输出口径保持一致。
// ---------------------------------------------------------------------------

/**
 * runCreditReport 积分日报：逐账号查余额聚合成全池账目（对齐 cmd/credit）。
 * 单账号失败不影响全局（失败行进accounts 且不计入 total）。
 */
export async function runCreditReport(env: Env, realm?: string): Promise<CreditReport> {
  const rows = await forEachAccountDetail(env, (auth) => fetchUserResourceSafe(env, auth), realm);
  return summarizeReport(rows);
}

/** forEachAccountDetail 遍历账号执行 fn，fn 永不抛错（返回带 ok/error 的明细）。 */
async function forEachAccountDetail<T extends { ok: boolean; error?: string }>(
  env: Env,
  fn: (auth: Auth) => Promise<T>,
  realm?: string,
): Promise<T[]> {
  const list = (await poolRPC(env, "/internal/list")) as any[];
  const out: T[] = [];
  for (const a of list) {
    if (realm && a.realm !== realm) continue;
    try {
      out.push(await fn(a.auth as Auth));
    } catch (e: any) {
      // fn 声称不抛错也兜一层：批量报表不该被单账号异常整体带崩。
      out.push({ ok: false, error: String(e?.message ?? e) } as T);
    }
  }
  return out;
}

/**
 * runTrialBatch 批量领取 global trial 加油包（对齐 cmd/trial）。
 * CN 账号在 claimTrialFor 内短路为 N/A，不发任何请求。
 */
export async function runTrialBatch(env: Env): Promise<{ rows: TrialOutcome[]; summary: TrialSummary }> {
  const list = (await poolRPC(env, "/internal/list")) as any[];
  const rows: TrialOutcome[] = [];
  for (const a of list) {
    try {
      rows.push(await claimTrialFor(env, a.auth as Auth));
    } catch (e: any) {
      rows.push({
        uid: a.uid ?? "",
        nickname: a.nickname ?? "",
        realm: a.realm ?? "cn",
        status: "FAIL",
        detail: String(e?.message ?? e),
      });
    }
  }
  return { rows, summary: summarizeTrial(rows) };
}

export { prettyReport, type CreditAccount, type CreditReport };