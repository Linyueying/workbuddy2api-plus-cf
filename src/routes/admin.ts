import type { Hono } from "hono";
import type { Env } from "../../worker-configuration.d.ts";
import { poolRPC } from "../durable/account-pool";
import { dailyCheckin, creditPackages, type CreditPackage } from "../services/upstream";
import {
  runCheckin,
  runBalance,
  refreshCredits,
  runTravel,
  runActivity,
  runKeepalive,
  runNightOwl,
  runGrowth,
  accountTasks,
  acceptTask,
  claimTask,
  accountTaskAuto,
  accountTaskAutoAll,
  autoTasks,
  forEachAccount,
} from "../services/tasks";
import type { Auth, CtxVars } from "../types";
import type { Credits } from "../services/upstream";

function wait(c: any, p: Promise<any>) {
  try {
    c.executionCtx?.waitUntil?.(p);
  } catch {
    /* 无 ctx 时忽略 */
  }
}

/**
 * creditsOrReason 查余额并带上失败原因。
 *
 * 存在的理由：refreshCredits 上游非 2xx 时会抛错（见 postBillingResource），
 * 早期实现在这里 catch 掉后统一返回 "user resource failed"，面板显示这句
 * 等于什么都没说。这里把 status 与上游响应片段一起带出去，
 * 用户（或日志）一眼能分辨 401 / 403 / 5xx。
 */
async function creditsOrReason(
  env: Env,
  a: Auth,
): Promise<{ cr: Credits | null; why: string }> {
  try {
    return { cr: await refreshCredits(env, a), why: "" };
  } catch (e: any) {
    // diag 里带 token 长度前缀/UA/hasDeviceToken/响应头，面板直接可见，
    // 用户手机上开不了实时日志流也能一次定位（token 不落明文）。
    // hint 带根因说明（如「缺 X-Device-Token」），优先展示。
    const why =
      String(e?.hint ?? "") ||
      String(e?.message ?? e) +
        (e?.detail ? ` | ${String(e.detail).slice(0, 160)}` : "") +
        (e?.diag ? ` | ${e.diag}` : "");
    console.error(`[admin] 余额查询失败 uid=${a?.uid ?? ""} realm=${a?.realm ?? ""} ${why}`);
    return { cr: null, why };
  }
}

