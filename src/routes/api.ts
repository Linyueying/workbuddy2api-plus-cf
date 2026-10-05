import type { Hono } from "hono";
import type { Env } from "../../worker-configuration.d.ts";
import { getConfig } from "../config";
import { proxyChat, clientIP, openAIError, autoConfigOf } from "../services/proxy";
import { poolRPC } from "../durable/account-pool";
import { modelsForApi } from "../services/resolveModel";
import { responsesToChat, anthropicToChat } from "../services/compat";
import { VirtualIDs } from "../services/autoroute";
import { healthReport } from "../services/health";
import { newTimeline, markSince, now } from "../services/timing";
import type { CtxVars } from "../types";

/**
 * timelineOf 取本次请求的分段计时表。
 *
 * t0 由最外层中间件打点（见 router.ts）；子密钥路径额外带上 auth 段。
 * 拿不到 wb2aT0（非中间件发起的调用 / 单测直连 handler）时退化为当下计时，
 * 只是 total 会偏小，不影响其余分段的准确性。
 */
function timelineOf(c: any) {
  const tl = newTimeline(Number(c.get("wb2aT0") ?? now()));
  const authMs = c.get("wb2aAuthMs");
  if (typeof authMs === "number") tl.seg.auth = authMs;
  return tl;
}

/**
 * waitUntilOf 取当前请求的生命周期延长钩子（Workers ExecutionContext）。
 *
 * Hono 把它挂在 c.executionCtx 上。它的作用是让「响应已经返回、但后台还要写 D1」
 * 这类收尾任务继续跑完——proxyChat 的用量回填正是这种情况，缺了它会表现为
 * 「有请求数有延迟、token 却全 0」，而且本地完全测不出来，只有真机才炸。
 * 取不到（测试环境 / 非 Workers 运行时）时降级为立即执行，不影响既有断言。
 */
function waitUntilOf(c: any): (p: Promise<unknown>) => void {
  try {
    const ctx = c?.executionCtx;
    if (ctx && typeof ctx.waitUntil === "function") return (p) => ctx.waitUntil(p);
  } catch {
    // ⚠️ 这个 try 不是防御性冗余，是必需的：Hono 的 `c.executionCtx` 是
    // **getter**，在没有 ExecutionContext 的宿主下它会 `throw new Error(
    // "This context has no ExecutionContext")`，而不是优雅地返回 undefined
    // （见 hono/dist/context.js 的 get executionCtx）。那么 `c?.executionCtx`
    // 里的可选链救不了——它只对 undefined/null 生效，对抛异常无效。
    // 取不到就降级为真机之外的「挂了也白挂」，至少请求本身不被打成 500。
  }
  return (p) => {
    void p;
  };
}

export function registerApi(app: Hono<{ Bindings: Env; Variables: CtxVars }>) {
  // /v1/chat/completions
  app.post("/v1/chat/completions", async (c) => {
    const tl = timelineOf(c);
    // 读请求体单独计一段：它是从客户端 socket 里吸字节，长上下文（几十 KB 的
    // system + tools）时能到十几毫秒，且与上游毫无关系——纯本地开销，必须能被看见。
    const tBody = now();
    const body = await c.req.json().catch(() => ({}));
    markSince(tl, "body", tBody);
    const model = body.model || "cn:hy3";
    const cfg = await getConfig(c.env);
    const req = c.req.raw;
    // 系统提示词改写不在这里做：它必须与降级重试共享同一份状态，由 proxyChat
    // 在轮转循环内统一裁决（对齐 Go handler.go 的改写位置）。
    return proxyChat(c.env, req, model, body, clientIP(req, cfg.trust_proxy), req.headers.get("user-agent") || "", c.get("keyRow") ?? null, waitUntilOf(c), tl);
  });

  // /v1/responses (OpenAI Responses API -> chat)
  app.post("/v1/responses", async (c) => {
    const tl = timelineOf(c);
    const tBody = now();
    const body = await c.req.json().catch(() => ({}));
    markSince(tl, "body", tBody);
    const chat = responsesToChat(body);
    const cfg = await getConfig(c.env);
    const req = c.req.raw;
    return proxyChat(c.env, req, chat.model || "cn:hy3", chat, clientIP(req, cfg.trust_proxy), req.headers.get("user-agent") || "", c.get("keyRow") ?? null, waitUntilOf(c), tl);
  });

  // /v1/messages (Anthropic Messages API -> chat)
  app.post("/v1/messages", async (c) => {
    const tl = timelineOf(c);
    const tBody = now();
    const body = await c.req.json().catch(() => ({}));
    markSince(tl, "body", tBody);
    const chat = anthropicToChat(body);
    const cfg = await getConfig(c.env);
    const req = c.req.raw;
    return proxyChat(c.env, req, chat.model || "cn:hy3", chat, clientIP(req, cfg.trust_proxy), req.headers.get("user-agent") || "", c.get("keyRow") ?? null, waitUntilOf(c), tl);
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
