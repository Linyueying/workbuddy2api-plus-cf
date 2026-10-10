import { describe, it, expect, vi, afterEach } from "vitest";
import { runCheckin, reportTask, reportTaskOne } from "../src/services/tasks";
import type { Env } from "../worker-configuration.d.ts";

// 任务日志（channel="task"）回归守卫。
//
// 背景：面板日志视图有 全部/任务/对话/系统 四个频道，分别对应 request_logs.channel
// 的 task/chat/sys。但整个代码库原先只有 proxy.ts 写日志且硬编码 channel="chat",
// 于是「任务」频道恒空——自动签到、保活、旅行巡检这些后台真正在干活的动作一条不留，
// 用户报的就是这个：「签到不会进任务日志」。
//
// 这里断言的是**写入行为本身**：签到跑完后确实往 request_logs 落了 channel="task"
// 的行，且 outcome/uid/msg 语义正确。不复制实现细节。

/** 捕获通过 WB2A_DB 写入 request_logs 的行（按 INSERT 列序还原成对象）。 */
function captureLogs() {
  const rows: any[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: any[]) {
          return {
            async run() {
              if (/INSERT INTO request_logs/i.test(sql)) {
                rows.push({
                  ts: params[0], channel: params[1], client_ip: params[2], user_agent: params[3],
                  uid: params[4], model: params[5], realm: params[6], outcome: params[7],
                  status: params[8], ms: params[9], msg: params[10],
                  prompt_tokens: params[11], completion_tokens: params[12],
                  credits: params[13], cache_read_tokens: params[14],
                });
              }
              return { meta: { last_row_id: rows.length } };
            },
          };
        },
      };
    },
  };
  return { rows, db };
}

function fakeEnv(db: any, accounts: any[] = [{ uid: "u1", realm: "cn" }]) {
  const kv = {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  };
  const poolStub = {
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname === "/internal/list") {
        return new Response(JSON.stringify(accounts), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return {
    POOL: { get: () => poolStub, idFromName: () => ({}) },
    WB2A_CONFIG: kv, WB2A_CACHE: kv, WB2A_DB: db, WB2A_LOGS: {},
  } as unknown as Env;
}

const AUTH = {
  accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 1e9,
  domain: "copilot.tencent.com", realm: "cn", uid: "u1", enterpriseId: "e", nickname: "n",
};

describe("任务日志（channel=task）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("签到成功后写入一条 channel=task 日志", async () => {
    const { rows, db } = captureLogs();
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      const url = (req as any).url as string;
      if (url.includes("daily-checkin")) return new Response(JSON.stringify({ code: 0, msg: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("get-user-resource")) return new Response(JSON.stringify({ credits: 10, creditsTotal: 100 }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));

    await runCheckin(fakeEnv(db, [{ uid: "u1", realm: "cn", auth: AUTH }]));

    expect(rows.length, "签到没有写任务日志").toBe(1);
    expect(rows[0].channel).toBe("task");
    expect(rows[0].uid).toBe("u1");
    expect(rows[0].outcome).toBe("ok");
    expect(rows[0].msg).toContain("签到");
  });

  it("今日已签（幂等成功）记 ok，不写成失败", async () => {
    const { rows, db } = captureLogs();
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      const url = (req as any).url as string;
      // 14001 = 今天已签到
      if (url.includes("daily-checkin")) return new Response(JSON.stringify({ code: 14001, msg: "今天已签到" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("get-user-resource")) return new Response(JSON.stringify({ credits: 10 }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));

    await runCheckin(fakeEnv(db, [{ uid: "u1", realm: "cn", auth: AUTH }]));

    expect(rows.length).toBe(1);
    expect(rows[0].channel).toBe("task");
    // 已签到是幂等成功，绝不能记为错误——否则日志里全是假故障
    expect(rows[0].outcome).toBe("ok");
    expect(rows[0].msg).toMatch(/已签/);
  });

  it("签到失败记 error 并带出原因", async () => {
    const { rows, db } = captureLogs();
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      const url = (req as any).url as string;
      if (url.includes("daily-checkin")) return new Response("boom", { status: 500 });
      if (url.includes("get-user-resource")) return new Response(JSON.stringify({ credits: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 500 });
    }));

    await runCheckin(fakeEnv(db, [{ uid: "u9", realm: "cn", auth: AUTH }]));

    expect(rows.length).toBe(1);
    expect(rows[0].channel).toBe("task");
    expect(rows[0].outcome).toBe("error");
    expect(rows[0].uid).toBe("u9");
    // dailyCheckinRetry 走 withBillingRetry（瞬时错误有界重试 + 退避），
    // 单账号跑完要等若干轮退避，默认 5s 不够。放宽超时而非改实现——
    // 重试正是这里要保住的行为（签到后偶发 500 不该让该账号整天漏签）。
  }, 20_000);

  it("日志写入失败不影响签到本身（观测设施不得拖垮任务）", async () => {
    // D1 prepare 直接抛错 → insertRequestLog 内部失败
    const brokenDb = {
      prepare() { throw new Error("D1 down"); },
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      const url = (req as any).url as string;
      if (url.includes("daily-checkin")) return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("get-user-resource")) return new Response(JSON.stringify({ credits: 5 }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));

    // 关键：不抛错，照常返回签到结果
    const out = await runCheckin(fakeEnv(brokenDb, [{ uid: "u1", realm: "cn", auth: AUTH }]));
    expect(out.length).toBe(1);
    expect(out[0].ok).toBe(true);
    errSpy.mockRestore();
  });

  it("reportTask 逐账号写行，outcome 随 ok 变化", async () => {
    const { rows, db } = captureLogs();
    await reportTask(fakeEnv(db), "测试任务", [
      { uid: "a", realm: "cn", ok: true, data: {} },
      { uid: "b", realm: "cn", ok: false, error: "炸了" },
    ], (r) => (r.ok ? "完成" : `失败：${r.error}`));

    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.channel === "task")).toBe(true);
    expect(rows.find((r) => r.uid === "a")!.outcome).toBe("ok");
    const b = rows.find((r) => r.uid === "b")!;
    expect(b.outcome).toBe("error");
    expect(b.msg).toContain("炸了");
  });

  it("reportTaskOne 写单账号日志（面板手动签到路径）", async () => {
    const { rows, db } = captureLogs();
    await reportTaskOne(fakeEnv(db), "签到", "u7", "cn", true, "签到成功，积分 3/10", 42);
    expect(rows.length).toBe(1);
    expect(rows[0].channel).toBe("task");
    expect(rows[0].uid).toBe("u7");
    expect(rows[0].outcome).toBe("ok");
    expect(rows[0].ms).toBe(42);
    expect(rows[0].msg).toContain("签到成功");
  });
});