export function registerAdmin(app: Hono<{ Bindings: Env; Variables: CtxVars }>) {
  // 单账号运维
  app.post("/panel/api/accounts/:uid/revive", async (c) => {
    const r = await poolRPC(c.env, "/internal/manage", "POST", { uid: c.req.param("uid"), action: "revive" }).catch(() => ({ ok: false }));
    return c.json({ ...r, ok: true });
  });
  app.post("/panel/api/accounts/:uid/disable", async (c) => {
    const r = await poolRPC(c.env, "/internal/manage", "POST", { uid: c.req.param("uid"), action: "disable" }).catch(() => ({ ok: false }));
    return c.json({ ok: true, reason: "manual disable" });
  });
  app.post("/panel/api/accounts/:uid/checkin", async (c) => {
    const uid = c.req.param("uid");
    const a = await poolRPC(c.env, "/internal/auth/" + encodeURIComponent(uid)).catch(() => null);
    if (!a?.accessToken) return c.json({ ok: false, error: "no account" }, 404);
    const ci: any = await dailyCheckin(c.env, a).catch(() => ({ done: false, already: false, message: "checkin failed" }));
    // 签到后查余额并回写池（对齐 Go panel.accountCheckin：先签到再 SetCreditsDetailed）。
    // 失败原因要原样带出去：面板只显示一句 "user resource failed" 的话，
    // 用户没法区分是 401（token/请求头）还是 5xx（上游抽风）。
    const { cr, why } = await creditsOrReason(c.env, a);
    if (!cr) return c.json({ ok: ci.done, checkin_done: ci.done, checkin_message: ci.message, balance_error: why });
    return c.json({
      ok: true,
      checkin_done: ci.done,
      checkin_message: ci.message,
      credits: cr.credits,
      credits_total: cr.creditsTotal,
    });
  });
  app.post("/panel/api/accounts/:uid/balance", async (c) => {
    const uid = c.req.param("uid");
    const a = await poolRPC(c.env, "/internal/auth/" + encodeURIComponent(uid)).catch(() => null);
    if (!a?.accessToken) return c.json({ ok: false, error: "no account" }, 404);
    const { cr, why } = await creditsOrReason(c.env, a);
    if (!cr) return c.json({ ok: false, error: why || "user resource failed" }, 502);
    return c.json({ ok: true, credits: cr.credits, credits_total: cr.creditsTotal });
  });
  app.get("/panel/api/accounts/:uid/packages", async (c) => {
    const uid = c.req.param("uid");
    const a = await poolRPC(c.env, "/internal/auth/" + encodeURIComponent(uid)).catch(() => null);
    if (!a?.accessToken) return c.json({ ok: false, error: "no account" }, 404);
    const packs = await creditPackages(c.env, a).catch(() => [] as CreditPackage[]);
    const remain = packs.reduce((s, p) => s + p.remain, 0);
    const size = packs.reduce((s, p) => s + p.size, 0);
    return c.json({ ok: true, credits: remain, credits_total: size, packages: packs });
  });
  app.post("/panel/api/accounts/:uid/remove", async (c) => {
    const r = await poolRPC(c.env, "/internal/remove", "POST", { uid: c.req.param("uid") }).catch(() => ({ ok: false }));
    return c.json({ ok: true, ...r });
  });

  // 任务中心（单账号）
  app.get("/panel/api/accounts/:uid/tasks", async (c) => {
    const r = await accountTasks(c.env, c.req.param("uid")).catch(() => ({ tasks: [] }));
    return c.json(r);
  });
  app.post("/panel/api/accounts/:uid/tasks/accept", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(await acceptTask(c.env, c.req.param("uid"), b.taskId).catch(() => ({ ok: false })));
  });
  app.post("/panel/api/accounts/:uid/tasks/accept_all", async (c) => {
    const uid = c.req.param("uid");
    const list = await accountTasks(c.env, uid).catch(() => ({ tasks: [] }));
    for (const t of (list as any).tasks ?? []) await acceptTask(c.env, uid, t.taskId).catch(() => {});
    return c.json({ ok: true });
  });
  app.post("/panel/api/accounts/:uid/tasks/claim", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(await claimTask(c.env, c.req.param("uid"), b.taskId).catch(() => ({ ok: false })));
  });
  app.post("/panel/api/accounts/:uid/tasks/auto", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!b.task_code) return c.json({ ok: false, error: "task_code required" }, 400);
    const r = await accountTaskAuto(c.env, c.req.param("uid"), b.task_code);
    return c.json(r, (r as any).status ?? 200);
  });
  app.post("/panel/api/accounts/:uid/tasks/auto_all", async (c) => {
    wait(c, accountTaskAutoAll(c.env, c.req.param("uid")).catch(() => null));
    return c.json({ ok: true, started: true });
  });

  // 全量定时任务（后台异步，立即返回 started）
  app.post("/panel/api/checkin_all", async (c) => {
    wait(c, Promise.resolve(runCheckin(c.env)));
    return c.json({ ok: true, started: true });
  });
  app.post("/panel/api/travel_all", async (c) => {
    wait(c, Promise.resolve(runTravel(c.env)));
    return c.json({ ok: true, started: true });
  });
  app.post("/panel/api/activity_all", async (c) => {
    wait(c, Promise.resolve(runActivity(c.env)));
    return c.json({ ok: true, started: true });
  });
  app.post("/panel/api/keepalive_all", async (c) => {
    wait(c, Promise.resolve(runKeepalive(c.env)));
    return c.json({ ok: true, started: true });
  });
  app.post("/panel/api/balance_all", async (c) => {
    const out = await runBalance(c.env).catch(() => []);
    return c.json({ ok: true, accounts: out });
  });

  // 任务中心队列
  app.post("/panel/api/tasks/scan_all", async (c) => {
    const list = (await poolRPC(c.env, "/internal/list").catch(() => [])) as any[];
    const results: any[] = [];
    for (const a of list) {
      const tasks = await accountTasks(c.env, a.uid).catch(() => ({ tasks: [] as any[] }));
      const pend = (tasks.tasks ?? []).filter((t: any) => !t.claimed && !t.locked);
      results.push({ uid: a.uid, total: (tasks.tasks ?? []).length, pending: pend.length, claimable: pend.filter((t: any) => t.claimable).length });
    }
    return c.json({ ok: true, results });
  });
  app.post("/panel/api/tasks/run_queue", async (c) => {
    wait(c, Promise.resolve(runGrowth(c.env)));
    return c.json({ ok: true, started: true });
  });
  app.get("/panel/api/tasks/queue", async (c) => {
    const list = (await poolRPC(c.env, "/internal/list").catch(() => [])) as any[];
    const items: any[] = [];
    for (const a of list) {
      const tasks = await accountTasks(c.env, a.uid).catch(() => ({ tasks: [] as any[] }));
      for (const t of (tasks.tasks ?? [])) {
        if (t.claimed) continue;
        items.push({ uid: a.uid, task_code: t.task_code, current: t.current, target: t.target, claimable: !!t.claimable, locked: !!t.locked, accept_status: t.accept_status });
      }
    }
    return c.json({ items });
  });

  // 启动 DO alarm 自调度（可选；推荐外部 cron 调上面 *_all 接口）
  app.post("/panel/api/scheduler/arm", async (c) => {
    const r = await poolRPC(c.env, "/internal/arm", "POST").catch(() => ({ ok: false }));
    return c.json({ ok: true, ...r });
  });
}
