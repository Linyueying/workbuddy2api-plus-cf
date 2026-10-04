import type { Hono } from "hono";
import type { Env } from "../../worker-configuration.d.ts";
import { getConfig, saveConfig } from "../config";
import { poolRPC } from "../durable/account-pool";
import { listModels } from "../services/resolveModel";
import {
  queryRequestLogs,
  usageByAccountWindow,
  type AccountUsageAgg,
  listKeys,
  getKey,
  insertKey,
  patchKey,
  deleteKey,
  maxKeySeq,
  quotaUsage,
  run,
} from "../storage/d1";
import { getUsage } from "../storage/usage";
import { kvGetJSON, CACHE_KEY_OUTPUT_PROBES, cacheKV } from "../storage/kv";
import { forEachAccount, runCreditReport, runTrialBatch, prettyReport } from "../services/tasks";
import { creditPackages, getCredits } from "../services/upstream";
import {
  signinOne,
  renderSigninTable,
  summarizeSignin,
  type SigninOutcome,
} from "../services/checkin";
import { normRealm } from "../services/apikeys";
import type { ApiKeyRow, Auth } from "../types";
import type { CtxVars } from "../types";

const VERSION = "1.0.0-pages";
const STARTED_AT = Date.now();

/**
 * 账号池「成功/失败」「用量」列的数据源：request_logs 窗口聚合（口径与用量页一致）。
 *
 * 此前这两个数据从 DO 的运行时计数（successCount/errTotal）出，与用量页（D1 权威
 * 账本）对不上号；token_usage 在 AccountState 里根本没有数据源。统一改为 D1 聚合。
 *
 * 前端在账号池视图下每 5s 轮询一次 overview，聚合结果做 60s 模块级缓存——
 * D1 扫描量只随时间增长（每分钟一次），不随轮询放大。
 */
const ACCT_USAGE_TTL_MS = 60_000;
const ACCT_USAGE_HOURS = 24; // 与用量页缺省窗口一致
let acctUsageCache: { at: number; byUid: Map<string, AccountUsageAgg> } | null = null;

async function accountUsageByUid(env: Env, hours = ACCT_USAGE_HOURS): Promise<Map<string, AccountUsageAgg>> {
  if (acctUsageCache && Date.now() - acctUsageCache.at < ACCT_USAGE_TTL_MS) return acctUsageCache.byUid;
  const to = Date.now();
  const rows = await usageByAccountWindow(env, to - hours * 3600_000, to).catch(() => []);
  const byUid = new Map<string, AccountUsageAgg>(rows.map((r) => [r.uid, r]));
  acctUsageCache = { at: Date.now(), byUid };
  return byUid;
}

