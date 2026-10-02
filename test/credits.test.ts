import { describe, it, expect, vi, afterEach } from "vitest";
import { getCreditsDetailed, getCredits, creditPackages, isAlreadyCheckin, primeConfig } from "../src/services/upstream";
import type { Env } from "../worker-configuration.d.ts";
import type { Auth } from "../src/types";

function fakeEnv() {
  const kv = { get: async () => null, put: async () => {}, delete: async () => {} };
  return { WB2A_CONFIG: kv, WB2A_CACHE: kv } as unknown as Env;
}

function auth(realm: "cn" | "global" = "cn"): Auth {
  return {
    accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 3600_000,
    domain: "copilot.tencent.com", realm, uid: "u_1", enterpriseId: "e1", nickname: "Tom",
  };
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 上游套餐到期墙钟（UTC+8），days 天后。 */
function endIn(days: number): string {
  return new Date(Date.now() + days * 86400_000 + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}
/** 已过期的墙钟。 */
function endPast(): string {
  return new Date(Date.now() - 86400_000 + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}

function envelope(accounts: any[]) {
  return { code: 0, data: { Response: { Data: { TotalDosage: 0, Accounts: accounts } } } };
}

/** 桩 fetch：只关心命中的是哪个 path。 */
function stubFetch(handler: (path: string) => Response | Promise<Response>) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
    const p = new URL((req as any).url).pathname;
    seen.push(p);
    return handler(p);
  }));
  return seen;
}

const HOUR = 3600_000;

