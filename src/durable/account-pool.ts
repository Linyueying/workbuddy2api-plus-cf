import type { Env } from "../../worker-configuration.d.ts";
import type { AccountState, Auth, PoolStatus, Realm, ModelCooldown, ModelCostEntry } from "../types";
import { getConfig, type Config } from "../config";
import { refreshToken } from "../services/upstream";
import { rateLookup } from "../services/rates";
import {
  pick as corePick,
  healthy as coreHealthy,
  healthyForModel as coreHealthyForModel,
  inFlightFull as coreInFlightFull,
  hardCooled,
  MODEL_COST_TTL,
  type PickCfg,
  type PickResult,
} from "./pool-core";
import { resolveSticky, bindSticky, countSticky } from "./session";

// 账号池 Durable Object：单实例顺序单线程，天然替代原 Go 全局锁。
// 持有全部账号凭证与运行时状态（存 DO Storage），并提供内部 RPC（供 _worker.js 调用）。
//
// 选号语义完全对齐 internal/pool/pick.go：成本分层硬过滤 → top5 短名单 →
// minPickGap 防撞号 → LRU 兜底 / 加权抽签；全冷却时取「到期最早」兜底。
// 纯逻辑在 pool-core.ts（本文件只做 IO 与状态写回），便于单测。
//
// RPC 协议（由 _worker.js 通过 env.POOL.get(id).fetch(subrequest) 调用）：
//   POST /internal/pick        { realm, model?, exclude?: string[], stickyKey? }
//   POST /internal/acquire     { uid }
//   POST /internal/release     { uid }
//   POST /internal/note        { uid, kind, model?, resetAt?, reason? }
//   POST /internal/model-cost  { uid, model, credit, tokens }
//   POST /internal/credits     { uid, credits, creditsTotal, expiring?, earliestExpiry?, earliestRemaining? }
//   POST /internal/add         { auth }
//   POST /internal/remove      { uid }
//   POST /internal/manage      { uid, action }
//   POST /internal/refresh     { uid }
//   GET  /internal/status
//   GET  /internal/list
//   GET  /internal/auth/:uid
//   POST /internal/scheduler/:task
//   POST /internal/alarm
//   POST /internal/arm

const POOL_NAME = "main";
const INDEX_KEY = "index";
/** 成本探索时刻表：key = realm + "\x1f" + model → 上次探索 epoch ms。 */
const EXPLORE_KEY = "cost_explore_last";
/** 累计探索事件数。 */
const EXPLORE_EVENTS_KEY = "cost_explore_events";
/** 单调选号序号（LRU 兜底权威依据，跨请求严格全序）。 */
const PICK_SEQ_KEY = "pick_seq";
const acctKey = (uid: string) => `acct:${uid}`;

/** modelBlock TTL（11102 负缓存退避，对齐 cooldown.go）。 */
const MODEL_BLOCK_BASE_TTL = 6 * 3600_000;
const MODEL_BLOCK_SHIFT = 4;
const MODEL_BLOCK_MAX_TTL = 24 * 3600_000;
/** EMA 平滑系数（NoteModelCost，约 5 次观测收敛）。 */
const COST_ALPHA = 0.3;
/** 404 固定短冷却（不随 soft_rate 退避升级：偶发路径缺失不是限流信号）。 */
const NOT_FOUND_COOLDOWN = 60_000;
/** WAF 403 冷却基数（对齐 Go wafCooldownBase=60s，抖动在调用侧注入）。 */
const WAF_COOLDOWN_BASE = 60_000;

export class PoolDO {
  private env: Env;
  private ctx: DurableObjectState;
  constructor(state: DurableObjectState, env: Env) {
    this.ctx = state;
    this.env = env;
  }

