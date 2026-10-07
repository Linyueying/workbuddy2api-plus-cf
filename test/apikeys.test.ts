import { describe, it, expect } from "vitest";
import {
  PREFIX,
  ipIn,
  ipToBytes,
  keyCreditQuota,
  keyTokenQuota,
  modelAllowed,
  normRealm,
  parseJSONArray,
  verifyKey,
  verifyKeyRequest,
} from "../src/services/apikeys";
import type { ApiKeyRow } from "../src/types";

function key(over: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: "k1",
    key_hash: "h",
    name: "n",
    models: [],
    created_at: 0,
    last_used: 0,
    enabled: 1,
    expires_at: 0,
    realm: "",
    ip_allowlist: [],
    max_ips: 0,
    ips: [],
    last_ip: "",
    req_count: 0,
    quota: 0,
    used_tokens: 0,
    quota_credit: 0,
    used_credit: 0,
    seq: 1,
    ...over,
  };
}

describe("常量与归一", () => {
  it("PREFIX 是 sk-", () => {
    expect(PREFIX).toBe("sk-");
  });

  it("normRealm 只认 cn/global，其余（含空）当不限", () => {
    expect(normRealm("cn")).toBe("cn");
    expect(normRealm(" GLOBAL ")).toBe("global");
    expect(normRealm("")).toBe("");
    expect(normRealm("mars")).toBe("");
    expect(normRealm(undefined)).toBe("");
  });

  it("parseJSONArray 脏数据当空数组不抛", () => {
    expect(parseJSONArray('["a","b"]')).toEqual(["a", "b"]);
    expect(parseJSONArray("{not json")).toEqual([]);
    expect(parseJSONArray("")).toEqual([]);
    expect(parseJSONArray('{"a":1}')).toEqual([]);
    expect(parseJSONArray(["x", 1])).toEqual(["x", "1"]);
  });

  it("配额读取：负数与 NaN 都当不限（0）", () => {
    expect(keyTokenQuota(key({ quota: -5 }))).toBe(0);
    expect(keyTokenQuota(key({ quota: NaN }))).toBe(0);
    expect(keyTokenQuota(key({ quota: 100 }))).toBe(100);
    expect(keyCreditQuota(key({ quota_credit: -1 }))).toBe(0);
    expect(keyCreditQuota(key({ quota_credit: 2.5 }))).toBe(2.5);
  });
});

describe("ipIn / ipToBytes", () => {
  it("ipToBytes 解析合法 IPv4", () => {
    expect(ipToBytes("192.168.1.1")).toEqual([192, 168, 1, 1]);
    expect(ipToBytes("0.0.0.0")).toEqual([0, 0, 0, 0]);
  });

  it("ipToBytes 拒非法", () => {
    expect(ipToBytes("1.2.3")).toBeNull();
    expect(ipToBytes("1.2.3.256")).toBeNull();
    expect(ipToBytes("a.b.c.d")).toBeNull();
    expect(ipToBytes("")).toBeNull();
  });

  it("空名单 = 不限制", () => {
    expect(ipIn("1.2.3.4", [])).toBe(true);
  });

  it("精确匹配", () => {
    expect(ipIn("1.2.3.4", ["1.2.3.4"])).toBe(true);
    expect(ipIn("1.2.3.5", ["1.2.3.4"])).toBe(false);
  });

  it("CIDR 命中（/24 /16 /32）", () => {
    expect(ipIn("192.168.1.7", ["192.168.1.0/24"])).toBe(true);
    expect(ipIn("192.168.2.7", ["192.168.1.0/24"])).toBe(false);
    expect(ipIn("10.0.5.9", ["10.0.0.0/16"])).toBe(true);
    expect(ipIn("1.2.3.4", ["1.2.3.4/32"])).toBe(true);
  });

  it("/0 匹配全部", () => {
    expect(ipIn("8.8.8.8", ["0.0.0.0/0"])).toBe(true);
  });

  it("非 /8 边界掩码（/12 /20）", () => {
    // 172.16.0.0/12 → 172.16~172.31
    expect(ipIn("172.20.1.1", ["172.16.0.0/12"])).toBe(true);
    expect(ipIn("172.32.1.1", ["172.16.0.0/12"])).toBe(false);
    // 192.168.0.0/20 → 192.168.0~192.168.15
    expect(ipIn("192.168.15.1", ["192.168.0.0/20"])).toBe(true);
    expect(ipIn("192.168.16.1", ["192.168.0.0/20"])).toBe(false);
  });

  it("非法 CIDR 前缀长度被忽略（不吃掉精确匹配项）", () => {
    expect(ipIn("1.2.3.4", ["1.2.3.0/33", "1.2.3.4"])).toBe(true);
    expect(ipIn("1.2.3.4", ["1.2.3.0/33"])).toBe(false);
  });

  it("ip 本身非法时只有精确字面量能命中", () => {
    expect(ipIn("not-an-ip", ["not-an-ip"])).toBe(true);
    expect(ipIn("not-an-ip", ["10.0.0.0/8"])).toBe(false);
  });
});

