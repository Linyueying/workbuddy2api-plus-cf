import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TRIAL_PATH,
  TRIAL_ALREADY_MARKERS,
  trialAlreadyErr,
  claimTrial,
  classifyTrial,
  claimTrialFor,
  summarizeTrial,
} from "../src/services/trial";
import {
  isTransient,
  withBillingRetry,
  applyDosageFloor,
  aggregateCredits,
  summarizeReport,
  prettyReport,
  fetchUserResourceSafe,
  type CreditAccount,
} from "../src/services/credit";
import {
  ALREADY_CHECKIN_MARKERS,
  isAlreadyCheckin,
  dailyCheckinRetry,
  signinOne,
  summarizeSignin,
  renderSigninTable,
} from "../src/services/checkin";
import { primeConfig, UpstreamError } from "../src/services/upstream";
import type { Env } from "../worker-configuration.d.ts";
import type { Auth } from "../src/types";

function fakeEnv() {
  const kv = { get: async () => null, put: async () => {}, delete: async () => {} };
  return { WB2A_CONFIG: kv, WB2A_CACHE: kv } as unknown as Env;
}
function auth(realm: "cn" | "global" = "cn"): Auth {
  return {
    accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 3600_000,
    domain: realm === "global" ? "www.workbuddy.ai" : "copilot.tencent.com",
    realm, uid: "u_1", enterpriseId: "e1", nickname: "Tom",
  };
}
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const env = fakeEnv();
beforeEach(async () => {
  await primeConfig(env);
});

// ---------------------------------------------------------------------------
// trial（替代 internal/upstream/trial.go + cmd/trial）
// ---------------------------------------------------------------------------
describe("trial", () => {
  it("端点路径为 /billing/ide/trial（global 无 /v2 前缀）", () => {
    expect(TRIAL_PATH).toBe("/billing/ide/trial");
  });

  it("幂等码 marker 覆盖 200-信封 与 400-裸body 两种指纹", () => {
    expect(TRIAL_ALREADY_MARKERS).toEqual(["code=14051", `"code":14051`]);
    // HTTP 200 + 业务 code 非 0 → doJSON 拼 "code=14051 msg=..."
    expect(trialAlreadyErr("code=14051 msg=已领取")).toBe(true);
    // HTTP ≥400 → doJSON 把裸 body 塞进 Msg
    expect(trialAlreadyErr('{"code":14051,"msg":"already"}')).toBe(true);
    expect(trialAlreadyErr("code=14052 msg=其他")).toBe(false);
    expect(trialAlreadyErr("")).toBe(false);
  });

  it("claimTrial global 账号成功 → claimed=true", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: 0, data: {} }));
    const r = await claimTrial(env, auth("global"));
    expect(r).toEqual({ claimed: true });
    const url = spy.mock.calls[0][0] as unknown as Request;
    expect((url as Request).url ?? String(url)).toContain(TRIAL_PATH);
    spy.mockRestore();
  });

  it("claimTrial CN 账号直接报错（不发请求）", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await claimTrial(env, auth("cn"));
    expect(r.claimed).toBe(false);
    expect(r.error).toContain("only global accounts");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("claimTrial 幂等码 14051 → claimed=false 但非失败", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: 14051, msg: "已领取过" }));
    const r = await claimTrial(env, auth("global"));
    expect(r).toEqual({ claimed: false });
    spy.mockRestore();
  });

  it("claimTrial 其他错误透传", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: 500, msg: "boom" }, 200));
    const r = await claimTrial(env, auth("global"));
    expect(r.claimed).toBe(false);
    expect(r.error).toContain("code=500");
    spy.mockRestore();
  });

  it("classifyTrial 三态映射（对齐 Go）", () => {
    expect(classifyTrial(true)).toEqual({ status: "OK", detail: "trial granted" });
    expect(classifyTrial(false)).toEqual({ status: "ALREADY", detail: "already claimed (idempotent)" });
    expect(classifyTrial(false, "boom")).toEqual({ status: "FAIL", detail: "boom" });
    // error优先于 claimed：带错即FAIL
    expect(classifyTrial(true, "boom").status).toBe("FAIL");
  });

  it("claimTrialFor CN → N/A + skipped（不发请求）", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await claimTrialFor(env, auth("cn"));
    expect(r.status).toBe("N/A");
    expect(r.skipped).toBe(true);
    expect(r.detail).toContain("not applicable");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("claimTrialFor global 成功带 uid/nickname", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: 0, data: {} }));
    const r = await claimTrialFor(env, auth("global"));
    expect(r).toMatchObject({ uid: "u_1", nickname: "Tom", realm: "global", status: "OK" });
    spy.mockRestore();
  });

  it("summarizeTrial 四类计数", () => {
    const rows = [
      { uid: "1", nickname: "", realm: "global", status: "OK", detail: "" },
      { uid: "2", nickname: "", realm: "global", status: "OK", detail: "" },
      { uid: "3", nickname: "", realm: "global", status: "ALREADY", detail: "" },
      { uid: "4", nickname: "", realm: "cn", status: "N/A", detail: "" },
      { uid: "5", nickname: "", realm: "global", status: "FAIL", detail: "x" },
    ] as any[];
    expect(summarizeTrial(rows)).toEqual({ total: 5, ok: 2, already: 1, na: 1, fail: 1 });
    expect(summarizeTrial([])).toEqual({ total: 0, ok: 0, already: 0, na: 0, fail: 0 });
  });
});

