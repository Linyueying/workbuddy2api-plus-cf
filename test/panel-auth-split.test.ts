import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildApp } from "../src/router";
import { timingSafeEqual } from "../src/services/apikeys";
import { invalidateConfig } from "../src/config";
import type { Env } from "../worker-configuration.d.ts";

// 面板登录口令与调用主钥匙的分离。
//
// 这条测试的份量在于：它守护的是「管理面の边界」。共用一把钥匙时，
// 把调用凭证发给下游＝把账户池、用量流水、配置写权限一起交出去。
// 分离之后即使面板口令泄露，也换不来一次模型调用——反过来调用密钥泄露，
// 也进不了面板。这两个方向都得钉死，少测一个方向分离就只剩一半意义。

function mkEnv(cfg: Record<string, any> = {}) {
  const kv = new Map<string, string>();
  return {
    // 必须忠实实现 `type: "json"`：getConfig 用这个选项读取，忽略它会把字符串
    // 当成已解析对象喂给 mergeDeep，于是整个 cfg 退化成那个字符串——
    // 报错会歪到 `cfg.global 为 undefined` 这种完全不像 KV 问题的地方去。
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
    WB2A_DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: { changes: 0, last_row_id: 0 } }) }) }) },
    WB2A_LOGS: {},
    POOL: { get: () => ({ fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) }), idFromName: () => ({}) },
    ASSETS: { fetch: async () => new Response("ok") },
    ...cfg,
  } as unknown as Env;
}

async function seedConfig(env: any, cfg: Record<string, any>) {
  await env.WB2A_CONFIG.put("config", JSON.stringify(cfg));
}

function app(): any {
  const a = new Hono<{ Bindings: Env }>();
  buildApp(a as any);
  return a;
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("timingSafeEqual", () => {
  it("相同为真、不同为假（含仅末位不同）", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
    // 长度不同必须 false：不能因为空串是任何串的前缀就判真
    expect(timingSafeEqual("", "sk-1")).toBe(false);
  });
});

