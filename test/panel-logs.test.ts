import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildApp } from "../src/router";
import { requestLogLine } from "../src/routes/panel";
import { invalidateConfig } from "../src/config";
import type { Env } from "../worker-configuration.d.ts";

// /panel/api/logs 的字段口径。
//
// 前端 vendor 的 loadLogs 按 Go 版口径消费：e.ch 筛频道（chat/task/sys）、
// e.text 渲染正文并按关键词（错误/失败→红，冷却/熔断→黄）着色。cf 版之前
// 返回 { channel, msg }，前端整页渲染成 "undefined 00:54:02 undefined"
// （真机截图实锤）。这组测试钉死 { ts, ch, text } 口径，防止再漂。

function mkEnv(rows: unknown[]) {
  const kv = new Map<string, string>();
  return {
    WB2A_CONFIG: {
      put: async (k: string, v: string) => void kv.set(k, v),
      get: async (k: string, opts?: any) => {
        const raw = kv.get(k);
        if (raw == null) return null;
        if (opts?.type === "json") return JSON.parse(raw);
        return raw;
      },
      delete: async (k: string) => void kv.delete(k),
    },
    WB2A_CACHE: { put: async () => {}, get: async () => null, delete: async () => {} },
    WB2A_DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: rows }),
          first: async () => null,
          run: async () => ({ meta: { changes: 0, last_row_id: 0 } }),
        }),
      }),
    },
    WB2A_LOGS: {},
    POOL: {
      get: () => ({ fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) }),
      idFromName: () => ({}),
    },
    ASSETS: { fetch: async () => new Response("ok") },
  } as unknown as Env;
}

function app(): any {
  const a = new Hono<{ Bindings: Env }>();
  buildApp(a as any);
  return a;
}

const bearer = { Authorization: "Bearer k" };

describe("requestLogLine 文本拼接", () => {
  it("成功请求：结果 · 模型 · 账号 · 状态 · 耗时 · token · 积分", () => {
    const s = requestLogLine({
      outcome: "success", model: "gpt-4.1", uid: "uid-aaaabbbbcccc1111",
      status: 200, ms: 3100, prompt_tokens: 1000, completion_tokens: 500, credits: 1.5,
    });
    expect(s).toContain("成功");
    expect(s).toContain("gpt-4.1");
    expect(s).toContain("uid=uid-aaaa"); // 截前 8 位
    expect(s).toContain("HTTP 200");
    expect(s).toContain("3.1s");
    expect(s).toContain("1.5k tok");
    expect(s).toContain("积分 1.50");
    expect(s).not.toContain("undefined");
  });

  it("outcome 中文口径与前端着色规则联动：错误/失败命中红色关键词", () => {
    expect(requestLogLine({ outcome: "http_error", status: 502 })).toContain("HTTP 错误");
    expect(requestLogLine({ outcome: "stream_error" })).toContain("流错误");
    // interrupted 不含「错误/失败」，不会误染红——中断是正常竞态不是故障
    const s = requestLogLine({ outcome: "interrupted" });
    expect(s).toContain("中断");
    expect(/error|失败|错误/.test(s)).toBe(false);
  });

  it("空字段全部跳过，绝不出现 undefined 字面量", () => {
    const s = requestLogLine({ outcome: "success" });
    expect(s).toBe("成功");
    expect(s).not.toContain("undefined");
    expect(s).not.toContain("null");
  });
});

describe("GET /panel/api/logs 字段口径", () => {
  beforeEach(() => invalidateConfig());

  it("返回 { ts, ch, text }（Go 版口径），不返回 channel/msg", async () => {
    const rows = [
      {
        id: 1, ts: 1791128000000, channel: "chat", outcome: "success",
        model: "cn:glm-5.2", uid: "uid-aaaabbbbcccc1111", status: 200, ms: 1200,
        prompt_tokens: 100, completion_tokens: 200, credits: 0.5,
      },
      {
        id: 2, ts: 1791127900000, channel: "sys", outcome: "http_error",
        model: null, uid: null, status: 502, ms: 300,
        prompt_tokens: 0, completion_tokens: 0, credits: 0,
      },
    ];
    const env = mkEnv(rows);
    // 未设 admin_key 时面板认 api_key（panel-auth-split 的既有口径）
    await (env as any).WB2A_CONFIG.put("config", JSON.stringify({ api_key: "k" }));
    const res = await app().fetch(new Request("https://x/panel/api/logs", { headers: bearer }), env);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.entries).toHaveLength(2);
    for (const e of j.entries) {
      expect(Object.keys(e).sort()).toEqual(["ch", "text", "ts"]);
      expect(e.ch).not.toBeUndefined();
      expect(e.text).not.toContain("undefined");
    }
    expect(j.entries[0].ch).toBe("chat");
    expect(j.entries[0].text).toContain("成功");
    expect(j.entries[1].ch).toBe("sys");
    expect(j.entries[1].text).toContain("HTTP 错误");
  });

  it("channel 缺失时兜底 sys（老行 / 手写行不至于渲染成 undefined 频道）", async () => {
    const env = mkEnv([{ id: 3, ts: 1, channel: null, outcome: "success" }]);
    await (env as any).WB2A_CONFIG.put("config", JSON.stringify({ api_key: "k" }));
    const res = await app().fetch(
      new Request("https://x/panel/api/logs", { headers: bearer }),
      env,
    );
    const j: any = await res.json();
    expect(j.entries[0].ch).toBe("sys");
  });
});