// ---------------------------------------------------------------------------
// credit（替代 cmd/credit）
// ---------------------------------------------------------------------------
describe("credit", () => {
  it("isTransient 认 5xx 与网络层，不认业务错误/4xx", () => {
    // 上游 5xx 形态（实测 code 10000 + HTTP 500）
    expect(isTransient("code=10000 msg=API request failed with status code: 500", 500)).toBe(true);
    expect(isTransient("http 502", 502)).toBe(true);
    // 业务错误带 code= → 不重试
    expect(isTransient("code=14001 msg=已签到", 200)).toBe(false);
    expect(isTransient("http 401", 401)).toBe(false);
    expect(isTransient("code=11140 msg=request illegal", 403)).toBe(false);
    // 永久性本地失败（刷新令牌失效/解析失败）→ 重试无意义
    expect(isTransient("refresh_token_failed:401", 0)).toBe(false);
    expect(isTransient("parse failed (body: xxx)", 0)).toBe(false);
    // 裸传输失败（无 code 无状态）→ 视为瞬时
    expect(isTransient("network error", 0)).toBe(true);
  });

  it("withBillingTransient 瞬时错误补打，成功即返回", async () => {
    vi.useFakeTimers();
    let n = 0;
    const p = withBillingRetry(async () => {
      n++;
      if (n < 2) throw new UpstreamError("server", 500, "code=10000 msg=x");
      return "ok";
    });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(n).toBe(2);
    vi.useRealTimers();
  });

  it("withBillingTransient 业务错误一次都不重试", async () => {
    let n = 0;
    await expect(
      withBillingRetry(async () => {
        n++;
        throw new UpstreamError("client", 200, "code=14001 msg=已签到");
      }),
    ).rejects.toThrow(/14001/);
    expect(n).toBe(1);
  });

  it("withBillingTransient 连续瞬时错误补打满 2 次后抛出（共 3 次）", async () => {
    vi.useFakeTimers();
    let n = 0;
    const p = withBillingRetry(async () => {
      n++;
      throw new UpstreamError("server", 503, "code=10000 msg=x");
    });
    const settled = p.then(() => "resolved").catch(() => "rejected");
    await vi.runAllTimersAsync();
    expect(await settled).toBe("rejected");
    expect(n).toBe(3);
    vi.useRealTimers();
  });

  it("applyDosageFloor: size-remain 反推 used 下限", () => {
    expect(applyDosageFloor(40, 10, 100, 0)).toEqual({ remain: 40, used: 60, size: 100 });
    // 上游已用值更大时保留上游值
    expect(applyDosageFloor(40, 90, 100, 0)).toEqual({ remain: 40, used: 90, size: 100 });
    // size=0 时不做反推
    expect(applyDosageFloor(5, 0, 0, 0)).toEqual({ remain: 5, used: 0, size: 0 });
  });

  it("applyDosageFloor: TotalDosage 作 size 下限并联动 used", () => {
    // TotalDosage 3000 >逐包求和 100 → size 抬到 3000，used 反推到 2960
    expect(applyDosageFloor(40, 60, 100, 3000)).toEqual({ remain: 40, used: 2960, size: 3000 });
    // TotalDosage 更小则不生效
    expect(applyDosageFloor(40, 60, 100, 50)).toEqual({ remain: 40, used: 60, size: 100 });
  });

  it("aggregateCredits 只累加 ok 的账号（失败不能当 0）", () => {
    const rows: CreditAccount[] = [
      { uid: "1", nickname: "a", realm: "cn", remain: 10, used: 5, size: 20, packages: 1, ok: true },
      { uid: "2", nickname: "b", realm: "cn", remain: null, used: null, size: null, packages: 0, ok: false, error: "401" },
      { uid: "3", nickname: "c", realm: "global", remain: 30, used: 1, size: 50, packages: 2, ok: true },
    ];
    expect(aggregateCredits(rows)).toEqual({ remain: 40, used: 6, size: 70, accounts: 3, ok: 2, failed: 1 });
  });

  it("summarizeReport 打包 service/ts（ts 为秒）", () => {
    const r = summarizeReport([], 1_700_000_000_000);
    expect(r.service).toBe("workbuddy");
    expect(r.ts).toBe(1_700_000_000);
    expect(r.total.accounts).toBe(0);
  });

  it("prettyReport 四行汇总 + 失败清单", () => {
    const report = summarizeReport([
      { uid: "1", nickname: "a", realm: "cn", remain: 50, used: 0, size: 100, packages: 1, ok: true },
      { uid: "abcdefgh", nickname: "", realm: "cn", remain: null, used: null, size: null, packages: 0, ok: false, error: "http 401" },
    ], 0);
    const lines = prettyReport(report);
    expect(lines[0]).toContain("积分日报");
    expect(lines[1]).toBe("账号: 1/2");
    expect(lines[2]).toBe("总计: 50/100");
    expect(lines[3]).toBe("剩余: 50%");
    // 昵称为空时用 uid 前 8 位
    expect(lines[4]).toContain("abcdefgh http 401");
  });

  it("prettyReport size=0 时百分比为 0 不NaN", () => {
    const lines = prettyReport(summarizeReport([], 0));
    expect(lines[3]).toBe("剩余: 0%");
  });

  it("fetchUserResourceSafe 无 accessToken → error，不抛", async () => {
    const r = await fetchUserResourceSafe(env, { ...auth(), accessToken: "" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no accessToken");
    expect(r.remain).toBeNull();
  });

  it("fetchUserResourceSafe 聚合 remain/used/size/packs", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({
        code: 0,
        data: {
          Response: {
            Data: {
              TotalDosage: 0,
              Accounts: [
                { CycleCapacitySize: 100, CycleCapacityRemain: 40, CycleCapacityUsed: 60 },
                { CapacitySize: 50, CapacityRemain: 30, CapacityUsed: 20 },
              ],
            },
          },
        },
      }),
    );
    const r = await fetchUserResourceSafe(env, auth());
    expect(r.ok).toBe(true);
    expect(r.packages).toBe(2);
    expect(r.remain).toBe(70);
    expect(r.size).toBe(150);
    expect(r.used).toBe(80);
    spy.mockRestore();
  });

  it("fetchUserResourceSafe HTTP 失败 → error 写进行，不抛", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({}, 401));
    const r = await fetchUserResourceSafe(env, auth());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("http 401");
    spy.mockRestore();
  });

  it("fetchUserResourceSafe TotalDosage 抬升 size", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({
        code: 0,
        data: {
          Response: {
            Data: {
              TotalDosage: 3000,
              Accounts: [{ CycleCapacitySize: 100, CycleCapacityRemain: 40, CycleCapacityUsed: 60 }],
            },
          },
        },
      }),
    );
    const r = await fetchUserResourceSafe(env, auth());
    expect(r.size).toBe(3000);
    expect(r.used).toBe(2960);
    expect(r.remain).toBe(40);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// checkin（替代 internal/upstream DailyCheckin + cmd/signin）
