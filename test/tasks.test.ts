import { describe, it, expect, vi } from "vitest";
import {
  DesktopChatSequence, DesktopAutomationCreateEvent, DesktopBuddyAppSequence,
  DesktopTemplateUseSequence, DesktopPlaybookPromptSequence, DesktopDesignCanvasSequence,
  DesktopExpertSummonSequence, DesktopExpertActualUseEvent, DesktopExpertActualUseLocal,
} from "../src/services/desktop";
import { SchoolChatTimesEvents, SchoolSeasonChatEvent, MiniExpertUseEvent, MiniChatModelEvent, MiniPlaybookEvents, SCHOOL_OPEN_DAY_ACTIVITY_ID } from "../src/services/school";
import { ReportChatActivity, ReportChatActivityModel } from "../src/services/report";
import { extractServerRequestId, isServerRequestId, clientToken, newMessageID } from "../src/services/ids";
import { primeConfig } from "../src/services/upstream";
import type { Env } from "../worker-configuration.d.ts";
import type { Auth } from "../src/types";

function fakeEnv() {
  const kv = {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  };
  return { WB2A_CONFIG: kv, WB2A_CACHE: kv } as unknown as Env;
}

function auth(realm: "cn" | "global" = "cn"): Auth {
  return {
    accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 3600_000,
    domain: "copilot.tencent.com", realm, uid: "u_1", enterpriseId: "e1", nickname: "Tom",
  };
}

function json(body: any) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ids", () => {
  it("extractServerRequestId 抓 cmb- / 裸 32hex 服务端 id", () => {
    expect(extractServerRequestId('data: {"id":"cmb-' + "a".repeat(32) + '"}')).toBe("cmb-" + "a".repeat(32));
    expect(extractServerRequestId('data: {"id":"' + "b".repeat(32) + '"}')).toBe("b".repeat(32));
  });
  it("忽略非 32hex 的消息 id（searchFrom 推进）", () => {
    const s = 'data: {"id":"msg-short"} data: {"id":"' + "c".repeat(32) + '"}';
    expect(extractServerRequestId(s)).toBe("c".repeat(32));
    expect(isServerRequestId("msg-short")).toBe(false);
  });
  it("clientToken / newMessageID 形态正确", () => {
    expect(clientToken()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(newMessageID()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("desktop 事件构造", () => {
  it("DesktopChatSequence 产出 6 事件链且含成功回执", () => {
    const evs = DesktopChatSequence("conv1", "req1", "msg1", "fast-model", "fast-model");
    expect(evs).toHaveLength(6);
    const codes = evs.map((e) => e.eventCode);
    expect(codes).toContain("agent_task_created");
    expect(codes).toContain("chat_message_response");
    const resp = evs.find((e) => e.eventCode === "chat_message_response")!;
    expect(resp.isSuccessful).toBe(true);
    // 所有事件都应带 conversationId 关联
    expect(resp.conversationId).toBe("conv1");
  });

  it("DesktopBuddyAppSequence 五连事件", () => {
    const evs = DesktopBuddyAppSequence("cb_x", "企鹅教师助手");
    expect(evs).toHaveLength(5);
    expect(evs[0].eventCode).toBe("buddyapp_discover_click");
    expect(evs[4].eventCode).toBe("buddyapp_bindaccount_skip_click");
  });

  it("DesktopAutomationCreateEvent / 模板 / 灵感 / 画布 序列", () => {
    expect(DesktopAutomationCreateEvent("x").eventCode).toBe("automated_task_create_suc");
    const tpl = DesktopTemplateUseSequence("c", "r", "1", "深度研究");
    expect(tpl.some((e) => e.eventCode === "template_used")).toBe(true);
    const pb = DesktopPlaybookPromptSequence("c", "r", "pm", "case");
    expect(pb.some((e) => e.eventCode === "playbook_prompt_send")).toBe(true);
    const cv = DesktopDesignCanvasSequence("c", "req-12345678");
    expect(cv.some((e) => e.eventCode === "wbx_design_canvas_task_create")).toBe(true);
  });

  it("专家召唤 + actual_use（craft / LOCAL 两变体）", () => {
    const e = { expert_id: "ex_1", expert_type: "agent", display_name_zh: "专家", profession_zh: "prof", version: "1.0.0" };
    const summon = DesktopExpertSummonSequence(e);
    expect(summon).toHaveLength(3);
    const use = DesktopExpertActualUseEvent(e, "c", "a".repeat(32));
    expect(use.mode).toBe("craft");
    expect(DesktopExpertActualUseLocal(e, "c", "a".repeat(32)).mode).toBe("LOCAL");
  });
});

describe("school(mp) 事件构造", () => {
  it("SchoolChatTimesEvents 基础形状", () => {
    const ev = SchoolChatTimesEvents("conv-mp");
    expect(ev.eventCode).toBe("chat_request_send");
    expect(ev.conversationId).toBe("conv-mp");
    expect(ev.extName).toBeUndefined();
  });
  it("SchoolSeasonChatEvent 带 activityId", () => {
    expect(SchoolSeasonChatEvent("c").activityId).toBe(SCHOOL_OPEN_DAY_ACTIVITY_ID);
  });
  it("MiniExpertUseEvent extVersion=2.2.8 + send_message + 不带 conversationId", () => {
    const ev = MiniExpertUseEvent("ex_9", "名称", "agent");
    expect(ev.extVersion).toBe("2.2.8");
    expect(ev.type).toBe("send_message");
    expect(ev.source).toBe("mini_program");
    expect(ev.conversationId).toBeUndefined();
  });
  it("MiniChatModelEvent 带模型字段", () => {
    const ev = MiniChatModelEvent("c", "glm-5.2", "GLM-5.2");
    expect(ev.requestModelId).toBe("glm-5.2");
  });
  it("MiniPlaybookEvents 两条（cta_click + prompt_send）", () => {
    const evs = MiniPlaybookEvents("pm", "case");
    expect(evs).toHaveLength(2);
    expect(evs[1].eventCode).toBe("playbook_prompt_send");
  });
});

describe("report 活跃上报", () => {
  it("ReportChatActivityModel 发 /v2/report 且事件带 userId + 模型", async () => {
    await primeConfig(fakeEnv());
    const seen: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (req: any) => {
      const url = typeof req === "string" ? req : req.url;
      const raw = typeof req === "string" ? "" : await req.clone().text();
      seen.push({ url, body: JSON.parse(raw) });
      return json({ code: 0, data: {} });
    }));
    await ReportChatActivityModel(auth(), fakeEnv(), "conv-1", "", "glm-5.2", "GLM-5.2");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("/v2/report");
    const ev = seen[0].body[0];
    expect(ev.eventCode).toBe("chat_request_send");
    expect(ev.userId).toBe("u_1");
    expect(ev.requestModelId).toBe("glm-5.2");
    // requestID 空时回落 conversationId
    expect(ev.requestId).toBe("conv-1");
    vi.unstubAllGlobals();
  });

  it("ReportChatActivity 默认 deepseek 模型", async () => {
    await primeConfig(fakeEnv());
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (req: any) => {
      body = JSON.parse(await req.clone().text());
      return json({ code: 0, data: {} });
    }));
    await ReportChatActivity(auth(), fakeEnv(), "c-x", "");
    expect(body[0].requestModelId).toBe("deepseek-v4-flash");
    vi.unstubAllGlobals();
  });
});