describe("modelAllowed", () => {
  it("空名单 = 全放行", () => {
    expect(modelAllowed("cn:hy3", [])).toBe(true);
  });

  it("精确匹配（不做前缀/模糊，避免授权边界漏成筛子）", () => {
    expect(modelAllowed("cn:hy3", ["cn:hy3"])).toBe(true);
    expect(modelAllowed("cn:hy3", ["global:hy3"])).toBe(false);
    expect(modelAllowed("cn:hy3", ["cn:hy"])).toBe(false);
  });
});

describe("verifyKey", () => {
  const ip = "1.2.3.4";

  it("默认零值全部放行", () => {
    expect(verifyKey(key(), ip)).toBeNull();
  });

  it("停用 → 403 key_disabled", () => {
    const e = verifyKey(key({ enabled: 0 }), ip);
    expect(e?.status).toBe(403);
    expect(e?.code).toBe("key_disabled");
  });

  it("过期 → 403 key_expired（now 判定）", () => {
    const past = Date.now() - 1000;
    const e = verifyKey(key({ expires_at: past }), ip);
    expect(e?.status).toBe(403);
    expect(e?.code).toBe("key_expired");
    // 未到期（含恰好等于 now）放行
    expect(verifyKey(key({ expires_at: Date.now() + 60_000 }), ip)).toBeNull();
  });

  it("token 配额用尽 → 429 quota_exhausted", () => {
    const e = verifyKey(key({ quota: 1000, used_tokens: 1000 }), ip);
    expect(e?.status).toBe(429);
    expect(e?.code).toBe("quota_exhausted");
    expect(e?.message).toContain("1000 / 上限 1000");
    // 未超限放行
    expect(verifyKey(key({ quota: 1000, used_tokens: 999 }), ip)).toBeNull();
  });

  it("积分配额用尽 → 429 credit_quota_exhausted（先于 token 判据之外独立判）", () => {
    const e = verifyKey(key({ quota_credit: 10, used_credit: 10.5 }), ip);
    expect(e?.status).toBe(429);
    expect(e?.code).toBe("credit_quota_exhausted");
    expect(e?.message).toContain("10.5 / 上限 10");
  });

  it("配额为 0 = 不限（不误判）", () => {
    expect(verifyKey(key({ quota: 0, used_tokens: 1e9 }), ip)).toBeNull();
    expect(verifyKey(key({ quota_credit: 0, used_credit: 1e9 }), ip)).toBeNull();
  });

  it("判据顺序：停用 > 过期 > token 配额 > 积分配额 > IP", () => {
    // 同时停用 + 过期 + 超额 + IP 不在白名单 → 报 key_disabled
    const e = verifyKey(key({ enabled: 0, expires_at: 1, quota: 1, used_tokens: 9, ip_allowlist: ["9.9.9.9"] }), ip);
    expect(e?.code).toBe("key_disabled");
    // 只留过期 + 超额 → 报 key_expired
    expect(verifyKey(key({ expires_at: 1, quota: 1, used_tokens: 9 }), ip)?.code).toBe("key_expired");
    // 只留超额 + IP 不在白名单 → 报 quota_exhausted
    expect(verifyKey(key({ quota: 1, used_tokens: 9, ip_allowlist: ["9.9.9.9"] }), ip)?.code).toBe("quota_exhausted");
  });

  it("IP 不在白名单 → 400 ip_not_allowed", () => {
    const e = verifyKey(key({ ip_allowlist: ["9.9.9.9"] }), ip);
    expect(e?.status).toBe(400);
    expect(e?.code).toBe("ip_not_allowed");
    expect(e?.message).toContain("1.2.3.4");
  });

  it("IP 在 CIDR 白名单内放行", () => {
    expect(verifyKey(key({ ip_allowlist: ["1.2.3.0/24"] }), ip)).toBeNull();
  });

  it("IP 数超限 → 400 too_many_ips（新 IP 且已绑满）", () => {
    const e = verifyKey(key({ max_ips: 2, ips: ["9.9.9.9", "8.8.8.8"] }), ip);
    expect(e?.status).toBe(400);
    expect(e?.code).toBe("too_many_ips");
    expect(e?.message).toContain("2 个 IP");
  });

  it("已绑过的 IP 不占新名额（超限也放行）", () => {
    expect(verifyKey(key({ max_ips: 2, ips: ["1.2.3.4", "9.9.9.9"] }), ip)).toBeNull();
  });

  it("还有空位时新 IP 放行", () => {
    expect(verifyKey(key({ max_ips: 3, ips: ["9.9.9.9"] }), ip)).toBeNull();
  });

  it("IP 为空串时不占名额（trust_proxy 关闭的形态）", () => {
    expect(verifyKey(key({ max_ips: 1, ips: ["9.9.9.9"] }), "")).toBeNull();
  });
});

