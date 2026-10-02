import type { Hono } from "hono";
import type { Env } from "../../worker-configuration.d.ts";
import { getConfig } from "../config";
import { proxyChat, clientIP, openAIError, autoConfigOf } from "../services/proxy";
import { poolRPC } from "../durable/account-pool";
import { modelsForApi } from "../services/resolveModel";
import { responsesToChat, anthropicToChat } from "../services/compat";
import { VirtualIDs } from "../services/autoroute";
import { healthReport } from "../services/health";
import type { CtxVars } from "../types";

export function registerApi(app: Hono<{ Bindings: Env; Variables: CtxVars }>) {
  // /v1/chat/completions
  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const model = body.model || "cn:hy3";
    const cfg = await getConfig(c.env);
    const req = c.req.raw;
    // 系统提示词改写不在这里做：它必须与降级重试共享同一份状态，由 proxyChat
    // 在轮转循环内统一裁决（对齐 Go handler.go 的改写位置）。
    return proxyChat(c.env, req, model, body, clientIP(req, cfg.trust_proxy), req.headers.get("user-agent") || "", c.get("keyRow") ?? null);
  });

  // /v1/responses (OpenAI Responses API -> chat)
  app.post("/v1/responses", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const chat = responsesToChat(body);
    const cfg = await getConfig(c.env);
    const req = c.req.raw;
    return proxyChat(c.env, req, chat.model || "cn:hy3", chat, clientIP(req, cfg.trust_proxy), req.headers.get("user-agent") || "", c.get("keyRow") ?? null);
  });

  // /v1/messages (Anthropic Messages API -> chat)
  app.post("/v1/messages", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const chat = anthropicToChat(body);
    const cfg = await getConfig(c.env);
    const req = c.req.raw;
    return proxyChat(c.env, req, chat.model || "cn:hy3", chat, clientIP(req, cfg.trust_proxy), req.headers.get("user-agent") || "", c.get("keyRow") ?? null);
  });

  // /v1/models
  app.get("/v1/models", async (c) => {
    const allowed = (c as any).get("models") as string[] | null;
    const cfg = await getConfig(c.env);
    const cn = await modelsForApi(c.env, "cn", allowed ?? undefined).catch(() => []);
    const gl = await modelsForApi(c.env, "global", allowed ?? undefined).catch(() => []);
    // 模型编排启用时把虚拟模型名（auto / <realm>:auto）也列进目录，
    // 否则客户端在编辑器里看不到这个可选项（对齐 Go /v1/models 的 VirtualIDs）。
    const vids = VirtualIDs(autoConfigOf(cfg));
    const data = [...cn, ...gl].map((m: any) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: "workbuddy",
      ...m,
    }));
    for (const id of vids ?? []) {
      if (allowed && allowed.length && !allowed.includes(id)) continue;
      if (data.some((m: any) => m.id === id)) continue;
      data.push({ id, object: "model", created: 0, owned_by: "workbuddy", virtual: true });
    }
    return c.json({ object: "list", data });
  });

  // /status
  app.get("/status", async (c) => {
    const st = await poolRPC(c.env, "/internal/status").catch(() => null);
    if (!st) return c.json({ error: "pool unavailable" }, 503);
    return c.json(st);
  });

  // /healthz —— 就绪探针（公开，无鉴权）。
  //
  // 两层语义刻意分开：
  // - ready（配置自检：D1 表/密钥/DO 绑定）→ 503。**部署坏了**该报 unhealthy。
  // - servable（池里有可服务账号）→ 200 但 healthy:false。刚部署完空池是正常
  //   中间态（还没导账号），若也报 503，外部探针会在导入账号前一直报警。
  // 鉴权单独探测：空钥匙返回 200 说明鉴权失效，面板形同无锁。
  app.get("/healthz", async (c) => {
    const hc = await healthReport(c.env);
    const st = await poolRPC(c.env, "/internal/status").catch(() => null);
    const servable =
      !!st && (st.realm_totals.cn.healthy > 0 || st.realm_totals.global.healthy > 0);
    const body = {
      service: "workbuddy2api",
      ready: hc.ready,
      healthy: servable,
      checks: hc.checks,
      total: st?.total ?? 0,
      realm_servable: {
        cn: st?.realm_totals.cn.healthy > 0,
        global: st?.realm_totals.global.healthy > 0,
      },
    };
    // 只有「配置坏了」才 503；空池不算故障。
    if (!hc.ready) return c.json(body, 503);
    return c.json(body);
  });

  // 兜底 404
  app.all("/v1/*", (c) => openAIError(404, "not_found", "route not found"));
}