// ---------------------------------------------------------------------------
describe("checkin", () => {
  it("marker 集合为 已签到 / already", () => {
    expect(ALREADY_CHECKIN_MARKERS).toEqual(["已签到", "already"]);
  });

  it("isAlreadyCheckin 只认UpstreamError（网络层不误判幂等）", () => {
    expect(isAlreadyCheckin(new UpstreamError("already_checkin", 200, "code=14001 msg=今天已签到"))).toBe(true);
    expect(isAlreadyCheckin(new UpstreamError("client", 200, "code=10001 msg=already check in"))).toBe(true);
    // 大小写变体
    expect(isAlreadyCheckin(new UpstreamError("client", 200, "ALREADY"))).toBe(true);
    // 非 UpstreamError（网络/解析层）→ false，否则补签抖动会被误记为已签
    expect(isAlreadyCheckin(new Error("已签到"))).toBe(false);
    expect(isAlreadyCheckin(new UpstreamError("client", 400, "code=11101 参数错"))).toBe(false);
  });

  it("dailyCheckinRetry code=0 → done", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: 0, msg: "ok" }));
    const r = await dailyCheckinRetry(env, auth());
    expect(r).toMatchObject({ done: true, already: false });
    spy.mockRestore();
  });

  it("dailyCheckinRetry 14001 → already=true 且不重试", async () => {
    let n = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      n++;
      return json({ code: 14001, msg: "今天已签到" });
    });
    const r = await dailyCheckinRetry(env, auth());
    expect(r).toMatchObject({ done: true, already: true });
    expect(n).toBe(1);
    spy.mockRestore();
  });

  it("dailyCheckinRetry 5xx 有界重试后成功", async () => {
    vi.useFakeTimers();
    let n = 0;
    // 形态对齐 Go TestDailyCheckinRetriesTransient500：HTTP 500 + code 10000。
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      n++;
      return n < 2
        ? json({ code: 10000, msg: "API request failed with status code: 500" }, 500)
        : json({ code: 0 });
    });
    const p = dailyCheckinRetry(env, auth());
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.done).toBe(true);
    expect(n).toBe(2);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it("dailyCheckinRetry 业务错误抛出（不吞）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: 11101, msg: "参数错" }));
    await expect(dailyCheckinRetry(env, auth())).rejects.toThrow(/11101/);
    spy.mockRestore();
  });

  it("signinOne OK / ALREADY 归一化", async () => {
    let spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: 0 }));
    expect((await signinOne(env, auth())).status).toBe("OK");
    spy.mockRestore();
    spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ code: 14001, msg: "今天已签到" }));
    expect((await signinOne(env, auth())).status).toBe("ALREADY");
    spy.mockRestore();
  });

  it("signinOne 无 accessToken → FAIL 不抛", async () => {
    const r = await signinOne(env, { ...auth(), accessToken: "" });
    expect(r.status).toBe("FAIL");
    expect(r.detail).toBe("no accessToken");
  });

  it("signinOne 会话已死 → AUTH_INVALID（区别于普通失败）", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("refresh_token_failed:401"));
    const r = await signinOne(env, auth());
    expect(r.status).toBe("AUTH_INVALID");
    spy.mockRestore();
  });

  it("summarizeSignin 计数 + renderSigninTable 表格", () => {
    const rows = [
      { uid: "u1", nickname: "Tom", realm: "cn", status: "OK" as const, detail: "", remain: 100, creditsTotal: 200 },
      { uid: "u2", nickname: "Amy", realm: "cn", status: "ALREADY" as const, detail: "今天已签到", remain: 50, creditsTotal: 100 },
      { uid: "u3", nickname: "Bo", realm: "global", status: "FAIL" as const, detail: "boom", remain: null, creditsTotal: null },
    ];
    const s = summarizeSignin(rows);
    expect(s).toEqual({ total: 3, ok: 1, already: 1, fail: 1, authInvalid: 0 });
    const table = renderSigninTable(rows);
    expect(table).toContain("uid");
    expect(table).toContain("| Tom");
    expect(table).toContain("total=3 ok=1 already=1 fail=1");
    // remain 为 null 显示 "-"
    expect(table).toMatch(/\| -\s+\|/);
  });

  it("renderSigninTable CJK 按双宽对齐（不串列）", () => {
    const table = renderSigninTable([
      { uid: "u1", nickname: "腾讯用户", realm: "cn", status: "OK", detail: "", remain: 1, creditsTotal: 1 },
    ]);
    const row = table.split("\n")[2];
    // 第二列起点= 36 宽 + " | " 分隔共 3 字符 → 39（与 renderSigninTable 的 pad 一致）
    expect(row.indexOf("腾讯用户")).toBe(39);
  });
});