  // ---- 状态读写 ----
  private async listUids(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(INDEX_KEY)) ?? [];
  }
  private async saveUids(uids: string[]): Promise<void> {
    await this.ctx.storage.put(INDEX_KEY, uids);
  }
  private async getAcct(uid: string): Promise<AccountState | null> {
    return (await this.ctx.storage.get<AccountState>(acctKey(uid))) ?? null;
  }
  private async putAcct(a: AccountState): Promise<void> {
    await this.ctx.storage.put(acctKey(a.uid), a);
  }
  private async allAccts(): Promise<AccountState[]> {
    const uids = await this.listUids();
    const out: AccountState[] = [];
    for (const uid of uids) {
      const a = await this.getAcct(uid);
      if (a) out.push(a);
    }
    return out;
  }

  // 运行期账号缓存（DO 内短生命周期，避免每次 pick 全量读 Storage）
  private _cache: AccountState[] | null = null;
  private async refreshCache(): Promise<AccountState[]> {
    this._cache = await this.allAccts();
    return this._cache;
  }

  // ---- 选号 ----
  private async pickCfg(cfg: Config): Promise<PickCfg> {
    return {
      idle_weight_per_hour: cfg.pool.idle_weight_per_hour,
      idle_weight_max: cfg.pool.idle_weight_max,
      prefer_expiring: cfg.pool.prefer_expiring,
      expiring_soon: cfg.pool.expiring_soon,
      credit_floor: cfg.pool.credit_floor,
      cost_explore_interval: cfg.pool.cost_explore_interval,
      max_in_flight: cfg.pool.max_in_flight,
      max_in_flight_global: cfg.pool.max_in_flight_global,
    };
  }

  /**
   * pickOne 选出账号并写回 lastUsed/usedSeq（LRU 与防撞号的权威依据）。
   * 惰性清理过期的模型级冷却与成本台账（两张 map 都不无限膨胀）。
   */
  private async pickOne(
    realm: string,
    model: string | undefined,
    exclude: string[],
    now: number,
    cfg: Config,
  ): Promise<{ uid: string; explored: boolean; fallback: boolean; fallbackKind: string } | null> {
    const accs = this._cache ?? [];
    for (const a of accs) this.prune(a, now);

    const exploreLast = (await this.ctx.storage.get<Record<string, number>>(EXPLORE_KEY)) ?? {};
    const modelRateOf = await rateLookup(this.env);
    const res: PickResult = corePick(accs, {
      realm,
      model: model ?? "",
      exclude: new Set(exclude),
      now,
      cfg: await this.pickCfg(cfg),
      modelRateOf,
      exploreLast,
      rnd: Math.random,
    });

    if (!res.uid) return null;
    if (res.explored) {
      // 探索时刻与事件计数在同锁内写：并发 pick 串行进入，只有一个能过窗口判定。
      await this.ctx.storage.put(EXPLORE_KEY, exploreLast);
      const n = (await this.ctx.storage.get<number>(EXPLORE_EVENTS_KEY)) ?? 0;
      await this.ctx.storage.put(EXPLORE_EVENTS_KEY, n + 1);
    }

    const a = await this.getAcct(res.uid);
    if (!a) return null;
    a.lastUsed = now;
    a.usedSeq = ((await this.ctx.storage.get<number>(PICK_SEQ_KEY)) ?? 0) + 1;
    await this.ctx.storage.put(PICK_SEQ_KEY, a.usedSeq);
    await this.putAcct(a);
    return { uid: a.uid, explored: res.explored, fallback: res.fallback, fallbackKind: res.fallbackKind };
  }

  /** realmSnapshot 各 realm 的 total/healthy 分布，用于 no_healthy_account 诊断。 */
  private realmSnapshot(now: number): Record<string, { total: number; healthy: number }> {
    const out: Record<string, { total: number; healthy: number }> = {};
    for (const a of this._cache ?? []) {
      const r = a.realm || "unknown";
      out[r] ??= { total: 0, healthy: 0 };
      out[r].total++;
      if (a.status !== "disabled" && coreHealthy(a, now)) out[r].healthy++;
    }
    return out;
  }

  /** prune 惰性清理过期的模型级冷却与成本台账条目（对齐 pruneExpiredModelCooldowns/Costs）。 */
  private prune(a: AccountState, now: number): void {
    if (a.modelCooldowns) {
      for (const m of Object.keys(a.modelCooldowns)) {
        const mc = a.modelCooldowns[m];
        if (!mc || mc.until <= now) delete a.modelCooldowns[m];
      }
    }
    if (a.modelCost) {
      for (const m of Object.keys(a.modelCost)) {
        const mc = a.modelCost[m];
        if (!mc || !mc.lastSeen || now - mc.lastSeen > MODEL_COST_TTL) delete a.modelCost[m];
      }
    }
  }

  // ---- RPC 分发 ----
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    const cfg = await getConfig(this.env);
    const now = Date.now();

    try {
      if (request.method === "GET" && p === "/internal/status") {
        return json(await this.status(cfg, now));
      }
      if (request.method === "GET" && p === "/internal/list") {
        await this.refreshCache();
        for (const a of this._cache ?? []) this.prune(a, now);
        return json(this._cache ?? []);
      }
      if (request.method === "GET" && p.startsWith("/internal/auth/")) {
        const uid = decodeURIComponent(p.slice("/internal/auth/".length));
        const a = await this.getAcct(uid);
        return a ? json(a.auth) : notFound();
      }

      const body: any = request.method === "POST" ? await request.json().catch(() => ({})) : {};

      if (p === "/internal/pick") {
        await this.refreshCache();
        const realm = (body.realm as Realm) ?? "cn";
        const model = body.model as string | undefined;
        const exclude: string[] = body.exclude ?? [];
        const stickyKeyName = body.stickyKey as string | undefined;
        const pcfg = await this.pickCfg(cfg);

        // 会话粘性：命中则优先复用同号（仍要过该模型健康 + 在途未满校验，
        // 与 Go PickByUIDForModel 同口径；不可用则解绑回落普通轮换）。
        if (stickyKeyName && cfg.session_sticky.enabled) {
          const bound = await resolveSticky(this.ctx, stickyKeyName);
          if (bound) {
            const a = await this.getAcct(bound);
            const ok =
              !!a &&
              a.realm === realm &&
              (model ? coreHealthyForModel(a, model, now) : coreHealthy(a, now)) &&
              !coreInFlightFull(a, pcfg);
            if (ok) {
              await bindSticky(this.ctx, stickyKeyName, bound, cfg.session_sticky.ttl);
              const a2 = a as AccountState;
              a2.lastUsed = now;
              a2.usedSeq = ((await this.ctx.storage.get<number>(PICK_SEQ_KEY)) ?? 0) + 1;
              await this.ctx.storage.put(PICK_SEQ_KEY, a2.usedSeq);
              await this.putAcct(a2);
              return json({ uid: a2.uid, auth: a2.auth, sticky: true });
            }
          }
        }

        const chosen = await this.pickOne(realm, model, exclude, now, cfg);
        if (!chosen) {
          // 本 realm 无健康账号：放宽 realm 限制再试一次。账号自带 realm，出站按
          // 账号自身 realm 打上游（basesFor(auth.realm)），放宽选号不会跨域错打。
          // 修复：单域用户——如国际版账号 realm=global，但请求模型未带 global:
          // 前缀导致 stripRealm 默认算成 cn——此前会被 a.realm !== "cn" 全量过滤，
          // 永远 no_healthy_account，尽管池里有可用账号。请求仍按裸模型名出站，
          // 选到的账号用自己的 realm 落到正确上游域。
          const relaxed = await this.pickOne("", model, exclude, now, cfg);
          if (!relaxed) {
            return json({ error: "no_healthy_account", realm, model: model ?? "", byRealm: this.realmSnapshot(now) }, 503);
          }
          if (stickyKeyName) await bindSticky(this.ctx, stickyKeyName, relaxed.uid, cfg.session_sticky.ttl);
          const ra = await this.getAcct(relaxed.uid);
          return json({
            uid: relaxed.uid,
            auth: ra?.auth,
            explored: relaxed.explored,
            fallback: true,
            fallback_kind: "realm_relaxed",
          });
        }
        if (stickyKeyName) await bindSticky(this.ctx, stickyKeyName, chosen.uid, cfg.session_sticky.ttl);
        const a = await this.getAcct(chosen.uid);
        return json({
          uid: chosen.uid,
          auth: a?.auth,
          explored: chosen.explored,
          fallback: chosen.fallback,
          fallback_kind: chosen.fallbackKind,
        });
      }

      if (p === "/internal/acquire") {
        const a = await this.getAcct(body.uid);
        if (!a) return notFound();
        a.inFlight++;
        await this.putAcct(a);
        return json({ ok: true, inFlight: a.inFlight });
      }

      if (p === "/internal/release") {
        const a = await this.getAcct(body.uid);
        if (!a) return notFound();
        a.inFlight = Math.max(0, a.inFlight - 1);
        await this.putAcct(a);
        return json({ ok: true, inFlight: a.inFlight });
      }

      if (p === "/internal/note") {
        const a = await this.getAcct(body.uid);
        if (!a) return notFound();
        this.applyNote(a, body.kind, body.model, now, cfg, {
          resetAt: Number(body.resetAt ?? 0) || 0,
          reason: typeof body.reason === "string" ? body.reason : "",
        });
        await this.putAcct(a);
        return json({
          ok: true,
          status: a.status,
          cooldownUntil: a.cooldownUntil,
          cooldownKind: a.cooldownKind,
          breakerUntil: a.breakerUntil ?? 0,
          degradeUntil: a.degradeUntil ?? 0,
          consecutiveFails: a.consecutiveFails ?? 0,
        });
      }

      if (p === "/internal/model-cost") {
        const a = await this.getAcct(body.uid);
        if (!a) return notFound();
        this.noteModelCost(a, String(body.model ?? ""), Number(body.credit ?? 0), Number(body.tokens ?? 0), now);
        await this.putAcct(a);
        return json({ ok: true, credits: a.credits ?? 0, modelCost: a.modelCost ?? {} });
      }

      if (p === "/internal/credits") {
        const a = await this.getAcct(body.uid);
        if (!a) return notFound();
        this.reenableIfCredits(a);
        this.setCreditsDetailed(a, body, now);
        await this.putAcct(a);
        return json({
          ok: true,
          credits: a.credits ?? 0,
          creditsTotal: a.creditsTotal ?? 0,
          status: a.status,
          cooldownKind: a.cooldownKind,
        });
      }

      if (p === "/internal/add") {
        const auth = body.auth as Auth;
        const a: AccountState = {
          uid: auth.uid,
          auth,
          status: "healthy",
          cooldownUntil: 0,
          cooldownKind: "",
          inFlight: 0,
          consecutiveFailures: 0,
          consecutiveFails: 0,
          nickname: auth.nickname,
          realm: auth.realm,
          modelCooldowns: {},
          modelCost: {},
          successCount: 0,
          errTotal: 0,
          // 以下为新建时的零值快照：DO 存量状态可能缺这些键，读侧一律 ?? 兜底，
          // 这里显式写全是为了让「一个刚入池的号有哪些字段」有确定答案。
          disabledReason: "",
          lastUsed: 0,
          lastSuccess: 0,
          lastError: "",
          lastErrorAt: 0,
          degradeUntil: 0,
          retryCount: 0,
          checkinDone: false,
          softStreak: 0,
          sessionDeadFails: 0,
          breakerUntil: 0,
          credits: 0,
          creditsTotal: 0,
          creditsExpiring: 0,
          creditsEarliestExpiry: 0,
          creditsEarliestRemaining: 0,
          creditsBelowFloor: false,
          refreshedAt: 0,
          usedSeq: 0,
        };
        const uids = await this.listUids();
        if (!uids.includes(a.uid)) uids.push(a.uid);
        await this.saveUids(uids);
        await this.putAcct(a);
        this._cache = null;
        return json({ ok: true, uid: a.uid });
      }

      if (p === "/internal/remove") {
        const uid = body.uid as string;
        await this.ctx.storage.delete(acctKey(uid));
        let uids = await this.listUids();
        uids = uids.filter((u) => u !== uid);
        await this.saveUids(uids);
        this._cache = null;
        return json({ ok: true });
      }

      if (p === "/internal/manage") {
        const a = await this.getAcct(body.uid);
        if (!a) return notFound();
        const action = body.action as string;
        if (action === "revive") this.revive(a);
        else if (action === "disable") {
          a.status = "disabled";
          a.disabledReason = String(body.reason ?? "manual disable");
        } else if (action === "enable") this.revive(a);
        else if (action === "checkin_done") a.checkinDone = true;
        await this.putAcct(a);
        this._cache = null;
        return json({ ok: true, status: a.status });
      }

      if (p === "/internal/refresh") {
        const a = await this.getAcct(body.uid);
        if (!a) return notFound();
        const refreshed = await refreshToken(this.env, a.auth);
        a.auth = refreshed;
        a.refreshedAt = now;
        await this.putAcct(a);
        this._cache = null;
        return json({ ok: true, auth: refreshed });
      }

      if (p.startsWith("/internal/scheduler/")) {
        const task = p.slice("/internal/scheduler/".length);
        const { runScheduledTask } = await import("../alarms");
        const result = await runScheduledTask(this.env, this, task, body);
        return json(result);
      }

      if (p === "/internal/alarm") {
        const { onAlarm } = await import("../alarms");
        await onAlarm(this.env, this, cfg);
        return json({ ok: true });
      }

      if (p === "/internal/arm") {
        // 启动 DO alarm 自调度到下一个整点（可选；推荐外部 cron）
        const next = nextHour();
        await this.ctx.storage.setAlarm(next);
        return json({ ok: true, next });
      }

      return json({ error: "unknown_action" }, 404);
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 500);
    }
  }

  // alarm 入口（Durable Object 原生）
  async alarm(): Promise<void> {
    const cfg = await getConfig(this.env);
    const { onAlarm } = await import("../alarms");
    await onAlarm(this.env, this, cfg);
  }

  /** 公开：自调度到下一个整点（供 alarms.onAlarm 调用）。 */
  async scheduleNextAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(nextHour());
  }

  // ---- 状态机（对齐 internal/pool/state.go + cooldown.go + degrade.go + transition.go）----

  /** applyNote 按错误类别施加冷却/熔断/降权/负缓存（对齐 applyErrorPolicy）。 */
  private applyNote(
    a: AccountState,
    kind: string,
    model: string | undefined,
    now: number,
    cfg: Config,
    opt: { resetAt: number; reason: string },
  ): void {
    a.lastError = kind;
    a.lastErrorAt = now;
    a.errTotal = (a.errTotal ?? 0) + 1;
    switch (kind) {
      case "success":
        this.noteSuccess(a, now);
        return;
      case "failures":
        // 连败降权喂入口（ErrClient / 传输层失败这类「不知道原因的失败」）。
        // 带权威分类的错误各有其罚则，不喂本计数器（避免重复计罚）。
        this.noteFailures(a, now, cfg);
        return;
      case "session_dead":
        // 12153 连续 3 次才判死：一次失败即禁用的旧行为会误杀健康账号。
        a.sessionDeadFails = (a.sessionDeadFails ?? 0) + 1;
        if (a.sessionDeadFails >= 3) {
          a.status = "disabled";
          a.disabledReason = "12153 session dead";
          a.cooldownUntil = 0;
          a.cooldownKind = "";
        }
        return;
      case "account_fault_11140":
        // 11140 request illegal：账号级授权封禁，需人工重登。
        a.status = "disabled";
        a.disabledReason = "account banned by upstream (11140 request illegal), re-login required";
        return;
      case "account_fault":
        // 14017 trial not activated：register 未完成，补完可自愈 → 软冷却不禁用。
        this.cooldown(a, "soft_rate", this.softCooldown(cfg), now, "account fault (14017)");
        return;
      case "hard_credit":
        // 402 余额耗尽：冷却到次日 04:00（等签到 09/21 恢复）。
        this.cooldown(a, "hard_credit", Math.max(0, next4AMChina(now) - now), now, "余额不足");
        return;
      case "soft_rate":
      case "waf_block": {
        // 6004（模型级）走模型独立冷却 → 切模型即可用；其余走账号级有界退避。
        const modelRateLimited = kind === "soft_rate" && !!model && isModelRateLimit(opt.reason || "");
        const base = kind === "waf_block" ? WAF_COOLDOWN_BASE : this.softCooldown(cfg);
        if (modelRateLimited && model) {
          this.cooldownForModel(a, model, opt.resetAt, base, cfg, now, "6004 model rate limit");
          return;
        }
        if (opt.resetAt > 0) {
          this.cooldown(a, "soft_rate", Math.max(0, opt.resetAt - now), now, opt.reason || "429 rate limit");
        } else {
          this.cooldownSoftRate(a, base, cfg, now, opt.reason || (kind === "waf_block" ? "waf 403 block" : "429 rate limit"));
        }
        return;
      }
      case "rate_limit_audit":
        // 6004 无可解析重置时间：只挂台账供展示，不改变路由。
        this.recordModelRateLimitAudit(a, String(model ?? ""), opt.reason || "6004 model rate limit (reset unknown)", now, cfg);
        return;
      case "server":
        // 5xx：喂熔断计数（指数退避），与账号级冷却解耦。
        this.noteError(a, now, cfg);
        return;
      case "model_blocked":
        // 11102「该后端无此模型」：负缓存指数退避（6h → 24h 封顶）。
        this.blockModelBackoff(a, String(model ?? ""), opt.reason || "11102 model not available", now);
        return;
      case "model_block_clear":
        // 该 (账号,模型) 实测又通了：清 11102 负缓存（不碰 6004 独立冷却）。
        this.blockModelClear(a, String(model ?? ""));
        return;
      case "not_found":
        // 404 固定短冷却，不随 soft_rate 退避升级。
        this.cooldown(a, "soft_rate", NOT_FOUND_COOLDOWN, now, "upstream 404");
        return;
      case "none":
      default:
        // 不罚号（内容拦截/参数错/上下文超长：换任何号都一样撞墙）。
        return;
    }
  }

  /** noteSuccess 成功即清空连续失败/熔断/连败降权运行态（对齐 NoteSuccess）。 */
  private noteSuccess(a: AccountState, now: number): void {
    a.successCount = (a.successCount ?? 0) + 1;
    a.lastSuccess = now;
    a.consecutiveFailures = 0;
    a.consecutiveFails = 0;
    a.retryCount = 0;
    a.breakerUntil = 0;
    a.softStreak = 0;
    a.sessionDeadFails = 0;
    a.degradeUntil = 0;
    a.status = a.status === "disabled" ? "disabled" : "healthy";
    a.cooldownUntil = 0;
    a.cooldownKind = "";
    // 不碰 modelCooldowns：6004/11102 每模型独立计时，其他模型成功不得抹掉。
  }

  /** noteError 5xx 熔断计数（指数退避，对齐 recordBreakerFailureLocked）。 */
  private noteError(a: AccountState, now: number, cfg: Config): void {
    a.consecutiveFailures = (a.consecutiveFailures ?? 0) + 1;
    if (a.consecutiveFailures < cfg.pool.breaker_threshold) return;
    const base = cfg.pool.breaker_cooldown * 1000;
    const max = cfg.pool.breaker_cooldown_max * 1000;
    const retries = a.retryCount ?? 0;
    let d = base;
    for (let i = 0; i < retries; i++) {
      d *= 2;
      if (d >= max) {
        d = max;
        break;
      }
    }
    a.consecutiveFailures = 0;
    a.retryCount = retries + 1;
    a.breakerUntil = now + d;
    a.status = "cooling";
  }

  /** noteFailures 连败降权（issue #114）：达阈临时出池，降权期内不延长/不翻倍。 */
  private noteFailures(a: AccountState, now: number, cfg: Config): void {
    a.consecutiveFails = (a.consecutiveFails ?? 0) + 1;
    if ((a.consecutiveFails ?? 0) < cfg.pool.degrade_threshold) return;
    // 达阈即清零（供下一轮重新累计），与熔断同哲学。
    a.consecutiveFails = 0;
    if ((a.degradeUntil ?? 0) > now) return; // 降权期内不延长、不翻倍
    let d = cfg.pool.degrade_cooldown * 1000;
    if (d <= 0) d = 10 * 60_000;
    const max = cfg.pool.degrade_cooldown_max * 1000;
    if (max > 0 && d > max) d = max;
    a.degradeUntil = now + d;
  }

  /** softCooldown 软冷却基数（毫秒），对齐 Go softCooldown()（热改立即生效）。 */
  private softCooldown(cfg: Config): number {
    return (cfg.cooldown.soft_rate > 0 ? cfg.cooldown.soft_rate : 600) * 1000;
  }

  /** cooldown 固定时长账号级冷却，并清掉参与路由的模型级豁免。 */
  private cooldown(a: AccountState, kind: any, d: number, now: number, reason: string): void {
    a.status = "cooling";
    a.cooldownKind = kind;
    a.cooldownUntil = now + Math.max(0, d);
    a.lastError = reason;
    this.clearRoutingModelCooldowns(a);
  }

  /** cooldownSoftRate 账号级有界退避：已在有效软冷却中时不推进 streak、不延长。 */
  private cooldownSoftRate(a: AccountState, base: number, cfg: Config, now: number, reason: string): void {
    const maxMs = (cfg.cooldown.soft_rate_max > 0 ? cfg.cooldown.soft_rate_max : 7200) * 1000;
    const inSoft = (a.cooldownKind === "soft" || a.cooldownKind === "soft_rate") && a.cooldownUntil > now;
    if (!inSoft) {
      const streak = (a.softStreak ?? 0) + 1;
      let d = base;
      const shift = Math.min(streak - 1, 16);
      for (let i = 0; i < shift; i++) d *= 2;
      if (!Number.isFinite(d) || d <= 0 || d > maxMs) d = maxMs;
      a.softStreak = streak;
      a.cooldownUntil = now + d;
    }
    a.status = "cooling";
    a.cooldownKind = "soft_rate";
    a.lastError = reason;
    this.clearRoutingModelCooldowns(a);
  }

  /**
   * cooldownForModel 429 的模型级软冷却：带重置墙钟 → 精确对齐（截断到 soft_rate_max），
   * 切模型即可用；无重置墙钟 → 账号级有界退避（不记模型，不豁免）。
   */
  private cooldownForModel(
    a: AccountState,
    model: string,
    resetAt: number,
    base: number,
    cfg: Config,
    now: number,
    reason: string,
  ): void {
    if (resetAt > 0) {
      const maxMs = (cfg.cooldown.soft_rate_max > 0 ? cfg.cooldown.soft_rate_max : 7200) * 1000;
      const cap = now + maxMs;
      const until = resetAt > cap ? cap : resetAt > now ? resetAt : now + 1;
      a.modelCooldowns[model] = { until, resetAt, reason };
      a.lastError = reason;
      return;
    }
    this.cooldownSoftRate(a, base, cfg, now, reason);
  }

  /** recordModelRateLimitAudit 6004 无重置时间：只挂展示台账，不影响路由。 */
  private recordModelRateLimitAudit(a: AccountState, model: string, reason: string, now: number, cfg: Config): void {
    if (!model) return;
    const old = a.modelCooldowns[model];
    if (old && !old.auditOnly && old.until > now) return; // 已有真实模型冷却，审计不得覆盖
    const maxMs = (cfg.cooldown.soft_rate_max > 0 ? cfg.cooldown.soft_rate_max : 7200) * 1000;
    const until = a.cooldownUntil > now ? a.cooldownUntil : now + maxMs;
    a.modelCooldowns[model] = { until, reason, auditOnly: true };
  }

  /** blockModelBackoff 11102 负缓存：TTL = 6h × 2^min(hits-1,4)，封顶 24h。 */
  private blockModelBackoff(a: AccountState, model: string, reason: string, now: number): void {
    if (!model) return;
    const hits = (a.modelCooldowns[model]?.hits ?? 0) + 1;
    const ttl = Math.min(MODEL_BLOCK_BASE_TTL * Math.pow(2, Math.min(hits - 1, MODEL_BLOCK_SHIFT)), MODEL_BLOCK_MAX_TTL);
    a.modelCooldowns[model] = { until: now + ttl, reason, hits };
  }

  /** blockModelClear 只清 11102 条目（reason 前缀判定），不碰 6004 独立冷却。 */
  private blockModelClear(a: AccountState, model: string): void {
    if (!model) return;
    const mc = a.modelCooldowns[model];
    if (!mc || !String(mc.reason ?? "").startsWith("11102")) return;
    delete a.modelCooldowns[model];
  }

  /** clearRoutingModelCooldowns 清参与选号豁免的模型冷却，保留 auditOnly 台账。 */
  private clearRoutingModelCooldowns(a: AccountState): void {
    for (const m of Object.keys(a.modelCooldowns)) {
      if (!a.modelCooldowns[m].auditOnly) delete a.modelCooldowns[m];
    }
  }

  /** revive 复活/解冻：清冷却、熔断、降权、模型台账与连续计数。 */
  private revive(a: AccountState): void {
    a.status = "healthy";
    a.cooldownUntil = 0;
    a.cooldownKind = "";
    a.breakerUntil = 0;
    a.degradeUntil = 0;
    a.consecutiveFailures = 0;
    a.consecutiveFails = 0;
    a.softStreak = 0;
    a.sessionDeadFails = 0;
    a.disabledReason = "";
    a.modelCooldowns = {};
  }

  /**
   * noteModelCost 记录一次实测扣费（EMA 平滑）并顺带内插扣减余额。
   * tokens<=0 不记录（无法折算单价，记进去污染账本）。余额用本地插值口径
   * （签到权威值 - 每笔实扣），只会偏低不会偏高，正是保底需要的安全方向。
   */
  private noteModelCost(a: AccountState, model: string, credit: number, tokens: number, now: number): void {
    if (!model || tokens <= 0) return;
    let per1k = (credit / tokens) * 1000;
    if (!(per1k >= 0)) per1k = 0;
    if (credit > 0) {
      let d = Math.round(credit);
      if (d > (a.credits ?? 0)) d = a.credits ?? 0; // 钳 0：扣穿不产生负余额
      a.credits = (a.credits ?? 0) - d;
      if ((a.creditsExpiring ?? 0) > 0) a.creditsExpiring = Math.max(0, (a.creditsExpiring ?? 0) - d);
      if ((a.creditsEarliestRemaining ?? 0) > 0) {
        if (d >= (a.creditsEarliestRemaining ?? 0)) {
          a.creditsEarliestRemaining = 0;
          a.creditsEarliestExpiry = 0;
        } else {
          a.creditsEarliestRemaining = (a.creditsEarliestRemaining ?? 0) - d;
        }
      }
    }
    if (!a.modelCost) a.modelCost = {};
    const prev = a.modelCost[model];
    if (!prev) {
      a.modelCost[model] = { costPer1k: per1k, lastSeen: now, samples: 1 };
      return;
    }
    if (prev.costPer1k <= 0 && per1k > 0) {
      // 限免结束事件：tier 0 被实测收费覆盖。写入口判定，只看覆盖前值。
      console.warn(`[pool] model ${model} on uid ${a.uid}: free tier ended, now ${per1k.toFixed(3)} credits/1k`);
    }
    const entry: ModelCostEntry = {
      costPer1k: prev.costPer1k * (1 - COST_ALPHA) + per1k * COST_ALPHA,
      lastSeen: now,
      samples: (prev.samples ?? 0) + 1,
    };
    a.modelCost[model] = entry;
  }

  /**
   * reenableIfCredits 签到/余额刷新后解冻（对齐 Go ReenableIfCredits +
   * reviveCoolingLocked）：余额 > 0 且账号未禁用时，只解冻**余额耗尽冷却**
   * （hard_credit），不动熔断器（fails/retryCount/breakerUntil）、软限流退避
   * （soft_rate/softStreak）与模型级台账（modelCooldowns）——限流冷却的恢复
   * 证据是上游重置墙钟到期，不是余额恢复；余额刷新每 5 分钟一轮，全清会把限流
   * 冷却实际寿命压到一个刷新周期内。
   */
  private reenableIfCredits(a: AccountState): void {
    if ((a.credits ?? 0) <= 0 || a.status === "disabled") return;
    if (a.cooldownKind === "hard_credit" || a.cooldownKind === "hard") {
      a.cooldownUntil = 0;
      a.cooldownKind = "";
      a.lastError = "";
      a.status = "healthy";
    }
    // 到期明细必须由紧随其后的 setCreditsDetailed 重写，不能沿用旧窗口快照。
    a.creditsExpiring = 0;
    a.creditsEarliestExpiry = 0;
    a.creditsEarliestRemaining = 0;
  }

  /** setCreditsDetailed 签到/余额刷新写回（子集钳到 [0, credits]，防上游脏数据）。 */
  private setCreditsDetailed(a: AccountState, body: any, now: number): void {
    let credits = Math.max(0, Math.floor(Number(body.credits ?? 0)));
    const total = Math.max(0, Math.floor(Number(body.creditsTotal ?? 0)));
    let expiring = Math.max(0, Math.floor(Number(body.expiring ?? 0)));
    if (expiring > credits) expiring = credits;
    let earliestRemaining = Math.max(0, Math.floor(Number(body.earliestRemaining ?? 0)));
    if (earliestRemaining > credits) earliestRemaining = credits;
    let earliestExpiry = Math.floor(Number(body.earliestExpiry ?? 0)) || 0;
    if (earliestExpiry <= now || earliestRemaining === 0) {
      earliestExpiry = 0;
      earliestRemaining = 0;
    }
    a.credits = credits;
    a.creditsTotal = total;
    a.creditsExpiring = expiring;
    a.creditsEarliestExpiry = earliestExpiry;
    a.creditsEarliestRemaining = earliestRemaining;
    a.creditsBelowFloor = credits <= 0;
    this._cache = null;
  }

  // ---- 统计 ----
  async status(cfg: Config, now: number): Promise<PoolStatus> {
    await this.refreshCache();
    const accs = this._cache ?? [];
    const pcfg = await this.pickCfg(cfg);
    let healthy = 0;
    let cooling = 0;
    let disabled = 0;
    let degraded = 0;
    let inFlightFull = 0;
    let modelCostEntries = 0;
    let modelCooldowns = 0;
    const realm: Record<Realm, { total: number; healthy: number }> = {
      cn: { total: 0, healthy: 0 },
      global: { total: 0, healthy: 0 },
    };
    for (const a of accs) {
      this.prune(a, now);
      realm[a.realm].total++;
      if (a.status === "disabled") disabled++;
      else if (coreHealthy(a, now)) {
        healthy++;
        realm[a.realm].healthy++;
      } else cooling++;
      if ((a.degradeUntil ?? 0) > now) degraded++;
      if (coreInFlightFull(a, pcfg)) inFlightFull++;
      modelCostEntries += Object.keys(a.modelCost ?? {}).length;
      modelCooldowns += Object.keys(a.modelCooldowns ?? {}).filter((m) => (a.modelCooldowns?.[m]?.until ?? 0) > now).length;
    }
    let sticky = 0;
    try {
      sticky = await countSticky(this.ctx);
    } catch {
      /* noop */
    }
    return {
      accounts: accs.length,
      total: accs.length,
      healthy,
      cooling,
      disabled,
      degraded,
      in_flight_full: inFlightFull,
      realm_totals: realm,
      sticky_sessions: sticky,
      redis_mode: false,
      credit_floor: cfg.pool.credit_floor,
      cost_explore: cfg.pool.cost_explore_interval > 0,
      cost_explore_interval: cfg.pool.cost_explore_interval,
      cost_explore_events: (await this.ctx.storage.get<number>(EXPLORE_EVENTS_KEY)) ?? 0,
      cost_explore_last: (await this.ctx.storage.get<Record<string, number>>(EXPLORE_KEY)) ?? {},
      model_cost_entries: modelCostEntries,
      model_cooldowns: modelCooldowns,
    };
  }
}

