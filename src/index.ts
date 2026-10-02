import { Hono } from "hono";
import type { Env } from "../worker-configuration.d.ts";
import { buildApp } from "./router";
import type { CtxVars } from "./types";
import { PoolDO } from "./durable/account-pool";

export { PoolDO };

// Pages 高级模式入口：拦截所有请求。
// - 静态资源（/panel/ 的 index.html、app.js 等）→ env.ASSETS.fetch
// - API（/v1/*、/panel/api/*、/status、/healthz）→ Hono（内部按需转发给 PoolDO）
const app = new Hono<{ Bindings: Env; Variables: CtxVars }>();
buildApp(app);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;

    if (
      p === "/" ||
      p === "/status" ||
      p === "/healthz" ||
      p.startsWith("/v1/") ||
      p.startsWith("/panel/api/")
    ) {
      return app.fetch(request, env, ctx);
    }

    // 静态资源（含 /panel/ 面板页面）。若无匹配返回 404（由 ASSETS 决定）。
    return env.ASSETS.fetch(request);
  },
};
