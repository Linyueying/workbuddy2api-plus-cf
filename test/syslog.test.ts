import { describe, it, expect, vi, afterEach } from "vitest";
import { logSystem, logMigrated, logMigrateFailed, logAccountEvent, logSchedulerEvent } from "../src/storage/syslog";
import { describeStateChange } from "../src/durable/account-pool";
import type { Env } from "../worker-configuration.d.ts";

// 系统日志（channel="sys"）回归守卫。
//
// 背景：面板日志视图的「系统」频道对应 request_logs.channel="sys"，但此前只有
// chat（proxy）和 task（定时任务）被写入过，**sys 从未写过**。panel.ts 里
// `ch: e.channel || "sys"` 那个兜底看着像有人写 sys，其实永远不触发——
// 建表时 `channel TEXT NOT NULL DEFAULT 'chat'`，channel 永不为空。
//
// 这里断言：① 各类系统事件确实以 channel="sys" 落库；② 严重级别正确映射到
// outcome；③ describeStateChange 只挑显著跃变（不把每次失败都当系统事件）。

/** 捕获通过 WB2A_DB 写入 request_logs 的行。 */
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
                  ts: params[0], channel: params[1], uid: params[4], outcome: params[7],
                  status: params[8], ms: params[9], msg: params[10],
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

const fakeEnv = (db: any) => ({ WB2A_DB: db } as unknown as Env);

describe("系统日志（channel=sys）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("logSystem 以 channel=sys 落库，严重级别映射 outcome", async () => {
    const { rows, db } = captureLogs();
    const env = fakeEnv(db);
    await logSystem(env, "info", "test", "普通信息");
    await logSystem(env, "warn", "test", "警告信息");
    await logSystem(env, "error", "test", "错误信息");

    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.channel === "sys"), "没有写 sys 频道").toBe(true);
    // info/warn 不算失败，只有 error 才是 error——日志行着色据此变化
    expect(rows[0].outcome).toBe("ok");
    expect(rows[1].outcome).toBe("ok");
    expect(rows[2].outcome).toBe("error");
    expect(rows[0].msg).toContain("[test]");
  });

  it("迁移真有 DDL 变更时留痕，包含建表/加列", async () => {
    const { rows, db } = captureLogs();
    await logMigrated(fakeEnv(db), ["apikeys", "request_logs"], ["quota_limit"]);
    expect(rows.length).toBe(1);
    expect(rows[0].channel).toBe("sys");
    expect(rows[0].msg).toContain("建表");
    expect(rows[0].msg).toContain("apikeys");
    expect(rows[0].msg).toContain("加列");
    expect(rows[0].msg).toContain("quota_limit");
  });

  it("迁移失败记 error（这是最该被看到的系统事件）", async () => {
    const { rows, db } = captureLogs();
    await logMigrateFailed(fakeEnv(db), "D1 不可用");
    expect(rows.length).toBe(1);
    expect(rows[0].channel).toBe("sys");
    expect(rows[0].outcome).toBe("error");
    expect(rows[0].msg).toContain("自动迁移失败");
    expect(rows[0].msg).toContain("D1 不可用");
  });

  it("账号事件带上 uid 前 8 位", async () => {
    const { rows, db } = captureLogs();
    await logAccountEvent(fakeEnv(db), "warn", "uid-1234567890abcdef", "进入熔断");
    expect(rows.length).toBe(1);
    expect(rows[0].channel).toBe("sys");
    expect(rows[0].msg).toContain("uid=uid-1234");
    expect(rows[0].msg).toContain("进入熔断");
  });

  it("调度事件落 sys 频道", async () => {
    const { rows, db } = captureLogs();
    await logSchedulerEvent(fakeEnv(db), "error", "签到 作业失败", { error: "timeout" });
    expect(rows.length).toBe(1);
    expect(rows[0].channel).toBe("sys");
    expect(rows[0].outcome).toBe("error");
    expect(rows[0].msg).toContain("scheduler");
  });

  it("写入失败不抛错（日志是观测设施，不能拖垮调用方）", async () => {
    const brokenDb = { prepare() { throw new Error("D1 down"); } };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 关键：不 reject
    await expect(logSystem(fakeEnv(brokenDb), "error", "test", "x")).resolves.toBeUndefined();
    errSpy.mockRestore();
  });
});

describe("describeStateChange 只挑显著跃变", () => {
  const now = 1_000_000;
  const base = { status: "healthy", cooling: false, coolingKind: "", breaker: false, degrade: false, disabledReason: "" };

  it("无变化时返回空数组（常态，绝大多数 note 都落这里）", () => {
    const a: any = { status: "healthy", cooldownUntil: 0, cooldownKind: "", breakerUntil: 0, degradeUntil: 0 };
    expect(describeStateChange(base, a, now)).toEqual([]);
  });

  it("进入熔断/降权/禁用都被识别", () => {
    expect(describeStateChange(base, { status: "cooling", cooldownUntil: 0, cooldownKind: "", breakerUntil: now + 60_000, degradeUntil: 0 } as any, now))
      .toEqual([expect.stringContaining("进入熔断")]);
    expect(describeStateChange(base, { status: "healthy", cooldownUntil: 0, cooldownKind: "", breakerUntil: 0, degradeUntil: now + 60_000 } as any, now))
      .toEqual([expect.stringContaining("进入连败降权")]);
    const dis = describeStateChange(base, { status: "disabled", disabledReason: "12153 session dead", cooldownUntil: 0, cooldownKind: "", breakerUntil: 0, degradeUntil: 0 } as any, now);
    expect(dis).toEqual([expect.stringContaining("被禁用")]);
    expect(dis[0]).toContain("12153");
  });

  it("同类别冷却内时长延长不算跃变（否则每次失败都写系统日志）", () => {
    const before = { ...base, cooling: true, coolingKind: "soft_rate" };
    // 有界退避会让 cooldownUntil 越来越远，但 kind 不变 → 不该记
    const a: any = { status: "cooling", cooldownUntil: now + 999_999, cooldownKind: "soft_rate", breakerUntil: 0, degradeUntil: 0 };
    expect(describeStateChange(before, a, now)).toEqual([]);
  });

  it("冷却类别切换算跃变（失败性质变了，如 soft → hard_credit）", () => {
    const before = { ...base, cooling: true, coolingKind: "soft_rate" };
    const a: any = { status: "cooling", cooldownUntil: now + 60_000, cooldownKind: "hard_credit", breakerUntil: 0, degradeUntil: 0 };
    const r = describeStateChange(before, a, now);
    expect(r).toEqual([expect.stringContaining("冷却类别")]);
    expect(r[0]).toContain("hard_credit");
  });

  it("从冷却/熔断恢复也被识别", () => {
    const before = { ...base, cooling: true, coolingKind: "soft", breaker: true };
    const a: any = { status: "healthy", cooldownUntil: 0, cooldownKind: "", breakerUntil: 0, degradeUntil: 0 };
    const r = describeStateChange(before, a, now);
    expect(r).toContain("熔断已解除");
    expect(r).toContain("冷却已解除");
  });
});