describe("面板登录与调用密钥分离", () => {
  let env: any;
  beforeEach(() => {
    // getConfig 有 5s 模块级缓存，不清的话第二个用例会读到上一个用例写的 key，
    // 表现为「分离生效了但又没完全生效」这种最难查的假失败。
    invalidateConfig();
    env = mkEnv();
  });

  it("未设 admin_key 时，面板仍认 api_key（老部署升级不至于锁死自己）", async () => {
    await seedConfig(env, { api_key: "call-main", admin_key: "" });
    const res = await app().fetch(new Request("https://x/panel/api/keys", { headers: bearer("call-main") }), env);
    expect(res.status).not.toBe(401);
  });

  it("设了 admin_key：面板只认它，api_key 反而进不去", async () => {
    await seedConfig(env, { api_key: "call-main", admin_key: "sk-panel-only" });
    const a = app();
    const ok = await a.fetch(new Request("https://x/panel/api/keys", { headers: bearer("sk-panel-only") }), env);
    expect(ok.status).not.toBe(401);

    const bad = await a.fetch(new Request("https://x/panel/api/keys", { headers: bearer("call-main") }), env);
    // 分离到位了：调用密钥不再是面板钥匙
    expect(bad.status).toBe(401);
  });

  it("关键反向：admin_key 不能调 /v1（面板口令泄露也换不来模型调用）", async () => {
    await seedConfig(env, { api_key: "call-main", admin_key: "sk-panel-only" });
    const res = await app().fetch(
      new Request("https://x/v1/chat/completions", {
        method: "POST",
        headers: { ...bearer("sk-panel-only"), "content-type": "application/json" },
        body: JSON.stringify({ model: "cn:hy3", messages: [] }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("调用主钥匙仍能调 /v1（分离没有弄丢正常路径）", async () => {
    await seedConfig(env, { api_key: "call-main", admin_key: "sk-panel-only" });
    const res = await app().fetch(
      new Request("https://x/v1/models", { headers: bearer("call-main") }),
      env,
    );
    expect(res.status).not.toBe(401);
  });
});

describe("面板登录口令的生成与清除", () => {
  it("生成：sk- 前缀 + 24 位 URL-safe base64（对齐 Go WriteDefault 的形态）", async () => {
    invalidateConfig();
    const env = mkEnv();
    await seedConfig(env, { api_key: "call-main", admin_key: "" });
    const res = await app().fetch(
      new Request("https://x/panel/api/admin/panel-key", {
        method: "POST",
        headers: { ...bearer("call-main"), "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    const j = (await res.json()) as any;
    expect(j.ok).toBe(true);
    // Go: "sk-" + base64.RawURLEncoding(18字节) → 无 padding，定长 24 字符
    expect(j.plain).toMatch(/^sk-[A-Za-z0-9_-]{24}$/);
    expect(j.plain).not.toMatch(/=/); // RawURLEncoding 无 padding
  });

  it("生成后落库，且面板立即只认新口令", async () => {
    invalidateConfig();
    const env = mkEnv();
    await seedConfig(env, { api_key: "call-main", admin_key: "" });
    const a = app();

    const gen = (await (
      await a.fetch(
        new Request("https://x/panel/api/admin/panel-key", {
          method: "POST",
          headers: { ...bearer("call-main"), "content-type": "application/json" },
          body: "{}",
        }),
        env,
      )
    ).json()) as any;

    const saved = JSON.parse((await env.WB2A_CONFIG.get("config")) as string);
    expect(saved.admin_key).toBe(gen.plain);

    const after = await a.fetch(new Request("https://x/panel/api/keys", { headers: bearer(gen.plain) }), env);
    expect(after.status).not.toBe(401);
    const old = await a.fetch(new Request("https://x/panel/api/keys", { headers: bearer("call-main") }), env);
    expect(old.status).toBe(401); // 旧钥匙不再是面板钥匙
  });

  it("每次生成的口令互不相同", async () => {
    invalidateConfig();
    const env = mkEnv();
    await seedConfig(env, { api_key: "call-main", admin_key: "" });
    const a = app();
    const mk = async () => {
      const j = (await (
        await a.fetch(
          new Request("https://x/panel/api/admin/panel-key", {
            method: "POST",
            headers: { ...bearer("call-main"), "content-type": "application/json" },
            body: "{}",
          }),
          env,
        )
      ).json()) as any;
      return j.plain as string;
    };
    const one = await mk();
    const two = await mk();
    expect(one).not.toBe(two);
  });

  it("清除：回到「面板认 api_key」的兼容模式（手滑后的退路）", async () => {
    invalidateConfig();
    const env = mkEnv();
    await seedConfig(env, { api_key: "call-main", admin_key: "sk-panel-only" });
    const a = app();

    const clr = await a.fetch(
      new Request("https://x/panel/api/admin/panel-key", {
        method: "POST",
        headers: { ...bearer("sk-panel-only"), "content-type": "application/json" },
        body: JSON.stringify({ clear: true }),
      }),
      env,
    );
    expect(((await clr.json()) as any).cleared).toBe(true);

    const saved = JSON.parse((await env.WB2A_CONFIG.get("config")) as string);
    expect(saved.admin_key).toBe("");

    const back = await a.fetch(new Request("https://x/panel/api/keys", { headers: bearer("call-main") }), env);
    expect(back.status).not.toBe(401);
  });

  it("状态查询不回照明文，只说有没有设置", async () => {
    invalidateConfig();
    const env = mkEnv();
    await seedConfig(env, { api_key: "call-main", admin_key: "sk-SECRET-PLAINTEXT" });
    const res = await app().fetch(
      new Request("https://x/panel/api/admin/panel-key", { headers: bearer("sk-SECRET-PLAINTEXT") }),
      env,
    );
    const body = await res.text();
    expect(JSON.parse(body).set).toBe(true);
    // 明文绝不能再出现在响应里
    expect(body).not.toContain("PLAINTEXT");
  });
});
