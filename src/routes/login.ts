import type { Hono } from "hono";
import type { Env } from "../../worker-configuration.d.ts";
import { startLogin, pollLogin, loginRegions } from "../services/oauth";
import type { CtxVars } from "../types";

export function registerLogin(app: Hono<{ Bindings: Env; Variables: CtxVars }>) {
  // POST /panel/api/login/start
  app.post("/panel/api/login/start", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const realm = body.realm === "global" ? "global" : "cn";
    let r;
    try {
      r = await startLogin(c.env, realm);
    } catch (e: any) {
      // 上游拒绝的原因（缺 Origin 头/业务 code!=0/HTTP 4xx）对排查登录失败是决定性
      // 信息，笼统报 "oauth state failed" 会让人无从下手。
      return c.json({ ok: false, error: `oauth state failed: ${String(e?.message ?? e)}` }, 502);
    }
    if (!r.ok) return c.json({ ok: false, error: `oauth state failed: ${r.url ? "empty state" : "no response"}` }, 502);
    return c.json(r);
  });

  // GET /panel/api/login/poll?state=
  app.get("/panel/api/login/poll", async (c) => {
    const state = c.req.query("state") || "";
    if (!state) return c.json({ done: false, error: "missing state" });
    const r = await pollLogin(c.env, state);
    return c.json(r);
  });

  // GET /panel/api/login/regions
  app.get("/panel/api/login/regions", async (c) => {
    return c.json(await loginRegions());
  });
}