function genKey(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return "wbk_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * keyPrefix 取明文前 12 字符做展示掩码（对齐 Go apikeys 里 `plain[:12]`）。
 *
 * 12 这个长度是刻意选的：够露出 `wbk_` + 足够区分同一账号下的多把钥匙，
 * 又不足以让人拿它去猜剩下的 48 位。
 */
function keyPrefix(plain: string): string {
  return String(plain ?? "").slice(0, 12);
}
/**
 * genAdminKey 生成面板登录口令：`sk-` + base64url(18 字节随机)。
 *
 * 格式刻意对齐 Go cmd/server/config.go 的 WriteDefault（`"sk-" + base64.RawURLEncoding(18B)`），
 * 与分发给下游的 `wbk_` 子密钥在**肉眼层面**就区分得开：一个管面板，一个管调用。
 */
function genAdminKey(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  // btoa → 标准 base64，再换成 Go RawURLEncoding 的 URL 安全字符集（去 padding）。
  return "sk-" + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** numOr 取有限数值，缺省/非法回落 def。配额字段的零值语义是「不限」，故负数也压到 0。 */
function numOr(v: unknown, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return def;
  return n;
}

/**
 * validateKeyInput 子密钥入参校验。
 *
 * 只拒「语义上不可能」的值（负数配额、非字符串名字段、数组字段塞了非数组），
 * 其余一律宽容归一——管理面板是自家人在用，为一个手滑的空字符串打回整次
 * 保存只会逼人改用 API。partial=true 时只校验出现的字段（PATCH 语义）。
 */
function validateKeyInput(body: any, partial = false): string | null {
  if (body.quota !== undefined && Number(body.quota) < 0) return "invalid_quota";
  if (body.quota_credit !== undefined && (!Number.isFinite(Number(body.quota_credit)) || Number(body.quota_credit) < 0)) {
    return "invalid_quota_credit";
  }
  if (body.max_ips !== undefined && Number(body.max_ips) < 0) return "invalid_max_ips";
  if (!partial && body.name !== undefined && typeof body.name !== "string") return "invalid_name";
  for (const f of ["models", "ip_allowlist"]) {
    if (body[f] !== undefined && !Array.isArray(body[f])) return `invalid_${f}`;
  }
  return null;
}

export function registerPanel(app: Hono<{ Bindings: Env; Variables: CtxVars }>) {
  // 概览
  app.get("/panel/api/overview", async (c) => {
    const cfg = await getConfig(c.env);
    const now = Date.now();
    const st = await poolRPC(c.env, "/internal/status").catch(() => null);
    const accounts = (await poolRPC(c.env, "/internal/list").catch(() => [])) as any[];
    // 成功/失败与用量列：D1 窗口聚合（与用量页同口径、同缺省窗口 24h）。
    const usageByUid = await accountUsageByUid(c.env);
    return c.json({
      version: VERSION,
      uptime_sec: Math.floor((now - STARTED_AT) / 1000),
      auth_required: true,
      redis_mode: false,
      sticky_sessions: st?.sticky_sessions ?? 0,
      total: st?.total ?? 0,
      healthy: st?.healthy ?? 0,
      cooling: st?.cooling ?? 0,
      disabled: st?.disabled ?? 0,
      in_flight_full: st?.in_flight_full ?? 0,
      usage_window_hours: ACCT_USAGE_HOURS,
      // 序列化对齐前端（Go 版）契约：前端 renderAccounts/renderPackages/groupItems
      // 读的是 snake_case 字段名，且需要 success_count/err_total/last_success/
      // breaker_until/degrade_until/cool_remaining_sec/cool_kind/disabled/reason/
      // checkin_done/model_costs 等运行时字段——后端此前只映射了 7 个基础字段，
      // 导致账号池整列空白（行能画、但成功/失败/用量/状态标签全空）。
      accounts: (accounts ?? []).map((a) => {
        // 聚合行口径与 usage-agg.ts 一致：requests 含失败；均值延迟/速率在展示层折算
        // （总耗时/请求数、总 token/总秒），避免逐行平均的辛普森悖论。
        const u = usageByUid.get(String(a.uid));
        const requests = Number(u?.requests ?? 0) || 0;
        const errors = Math.min(Number(u?.errors ?? 0) || 0, requests);
        const msSum = Number(u?.ms_sum ?? 0) || 0;
        const totalTokens = Number(u?.total_tokens ?? 0) || 0;
        return {
          uid: a.uid,
          nickname: a.nickname,
          realm: a.realm,
          status: a.status,
          disabled: a.status === "disabled",
          reason: a.disabledReason ?? "",
          credits: a.credits ?? 0,
          credits_total: a.creditsTotal ?? 0,
          in_flight: a.inFlight ?? 0,
          success_count: requests - errors,
          err_total: errors,
          last_success: a.lastSuccess ? new Date(a.lastSuccess).toISOString() : "",
          breaker_until: a.breakerUntil ? new Date(a.breakerUntil).toISOString() : "",
          degrade_until: a.degradeUntil ? new Date(a.degradeUntil).toISOString() : "",
          cool_remaining_sec: a.cooldownUntil > now ? Math.max(0, Math.floor((a.cooldownUntil - now) / 1000)) : 0,
          cool_kind: a.cooldownKind ?? "",
          checkin_done: a.checkinDone ?? false,
          rate_limited_models: [],
          model_costs: Object.entries(a.modelCost ?? {}).map(([model, c]) => ({
            model,
            cost_per_1k: (c as { costPer1k?: number })?.costPer1k ?? 0,
          })),
          token_usage: {
            request_count: requests,
            total_tokens: totalTokens,
            last_latency_ms: requests > 0 ? msSum / requests : 0,
            last_tokens_per_second: msSum > 0 ? totalTokens / (msSum / 1000) : 0,
          },
        };
      }),
    });
  });

  // 日志环形缓冲（读 D1 最近 entries）
  app.get("/panel/api/logs", async (c) => {
    const entries = await queryRequestLogs(c.env, { limit: 200 }).catch(() => []);
    return c.json({ entries: entries.map((e) => ({ ts: e.ts, channel: e.channel, msg: `${e.outcome} ${e.model ?? ""} uid=${e.uid ?? "-"} ${e.status}` })) });
  });

  app.get("/panel/api/request_metrics", async (c) => {
    return c.json({ requests: 0, note: "see /panel/api/request_logs" });
  });

  app.get("/panel/api/request_logs", async (c) => {
    const q = c.req.query();
    const entries = await queryRequestLogs(c.env, {
      limit: Number(q.limit) || 200,
      outcome: q.outcome,
      account: q.account,
      model: q.model,
      client_ip: q.client_ip,
      user_agent: q.user_agent,
      from: q.from ? Number(q.from) : undefined,
      to: q.to ? Number(q.to) : undefined,
    }).catch(() => []);
    return c.json({ entries, limit: Number(q.limit) || 200 });
  });

  // 模型目录（直连上游实时探测）
  app.get("/panel/api/models", async (c) => {
    const cn = await listModels(c.env, "cn").catch(() => []);
    const gl = await listModels(c.env, "global").catch(() => []);
    return c.json({ ok: true, models: [...cn, ...gl] });
  });

  // 导入：配置
  app.post("/panel/api/import/config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = await saveConfig(c.env, body);
    return c.json({ ok: true, restart_required: [] as string[] });
  });

  // 导入：auths 数组
  app.post("/panel/api/import/auths", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const arr: any[] = Array.isArray(body) ? body : body.accounts ?? [];
    let imported = 0;
    const errors: string[] = [];
    for (const a of arr) {
      try {
        await poolRPC(c.env, "/internal/add", "POST", { auth: a });
        await poolRPC(c.env, "/internal/manage", "POST", { uid: a.uid, action: "revive" });
        imported++;
      } catch (e: any) {
        errors.push(String(e?.message ?? e));
      }
    }
    return c.json({ ok: true, imported, errors });
  });

  // 导入：cockpit 多账号文件（multipart）
  app.post("/panel/api/import/cockpit", async (c) => {
    const form = await c.req.parseBody({ all: true }).catch(() => null);
    const file = form?.["file"] as File | undefined;
    if (!file) return c.json({ ok: false, error: "no file" }, 400);
    const text = await file.text();
    let arr: any[] = [];
    try {
      const j = JSON.parse(text);
      arr = Array.isArray(j) ? j : j.accounts ?? [j];
    } catch {
      return c.json({ ok: false, error: "invalid json" }, 400);
    }
    let imported = 0;
    const errors: string[] = [];
    for (const a of arr) {
      try {
        await poolRPC(c.env, "/internal/add", "POST", { auth: a });
        imported++;
      } catch (e: any) {
        errors.push(String(e?.message ?? e));
      }
    }
    return c.json({ ok: true, imported, errors });
  });

  // 配置读写
  app.get("/panel/api/config", async (c) => {
    const cfg = await getConfig(c.env);
    return c.json(cfg);
  });
  app.post("/panel/api/config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cfg = await saveConfig(c.env, body);
    return c.json({ ok: true, restart_required: [] as string[] });
  });

  // 面板登录口令：与调用主钥匙 api_key 分开的一把，只用来进面板。
  //
  // 为什么不再共用：共用时「给下游发一把调用密钥」等于把管理面板交出去。
  // 生成是一次性的——明文只在响应里出现这一次，之后只读得到「已设置」，
  // 忘了就得再生成一把（旧的立即失效），不做 recover。
  app.post("/panel/api/admin/panel-key", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cur = await getConfig(c.env);
    // clear：退回「面板认 api_key」的老行为。手滑生成后想恢复时用这条路，
    // 免得只剩一把没处记录的口令把自己关在外面。
    if (body?.clear) {
      await saveConfig(c.env, { ...cur, admin_key: "" });
      return c.json({ ok: true, cleared: true });
    }
    const next = genAdminKey();
    await saveConfig(c.env, { ...cur, admin_key: next });
    return c.json({ ok: true, plain: next });
  });
  /** GET 面板口令是否已独立设置（不回照明文：忘了只能重生成）。 */
  app.get("/panel/api/admin/panel-key", async (c) => {
    const cfg = await getConfig(c.env);
    return c.json({ ok: true, set: !!cfg.admin_key, shared_with_api_key: !cfg.admin_key });
  });

  // 子密钥
  app.get("/panel/api/keys", async (c) => {
    const keys = await listKeys(c.env).catch(() => []);
    return c.json({ ok: true, keys });
  });
  app.post("/panel/api/keys", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const key = genKey();
    const bad = validateKeyInput(body);
    if (bad) return c.json({ ok: false, error: bad }, 400);
    const row: ApiKeyRow = {
      id: crypto.randomUUID(),
      key_hash: await sha256Hex(key),
      name: String(body.name || "key"),
      prefix: keyPrefix(key),
      models: Array.isArray(body.models) ? body.models.map(String) : [],
      created_at: Date.now(),
      last_used: 0,
      enabled: body.enabled === false || body.enabled === 0 ? 0 : 1,
      expires_at: numOr(body.expires_at, 0),
      realm: normRealm(body.realm),
      ip_allowlist: Array.isArray(body.ip_allowlist) ? body.ip_allowlist.map(String) : [],
      max_ips: numOr(body.max_ips, 0),
      ips: [],
      last_ip: "",
      req_count: 0,
      quota: numOr(body.quota, 0),
      used_tokens: 0,
      quota_credit: numOr(body.quota_credit, 0),
      used_credit: 0,
      seq: (await maxKeySeq(c.env).catch(() => 0)) + 1,
    };
    await insertKey(c.env, row).catch(() => {});
    // key / plain **必须同时在**：这是 Go internal/panel/keys.go 的契约
    //（`{"key": k, "plain": plain}`），前端 showIssued(r.plain) 读的是 plain。
    // 只返回 key 会让「仅此刻可见」的明文框弹出一个空字符串——看似小错，
    // 实际是用户永远拿不到自己刚创建的密钥。
    return c.json({ ok: true, key, plain: key, id: row.id });
  });
  app.get("/panel/api/keys/:id", async (c) => {
    const k = await getKey(c.env, c.req.param("id")).catch(() => null);
    return c.json({ ok: true, key: k });
  });
  // 改管控字段（停用/配额/IP/模型/有效期）。不接收 key_hash —— 轮换走 /rotate。
  app.patch("/panel/api/keys/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const bad = validateKeyInput(body, true);
    if (bad) return c.json({ ok: false, error: bad }, 400);
    await patchKey(c.env, c.req.param("id"), body).catch(() => {});
    const k = await getKey(c.env, c.req.param("id")).catch(() => null);
    return c.json({ ok: true, key: k });
  });
  app.delete("/panel/api/keys/:id", async (c) => {
    await deleteKey(c.env, c.req.param("id")).catch(() => {});
    return c.json({ ok: true });
  });
  // POST /reset 语义**必须与 Go 一致**：清零已用额度，而不是换密钥
  //（Go internal/panel/keys.go 的 keysReset 调的是 ResetUsage）。
  // 此前这里做了密钥轮换，而前端按钮文案写的是「重置用量统计」——管理员以为
  // 只是续期的无害操作，实际所有客户端瞬间 401，且新明文被丢弃、无处可寻。
  // 轮换这种**不可逆且会打挂下游**的动作，必须走独立的 /rotate。
  app.post("/panel/api/keys/:id/reset", async (c) => {
    const r = await run(
      c.env,
      "UPDATE apikeys SET used_tokens = 0, used_credit = 0, req_count = 0 WHERE id = ?",
      [c.req.param("id")],
    ).catch(() => null);
    // 行不存在时不报错——幂等语义，调一次和调十次结果相同。
    return c.json({ ok: true, changed: Number(r?.meta?.changes ?? 0) });
  });
  // 清零已用额度（续期/加配额后免重建密钥）。语义与 /reset 相同，保留用于兼容早期客户端。
  app.post("/panel/api/keys/:id/reset_usage", async (c) => {
    await run(c.env, "UPDATE apikeys SET used_tokens = 0, used_credit = 0, req_count = 0 WHERE id = ?", [
      c.req.param("id"),
    ]).catch(() => {});
    return c.json({ ok: true });
  });
  // Go 没有轮换能力，这是 CF 侧的增强：换一把新明文，**旧密钥立即失效**。
  // 返回 plain 让前端一次性展示——轮换后不展示新密钥等于把用户锁在门外。
  app.post("/panel/api/keys/:id/rotate", async (c) => {
    const id = c.req.param("id");
    const k = await getKey(c.env, id).catch(() => null);
    if (!k) return c.json({ ok: false }, 404);
    const key = genKey();
    // prefix 必须跟着换：留在旧掩码上会让列表页继续显示一把已作废的钥匙。
    await insertKey(c.env, { ...k, key_hash: await sha256Hex(key), prefix: keyPrefix(key) }).catch(() => {});
    return c.json({ ok: true, key, plain: key });
  });
  // 配额概览（面板顶部：多少把钥匙、已用多少 token/积分、多少把已超额）。
  app.get("/panel/api/keys/quota", async (c) => {
    return c.json({ ok: true, ...(await quotaUsage(c.env).catch(() => ({ keys: 0, tokens: 0, credit: 0, exhausted: 0 }))) });
  });
  app.post("/panel/api/keys/check-models", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cn = await listModels(c.env, "cn").catch(() => []);
    const gl = await listModels(c.env, "global").catch(() => []);
    const all = new Set([...cn, ...gl].map((m: any) => m.id));
    const invalid = (body.models ?? []).filter((m: string) => !all.has(m));
    return c.json({ ok: true, invalid });
  });

  // 用量：从 request_logs 实时聚合成面板「用量」页的视图模型。
  //
  // 这里曾是 `/panel/api/usage` 返回一张独立的 usage 表的原始行，而前端 renderUsage
  // 期待的是 totals/series/by_*/credit_by_* 一整套——字段完全对不上，所以即便有数据
  // 页面也只会是一片空。两套口径必须对齐，且只能有一套数据源。
  app.get("/panel/api/usage", async (c) => {
    const q = c.req.query();
    const to = Date.now();
    // 前端 trangeQuery 传的是**秒**（自定义/固定区间）；滚动窗口传 hours。两者
    // 都可能缺席，缺省给 24 小时——与前端 trangeState 的默认预设保持一致。
    const hours = Number(q.hours) || 24;
    const toMs = q.to ? Number(q.to) * 1000 : to;
    const fromMs = q.from ? Number(q.from) * 1000 : toMs - hours * 3600_000;

    // 昵称是明细表的润色项，拿不到就降级显示 uid —— 不能因为它失败就整页空。
    const accounts = ((await poolRPC(c.env, "/internal/list").catch(() => [])) as any[]) ?? [];
    const nicknames: Record<string, string> = {};
    for (const a of accounts) {
      if (a?.uid && a?.nickname) nicknames[String(a.uid)] = String(a.nickname);
    }

    const snap = await getUsage(c.env, { from: fromMs, to: toMs, nicknames }).catch(() => null);
    if (!snap) return c.json({ ok: false, buckets: 0, totals: {}, series: [], by_account: [], by_model: [], by_realm: [], credit_by_account: [], credit_by_model: [] });
    // raw_latest：最近 5 条日志的原始行（含 msg 里的上游 usage 原文）。
    // 用途单一——当 token 全 0 时，用户能一眼看到「库里到底存了什么」，
    // 区分「上游没回 usage」与「回了解析/写库失败」，不必再靠猜。
    const rawLatest = await queryRequestLogs(c.env, { limit: 5, from: fromMs, to: toMs }).catch(() => []);
    return c.json({ ok: true, ...snap, raw_latest: rawLatest });
  });
  app.post("/panel/api/usage/save", async (c) => {
    return c.json({ ok: true });
  });

  // 模型探测
  app.get("/panel/api/model_probes", async (c) => {
    const probes = (await kvGetJSON(cacheKV(c.env), CACHE_KEY_OUTPUT_PROBES).catch(() => null)) as any;
    return c.json({ probes: probes ?? [], exists: !!probes, updated_at: probes?.updated_at ?? null });
  });

  // 积分包：逐账号向上游实时查询（对齐 Go panel.packages）。
  // 并发上限 3，避免瞬时打满上游限流；单号失败只在对应行标 error，不影响整页。
  app.get("/panel/api/packages", async (c) => {
    const accounts = ((await poolRPC(c.env, "/internal/list").catch(() => [])) as any[]) ?? [];
    const rows: any[] = new Array(accounts.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= accounts.length) return;
        const a = accounts[i];
        const row: any = { uid: a.uid, nickname: a.nickname, realm: a.realm, remain: 0, size: 0, packages: [] };
        try {
          const auth = a.auth as Auth;
          if (!auth?.accessToken) throw new Error("account not loaded");
          const packs = await creditPackages(c.env, auth);
          row.packages = packs;
          row.remain = packs.reduce((s, p) => s + p.remain, 0);
          row.size = packs.reduce((s, p) => s + p.size, 0);
        } catch (e: any) {
          row.error = String(e?.message ?? e);
        }
        rows[i] = row;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, accounts.length) }, worker));
    // 余额降序：多的在前，便于和少的对比。
    rows.sort((x, y) => (y.remain ?? 0) - (x.remain ?? 0));
    return c.json({ accounts: rows });
  });

  // 校园代金券
  app.get("/panel/api/school/vouchers", async (c) => {
    const out = await forEachAccount(c.env, (auth) =>
      fetch("https://www.workbuddy.cn/api/school/vouchers", { headers: { Authorization: "Bearer " + auth.accessToken } }).then((r) => r.json().catch(() => ({}))),
    ).catch(() => []);
    return c.json({ ok: true, results: out });
  });

  // ---- CLI 能力的服务端入口（替代 cmd/credit、cmd/trial）----
  //
  // Go 侧这两个命令是遍历本地 auths/ 目录的独立二进制；Workers 下账号池在 DO、
  // 凭证在 Secrets，能力上移为服务端批量操作，这里是它们的 HTTP 落点。
  // ?pretty=1 返回人类可读行数组（CLI 直接打印），默认返回结构化 JSON。

  // GET /panel/api/credits?realm=cn|global&pretty=1
  app.get("/panel/api/credits", async (c) => {
    const realm = c.req.query("realm") || undefined;
    const report = await runCreditReport(c.env, realm);
    if (c.req.query("pretty") === "1") return c.json({ ok: true, lines: prettyReport(report) });
    return c.json(report);
  });

  // POST /panel/api/trial —— 批量领取 global trial 加油包（CN 自动 N/A）
  app.post("/panel/api/trial", async (c) => {
    const { rows, summary } = await runTrialBatch(c.env);
    return c.json({ ok: summary.fail === 0, summary, accounts: rows });
  });

  /**
   * POST /panel/api/signin_report —— 批量签到并**同步返回逐账号结果**。
   *
   * 与 /panel/api/checkin_all 的区别不是重复：后者是 fire-and-forget（后台跑完
   * 只能去面板看日志），对齐的是定时任务；而 CLI 要的是 cmd/signin 那张逐账号
   * 表格（谁 OK、谁已签、谁 AUTH_INVALID），必须同步拿结果。
   * 并发压到 3（同/packages）：全池串行会撞 Workers 请求时限。
   * 签到结果不回写面板缓存——余额台账由 runCheckin 那条链路负责刷新。
   */
  app.post("/panel/api/signin_report", async (c) => {
    const realm = c.req.query("realm") || undefined;
    const list = ((await poolRPC(c.env, "/internal/list").catch(() => [])) as any[]) ?? [];
    const rows: SigninOutcome[] = new Array(list.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= list.length) return;
        const a = list[i];
        if (realm && a.realm !== realm) continue;
        const r = await signinOne(c.env, a.auth as Auth);
        // 顺手查余额（对齐 cmd/signin 的 remain 列），失败留 null 不影响签到判定。
        try {
          const cr = await getCredits(c.env, a.auth as Auth);
          rows[i] = { ...r, remain: cr.credits, creditsTotal: cr.creditsTotal };
        } catch {
          rows[i] = r;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
    const filled = rows.filter(Boolean);
    return c.json({ ok: true, summary: summarizeSignin(filled), accounts: filled, table: renderSigninTable(filled) });
  });
}
