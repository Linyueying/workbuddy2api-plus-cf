import { Hono } from "hono";
import type { Env } from "../worker-configuration.d.ts";
import { buildApp } from "./router";
import type { CtxVars } from "./types";
import { PoolDO } from "./durable/account-pool";

export { PoolDO };

// Pages 高级模式入口：拦截所有请求。
// - 静态资源（/panel/ 的 index.html、app.js 等）→ env.ASSETS.fetch
// - API（/v1/*、/panel/api/*、/status、/healthz）→ Hono（内部按需转发给 PoolDO）
//
// D1 自动迁移**不在**这里做。原先它是在 app.fetch 之前 await 的，代价是这段
// 冷启动最大头的开销落在任何中间件计时之外，在 Server-Timing 里完全隐形——
// 优化无从下手。现在它搬进了 router.ts 的中间件（在计时起点之后、鉴权之前），
// 耗时能写进 CtxVars 并出现在响应头。详见那里与 services/timing.ts 的注释。
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
      // 迁移由 router.ts 的中间件负责（见本文件顶部注释）。
      return app.fetch(request, env, ctx);
    }

    // 静态资源（含 /panel/ 面板页面）。若无匹配返回 404（由 ASSETS 决定）。
    return env.ASSETS.fetch(request);
  },
};
