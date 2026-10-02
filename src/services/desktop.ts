import type { Env } from "../../worker-configuration.d.ts";
import type { Auth } from "../types";
import { basesFor, desktopFingerprint, deriveID, doJSON, DESKTOP_UA, WEB_UA, type Bases } from "./upstream";
import { extractServerRequestId, isServerRequestId, wbConvID } from "./ids";

// 桌面客户端（WorkBuddy Desktop 5.5.6）行为指纹上报（替代 internal/upstream/desktop.go）。
// 关键：不是独立端点，而是同一 POST /v2/report 上**不同客户端指纹**。
// 桌面走 chatBase(copilot.tencent.com)/v2/report + extName=workbuddy-desktop；
// web 域页面行为走 www.workbuddy.cn/v2/report；appearance/set 为独立 API。

export type DesktopEvent = Record<string, any>;

const DESKTOP_REPORT = "/v2/report";
const APPEARANCE_SET = "/v2/user-asset/appearance/set";

function desktopHeaders(auth: Auth, base: Bases, extra?: Record<string, string>): Headers {
  const h = new Headers();
  h.set("Authorization", "Bearer " + auth.accessToken);
  h.set("Accept", "application/json, text/plain, */*");
  h.set("Content-Type", "application/json;charset=UTF-8");
  h.set("User-Agent", DESKTOP_UA);
  h.set("X-Domain", base.chat);
  h.set("X-Product", "SaaS");
  if (auth.uid) h.set("X-User-Id", auth.uid);
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

/** ReportDesktopEvent 以桌面指纹批量上报事件；公共指纹注入，业务字段优先（可覆盖设备标识）。 */
export async function ReportDesktopEvent(auth: Auth, env: Env, events: DesktopEvent[]): Promise<void> {
  if (!events.length) throw new Error("desktop report: no events");
  const base = basesFor(auth.realm, env);
  const fp = desktopFingerprint(auth);
  const arr = events.map((ev) => ({ ...fp, ...ev }));
  const h = desktopHeaders(auth, base, { "X-Request-ID": deriveID(auth, "req") + (Date.now() % 1e6) });
  await doJSON(new Request(base.chat + DESKTOP_REPORT, { method: "POST", headers: h, body: JSON.stringify(arr) }));
}

const mk = (code: string, extra?: Record<string, any>): DesktopEvent => ({ eventCode: code, ...(extra ?? {}) });

/** DesktopChatSequence 一次「桌面端成功对话」完整事件链（点亮 RichMeow_Chat）。 */
export function DesktopChatSequence(conversationID: string, requestID: string, messageID: string, modelID: string, modelName: string): DesktopEvent[] {
  return [
    mk("agent_task_created", {
      source: "LOCAL", name: "working", task_target: "local", mode: "craft",
      requestModelId: modelID, requestModelName: modelName,
      has_repo: false, repo_type: "none", workspace_type: "empty",
      has_connector: false, connector_types: [], has_mention: false, mention_types: [],
      has_template: false, action: "", template_name: "",
      has_expert: false, expert_id: "", expert_name: "", expert_industry_id: "",
      has_skill: false, skill_names: [],
      conversationId: conversationID, messageId: messageID,
      buddyId: "", buddyName: "",
    }),
    mk("chat_message_send", {
      messageId: messageID + "-assistant", historyCount: 0,
      isContextTruncated: false, currentStepCount: 1,
      traceId: requestID, rootRequestId: requestID,
      parentConversationId: conversationID, agentName: "cli", agentType: "main",
    }),
    mk("chat_request_send", {
      inputLength: 24, isPlan: false, isAutoExecuteTerminal: false,
      isAutoModify: false, codebaseEnable: false, maxToken: 0,
      maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: "", mentionContextCount: 0, command: "",
      recommendId: "", skillId: "", skillCount: 0, totalCount: 0,
      traceId: requestID, rootRequestId: requestID,
      parentConversationId: conversationID, agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationID,
      "codebuddy.conversation_request_id": requestID,
    }),
    mk("chat_message_response", {
      messageId: messageID + "-assistant", responseModelId: modelID,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: "", finishReason: "stop",
      firstTokenAt: Date.now(), traceId: requestID,
      conversationId: conversationID, rootRequestId: requestID, parentConversationId: conversationID,
      agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationID,
      "codebuddy.conversation_request_id": requestID,
    }),
    mk("chat_message_status", {
      messageId: messageID + "-assistant", messageErrorCode: "0",
      traceId: requestID, rootRequestId: requestID,
      parentConversationId: conversationID, agentName: "cli", agentType: "main",
    }),
    mk("chat_request_response", {
      mode: "craft", toolCallCount: 0,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: "", finishReason: "stop",
      rootRequestId: requestID, parentConversationId: conversationID,
    }),
  ];
}

/** SetAppearanceTheme 应用外观主题（POST /v2/user-asset/appearance/set）。 */
export async function SetAppearanceTheme(auth: Auth, env: Env, resourceKey: string): Promise<void> {
  const base = basesFor(auth.realm, env);
  const h = desktopHeaders(auth, base);
  await doJSON(new Request(base.chat + APPEARANCE_SET, { method: "POST", headers: h, body: JSON.stringify({ kind: "theme", resource_key: resourceKey }) }));
}

/** DesktopBuddyAppSequence 「进入 Buddy 应用」五连事件（点亮 Buddy_App / Buddy_App_QQ）。 */
export function DesktopBuddyAppSequence(buddyID: string, buddyName: string): DesktopEvent[] {
  const m = (code: string, extra?: Record<string, any>): DesktopEvent => ({ eventCode: code, mode: "LOCAL", buddyId: buddyID, buddyName: buddyName, ...(extra ?? {}) });
  return [
    m("buddyapp_discover_click"),
    m("buddyapp_show", { elementId: buddyID, elementName: buddyName, position: 2 }),
    m("buddyapp_enter_click", { elementId: buddyID, elementName: buddyName, position: 2, isFirstPage: "1" }),
    m("buddyapp_auth_confirm_click", { elementId: buddyID, elementName: buddyName }),
    m("buddyapp_bindaccount_skip_click", { elementId: buddyID, elementName: buddyName }),
  ];
}

/** DesktopAutomationCreateEvent 「定时任务创建成功」事件（点亮 automation_1）。 */
export function DesktopAutomationCreateEvent(name: string): DesktopEvent {
  return {
    eventCode: "automated_task_create_suc", name,
    source: "manually", modelId: "fast-model", modelIsThinking: true,
    connectorCount: 0, skills: "", skillCount: 0,
    scheduleType: "once", mode: "LOCAL",
  };
}

/** ReportWebEvent 以 web 指纹上报单事件（页面行为类，如 library_doc_intro_click）。 */
export async function ReportWebEvent(auth: Auth, env: Env, eventCode: string, pageURL: string, elementID: string, elementName: string): Promise<void> {
  const base = basesFor(auth.realm, env);
  const ev = {
    eventCode, timestamp: Date.now(), reportDelay: 0,
    pageURL, elementId: elementID, elementName,
    os: "Win32", arch: "", osVersion: "10.0", userAgent: WEB_UA,
    machineId: deriveID(auth, "webmachine"), userId: auth.uid,
    userNickname: auth.nickname, enterpriseId: auth.enterpriseId,
  };
  const h = new Headers();
  h.set("Authorization", "Bearer " + auth.accessToken);
  h.set("Content-Type", "application/json");
  h.set("Accept", "application/json");
  h.set("x-client-platform", "web");
  h.set("Origin", base.web);
  h.set("Referer", pageURL);
  h.set("User-Agent", WEB_UA);
  if (auth.uid) h.set("X-User-Id", auth.uid);
  await doJSON(new Request(base.web + "/v2/report", { method: "POST", headers: h, body: JSON.stringify([ev]) }));
}

/** DesktopTemplateUseSequence 「使用模板创建任务」事件组（点亮 template_5）。 */
export function DesktopTemplateUseSequence(conversationID: string, requestID: string, templateID: string, templateName: string): DesktopEvent[] {
  const events = DesktopChatSequence(conversationID, requestID, "msg-" + templateID, "fast-model", "fast-model");
  events.push(
    mk("agent_task_created_with_template", { mode: "working", isCustomModel: false, id: templateID, name: templateName, requestId: requestID }),
    mk("template_used", { template_id: templateID, task_mode: "working" }),
  );
  return events;
}

/** DesktopPlaybookPromptSequence 「灵感案例做同款」事件组（点亮 playbook_prompt）。 */
export function DesktopPlaybookPromptSequence(conversationID: string, requestID: string, caseID: string, caseName: string): DesktopEvent[] {
  const events = DesktopChatSequence(conversationID, requestID, "msg-pb", "fast-model", "fast-model");
  const payload = { id: caseID, name: caseName, type: "document", categoryId: "", categoryName: "" };
  events.push(
    mk("web_element_click", { pageName: "playbook_detail", elementId: "playbook_ctaClick", elementName: caseName, source: "discover" }),
    mk("playbook_cta_click", { source: "discover", position: 0, ...payload }),
    mk("playbook_prompt_send", { conversationId: conversationID, requestId: requestID, ...payload }),
  );
  return events;
}

/** DesktopDesignCanvasSequence 「设计创意画布」事件组（点亮 create_canvas）。 */
export function DesktopDesignCanvasSequence(conversationID: string, requestID: string): DesktopEvent[] {
  const events = DesktopChatSequence(conversationID, requestID, "msg-canvas", "fast-model", "fast-model");
  events.push(
    mk("wbx_design_canvas_task_create", { conversationId: conversationID, requestId: requestID, source: "summon_keyword", cost: 12000, isSuccessful: true }),
    mk("wbx_design_canvas_open", { conversationId: conversationID, requestId: requestID, id: "ardot-file-" + requestID.slice(-8), source: "summon_keyword", type: "page", cost: 13000, isSuccessful: true }),
  );
  return events;
}

/** MarketExpert 专家市场的单个专家。 */
export interface MarketExpert {
  expert_id: string;
  expert_type: string;
  display_name_zh: string;
  profession_zh: string;
  version: string;
  categories?: any[];
}

/** MarketExpertList 拉取专家市场真实列表（expert_actual_use 判据要求 id 真实存在）。 */
export async function MarketExpertList(auth: Auth, env: Env, expertType: string): Promise<MarketExpert[]> {
  const base = basesFor(auth.realm, env);
  const body: Record<string, any> = { page: 1, page_size: 20, sort_by: "reco_rank", sort_order: "desc" };
  if (expertType) body.expert_type = expertType;
  const h = desktopHeaders(auth, base);
  const data = await doJSON(new Request(base.chat + "/portal/operation-platform/market/expert/list", { method: "POST", headers: h, body: JSON.stringify(body) }));
  return (data?.experts ?? []) as MarketExpert[];
}

/**
 * DesktopChatWithExpert 发一条真实桌面指纹 chat（可带 X-Expert-Id），从 SSE 解析
 * **服务端返回的 requestId**。expert_actual_use 等 JOIN 事件的 requestId 必须用它——
 * 自造 UUID 不计数。读干流避免残留连接。
 */
export async function DesktopChatWithExpert(auth: Auth, env: Env, expertID: string): Promise<{ conversationID: string; requestID: string }> {
  const base = basesFor(auth.realm, env);
  const conversationID = wbConvID();
  const body = {
    model: "fast-model",
    messages: [
      { role: "system", content: "You are a helpful assistant. 当前处于中文环境，使用简体中文回答。" },
      { role: "user", content: "1+1等于几？直接回答。" },
    ],
    agent: "cli",
    temperature: 1,
    stream: true,
    stream_options: { include_usage: true },
  };
  const h = desktopHeaders(auth, base, {
    Accept: "text/event-stream",
    "X-Conversation-ID": conversationID,
    "X-Request-ID": String(Date.now() * 1000000),
    "X-Agent-Intent": "craft",
    "X-Agent-Type": "main",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Version": "5.5.6",
    "x-codebuddy-request": "1",
    ...(expertID ? { "X-Expert-Id": expertID } : {}),
  });
  const res = await fetch(new Request(base.chat + "/v2/chat/completions", { method: "POST", headers: h, body: JSON.stringify(body) }));
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`chat http ${res.status}: ${t.slice(0, 200)}`);
  }
  // 读干流（最多 1MB），从中抓首个服务端 id。
  const reader = res.body?.getReader();
  if (!reader) throw new Error("SSE 中未找到服务端 requestId");
  const dec = new TextDecoder();
  let buf = "";
  const limit = 1 << 20;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const id = extractServerRequestId(buf);
    if (id && isServerRequestId(id)) {
      try { await reader.cancel(); } catch { /* noop */ }
      return { conversationID, requestID: id };
    }
    if (buf.length > limit) break;
  }
  throw new Error("SSE 中未找到服务端 requestId");
}

