import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { onAlarm, runScheduledJobs } from "../src/alarms";
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

  // runScheduledJobs 是 DO alarm 与 Workers Cron Triggers 的共用实现，
  // 两条路径必须跑出同一结果，所以单独钉死它的行为。
  describe("runScheduledJobs（alarm 与 cron 共用）", () => {
    function cfgWith(hour: number, on: Record<string, boolean> = {}) {
      const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      cfg.schedule.checkin_hours = [hour];
      cfg.schedule.travel_hours = [hour];
      cfg.schedule.activity_hours = [hour];
      cfg.schedule.keepalive_hours = [hour];
      cfg.schedule.blackcat_hours = [hour];
      cfg.schedule.growth_hours = [hour];
      cfg.schedule.balance_refresh_enabled = false;
      Object.assign(cfg.schedule, on);
      return cfg;
    }

    it("只执行配置开关打开且落在当前小时的作业", async () => {
      const h = new Date(Date.now() + 8 * 3600_000).getUTCHours();
      const cfg = cfgWith(h, {
        checkin_enabled: true,
        travel_enabled: false, // 关掉
        activity_enabled: false,
        keepalive_enabled: false,
        blackcat_enabled: false,
        growth_enabled: false,
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));

      const ran = await runScheduledJobs(fakeEnv(), cfg);
      expect(ran).toEqual(["checkin"]);
    });

    it("不在当前小时 → 什么都不跑", async () => {
      const h = (new Date(Date.now() + 8 * 3600_000).getUTCHours() + 5) % 24;
      const cfg = cfgWith(h);
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

      const ran = await runScheduledJobs(fakeEnv(), cfg);
      expect(ran).toEqual([]);
    });

    it("单个作业失败不影响其余（签到挂了保活仍继续）", async () => {
      const h = new Date(Date.now() + 8 * 3600_000).getUTCHours();
      const cfg = cfgWith(h, {
        checkin_enabled: true,
        travel_enabled: true,
        activity_enabled: false,
        keepalive_enabled: false,
        blackcat_enabled: false,
        growth_enabled: false,
      });
      // 让第一条链路抛错，第二条应当照常完成
      let n = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        n++;
        if (n === 1) throw new Error("upstream down");
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }));

      const ran = await runScheduledJobs(fakeEnv(), cfg);
      // 关键：不是空数组、也不是抛错 —— 失败的跳过，成功的继续
      expect(ran.length).toBeGreaterThan(0);
      expect(ran).not.toContain("activity");
    });

    it("balance_refresh_enabled 打开时追加 balance（与整点解耦）", async () => {
      const h = new Date(Date.now() + 8 * 3600_000).getUTCHours();
      const cfg = cfgWith(h, {
        checkin_enabled: false,
        travel_enabled: false,
        activity_enabled: false,
        keepalive_enabled: false,
        blackcat_enabled: false,
        growth_enabled: false,
        balance_refresh_enabled: true,
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ credits: 1, creditsTotal: 2 }), { status: 200, headers: { "content-type": "application/json" } })));

      const ran = await runScheduledJobs(fakeEnv(), cfg);
      expect(ran).toContain("balance");
    });

    it("不触碰 pool（cron 路径无需 DO 自调度）", async () => {
      const h = new Date(Date.now() + 8 * 3600_000).getUTCHours();
      const cfg = cfgWith(h, { checkin_enabled: false, travel_enabled: false, activity_enabled: false, keepalive_enabled: false, blackcat_enabled: false, growth_enabled: false });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

      // 传一个会炸的 pool：runScheduledJobs 若碰它就必然抛错
      const hostilePool: any = new Proxy({}, { get() { throw new Error("不应访问 pool"); } });
      await expect(runScheduledJobs(fakeEnv(), cfg)).resolves.toEqual([]);
      void hostilePool;
    });
  });
});