describe("余额聚合（对齐 Go UserResourceDetailedWithExpiry）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Cycle 字段优先：remain/size 求和", async () => {
    stubFetch(() => json(envelope([
      { PackageName: "签到包", CycleCapacitySize: 2000, CycleCapacityRemain: 1200, CycleCapacityUsed: 800 },
      { PackageName: "体验包", CycleCapacitySize: 1000, CycleCapacityRemain: 300, CycleCapacityUsed: 700 },
    ])));
    await primeConfig(fakeEnv());
    const r = await getCredits(fakeEnv(), auth());
    expect(r.credits).toBe(1500);
    expect(r.creditsTotal).toBe(3000);
  });

  it("无 Cycle 字段时回退 Capacity 字段（used 缺失按 size-remain 补）", async () => {
    stubFetch(() => json(envelope([{ PackageName: "gift", CapacitySize: 1000, CapacityRemain: 400 }])));
    await primeConfig(fakeEnv());
    const r = await getCredits(fakeEnv(), auth());
    expect(r.credits).toBe(400);
    expect(r.creditsTotal).toBe(1000);
  });

  it("上游脏数据负值/超面额被钳位", async () => {
    stubFetch(() => json(envelope([
      { PackageName: "p", CycleCapacitySize: 100, CycleCapacityRemain: -50, CycleCapacityUsed: 150 },
    ])));
    await primeConfig(fakeEnv());
    const r = await getCredits(fakeEnv(), auth());
    expect(r.credits).toBe(0); // remain<0 钳 0
    expect(r.creditsTotal).toBe(100);
  });

  it("CycleUsed > size-remain 时以 used 反推 remain", async () => {
    stubFetch(() => json(envelope([
      { PackageName: "p", CycleCapacitySize: 100, CycleCapacityRemain: 90, CycleCapacityUsed: 30 },
    ])));
    await primeConfig(fakeEnv());
    const r = await getCredits(fakeEnv(), auth());
    expect(r.credits).toBe(70); // used=30 胜出 → remain=100-30
  });

  it("expiring 分桶：soon 窗口内到期计入，窗口外不计", async () => {
    stubFetch(() => json(envelope([
      { PackageName: "soon", CycleCapacitySize: 100, CycleCapacityRemain: 40, CycleEndTime: endIn(3) },
      { PackageName: "later", CycleCapacitySize: 100, CycleCapacityRemain: 60, CycleEndTime: endIn(30) },
    ])));
    await primeConfig(fakeEnv());
    const r = await getCreditsDetailed(fakeEnv(), auth(), 7 * 24 * HOUR);
    expect(r.credits).toBe(100);
    expect(r.expiring).toBe(40);
  });

  it("soon<=0 禁用分桶：expiring 恒 0", async () => {
    stubFetch(() => json(envelope([
      { PackageName: "soon", CycleCapacitySize: 100, CycleCapacityRemain: 40, CycleEndTime: endIn(1) },
    ])));
    await primeConfig(fakeEnv());
    const r = await getCreditsDetailed(fakeEnv(), auth(), 0);
    expect(r.expiring).toBe(0);
  });

  it("最早未来到期批次：取最早时刻并累加同刻余额", async () => {
    stubFetch(() => json(envelope([
      { PackageName: "a", CycleCapacitySize: 100, CycleCapacityRemain: 10, CycleEndTime: endIn(10) },
      { PackageName: "b", CycleCapacitySize: 100, CycleCapacityRemain: 20, CycleEndTime: endIn(2) },
      { PackageName: "c", CycleCapacitySize: 100, CycleCapacityRemain: 30, CycleEndTime: endIn(2) },
    ])));
    await primeConfig(fakeEnv());
    const r = await getCreditsDetailed(fakeEnv(), auth(), 0);
    expect(r.earliestRemaining).toBe(50); // b+c 同刻
    expect(r.earliestExpiry).toBeGreaterThan(Date.now());
    expect(r.earliestExpiry).toBeLessThanOrEqual(Date.now() + 3 * 86400_000);
  });

  it("已过期 / 零余额 / 无到期字段的包不进最早批次", async () => {
    stubFetch(() => json(envelope([
      { PackageName: "past", CycleCapacitySize: 100, CycleCapacityRemain: 50, CycleEndTime: endPast() },
      { PackageName: "zero", CycleCapacitySize: 100, CycleCapacityRemain: 0, CycleEndTime: endIn(1) },
      { PackageName: "noend", CycleCapacitySize: 100, CycleCapacityRemain: 70 },
    ])));
    await primeConfig(fakeEnv());
    const r = await getCreditsDetailed(fakeEnv(), auth(), 0);
    expect(r.earliestExpiry).toBe(0);
    expect(r.earliestRemaining).toBe(0);
    expect(r.credits).toBe(120); // 聚合仍含全部包
  });

  it("到期墙钟按 UTC+8 解释（不是本地时区）", async () => {
    // 2100-01-01 00:00:00 UTC+8 == 2099-12-31 16:00:00Z
    stubFetch(() => json(envelope([
      { PackageName: "p", CycleCapacitySize: 10, CycleCapacityRemain: 5, CycleEndTime: "2100-01-01 00:00:00" },
    ])));
    await primeConfig(fakeEnv());
    const r = await getCreditsDetailed(fakeEnv(), auth(), 0);
    expect(r.earliestExpiry).toBe(Date.UTC(2099, 11, 31, 16, 0, 0));
  });

  it("global 域 404 时 fallback 到 /v2 前缀路径", async () => {
    const seen = stubFetch((p) =>
      p === "/billing/meter/get-user-resource" ? json({}, 404) : json(envelope([{ CycleCapacitySize: 50, CycleCapacityRemain: 25 }])),
    );
    await primeConfig(fakeEnv());
    const r = await getCredits(fakeEnv(), auth("global"));
    expect(seen).toEqual(["/billing/meter/get-user-resource", "/v2/billing/meter/get-user-resource"]);
    expect(r.credits).toBe(25);
  });

  it("cn 域单路径，不做 fallback", async () => {
    const seen = stubFetch(() => json(envelope([{ CycleCapacitySize: 50, CycleCapacityRemain: 25 }])));
    await primeConfig(fakeEnv());
    await getCredits(fakeEnv(), auth("cn"));
    expect(seen).toEqual(["/v2/billing/meter/get-user-resource"]);
  });

  it("上游 401 不再被当成「空余额」：必须抛错并带 status 与响应片段", async () => {
    stubFetch(() => new Response("<html>401 Authorization Required</html>", { status: 401 }));
    await primeConfig(fakeEnv());
    let err: any = null;
    try {
      await getCredits(fakeEnv(), auth());
    } catch (e) {
      err = e;
    }
    // 旧实现在这里返回 credits=0（静默），调用方无从区分「接口拒绝」与「真没额度」
    expect(err).toBeTruthy();
    expect(String(err?.message)).toContain("401");
    expect(err?.status).toBe(401);
    expect(String(err?.detail ?? "")).toContain("401");
  });

  it("global 域非 2xx 时两条候选路径都试一遍再报错", async () => {
    const seen = stubFetch(() => new Response("nope", { status: 403 }));
    await primeConfig(fakeEnv());
    await expect(getCredits(fakeEnv(), auth("global"))).rejects.toThrow(/403/);
    expect(seen).toEqual(["/billing/meter/get-user-resource", "/v2/billing/meter/get-user-resource"]);
  });

  it("账单域必须带归属头：X-User-Id / X-Domain / X-Enterprise-Id", async () => {
    // 回归护栏：曾经这里用的是 chat 域的 buildHeaders（只有 X-IDE-*），
    // 账单域网关拿不到归属头直接 401，而响应是 HTML，代码把它当成空余额吞掉。
    let h: Headers | null = null;
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      h = (req as Request).headers;
      return json(envelope([]));
    }));
    await primeConfig(fakeEnv());
    await getCredits(fakeEnv(), auth());
    expect(h!.get("X-User-Id")).toBe("u_1");
    expect(h!.get("X-Enterprise-Id")).toBe("e1");
    expect(h!.get("X-Domain")).toBe("copilot.tencent.com");
    expect(h!.get("Authorization")).toBe("Bearer AT");
  });

  it("确实没有积分包（Accounts 为空）不是错误：返回 0 聚合且不抛", async () => {
    stubFetch(() => json(envelope([])));
    await primeConfig(fakeEnv());
    const r = await getCredits(fakeEnv(), auth());
    expect(r.credits).toBe(0);
    expect(r.creditsTotal).toBe(0);
    expect(r.earliestExpiry).toBe(0);
  });

  it("请求体带 ProductCode 与到期时间范围（上游按此过滤有效包）", async () => {
    let body: any = null;
    vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
      body = await req.clone().json();
      return json(envelope([]));
    }));
    await primeConfig(fakeEnv());
    await getCredits(fakeEnv(), auth());
    expect(body.ProductCode).toBe("p_tcaca");
    expect(body.Status).toEqual([0, 3]);
    expect(String(body.PackageEndTimeRangeBegin)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("creditPackages 逐包构成", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("面额降序 + 到期/CreateTime 解析", async () => {
    stubFetch(() => json(envelope([
      { PackageName: "small", CapacitySize: 10, CapacityRemain: 10, PackageCode: "c1" },
      { PackageName: "big", CapacitySize: 100, CapacityRemain: 80, CycleEndTime: endIn(7), CreateTime: Date.UTC(2026, 0, 2) },
    ])));
    await primeConfig(fakeEnv());
    const packs = await creditPackages(fakeEnv(), auth());
    expect(packs.map((p) => p.name)).toEqual(["big", "small"]);
    expect(packs[0].remain).toBe(80);
    expect(packs[0].expires_at).toBeGreaterThan(Date.now());
    expect(packs[0].created_at).toBe("2026-01-02T00:00:00.000Z");
    expect(packs[1].expires_at).toBeUndefined();
  });

  it("ExpiredTime 优先于 PackageEndTime / CycleEndTime", async () => {
    stubFetch(() => json(envelope([
      { PackageName: "p", CycleCapacitySize: 10, CycleCapacityRemain: 10, ExpiredTime: "2099-01-01 00:00:00", CycleEndTime: endIn(1) },
    ])));
    await primeConfig(fakeEnv());
    const packs = await creditPackages(fakeEnv(), auth());
    expect(packs[0].end_time).toBe("2099-01-01 00:00:00");
  });

  it("Cycle 标记与 cycle 字段一致", async () => {
    stubFetch(() => json(envelope([
      { PackageName: "cy", CycleCapacitySize: 10, CycleCapacityRemain: 4, cycle: true },
      { PackageName: "cap", CapacitySize: 10, CapacityRemain: 4 },
    ])));
    await primeConfig(fakeEnv());
    const packs = await creditPackages(fakeEnv(), auth());
    expect(packs.find((p) => p.name === "cy")!.cycle).toBe(true);
    expect(packs.find((p) => p.name === "cap")!.cycle).toBe(false);
  });
});

describe("isAlreadyCheckin", () => {
  it("14001 与中文文案都判已签", () => {
    expect(isAlreadyCheckin({ code: 14001, msg: "今日已签到" })).toBe(true);
    expect(isAlreadyCheckin({ code: 0, msg: "今天已签到" })).toBe(true);
    expect(isAlreadyCheckin({ code: 0, msg: "ok" })).toBe(false);
  });
});
