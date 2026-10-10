import type { Env } from "../../worker-configuration.d.ts";
import type { AccountState, Auth, PoolStatus, Realm, ModelCooldown, ModelCostEntry } from "../types";
import { getConfig, type Config } from "../config";
import { refreshToken, needsRefresh } from "../services/upstream";
import { rateLookup } from "../services/rates";
import {
  pick as corePick,
  healthy as coreHealthy,
  healthyForModel as coreHealthyForModel,
  inFlightFull as coreInFlightFull,
  hardCooled,
  floorBlocked,
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
//   POST /internal/pick        { realm, model?, exclude?: string[], stickyKey?, acquire? }
//   POST /internal/acquire     { uid }
//   POST /internal/release     { uid, cost?: { model, credit, tokens } }
//   POST /internal/note        { uid, kind | kinds: string[], model?, resetAt?, reason? }
//   POST /internal/model-cost  { uid, model, credit, tokens }
//
// 带 acquire / kinds / cost 三个可选字段是为了压跨 Worker 往返次数：PoolDO 部署在
// 独立 Worker 上，每次 RPC 都是一次完整 HTTP 往返。见各处字段的注释。
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
/** 账号键前缀：批量读（storage.list）靠它一次捞出全部账号，替代逐 uid 的 get。 */
const ACCT_PREFIX = "acct:";

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
  //
  // 内存态是本 DO 的**唯一活状态**：账号对象只在首次访问时从 Storage 反序列化一次，
  // 之后 getAcct 直接返回内存里的那个对象，putAcct 写 Storage 并同步内存。
  //
  // 为什么必须这样（而不是"每次读都拿一份新副本"）：
  //   老实现是"逐 uid storage.get（N+1）+ 每次 pick 全量重读"。pick 在每条对话请求的
  //   关键路径上，N 个账号就是 N 次 Storage 读 + 一轮 JSON 反序列化，N 越大首字延迟越长。
  //   但直接加缓存会踩一个更隐蔽的坑：DO 的 storage.get 每次返回**独立副本**，
  //   acquire/release/note 这些写路径如果读的是副本、而 pick 读的是缓存里的另一个对象，
  //   inFlight/冷却就会各写各的、互相覆盖 —— 比慢更危险。
  //   所以缓存存的必须是"活对象引用"，且所有写路径一律走 putAcct（含内存同步），
  //   不允许绕过它裸调 storage.put。
  private _accts: Map<string, AccountState> | null = null;
  /** 账号顺序（快照来自 index 键；list 顺序影响同分时的兜底选取，故要稳定）。 */
  private _order: string[] | null = null;

  /** ensureState 首次访问时批量装载；已装载则直接返回（写路径自行维护，无需重读）。 */
  private async ensureState(): Promise<Map<string, AccountState>> {
    if (this._accts) return this._accts;
    // 一次 list 拿全部账号（1 次 Storage 读），替代 N 次 get。
    const [uids, listed] = await Promise.all([
      this.ctx.storage.get<string[]>(INDEX_KEY),
      this.ctx.storage.list<AccountState>({ prefix: ACCT_PREFIX }),
    ]);
    const byUid = new Map<string, AccountState>();
    for (const [k, v] of listed) {
      if (!v || typeof v !== "object") continue;
      byUid.set(k.slice(ACCT_PREFIX.length), v as AccountState);
    }
    // index 是权威顺序；index 缺失/落后于实际账号（老数据或异常写入）时补齐，
    // 保证"存了就一定选得到"，不会凭空少号。
    const order = (uids ?? []).filter((u) => typeof u === "string");
    const seen = new Set(order);
    for (const uid of byUid.keys()) if (!seen.has(uid)) order.push(uid);
    this._order = order;
    this._accts = byUid;
    return byUid;
  }

  private async listUids(): Promise<string[]> {
    await this.ensureState();
    return (this._order ?? []).slice();
  }
  private async saveUids(uids: string[]): Promise<void> {
    await this.ctx.storage.put(INDEX_KEY, uids);
    if (this._order) this._order = uids.slice();
  }
  private async getAcct(uid: string): Promise<AccountState | null> {
    return (await this.ensureState()).get(uid) ?? null;
  }
  private async putAcct(a: AccountState): Promise<void> {
    await this.ctx.storage.put(acctKey(a.uid), a);
    // 写穿：内存态与 Storage 一起更新，避免"改了副本、缓存还是旧值"。
    if (this._accts) {
      this._accts.set(a.uid, a);
      if (this._order && !this._order.includes(a.uid)) this._order.push(a.uid);
    }
  }
  /**
   * freshAuth 选号命中后**就地**刷新临期 token，返回可直接出站的 auth。
   *
   * 存在理由：原流程是 proxy 拿到 pick 的 auth → 发现临期 → 再发一次
   * /internal/refresh（跨 Worker 一次完整 HTTP 往返，30-150ms）→ DO 才去刷新。
   * 而「选号」与「用这个号出站」永远连着发生，token 是否临期在 DO 里就能判，
   * 没必要让调用方再跑一趟。
   *
   * 刷新失败不抛：返回旧 auth，让调用方照旧走它自己的兜底（再试一次）。
   */
  private async freshAuth(a: AccountState, now: number): Promise<Auth> {
    if (!needsRefresh(a.auth)) return a.auth;
    try {
      const refreshed = await refreshToken(this.env, a.auth);
      a.auth = refreshed;
      a.refreshedAt = now;
      await this.putAcct(a);
      return refreshed;
    } catch {
      return a.auth;
    }
  }

  private async allAccts(): Promise<AccountState[]> {
    const byUid = await this.ensureState();
    const out: AccountState[] = [];
    for (const uid of this._order ?? []) {
      const a = byUid.get(uid);
      if (a) out.push(a);
    }
    return out;
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
  /** ACQUIRE_TTL_MS 在途占用超时：超过此值仍未 release（客户端断连 / Worker 异常导致
   *  onEnd 不触发）则强制回收，避免所有账号 inFlight 永久占满 → no_healthy_account。 */
  private static readonly ACQUIRE_TTL_MS = 10 * 60_000;

  private async pickOne(
    realm: string,
    model: string | undefined,
    exclude: string[],
    now: number,
    cfg: Config,
  ): Promise<{ uid: string; explored: boolean; fallback: boolean; fallbackKind: string } | null> {
    // 内存态已装载则零 Storage 读；写路径（acquire/release/note/…）改的是同一批对象，
    // 所以这里看到的必然是最新的 inFlight / 冷却 / 成本台账。
    const accs = await this.allAccts();
    for (const a of accs) this.prune(a, now);

    // 超时回收：acquire 后长时间未 release 的在途占用强制清零（见 ACQUIRE_TTL_MS 说明）。
    // 注意 acquiredAt 缺失也回收：那是升级前留下的泄漏计数（老版本 acquire 不写时间戳），
    // 不回收会永远卡死（no_healthy_account, reasons={in_flight_full:1}）。
    const recycled: AccountState[] = [];
    for (const a of accs) {
      if (a.inFlight > 0 && (!a.acquiredAt || now - a.acquiredAt > PoolDO.ACQUIRE_TTL_MS)) {
        a.inFlight = 0;
        a.acquiredAt = 0;
        recycled.push(a);
      }
    }
    for (const a of recycled) await this.putAcct(a);

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
  private async realmSnapshot(now: number): Promise<Record<string, { total: number; healthy: number }>> {
    const out: Record<string, { total: number; healthy: number }> = {};
    for (const a of await this.allAccts()) {
      const r = a.realm || "unknown";
      out[r] ??= { total: 0, healthy: 0 };
      out[r].total++;
      if (a.status !== "disabled" && coreHealthy(a, now)) out[r].healthy++;
    }
    return out;
  }

  /**
   * diagnose 逐账号列出「为什么不可选」，用于 no_healthy_account 时一锤定音。
   * 若 sample 里出现 realize="pickable_but_unselected"，说明兜底逻辑本身有 bug
   * （本应可选却没被选上）；若 total=0，说明 DO 里根本没加载到账号（绑定/加载问题）。
   */
  private async diagnose(
    now: number,
    realm: string,
    model: string | undefined,
    cfg: Config,
  ): Promise<{ total: number; by_reason: Record<string, number>; sample: Array<Record<string, unknown>> }> {
    const pcfg = await this.pickCfg(cfg);
    const modelRateOf = await rateLookup(this.env);
    const byReason: Record<string, number> = {};
    const sample: Array<Record<string, unknown>> = [];
    const pushReason = (r: string) => {
      byReason[r] = (byReason[r] ?? 0) + 1;
    };
    const accs = await this.allAccts();
    for (const a of accs) {
      const reasons: string[] = [];
      if (realm && a.realm !== realm) reasons.push("realm_mismatch");
      if (a.status === "disabled") reasons.push("disabled");
      if (a.cooldownUntil > now) reasons.push("cooled");
      if ((a.breakerUntil ?? 0) > now) reasons.push("breaker");
      if ((a.degradeUntil ?? 0) > now) reasons.push("degraded");
      if (hardCooled(a, now)) reasons.push("hard_cooled");
      const m = model ?? "";
      if (m && floorBlocked(a, m, pcfg, now, modelRateOf, realm)) reasons.push("floor_blocked");
      if (coreInFlightFull(a, pcfg)) reasons.push("in_flight_full");
      if (reasons.length === 0) reasons.push("pickable_but_unselected");
      for (const r of reasons) pushReason(r);
      if (sample.length < 8) {
        sample.push({
          uid: a.uid,
          realm: a.realm,
          status: a.status,
          inFlight: a.inFlight,
          credits: a.credits,
          cooldownUntil: a.cooldownUntil,
          breakerUntil: a.breakerUntil ?? 0,
          degradeUntil: a.degradeUntil ?? 0,
          reasons,
        });
      }
    }
    return { total: accs.length, by_reason: byReason, sample };
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
        const list = await this.allAccts();
        for (const a of list) this.prune(a, now);
        // ?stats=1：一次 RPC 带回面板概览要的全部信息。sticky_sessions 读的是 DO
        // 内会话存储，Worker 侧拿不到，只能在这里顺带返回——其余统计项（healthy/
        // cooling/disabled/in_flight_full）Worker 侧可用 pool-core 的同一份纯函数
        // 从账号列表直接算出，不必再发一次 /internal/status。
        // 面板轮询从 5s 降到 30s 后仍是持续开销，合并成单次 RPC 把 DO 请求再砍一半。
        if (url.searchParams.get("stats") === "1") {
          let sticky = 0;
          try {
            sticky = await countSticky(this.ctx);
          } catch {
            /* noop */
          }
          return json({ accounts: list, sticky_sessions: sticky });
        }
        return json(list);
      }
      if (request.method === "GET" && p.startsWith("/internal/auth/")) {
        const uid = decodeURIComponent(p.slice("/internal/auth/".length));
        const a = await this.getAcct(uid);
        return a ? json(a.auth) : notFound();
      }

      const body: any = request.method === "POST" ? await request.json().catch(() => ({})) : {};

      if (p === "/internal/pick") {
        // 不再无条件全量重读 Storage：账号状态常驻内存，写路径写穿维护。
        // 面板每次对话请求都要走这一支，此前 N 个账号 = N+1 次 Storage 读。
        const realm = (body.realm as Realm) ?? "cn";
        const model = body.model as string | undefined;
        const exclude: string[] = body.exclude ?? [];
        const stickyKeyName = body.stickyKey as string | undefined;
        const pcfg = await this.pickCfg(cfg);
        // acquire=1：选号成功即在本次调用内占位，省掉调用方紧接着的第二次
        // /internal/acquire 往返。PoolDO 是**独立 Worker**（Pages 不能自带 DO），
        // 每一次 poolRPC 都是一次跨 Worker HTTP 往返——这是请求延迟里最大的一块
        // 可压缩项，能合并的往返必须合并。
        // 响应带 acquired:true 让调用方确认已占位；不带就说明 engine 还是旧版，
        // 调用方补发一次显式 acquire（部署有先后时的兼容兜底）。
        const wantAcquire = body.acquire === true || body.acquire === 1 || body.acquire === "1";
        const acquireIn = async (uid: string): Promise<boolean> => {
          if (!wantAcquire) return false;
          const a = await this.getAcct(uid);
          if (!a) return false;
          a.inFlight++;
          a.acquiredAt = now;
          await this.putAcct(a);
          return true;
        };

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
              const got = await acquireIn(a2.uid);
              return json({ uid: a2.uid, auth: await this.freshAuth(a2, now), sticky: true, acquired: got });
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
            const diag = await this.diagnose(now, realm, model, cfg);
            return json(
              { error: "no_healthy_account", realm, model: model ?? "", byRealm: await this.realmSnapshot(now), diagnose: diag },
              503,
            );
          }
          if (stickyKeyName) await bindSticky(this.ctx, stickyKeyName, relaxed.uid, cfg.session_sticky.ttl);
          const gotRelaxed = await acquireIn(relaxed.uid);
          const ra = await this.getAcct(relaxed.uid);
          return json({
            uid: relaxed.uid,
            auth: ra ? await this.freshAuth(ra, now) : undefined,
            explored: relaxed.explored,
            fallback: true,
            fallback_kind: "realm_relaxed",
            acquired: gotRelaxed,
          });
        }
        if (stickyKeyName) await bindSticky(this.ctx, stickyKeyName, chosen.uid, cfg.session_sticky.ttl);
        const got = await acquireIn(chosen.uid);
        const a = await this.getAcct(chosen.uid);
        return json({
          uid: chosen.uid,
          auth: a ? await this.freshAuth(a, now) : undefined,
          explored: chosen.explored,
          fallback: chosen.fallback,
          fallback_kind: chosen.fallbackKind,
          acquired: got,
        });
      }

      if (p === "/internal/acquire") {
        const a = await this.getAcct(body.uid);
        if (!a) return notFound();
        a.inFlight++;
        a.acquiredAt = now;
        await this.putAcct(a);
        return json({ ok: true, inFlight: a.inFlight });
      }

      if (p === "/internal/release") {
        const a = await this.getAcct(body.uid);
        if (!a) return notFound();
        // cost: {model, credit, tokens} —— 流末「记成本台账 + 释放在途」合成一次
        // RPC。二者本来就前后脚发生在同一个 onEnd 里，拆成两次要多付一次跨 Worker
        // 往返和一个 DO 请求额度。tokens<=0 不记（无法折算单价，与 model-cost 同口径）。
        const cost = body.cost as { model?: string; credit?: number; tokens?: number } | undefined;
        if (cost && String(cost.model ?? "") && Number(cost.tokens ?? 0) > 0) {
          this.noteModelCost(a, String(cost.model), Number(cost.credit ?? 0), Math.floor(Number(cost.tokens)), now);
        }
        a.inFlight = Math.max(0, a.inFlight - 1);
        if (a.inFlight === 0) a.acquiredAt = 0;
        await this.putAcct(a);
        return json({ ok: true, inFlight: a.inFlight });
      }

      if (p === "/internal/note") {
        const a = await this.getAcct(body.uid);
        if (!a) return notFound();
        // kinds: string[] —— 一次 RPC 施加多个事件（如成功路径的
        // model_block_clear + success）。跨 Worker 往返是延迟主项，能并就并。
        // 单发形态 kind: string 保留兼容。
        const kinds: string[] =
          Array.isArray(body.kinds) && body.kinds.length ? body.kinds.map((k: unknown) => String(k)) : [String(body.kind ?? "")];
        const opt = {
          resetAt: Number(body.resetAt ?? 0) || 0,
          reason: typeof body.reason === "string" ? body.reason : "",
        };
        // 记下施加前的状态，用于识别「这次调用是否造成了显著跃变」。
        // 调用方（proxy）据此写系统日志——**DO 自己不写 D1**：DO 有严格的并发
        // 约束，在选号热路径上插一次 D1 往返会拖慢每一个请求。
        const before = {
          status: a.status,
          cooling: (a.cooldownUntil ?? 0) > now,
          coolingKind: String(a.cooldownKind ?? ""),
          breaker: (a.breakerUntil ?? 0) > now,
          degrade: (a.degradeUntil ?? 0) > now,
          disabledReason: String(a.disabledReason ?? ""),
        };
        for (const kind of kinds) this.applyNote(a, kind, body.model, now, cfg, opt);
        // 只写一次 Storage：N 个 kind 一次落盘，而不是 N 次。
        await this.putAcct(a);
        return json({
          ok: true,
          status: a.status,
          cooldownUntil: a.cooldownUntil,
          cooldownKind: a.cooldownKind,
          breakerUntil: a.breakerUntil ?? 0,
          degradeUntil: a.degradeUntil ?? 0,
          consecutiveFails: a.consecutiveFails ?? 0,
          // changed: 本次调用造成的**显著**状态跃变，供上层写 sys 日志。
          // 空数组 = 没有值得留痕的变化（常态，绝大多数失败上报都落这里）。
          changed: describeStateChange(before, a, now),
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
        await this.putAcct(a); // 写穿：内存态同步入池
        return json({ ok: true, uid: a.uid });
      }

      if (p === "/internal/remove") {
        const uid = body.uid as string;
        await this.ctx.storage.delete(acctKey(uid));
        let uids = await this.listUids();
        uids = uids.filter((u) => u !== uid);
        await this.saveUids(uids);
        // 内存态同步除名，否则"删了还在池里被选中"。
        this._accts?.delete(uid);
        if (this._order) this._order = this._order.filter((u) => u !== uid);
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
        await this.putAcct(a); // 写穿：disable/enable 立刻对选号生效
        return json({ ok: true, status: a.status });
      }

      if (p === "/internal/refresh") {
        const a = await this.getAcct(body.uid);
        if (!a) return notFound();
        const refreshed = await refreshToken(this.env, a.auth);
        a.auth = refreshed;
        a.refreshedAt = now;
        await this.putAcct(a); // 写穿：新 token 立刻对后续 pick 生效
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
    // 不需要失效缓存：调用方（/internal/credits）紧接着 putAcct，改的就是内存里这个对象。
  }

  // ---- 统计 ----
  async status(cfg: Config, now: number): Promise<PoolStatus> {
    const accs = await this.allAccts();
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
  if (!res.ok) {
    // 把 DO 的真实状态码挂到错误上，让调用方区分「传输层连不上」与「DO 返回了错误」。
    // 否则 no_healthy_account(503) 会被 poolRPC 的 throw 吞掉、被 proxy 误判成 pool_unavailable，
    // 把「没账号」伪装成「池连不上」，排查时完全误导。
    const err: any = new Error(JSON.stringify(data));
    err.poolStatus = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// 状态跃变的「显著变化」识别
// ---------------------------------------------------------------------------

/** NoteBefore 施加 note 之前的账号状态快照（/internal/note 内部用）。 */
export interface NoteBefore {
  status: string;
  cooling: boolean;
  coolingKind: string;
  breaker: boolean;
  degrade: boolean;
  disabledReason: string;
}

/**
 * describeStateChange 比较施加前后，返回**值得写进系统日志**的跃变描述。
 *
 * 为什么不能把每次 note 都记为系统事件：note 是热路径，一次 429、一次 5xx 都会走
 * 这里；全记会把「系统」频道刷成一片冷却噪音，真出事时反而找不到，还白烧 D1 额度
 * （免费额度按扫描行数计费）。所以只挑真正的**状态跃变**：
 *
 *   - 进入熔断（breaker 由 0 变有）：该账号连续 5xx 被出池，是池容量缩水的信号
 *   - 进入降权（degrade 由 0 变有）：连败被临时出池（issue #114）
 *   - 被禁用（status 变 disabled）：凭证失效/账号封禁，需人工介入重登 —— 最严重
 *   - 冷却类别变化（如 soft → hard_credit）：说明失败原因换了性质
 *   - 从冷却中恢复（cooling/breaker/degrade 由有变无）：账号重新可用
 *
 * 返回空数组表示「没有值得留痕的变化」——这是绝大多数调用的情况，属正常。
 */
export function describeStateChange(before: NoteBefore, a: AccountState, now: number): string[] {
  const out: string[] = [];
  const wasDisabled = before.status === "disabled";
  const nowDisabled = a.status === "disabled";

  // 1) 被禁用：最高优先级，必须留痕。带出 disabledReason 便于定位（12153 / 11140）。
  if (!wasDisabled && nowDisabled) {
    out.push(`账号被禁用${a.disabledReason ? `（${a.disabledReason}）` : ""}`);
  } else if (wasDisabled && !nowDisabled) {
    out.push("账号已解禁");
  }

  // 2) 熔断：连续 5xx 达阈被出池（带指数退避时长）。
  const breakerNow = (a.breakerUntil ?? 0) > now;
  if (!before.breaker && breakerNow) {
    out.push(`进入熔断至 ${fmtUntil(a.breakerUntil ?? 0, now)}`);
  } else if (before.breaker && !breakerNow) {
    out.push("熔断已解除");
  }

  // 3) 降权：连败达阈临时出池。
  const degradeNow = (a.degradeUntil ?? 0) > now;
  if (!before.degrade && degradeNow) {
    out.push(`进入连败降权至 ${fmtUntil(a.degradeUntil ?? 0, now)}`);
  } else if (before.degrade && !degradeNow) {
    out.push("降权已解除");
  }

  // 4) 冷却类别切换（如 soft → hard_credit 余额耗尽）。同类别内时长变化不记——
  //    有界退避每次失败都会延长，记它等于记每一次失败。
  const coolNow = (a.cooldownUntil ?? 0) > now;
  const kindNow = String(a.cooldownKind ?? "");
  if (!before.cooling && coolNow) {
    out.push(`进入冷却（${kindNow || "unknown"}）至 ${fmtUntil(a.cooldownUntil ?? 0, now)}`);
  } else if (before.cooling && coolNow && before.coolingKind && before.coolingKind !== kindNow) {
    out.push(`冷却类别由 ${before.coolingKind} 变为 ${kindNow || "unknown"}`);
  } else if (before.cooling && !coolNow) {
    out.push("冷却已解除");
  }

  return out;
}

/** fmtUntil 把到期时间戳压成「还有 N 分钟」这种运维一眼能读的形式。 */
function fmtUntil(until: number, now: number): string {
  const ms = Math.max(0, until - now);
  const min = Math.round(ms / 60_000);
  if (min < 1) return "少于 1 分钟";
  if (min < 60) return `${min} 分钟后`;
  const h = (min / 60).toFixed(1);
  return `${h} 小时后`;
}
