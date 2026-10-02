import { Hono } from "hono";
import type { Env } from "../worker-configuration.d.ts";
import { buildApp } from "./router";
import type { CtxVars } from "./types";
import { PoolDO } from "./durable/account-pool";
import { ensureSchema } from "./storage/migrate";

export { PoolDO };

// D1 自动迁移。Pages 的 Git 集成不跑数据库迁移，把这一步搬进 Worker，
// 部署后首个请求即完成建表，无需手工 `db:init:remote`。
//
// 刻意放在中间件而非顶层：Workers 禁止在模块全局作用域做 I/O，
// 而这里是请求上下文内，安全。结果用模块级 promise 缓存，后续请求零开销。
//
// 迁移失败**不得**阻断请求：D1 未绑定/配额用尽时服务仍应返回明确错误，
// 而不是全体 500。失败原因由 /healthz 的 d1_schema 项上报。
let schemaWarned = false;
async function autoMigrate(env: Env): Promise<void> {
  try {
    const r = await ensureSchema(env);
    if (r.status === "error" && !schemaWarned) {
      schemaWarned = true;
      console.error("[migrate] D1 自动迁移失败:", r.error);
    }
  } catch (e) {
    if (!schemaWarned) {
      schemaWarned = true;
      console.error("[migrate] D1 自动迁移异常:", String(e));
    }
  }
}

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
      // 只有会碰 D1 的路径才等迁移；静态资源不受影响。
      // 首次 await 完成建表，之后走模块级 promise 缓存，开销为零。
      await autoMigrate(env);
      return app.fetch(request, env, ctx);
    }

    // 静态资源（含 /panel/ 面板页面）。若无匹配返回 404（由 ASSETS 决定）。
    return env.ASSETS.fetch(request);
  },
};
