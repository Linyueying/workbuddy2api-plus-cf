import type { Env } from "../../worker-configuration.d.ts";
import type { Auth } from "../types";
import { billingJSON } from "./upstream";

// growth 域「对话活跃上报」（替代 internal/upstream/report.go）：
// POST {billingBase}/v2/report。照抄客户端 chat_request_send 事件全字段
// （勿用最小 3 字段，防上游加严）。事件必带 userId（=账号 uid），缺失服务端 200 但静默丢弃。
// 一条上报同时点亮 growth 连登 + 解锁 first_buddy（领养前置）。

/** ReportChatActivity 上报一条对话活跃（默认 deepseek 模型）。 */
export async function ReportChatActivity(auth: Auth, env: Env, conversationID: string, requestID: string): Promise<void> {
  await ReportChatActivityModel(auth, env, conversationID, requestID, "deepseek-v4-flash", "DeepSeek V4 Flash");
}

/**
 * ReportChatActivityModel 同上但可指定模型：供「体验某模型」类任务对齐实际模型
 * （Model_chat_GLM5.2 需 requestModelId=glm-5.2 与独立 requestID）。
 */
export async function ReportChatActivityModel(
  auth: Auth,
  env: Env,
  conversationID: string,
  requestID: string,
  modelID: string,
  modelName: string,
): Promise<void> {
  const rid = requestID || conversationID;
  const mid = modelID || "deepseek-v4-flash";
  const mname = modelName || mid;
  const now = Date.now();
  const ev = {
    eventCode: "chat_request_send",
    timestamp: now,
    reportDelay: 0,
    mode: "craft",
    conversationId: conversationID,
    requestId: rid,
    inputLength: 12,
    requestModelId: mid,
    requestModelName: mname,
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: "",
    mentionContextCount: 0,
    command: "",
    expertId: "",
    recommendId: "",
    skillId: "",
    skillCount: 0,
    totalCount: 0,
    fileUri: "",
    presentAt: now,
    traceId: "",
    rootRequestId: rid,
    parentConversationId: conversationID,
    agentName: "default",
    agentType: "conversation",
    userId: auth.uid,
  };
  await billingJSON(auth, env, "POST", "/v2/report", [ev]);
}