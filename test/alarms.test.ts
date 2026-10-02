import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { onAlarm } from "../src/alarms";
import { DEFAULT_CONFIG } from "../src/config";
import type { Env } from "../worker-configuration.d.ts";

function fakeKV() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
  };
}

function fakeEnv() {
  const kv = fakeKV();
  const poolStub = {
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname === "/internal/list") {
        return new Response(JSON.stringify([{ uid: "u1", realm: "cn", auth: { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 1e9, domain: "copilot.tencent.com", realm: "cn", uid: "u1", enterpriseId: "e", nickname: "n" } }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  return {
    POOL: { get: () => poolStub, idFromName: () => ({}) },
    WB2A_CONFIG: kv,
    WB2A_CACHE: kv,
    WB2A_DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
    WB2A_LOGS: {},
  } as unknown as Env;
}

describe("alarms", () => {
  beforeEach(() => {});
  afterEach(() => vi.unstubAllGlobals());

  it("onAlarm 按整点执行任务并自调度下一个 alarm", async () => {
    const setAlarm = vi.fn(async () => {});
    const fakePool: any = { ctx: { storage: { setAlarm } }, scheduleNextAlarm: () => setAlarm() };
    // 把当前小时纳入触发窗口，确保任务被执行
    const h = new Date(Date.now() + 8 * 3600_000).getUTCHours();
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    cfg.schedule.checkin_hours = [h];
    cfg.schedule.travel_hours = [h];
    cfg.schedule.balance_refresh_enabled = true;

    const fetchMock = vi.fn(async (req: Request) => {
      const url = (req as any).url as string;
      if (url.includes("/daily-checkin")) return new Response(JSON.stringify({ credits: 1, creditsTotal: 2 }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/get-user-resource")) return new Response(JSON.stringify({ credits: 1, creditsTotal: 2 }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await onAlarm(fakeEnv(), fakePool, cfg);
    expect(setAlarm).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalled(); // 真实调用了上游签到/余额
  });
});
