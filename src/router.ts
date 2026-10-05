import { Hono } from "hono";
import type { Env } from "../worker-configuration.d.ts";
import { getConfig } from "./config";
import { PREFIX, parseJSONArray, timingSafeEqual, touchKey, verifyKey, loadKeyByHash } from "./services/apikeys";
import { registerApi } from "./routes/api";
import { registerPanel } from "./routes/panel";
import { registerLogin } from "./routes/login";
import { registerAdmin } from "./routes/admin";
import type { CtxVars } from "./types";
import { now } from "./services/timing";

// 鉴权：Bearer api_key（管理员总钥匙，全权放行）或 wbk_ 子密钥（D1 内 key_hash，
// 带停用/过期/双配额/IP/realm/模型白名单管控）。
//
// 状态码分类刻意不同于普通 4xx（对齐 Go apikeys）：停用过期 403、配额用尽 429、
// 参数类不匹配 400 —— 客户端据此区分「密钥不可用」「额度用完」「请求不对」。
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function keyError(c: any, e: { status: number; code: string; message: string }): Response {
  return c.json({ error: { message: e.message, type: "api_error", code: e.code } }, e.status as any);
}

/** clientIPOf 解析客户端 IP（trust_proxy 时读 CF-Connecting-IP / XFF 首段）。 */
function clientIPOf(c: any, trustProxy: boolean): string {
  if (!trustProxy) return "0.0.0.0";
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for");
  return ip ? ip.split(",")[0].trim() : "0.0.0.0";
}

async function authMiddleware(c: any, next: () => Promise<void>) {
  const path = c.req.path;
  // 公开接口
  if (
    path.startsWith("/panel/api/login/start") ||
    path.startsWith("/panel/api/login/poll") ||
    path.startsWith("/panel/api/login/regions")
  ) {
    return next();
  }
  const auth = c.req.header("Authorization") || "";
  // 鉴权计时起点（子密钥有 D1 读，是 TTFT 的关键分段之一）。
  const authStart = now();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return c.json({ error: { message: "unauthorized", type: "api_error", code: "unauthorized" } }, 401);
  const token = m[1];
  const cfg = await getConfig(c.env);
  const isPanel = path.startsWith("/panel/");

  if (isPanel) {
    // 面板凭据：admin_key 优先；未单独配置时回退 api_key。
    // 回退是刻意的——老部署升级后若立刻只认 admin_key（默认为空），所有已保存
    // 的会话都会 401，管理员等于把自己锁在门外。想真正隔离，去面板生成一次即可。
    const ok = cfg.admin_key
      ? timingSafeEqual(token, cfg.admin_key)
      : !!(cfg.api_key && timingSafeEqual(token, cfg.api_key));
    if (!ok) {
      return c.json({ error: { message: "unauthorized", type: "api_error", code: "unauthorized" } }, 401);
    }
    c.set("role", "admin");
    c.set("models", null);
    c.set("keyRow", null);
    return next();
  }

  // 接口凭据：只认调用主钥匙与 wbk_ 子密钥，**admin_key 在此一律不认**。
  // 这是「登录与调用分离」的实质所在：面板口令泄露也换不来一次模型调用。
  if (cfg.api_key && timingSafeEqual(token, cfg.api_key)) {
    c.set("role", "admin");
    c.set("models", null);
    c.set("keyRow", null);
    return next();
  }
  if (token.startsWith(PREFIX)) {
    const hash = await sha256Hex(token);
    // 走带内存缓存的读：一次 /v1 调用只因鉴权就要跨洋查一趟 D1（实测 20~150ms 抖动），
    // 而密钥行是天量级变更的数据。见 services/apikeys.ts 的缓存注释。
    const row = await loadKeyByHash(c.env, hash).catch(() => null);
    // 只有子密钥路径才打 auth 段：这里是热路径上唯一一趟会被感知到的 IO。
    // 管理员分支是内存比对，记它只会平添噪声。
    c.set("wb2aAuthMs", now() - authStart);
    if (!row) {
      return c.json({ error: { message: "invalid api key", type: "api_error", code: "invalid_api_key" } }, 401);
    }
    // 停用 / 过期 / 双配额 / IP 白名单与上限。realm 与模型白名单要读完 body 才知道，
    // 由 verifyKeyRequest 在代理层补判（对齐 Go VerifyRequest 的拆分口径）。
    const bad = verifyKey(row, clientIPOf(c, cfg.trust_proxy));
    if (bad) return keyError(c, bad);
    c.set("role", "key");
    c.set("models", parseJSONArray(row.models).length ? parseJSONArray(row.models) : null);
    c.set("keyRow", row);
    // Touch 最佳努力：统计口径不该因为写失败而拦住业务请求。
    void touchKey(c.env, row, clientIPOf(c, cfg.trust_proxy)).catch(() => {});
    return next();
  }
  return c.json({ error: { message: "invalid api key", type: "api_error", code: "invalid_api_key" } }, 401);
}

