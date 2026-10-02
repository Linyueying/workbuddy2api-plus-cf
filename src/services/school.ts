import type { Env } from "../../worker-configuration.d.ts";
import type { Auth } from "../types";
import { basesFor, doJSON, mpEventBase } from "./upstream";
import { clientToken } from "./ids";

// 小程序口径事件上报（替代 internal/upstream/school.go 的 mp 侧）：
// ReportMPEvent 以小程序指纹向 {billingBaseCN}/v2/report 批量上报。
// 事件构造：SchoolChatTimesEvents / SchoolSeasonChatEvent / MiniExpertUseEvent /
// MiniChatModelEvent / MiniPlaybookEvents。

const MP_REPORT = "/v2/report";

/** schoolOpenDayActivityID 开学季/校园日活动 id（事件 activityId 字段值，两域共用）。 */
export const SCHOOL_OPEN_DAY_ACTIVITY_ID = "school_open_day_2026";

/** ReportMPEvent 以小程序指纹批量上报事件（base 注入，业务字段优先）。 */
export async function ReportMPEvent(auth: Auth, env: Env, events: Record<string, any>[]): Promise<void> {
  if (!events.length) throw new Error("mp report: no events");
  const base = mpEventBase(auth);
  const arr = events.map((ev) => ({ ...base, ...ev }));
  const billingCN = basesFor("cn", env).billing;
  const h = new Headers();
  h.set("Authorization", "Bearer " + auth.accessToken);
  h.set("Content-Type", "application/json");
  h.set("Accept", "application/json");
  if (auth.uid) h.set("X-User-Id", auth.uid);
  h.set("X-Client-Product", "workbuddy-mp");
  h.set("X-Client-Version", "2.4.0");
  h.set("X-Client-Platform", "mp-weixin");
  h.set("X-Platform", "wechatmp");
  await doJSON(new Request(billingCN + MP_REPORT, { method: "POST", headers: h, body: JSON.stringify(arr) }));
}

/** SchoolChatTimesEvents 构造一条 mp chat_request_send 事件（chat_3_times 计数）。 */
export function SchoolChatTimesEvents(conversationID: string): Record<string, any> {
  const rid = "wb2api-" + clientToken();
  return {
    eventCode: "chat_request_send",
    inputLength: 14, isPlan: false, isAutoExecuteTerminal: false,
    isAutoModify: false, codebaseEnable: false, maxToken: 0,
    maxSteps: 500, temperature: 0, maxRetries: 0,
    mentionContexts: [], knowledgeId: [], knowledgeName: [],
    codebaseId: "", mentionContextCount: 0, command: "",
    recommendId: "", skillId: "", skillCount: 0, totalCount: 0,
    traceId: rid, rootRequestId: rid,
    parentConversationId: conversationID, conversationId: conversationID,
    messageId: "msg-" + rid.slice(-8),
    agentName: "mp", agentType: "main",
    "codebuddy.session_id": conversationID,
    "codebuddy.conversation_request_id": rid,
  };
}

/** SchoolSeasonChatEvent 「校园日」判据事件：mp chat + activityId=school_open_day_2026。 */
export function SchoolSeasonChatEvent(conversationID: string): Record<string, any> {
  return { ...SchoolChatTimesEvents(conversationID), activityId: SCHOOL_OPEN_DAY_ACTIVITY_ID };
}

/**
 * MiniExpertUseEvent Sequential_Tasks_2「小程序内选中专家并对话」判据：mp 指纹
 * expert_actual_use。不带 conversationId/activityId；extVersion=2.2.8；
 * source=mini_program + type="send_message"。expertID 必须是市场真实 ex_ id。
 */
export function MiniExpertUseEvent(expertID: string, expertName: string, expertType: string): Record<string, any> {
  return {
    eventCode: "expert_actual_use", reportDelay: 0,
    extVersion: "2.2.8", source: "mini_program",
    id: expertID, name: expertID,
    expertTitle: expertName || expertID, type: "send_message",
    characterCount: 12, expertType: expertType || "agent",
  };
}

/** MiniChatModelEvent mp 对话事件 + 模型字段（Sequential_Tasks_5 判据载体）。 */
export function MiniChatModelEvent(conversationID: string, modelID: string, modelName: string): Record<string, any> {
  return { ...SchoolChatTimesEvents(conversationID), requestModelId: modelID, requestModelName: modelName };
}

/** MiniPlaybookEvents mp 指纹灵感事件组（Sequential_Tasks_7 判据载体）。 */
export function MiniPlaybookEvents(caseID: string, caseName: string): Record<string, any>[] {
  const base = { id: caseID, name: caseName, type: "document", categoryId: "", categoryName: "", skills: "", skillNames: "" };
  return [
    { eventCode: "playbook_cta_click", source: "discover", position: 1, extVersion: "2.2.8", ...base },
    { eventCode: "playbook_prompt_send", source: "discover", promptLength: 96, isOfficial: 1, conversationId: "wb2api-mp-pb-" + clientToken(), extVersion: "2.2.8", ...base },
  ];
}