function expertCat(e: MarketExpert): string {
  const c = e.categories?.[0];
  return typeof c === "string" ? c : "expert-all";
}
function expertVer(e: MarketExpert): string {
  return e.version || "1.0.0";
}

/** DesktopExpertSummonSequence 「召唤平台专家」事件组。 */
export function DesktopExpertSummonSequence(e: MarketExpert): DesktopEvent[] {
  const cat = expertCat(e);
  const ver = expertVer(e);
  return [
    {
      eventCode: "web_element_click", source: e.expert_id, type: cat, version: ver,
      elementId: "expert_summon_click", elementName: "立即召唤",
      pageURL: "/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html",
    },
    {
      eventCode: "expert_summon_click", id: e.expert_id, name: e.display_name_zh,
      expertTitle: e.profession_zh, type: "expert-all", position: 0,
      expertType: e.expert_type, version: ver, mode: "LOCAL",
    },
    {
      eventCode: "expert_summoned", id: e.expert_id, name: e.display_name_zh,
      expertTitle: e.profession_zh, type: "expert-all",
    },
  ];
}

function expertActualUse(e: MarketExpert, conversationID: string, requestID: string): DesktopEvent {
  return {
    eventCode: "expert_actual_use",
    id: e.expert_id, name: e.display_name_zh, expertTitle: e.profession_zh,
    type: expertCat(e), expertType: e.expert_type, source: "builtin", version: expertVer(e),
    cost: 9000, characterCount: 14,
    conversationId: conversationID, requestId: requestID, messageId: "msg-" + requestID.slice(-8),
    requestModelId: "fast-model", requestModelName: "fast-model",
  };
}

/** DesktopExpertActualUseEvent mode=craft 变体（expert_5 / Expert_team_use_3 计数）。 */
export function DesktopExpertActualUseEvent(e: MarketExpert, conversationID: string, requestID: string): DesktopEvent {
  return { ...expertActualUse(e, conversationID, requestID), mode: "craft" };
}

/** DesktopExpertActualUseLocal mode=LOCAL 变体（Expert_lighthouse 判据）。 */
export function DesktopExpertActualUseLocal(e: MarketExpert, conversationID: string, requestID: string): DesktopEvent {
  return { ...expertActualUse(e, conversationID, requestID), mode: "LOCAL" };
}