export function buildApp(app: Hono<{ Bindings: Env; Variables: CtxVars }>) {
  // CORS 预检
  app.options("*", (c) => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Conversation-Request-ID,X-Session-Key",
        "Access-Control-Max-Age": "86400",
      },
    });
  });

  // ⚠️ CORS 头必须在 `await next()` **之后**写进 c.res.headers，不能在此之前用
  // c.header()。
  //
  // Hono 的 Context.set res 里有一句 `this.#preparedHeaders = undefined`：任何在
  // next() 之前通过 c.header() 攒下的头，都会在 handler 交出 Response 的那一刻被
  // 丢弃。而本项目的 handler 一律 `return new Response(...)`（不是 c.json/c.body），
  // 走的正是不经过 preparedHeaders 合并的那条路——于是这些头从来没出现在成功响应
  // 上。症状很有迷惑性：鉴权失败等走 c.json 的路径 CORS 正常，成功路径却没有，
  // 而同源面板看不出任何问题，只有跨域浏览器客户端（Web UI 直连 /v1）会被拦。
  //
  // 放在 next() 之后就没这个问题了：此刻 c.res 已是 handler 的 Response，
  // 直接 set 到它自己的 headers 上。
  app.use("*", async (c, next) => {
    // 计时起点：这是**最先注册**的中间件，它的入口时刻最贴近「请求到达 Workers」，
    // 晚于此处的任何打点都会漏掉鉴权 / 路由匹配的耗时。
    c.set("wb2aT0", now());
    await next();
    const h = c.res?.headers;
    if (!h) return;
    try {
      h.set("Access-Control-Allow-Origin", "*");
      h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      h.set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Conversation-Request-ID,X-Session-Key");
      // Expose-Headers 是自定义响应头能否被浏览器 JS 读到的开关：同源不看它，
      // 但跨域客户端要认 X-WB2A-* 就必须列出，否则 headers.get() 恒为 null
      // ——头在 HTTP 层面明明存在，抓包看得到、代码读不到。
      h.set("Access-Control-Expose-Headers", "Server-Timing, X-WB2A-Timing, X-WB2A-Routed-Model");
    } catch {
      // 静态资源由 env.ASSETS.fetch 返回，其 headers 带 immutable guard，set 会抛
      // TypeError。静态页同源访问本就不需要 CORS，尽力而为即可，不必为它重建
      // 一遍 Response（那要复制整个 body 引用，纯属浪费）。
    }
  });

  // 鉴权
  app.use("/v1/*", authMiddleware);
  app.use("/panel/api/*", authMiddleware);
  app.use("/status", authMiddleware);

  // 路由注册
  registerApi(app);
  registerPanel(app);
  registerLogin(app);
  registerAdmin(app);

  // 根路径重定向到面板
  app.get("/", (c) => c.redirect("/panel/"));
}