// ---- 工具 ----

/** isModelRateLimit 报告 body 是否明确指向模型级限流（业务 code 6004）。 */
function isModelRateLimit(body: string): boolean {
  return /"code"\s*:\s*"?6004"?/.test(body);
}

function next4AMChina(now: number): number {
  // now+8h 是「把北京时间当 UTC 看」的伪时间，全程必须用它比较，
  // 不能拿它和真实 epoch 的 now 比（差 8 小时）——否则每天北京 04:00 之后
  // 判定为「未过今日 4 点」而不再 +1 天，差值变负、被 Math.max(0,…) 吃成 0，
  // 硬积分耗尽冷却彻底失效（账号不冷却、持续被选中）。
  const shifted = now + 8 * 3600_000;
  const d = new Date(shifted);
  d.setUTCHours(4, 0, 0, 0);
  if (d.getTime() <= shifted) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime() - 8 * 3600_000;
}

function nextHour(): number {
  const d = new Date(Date.now() + 8 * 3600_000); // UTC+8 本地
  d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
  return d.getTime() - 8 * 3600_000;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function notFound(): Response {
  return json({ error: "not_found" }, 404);
}

// ---- 供 _worker.js 调用的 RPC 客户端 ----
export function poolStub(env: Env): DurableObjectStub {
  return env.POOL.get(env.POOL.idFromName(POOL_NAME));
}

export async function poolRPC(env: Env, path: string, method = "GET", body?: unknown): Promise<any> {
  const stub = poolStub(env);
  const req = new Request("https://pool" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await stub.fetch(req);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}
