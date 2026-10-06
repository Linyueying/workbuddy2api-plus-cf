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
import { isColdStart, markServed, uptimeMs } from "./services/boot";
import { ensureSchema } from "./storage/migrate";

// 会碰 D1 的路径才需要等迁移；纯静态资源不受影响（与 index.ts 的路由判定同源）。
function needsSchema(p: string): boolean {
  return (
    p === "/" || p === "/status" || p === "/healthz" || p.startsWith("/v1/") || p.startsWith("/panel/api/")
  );
}

// D1 自动迁移。Pages 的 Git 集成不跑数据库迁移，把这一步搬进 Worker，
// 部署后首个请求即完成建表，无需手工 `db:init:remote`。
//
// 刻意放在**中间件**而非模块顶层：Workers 禁止在模块全局作用域做 I/O，
// 而这里是请求上下文内，安全。结果用模块级 promise 缓存，后续请求零开销。
//
// 放在这里而不是 index.ts 的 app.fetch 之前，是为了让耗时能写进 CtxVars、
// 进而出现在 Server-Timing 里——原先它是唯一一段完全隐形的关键路径开销，
// 冷启动慢却看不出慢在哪。见 services/timing.ts 的 SEG_ORDER 注释。
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

// 鉴权：Bearer api_key（管理员总钥匙，全权放行）或 wbk_ 子密钥（D1 内 key_hash，
// 带停用/过期/双配额/IP/realm/模型白名单管控）。
//
// 状态码分类刻意不同于普通 4xx（对齐 Go apikeys）：停用过期 403、配额用尽 429、
// 参数类不匹配 400 —— 客户端据此区分「密钥不可用」「额度用完」「请求不对」。
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * waitUntilOf 把异步收尾挂到 Workers 生命周期上（与 routes/api.ts 同源约定）。
 *
 * 关键：路由层没有把 waitUntil 作为参数传进来，必须自己从 c.executionCtx 取。
 * 按用户已踩过的坑——Hono 的 `c.executionCtx` 在请求上下文缺失时是**抛出**而非
 * 返回 undefined——这里用 try/catch 兜住；取不到就退化为「立即执行」（本地/单测
 * 场景），保证逻辑仍然跑，只是不再享受 isolate 回收前的延寿。
 */
function waitUntilOf(c: any): (p: Promise<unknown>) => void {
  let ctx: ExecutionContext | undefined;
  try {
    ctx = c.executionCtx as ExecutionContext | undefined;
  } catch {
    ctx = undefined;
  }
  if (ctx && typeof ctx.waitUntil === "function") return (p) => ctx!.waitUntil(p);
  return (p) => void p;
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
  const isPanel = path.startsWith("/panel/");
  const isSubKey = !isPanel && token.startsWith(PREFIX);

  // 冷启动优化：配置（1 次 KV）与子密钥（1 次 D1）**互不依赖**，原先串行 await
  // 等于把两段 RTT 相加。这里并行发起，总耗时取较慢者。
  //
  // 热启动时两者都命中进程内缓存（config 30s SWR / 子密钥 30s Map），开销为零，
  // 所以这个改动只影响冷启动，稳态行为完全不变。
  //
  // sha256 是纯 CPU（crypto.subtle.digest，亚毫秒），必须先算出来才能查子密钥；
  // 它不是 IO，放在并行之前不占用往返。
  const hash = isSubKey ? await sha256Hex(token) : "";
  const [cfg, subKeyRow] = await Promise.all([
    getConfig(c.env),
    isSubKey ? loadKeyByHash(c.env, hash).catch(() => null) : Promise.resolve(null),
  ]);

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
  if (isSubKey) {
    // 走带内存缓存的读：一次 /v1 调用只因鉴权就要跨洋查一趟 D1（实测 20~150ms 抖动），
    // 而密钥行是天量级变更的数据。见 services/apikeys.ts 的缓存注释。
    // 这趟 D1 已在上面与 getConfig 并行发起，这里只是取结果。
    const row = subKeyRow;
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
    // Touch 最佳努力：统计口径不该因为写失败而拦住业务请求。挂 waitUntil 而非
    // 裸 `void`——否则响应返回、isolate 被回收时会把这笔 D1 写静默吞掉，症状就是
    // last_used / last_ip 偶尔不更新（只在 Workers 上出现，本地/Go 复现不了）。
    waitUntilOf(c)(touchKey(c.env, row, clientIPOf(c, cfg.trust_proxy)).catch(() => {}));
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
    // 冷启动快照必须在 await next() **之前**取：并发的首批请求要一起看到 true
    // （它们同样在付 isolate 启动成本），等第一个请求走完才翻假。
    const cold = isColdStart();
    markServed();
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
      h.set(
        "Access-Control-Expose-Headers",
        "Server-Timing, X-WB2A-Timing, X-WB2A-Routed-Model, X-Cold-Start, X-Worker-Uptime",
      );
      // 冷启动标记：让「这次慢是不是冷启动」不再靠猜。uptime 是本 isolate 存活
      // 毫秒，用来判断这个 isolate 是刚起来的还是跑了很久的。
      h.set("X-Cold-Start", cold ? "1" : "0");
      h.set("X-Worker-Uptime", String(Math.round(uptimeMs())));
    } catch {
      // 静态资源由 env.ASSETS.fetch 返回，其 headers 带 immutable guard，set 会抛
      // TypeError。静态页同源访问本就不需要 CORS，尽力而为即可，不必为它重建
      // 一遍 Response（那要复制整个 body 引用，纯属浪费）。
    }
  });

  // 自动迁移：必须在**鉴权之前**（鉴权要读 apikeys 表），且在计时起点之后
  // （这样它才会被算进 total）。静态路径直接跳过，一次字符串比较而已。
  app.use("*", async (c, next) => {
    if (needsSchema(c.req.path)) {
      const t = now();
      await autoMigrate(c.env);
      const ms = now() - t;
      // 只有真付了成本才记段：热启动 await 的是已 resolve 的 promise（约 0ms），
      // 无条件设进去会让每个响应都多一个恒为 0 的字段，把真正的冷启动现场淹掉。
      if (ms > 0.5) c.set("wb2aMigrateMs", ms);
    }
    await next();
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
