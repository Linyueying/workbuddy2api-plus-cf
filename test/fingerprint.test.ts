import { describe, it, expect } from "vitest";
import { md5Hex, deviceHeaders } from "../src/services/upstream";

describe("md5Hex 对齐标准实现（设备指纹派生口径必须一致）", () => {
  it("标准测试向量 md5('abc')", () => {
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });
  it("空串 / 长输入不抛错且为 32 位 hex", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("The quick brown fox jumps over the lazy dog")).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
    expect(md5Hex("machine:abc")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("deviceHeaders 由 uid 稳定派生三头", () => {
  it("同一 uid 幂等，且三头均为 32 位 hex 前缀", () => {
    const a = deviceHeaders("u_123");
    const b = deviceHeaders("u_123");
    expect(a["X-Machine-ID"]).toBe(b["X-Machine-ID"]);
    expect(a["X-Session-ID"]).toBe(b["X-Session-ID"]);
    for (const k of ["X-Machine-ID", "X-Session-ID", "X-Request-ID"]) {
      expect(a[k]).toMatch(/^[0-9a-f]{32}(-[0-9]{6})?$/);
    }
  });
  it("不同 salt 产出不同值，uid 缺失回退 anonymous", () => {
    const a = deviceHeaders("u_x");
    expect(a["X-Machine-ID"]).not.toBe(a["X-Session-ID"]);
    const anon = deviceHeaders(undefined);
    expect(anon["X-Machine-ID"]).toBe(md5Hex("machine:anonymous"));
  });
});