describe("verifyKeyRequest", () => {
  it("无限制 → 放行", () => {
    expect(verifyKeyRequest(key(), "cn:hy3", "cn")).toBeNull();
  });

  it("模型白名单命中 / 不中", () => {
    const k = key({ models: ["cn:hy3"] });
    expect(verifyKeyRequest(k, "cn:hy3", "cn")).toBeNull();
    const e = verifyKeyRequest(k, "cn:hy4", "cn");
    expect(e?.status).toBe(400);
    expect(e?.code).toBe("model_not_allowed");
  });

  it("启用了白名单但请求没带 model → 400（文案区别于 realm 侧）", () => {
    const e = verifyKeyRequest(key({ models: ["cn:hy3"] }), "", "cn");
    expect(e?.code).toBe("model_not_allowed");
    expect(e?.message).toContain("未指定 model");
  });

  it("realm 限定：命中放行", () => {
    expect(verifyKeyRequest(key({ realm: "global" }), "global:hy3", "global")).toBeNull();
  });

  it("realm 限定：不中 → 400 realm_mismatch + 修正提示", () => {
    const e = verifyKeyRequest(key({ realm: "cn" }), "global:hy3", "global");
    expect(e?.status).toBe(400);
    expect(e?.code).toBe("realm_mismatch");
    expect(e?.message).toContain("去掉 global: 前缀");
  });

  it("realm 限定为 global 时的提示方向", () => {
    const e = verifyKeyRequest(key({ realm: "global" }), "cn:hy3", "cn");
    expect(e?.code).toBe("realm_mismatch");
    expect(e?.message).toContain("需带 global: 前缀");
  });

  it("realm 限定但请求没带 model → 400 realm_mismatch", () => {
    const e = verifyKeyRequest(key({ realm: "global" }), "", "cn");
    expect(e?.code).toBe("realm_mismatch");
    expect(e?.message).toContain("国际版");
  });

  it("realm 与模型白名单同时不满足：realm 先判（与 Go 同序）", () => {
    const e = verifyKeyRequest(key({ realm: "cn", models: ["global:hy3"] }), "global:hy3", "global");
    expect(e?.code).toBe("realm_mismatch");
  });

  it("非法 realm 值当不限（不误拒）", () => {
    expect(verifyKeyRequest(key({ realm: "mars" }), "cn:hy3", "cn")).toBeNull();
  });
});
