import type { Env } from "../../worker-configuration.d.ts";
import type { Realm } from "../types";
import { getConfig } from "../config";
import { poolRPC } from "../durable/account-pool";
import { chatStream, needsRefresh, primeConfig } from "./upstream";
import { classify, type Classified } from "./classify";
import { streamChat, aggregateChat } from "./sse";
import { Chain, Fallbackable, NO_HEALTHY_ACCOUNT, type AutoModelConfig } from "./autoroute";
import { realModelExists, stripRealm } from "./resolveModel";
import { applyPromptPolicy, DEGRADED, rewriteSystemPrompt, triggerDegrade } from "./prompt";
import { consumeKey, verifyKeyRequest, type KeyError } from "./apikeys";
import { insertRequestLog } from "../storage/d1";
import { logAccountEvent } from "../storage/syslog";
import { newTimeline, markSince, addElapsed, withTiming, headersWithTiming, now, type Timeline } from "./timing";
import type { CacheProbe } from "./boot";
import type { Usage } from "./sse";

// 反向代理 + 多账号轮转 + 模型编排（替代 internal/server/handler.go 的
// chatCompletions 主循环）。
//
// 三个正交维度：
//   - 模型候选链（autoroute）：auto 虚拟模型昼夜轮换 + model_fallback 递归展开；
//     链首首选，仅在「换号解决不了」的错误（Fallbackable）或该模型无可用账号时降级。
//   - 每候选模型的换号额度 MaxRotate：额度用尽才换模型（继续换号已无意义）。
//   - 账号选号（pool）：成本分层 + 短名单 + 加权抽签，见 pool-core。
//
// 纯流式：不缓冲上游正文；客户端断开经 request.signal 清理。

/** MAX_ROTATE 单请求每个候选模型的换号额度（对齐 Go MaxRotate=3）。 */
const MAX_ROTATE = 3;
/** MAX_ATTEMPTS_CAP 轮转总预算封顶（Go 口径 MaxRotate × 链长，上限 32）。 */
const MAX_ATTEMPTS_CAP = 32;
/** ROTATE_BACKOFF_BASE 轮转退避基数（对齐官方 CLI 500ms 形态）。 */
const ROTATE_BACKOFF_BASE = 500;
/** ROTATE_BACKOFF_CAP 轮转退避封顶。 */
const ROTATE_BACKOFF_CAP = 8000;

export function openAIError(status: number, code: string, message: string, hint?: string, tl?: Timeline): Response {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  // 错误响应也带计时：失败路径的时间分布同样是诊断依据——pick 慢导致的
  // 503（no_healthy_account）与其���错误码的耗时画像完全不同，丢了就白瞎一趟。
  return new Response(
    JSON.stringify({ error: { message, type: "api_error", code, gateway_hint: hint } }),
    { status, headers: tl ? headersWithTiming(headers, tl) : headers },
  );
}

function stickyKeyOf(request: Request): string | undefined {
  return request.headers.get("x-conversation-request-id") ?? request.headers.get("x-session-key") ?? undefined;
}

/** autoConfigOf 从网关配置抽出模型编排段（config.auto_model + model_fallback）。 */
export function autoConfigOf(cfg: any): AutoModelConfig {
  const a = cfg?.auto_model ?? {};
  return {
    enabled: !!a.enabled,
    day_primary: a.day_primary ?? "",
    night_primary: a.night_primary ?? "",
    day_start: a.day_start ?? 8,
    day_end: a.day_end ?? 23,
    fallback: a.fallback ?? [],
    model_fallback: cfg?.model_fallback ?? {},
    virtual_id: a.virtual_id ?? "",
    override: !!a.override,
    on_empty: a.on_empty !== false,
    fallback_on: a.fallback_on ?? [],
  };
}

/** hourCST 当前 Asia/Shanghai 小时（0-23），编排的昼夜判定必须按北京时间。 */
export function hourCST(now = Date.now()): number {
  return new Date(now + 8 * 3600_000).getUTCHours();
}

/** jitterDur 给时长施加 ±25% 抖动（打散多请求同相位重试）。 */
function jitterDur(d: number): number {
  if (d <= 0) return d;
  const f = 1 + (Math.random() * 2 - 1) * 0.25;
  return Math.max(0, Math.round(d * f));
}

/** backoffAfter 第 n 次轮转前的退避时长：base·2^n 封顶 cap，再 ±25% 抖动。 */
export function backoffAfter(n: number): number {
  let d = ROTATE_BACKOFF_BASE;
  for (let k = 0; k < n && d < ROTATE_BACKOFF_CAP; k++) d *= 2;
  if (d > ROTATE_BACKOFF_CAP) d = ROTATE_BACKOFF_CAP;
  return jitterDur(d);
}

/** backoffAfterFor 供测试注入确定性抖动幅度断言用。 */
export const backoffAfterFor = backoffAfter;

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal?.aborted);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** isEmptyCompletion 200 但正文为空（issue #31：reasoning_effort=max 吃满预算）。 */
export function isEmptyCompletion(resp: any): boolean {
  const choices = resp?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return true;
  const c0 = choices[0];
  if (!c0 || typeof c0 !== "object") return false; // 形态未知 → 不判空
  const msg = c0.message;
  if (!msg || typeof msg !== "object") return true;
  const content = String(msg.content ?? "").trim();
  if (content !== "") return false;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return false; // 工具调用是有效结果
  if (String(msg.reasoning_content ?? "").trim() !== "") return false;
  return true;
}

/** rewriteModel 改写出站 body 的 model 名（链上切换候选时用）。 */
function rewriteModel(body: any, bareModel: string): any {
  if (!body || typeof body !== "object") return body;
  return { ...body, model: bareModel };
}

export async function proxyChat(
  env: Env,
  request: Request,
  rawModel: string,
  body: any,
  clientIP: string,
  userAgent: string,
  keyRow?: { id: string } | null,
  /**
   * waitUntil 把「响应返回之后的异步收尾」挂到 Workers 生命周期上。
   *
   * ⚠️ 这不是可选优化，而是流式用量能不能落库的决定性一环。Cloudflare Workers 的
   * 语义是：handler 返回 Response 后，只有被 ctx.waitUntil 显式延寿的 promise 才
   * 保证跑完，其余会在 isolate 回收时被**静默丢弃**。而流式请求的收尾天生躲在
   * 这个空档里——Response 立刻返回给客户端，用量回填却发生在上游流读完之后的
   * tap.flush 中；那句 UPDATE 落进 unprotected 窗口就会被吞掉，症状正是
   * 「有请求数、有延迟，但 token / credits / msg 全 0」，且没有任何报错。
   *
   * 本地 vitest 完全测不出这个问题（Node 没有 isolate 回收），Go 版更是天然免疫
   * ——它跑在常驻进程里，chatStat.done() 与 usage.Recorder.Add() 都是进程内写入，
   * 请求结束不等于进程结束。移植到 Workers 时这一环极易漏掉，这里是显式补偿。
   *
   * 缺省值保留「立即执行」语义，便于单测在没有 ExecutionContext 时照常断言写入。
   */
  waitUntil: (p: Promise<unknown>) => void = (p) => {
    void p;
  },
  /**
   * tl 本次请求的分段计时表（TTFT 归因用，见 services/timing.ts）。
   *
   * 由路由层建好后一路传进来，而不是在这里新建：t0 必须是请求进入网关的
   * 时刻，那比 proxyChat 被调用早一个中间件（CORS + 鉴权 + 读 body 都在之前），
   * 在这里起表会把最该被看见的几段（auth / body）整个漏掉。
   * 缺省自建一张：单测直连本函数时不会崩，只是 total 会偏小。
   */
  tl: Timeline = newTimeline(),
  /**
   * probe 每请求一份的缓存命中探针（见 services/boot.ts）。
   *
   * 只用来喂 X-Auth-Cache / X-Models-Cache 这几个观测头——把「isolate 刚起来」
   * 和「cache TTL 到期」两种冷启动成因区分开。缺省留空（单测直连本函数时
   * 不报错，只是收不到缓存命中数据）。
   */
  probe?: CacheProbe,
): Promise<Response> {
  const tCfg = now();
  await primeConfig(env);
  const cfg = await getConfig(env, { onCache: (h) => probe?.config.push(h) });
  markSince(tl, "cfg", tCfg);
  const autoCfg = autoConfigOf(cfg);
  const start = Date.now();
  const signal = request.signal;

  // 子密钥请求级校验：realm 归属 + 模型白名单（读完 body 才判得着，故不进鉴权中间件）。
  // 400 + 具体原因，让客户端把「配置不对」与「密钥无效」区分开。
  if (keyRow) {
    const bad: KeyError | null = verifyKeyRequest(keyRow as any, rawModel, stripRealm(rawModel).realm);
    if (bad) return openAIError(bad.status, bad.code, bad.message, undefined, tl);
  }

  // 系统提示词改写（出站前、轮转前；每个请求一次，对齐 Go handler.go）。
  // 必须在 conversation/轮级键派生之前——改写会动 messages 内容，之后取会键漂移。
  // 轮级键在 TS 侧由 pool 的 stickyKey 承担，不从 body 派生，故此处顺序无耦合。
  const promptCfg = cfg;
  const promptMode = String(promptCfg?.prompt?.mode ?? "passthrough").trim().toLowerCase();
  // prompt 与 models 是两次**互不相干**的 KV 读，原先串行 await，于是两笔
  // ~100ms 的往返首尾相接叠成 ~200ms。这里并行发起，各自在落地时打点。
  const tPrompt = now();
  const policyP = applyPromptPolicy(env, body, promptCfg).then((p) => {
    tl.seg.prompt = Math.max(0, now() - tPrompt);
    return p;
  });
  const tModels = now();
  const existsP = realModelExists(env, rawModel, { onCache: (h) => probe?.models.push(h) })
    .catch(() => false)
    .then((exists) => {
      tl.seg.models = Math.max(0, now() - tModels);
      return exists;
    });
  const [policy, realExists] = await Promise.all([policyP, existsP]);
  let degradedApplied = policy.degraded;

  // ---- 模型编排：客户端写的模型名 → 候选链（链首首选）----
  const chain = Chain(autoCfg, rawModel, hourCST(), realExists);
  let ci = 0;
  let work = policy.body;
  const sticky = stickyKeyOf(request);
  let tried: string[] = [];
  let perModel = 0;
  let lastErr: Classified | null = null;

  const maxAttempts = Math.min(MAX_ROTATE * chain.length, MAX_ATTEMPTS_CAP);

  // advance 切到下一个候选模型：重算 realm/裸名、重写出站 body、清空已试账号
  // （换模型后账号可用性判据——6004 模型级冷却——完全不同）。
  const advance = (): boolean => {
    if (ci + 1 >= chain.length) return false;
    ci++;
    work = rewriteModel(work, stripRealm(chain[ci]).model);
    tried = [];
    perModel = 0;
    return true;
  };

  for (let i = 0; i < maxAttempts; i++) {
    // 当前候选的换号额度用尽且还有候选 → 换模型。
    if (perModel >= MAX_ROTATE && advance()) continue;
    perModel++;

    const { realm, model: bareModel } = stripRealm(chain[ci]);

    let pick: any;
    let pickErr: string | undefined;
    let pickStatus: number | undefined;
    // pick 累加而非覆盖：轮转重试会打好几轮，要看的是「选号这件事总共占了多久」。
    const tPick = now();
    try {
      // acquire 随 pick 一起做：PoolDO 在独立 Worker 上，这两步原本是两次跨 Worker
      // HTTP 往返，而它们永远成对出现（选到号就一定要占位）。合并后关键路径少一次。
      pick = await poolRPC(env, "/internal/pick", "POST", { realm, model: bareModel, exclude: tried, stickyKey: sticky, acquire: 1 });
    } catch (e: any) {
      pickErr = String(e?.message ?? e);
      pickStatus = e?.poolStatus;
      // 还原 DO 真实返回的错误（如 no_healthy_account + byRealm 分布），不让它
      // 被「poolRPC 抛异常」这件事掩盖成 pool_unavailable。
      let parsed: any = {};
      try { parsed = JSON.parse(e?.message ?? "{}"); } catch {}
      if (pickStatus !== undefined && parsed?.error) pick = { error: parsed.error, ...parsed };
      else pick = { error: "pool_unavailable" };
    } finally {
      addElapsed(tl, "pick", now() - tPick);
    }
    if (pick.error) {
      // 该模型在池里已无可用账号（或 DO 直接报错）：换号已穷尽才降级换模型。
      if (Fallbackable(autoCfg, NO_HEALTHY_ACCOUNT) && advance()) continue;
      // 区分三类故障：
      //   pool_unavailable      → 传输层连不上（POOL 未绑 / engine 未部署）
      //   no_healthy_account    → DO 正常响应，但本模型确实无健康账号（附 byRealm 分布）
      //   其它错误码（含 500）  → DO 自身报错，原样回传 HTTP 状态
      const unreachable = pick.error === "pool_unavailable";
      lastErr = {
        kind: "ErrClient",
        kindName: NO_HEALTHY_ACCOUNT,
        status: unreachable ? 503 : pickStatus ?? 503,
        code: unreachable ? "pool_unavailable" : pick.error,
        message: unreachable
          ? `account pool unreachable (PoolDO RPC failed)${pickErr ? ` — ${pickErr}` : ""}`
          : pick.error === "no_healthy_account"
            ? `no healthy account available | total=${pick.diagnose?.total ?? "?"} reasons=${JSON.stringify(pick.diagnose?.by_reason ?? {})}`
            : `account pool DO error (HTTP ${pickStatus})${pickErr ? ` — ${pickErr}` : ""}`,
        note: "none",
        passthrough: false,
        rotate: false,
        hint: unreachable
          ? "Pages 调不动 PoolDO（传输层失败）：检查 Pages 项目是否绑定 engine 的 POOL（Dashboard → Pages → Settings → Functions → Durable Object 绑定（bindings）→ 新增 POOL，class=PoolDO，script_name=workbuddy2api-engine），且 engine Worker 已部署、未报错。" +
            (pickErr ? ` | ${pickErr}` : "")
          : pick.error === "no_healthy_account"
            ? `请求 realm=${realm}。DO 账号总数=${pick.diagnose?.total ?? "?"}。各不可选原因=${JSON.stringify(pick.diagnose?.by_reason ?? {})}。明细=${JSON.stringify(pick.diagnose?.sample ?? [])}`
            : `PoolDO 自身返回了错误（HTTP ${pickStatus}）。${pickErr ?? ""}`,
      };
      break;
    }

    const uid: string = pick.uid;
    tried.push(uid);
    let auth = pick.auth;
    // 兼容性兜底：engine Worker 还没升级（不含 acquire 合并）时，pick 响应里不会有
    // acquired:true —— 补发一次显式 acquire。否则在途计数永远不增，
    // max_in_flight 并发闸门会静默失效，但不报错，属于最难查的那类退化。
    if (pick.acquired !== true) await poolRPC(env, "/internal/acquire", "POST", { uid }).catch(() => {});

    try {
      // 已升级的 engine 在 pick 里就顺带刷好了临期 token（freshAuth），这里判定为
      // 「不临期」直接跳过 —— 省掉一次跨 Worker 往返。旧版 engine 返回的还是旧
      // auth，判定仍成立，于是照原路补一次 refresh：功能不变，只是没省这一趟。
      if (needsRefresh(auth)) {
        const tRefresh = now();
        const r = await poolRPC(env, "/internal/refresh", "POST", { uid }).catch(() => null);
        if (r?.auth) auth = r.auth;
        markSince(tl, "refresh", tRefresh);
      }
      const tUp = now();
      const up = await chatStream(env, auth, bareModel, work, request.headers);
      // upstream = 到**响应头**为止（fetch 在头到达时 resolve），即上游握手 + 排队
      // 的首字节延迟。真正的模型首 Token 还在这之后（上游要先把第一个 chunk 发出），
      // 但那是不可逆的物理等待，也从第一个 SSE 帧的下发时刻起就与本地无关了。
      markSince(tl, "upstream", tUp);
      if (!up.ok) {
        const txt = await up.text();
        const c = classify(up.status, txt);
        await note(env, uid, c, bareModel, txt);
        await poolRPC(env, "/internal/release", "POST", { uid }).catch(() => {});
        lastErr = c;

        // 内容拦截误报（passthrough/append 模式首遇）：判定为 system 指纹误报，
        // 触发降级到次日 00:00 CST，换 Degraded 中性提示词同请求内重试（append
        // 降级重试同样退化为 replace——原文在场只会确定性再撞 400）。第二次仍被拦
        // （用户内容本身触发审核）→ 走下面的 content_blocked 透传。
        // 内容问题非账号问题：note 的 kind 是 "none"，不罚账号。
        if (c.kind === "ErrContentBlocked" && (promptMode === "passthrough" || promptMode === "append") && !degradedApplied) {
          await triggerDegrade(env).catch(() => {});
          work = rewriteSystemPrompt(work, DEGRADED);
          degradedApplied = true;
          // 单账号池也能拿到重试机会（降级重试占一次名额）。
          const idx = tried.lastIndexOf(uid);
          if (idx >= 0) tried.splice(idx, 1);
          continue;
        }

        if (c.passthrough || c.kind === "ErrContentBlocked") {
          waitUntil(log(env, clientIP, userAgent, uid, rawModel, chain[ci], realm, "blocked", c.status, start));
          return openAIError(c.status, c.code, c.message, c.hint, tl);
        }
        // 模型级降级：换号解决不了的错误 → 切下一个候选模型。
        if (Fallbackable(autoCfg, c.kindName) && advance()) continue;
        if (c.rotate && !(await sleep(backoffAfter(i), signal))) break; // 客户端断连
        if (i >= maxAttempts - 1) break;
        continue;
      }

      // 成功：清该 (账号,模型) 的 11102 负缓存 + 记成功。
      // 两个事件一次 RPC 施加（kinds 批量），省一次跨 Worker 往返。
      // 副作用与分两次发完全一致：applyNote 按 kinds 顺序逐个施加，最后统一落盘。
      //
      // ⚠️ 挂 waitUntil 而不是 await：这趟 RPC 原本排在 `up.ok` 之后、首字节之前
      // ——一个完整的跨 Worker 往返（真机实测 41ms）被白压在用户的 TTFT 上，而它
      // 的结果（清负缓存、成功计数）对本次响应**没有任何影响**：流都还没开始转
      // 发，客户端此刻也不需要知道这一步的成败。
      // waitUntil 保证它在 isolate 回收前跑完，语义等价于原来的 await，只是不再
      // 结算到用户的等待时间里。
      waitUntil(poolRPC(env, "/internal/note", "POST", { uid, kinds: ["model_block_clear", "success"], model: bareModel }).catch(() => {}));
      // 段值记 0 而非删除：让响应头持续反映「它已不在关键路径上」，而不是让人
      // 怀疑是埋点丢了。
      tl.seg.note = 0;

      const routed = chain[ci] !== rawModel;

      if (body.stream) {
        // 成功即记（不论是否被编排路由）。流式分支此前只在 routed 时记，导致
        // 「流式 + 未路由」（最常见的直连用法）一条日志都不写，面板日志页全空。
        //
        // 日志改成**流结束时一次写清**（含用量），不再是「开局占位 + 末帧 UPDATE」：
        //   1) 占位 INSERT 是在返回首个字节之前 await 的 —— 一次 D1 往返被压进了 TTFB，
        //      而 D1 的往返是毫秒级可变延迟，直接加在用户感知的"首字时间"上；
        //   2) 占位 + 回填是**两行写**，D1 免费套餐按写入行数计（10 万行/天），
        //      一次对话请求付两行，等于把日志额度砍半；
        //   3) 少一条 UPDATE 也就少一次"UPDATE 掉进 unprotected 窗口被静默丢弃"的风险。
        // 代价：客户端中途断连、且 Worker 在 abort 回调跑完前就被回收时，这一条没有记录。
        // 正常情况下 abort 分支会补写一行（见下），真正丢的只有进程级硬中断。
        let rawUsage: string | undefined;
        let logged = false;
        /** close 落日志，只落一次；usage 为 null 时靠 note 说明"为什么没有用量"。 */
        const close = (usage: Usage | null, note?: string) => {
          if (logged) return;
          logged = true;
          waitUntil(
            log(env, clientIP, userAgent, uid, rawModel, chain[ci], realm, "ok", 200, start, usage, rawUsage ?? note),
          );
        };
        // 在途回收双保险：流式请求此前只 acquire 从不 release，inFlight 只增不减，
        // 几次请求后所有账号在途占满 → inFlightFull → no_healthy_account（真机「之前能用、
        // 用着用着全空」的根因）。正常结束走 onEnd；客户端中途断连时 streamChat 的
        // tap.flush 不触发，改由 request.signal 兜底。released 标志避免双重回收。
        let released = false;
        /** cost 一并带上，把「记成本台账 + 释放在途」合并成一次 RPC。 */
        const release = (cost?: CostPayload) => {
          if (released) return;
          released = true;
          waitUntil(poolRPC(env, "/internal/release", "POST", { uid, ...(cost ? { cost } : {}) }).catch(() => {}));
        };
        // 诊断：把上游真实返回的 usage 原文暂存，随日志一起写进 msg，
        // 便于面板日志页直接看到「上游到底回了什么 usage」（token 恒 0 时最关键）。
        const res = streamChat(up, request, {
          onUsageRaw: (raw) => {
            rawUsage = raw;
          },
          onEnd: (usage) => {
            // 上游若整条流都没给 usage，rawUsage 为空——写明确标记，便于区分
            // 「上游没回 usage」与「解析器认不出字段」这两种完全不同的原因。
            close(usage, usage ? undefined : "上游流内无 usage 帧");
            if (keyRow) waitUntil(consumeKey(env, keyRow.id, Number(usage?.credit ?? 0), Number(usage?.total_tokens ?? 0)));
            release(costOf(usage, bareModel));
          },
        });
        request.signal.addEventListener("abort", () => {
          close(null, "客户端在流结束前断开");
          release();
        });
        if (routed) res.headers.set("X-WB2A-Routed-Model", chain[ci]);
        // 计时头在**返回前**写：此刻 downstream 还没拿到任何字节，写入的两帧
        // headers 仍然可变。这是 TTFT 归因的关键——客户端（或 curl -I）在收到
        // 第一个 data 帧的同时就能读到完整的时间分布。
        withTiming(res, tl);
        return res;
      }

      const merged = await aggregateChat(up);
      if (!merged.ok) {
        await poolRPC(env, "/internal/release", "POST", { uid }).catch(() => {});
        // 「响应返回后还要写库」一律交给 waitUntil，否则 isolate 回收会把日志吞掉。
        waitUntil(log(env, clientIP, userAgent, uid, rawModel, chain[ci], realm, "error", merged.status, start));
        return withTiming(merged, tl);
      }
      const payload: any = await merged.json().catch(() => null);

      // 空回复降级（auto_model.on_empty，默认开）：响应尚未写回，可直接换候选重试。
      if (autoCfg.on_empty && isEmptyCompletion(payload)) {
        // 空回复也是一次真实消耗：先记账再降级，否则换模型重试等于白嫖一次上游消耗。
        // 扣配额挂 waitUntil（不影响下面是否重试）；release 仍 await——这条路径
        // 后面可能 continue 重试，必须确认在途已释放才去选下一个号。
        if (keyRow) waitUntil(consumeKey(env, keyRow.id, Number(payload?.usage?.credit ?? 0), Number(payload?.usage?.total_tokens ?? 0)));
        // 记账随 release 一起发（cost 字段），少一次跨 Worker 往返。
        await poolRPC(env, "/internal/release", "POST", { uid, ...costArg(payload?.usage, bareModel) }).catch(() => {});
        if (advance()) {
          tried.push(uid); // 换模型后换一个号重试（同号第二次请求明显更慢且更易失败）
          continue;
        }
        await poolRPC(env, "/internal/release", "POST", { uid }).catch(() => {});
        waitUntil(log(env, clientIP, userAgent, uid, rawModel, chain[ci], realm, "error", 502, start));
        return openAIError(502, "empty_completion", "upstream returned empty completion", undefined, tl);
      }

      // 收尾三件（扣配额 / 带成本台账的 release / 日志）全部挂 waitUntil 并行发出，
      // **不再 await**：响应体此刻已经在手，若还等这三次跨 Worker + D1 往返才返回，
      // 就等于把 60-300ms 白加在每个非流式请求上——而它们对用户回包毫无影响。
      // release 走 waitUntil 是安全的：waitUntil 的语义就是保证跑完，不会因 isolate
      // 回收而丢；且这条路径后面直接 return，不存在「释放没生效就又去选号」的问题。
      if (keyRow) waitUntil(consumeKey(env, keyRow.id, Number(payload?.usage?.credit ?? 0), Number(payload?.usage?.total_tokens ?? 0)));
      waitUntil(poolRPC(env, "/internal/release", "POST", { uid, ...costArg(payload?.usage, bareModel) }).catch(() => {}));
      waitUntil(log(env, clientIP, userAgent, uid, rawModel, chain[ci], realm, "ok", 200, start, payload?.usage));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: headersWithTiming(
          {
            "content-type": "application/json; charset=utf-8",
            ...(routed ? { "X-WB2A-Routed-Model": chain[ci] } : {}),
          },
          tl,
        ),
      });
    } catch (e: any) {
      // 传输层失败：不知道原因的失败 → 喂连败计数（降权兜底），并按 5xx 记熔断。
      // 这里同样读回 changed：连败达阈会把账号降权出池，属于「池容量缩水」的系统事件。
      const nr: any = await poolRPC(env, "/internal/note", "POST", { uid, kind: "failures" }).catch(() => null);
      const nchanged: string[] = Array.isArray(nr?.changed) ? nr.changed : [];
      if (nchanged.length) void logAccountEvent(env, "warn", uid, nchanged.join("；"));
      await poolRPC(env, "/internal/release", "POST", { uid }).catch(() => {});
      lastErr = {
        kind: "ErrServer",
        kindName: "server",
        status: 503,
        code: "upstream_error",
        message: String(e?.message ?? e),
        note: "server",
        passthrough: false,
        rotate: true,
      };
      if (Fallbackable(autoCfg, "server") && advance()) continue;
      if (i >= maxAttempts - 1) break;
    }
  }

  waitUntil(log(env, clientIP, userAgent, undefined, rawModel, chain[ci], stripRealm(chain[ci]).realm, "error", lastErr?.status ?? 503, start));
  return openAIError(
    lastErr?.status ?? 503,
    lastErr?.code ?? "no_healthy_account",
    lastErr?.message ?? "no healthy account available",
    lastErr?.hint,
    tl,
  );
}

/** note 把分类结果落到账号池（含 6004 模型级冷却所需的重置时间解析）。 */
async function note(env: Env, uid: string, c: Classified, model: string, bodyText: string): Promise<void> {
  const base: Record<string, unknown> = { uid, kind: c.note, model, reason: bodyText.slice(0, 500) };
  if (c.kind === "ErrSoftRate") {
    const resetAt = parseRateReset(bodyText);
    if (resetAt) base.resetAt = resetAt;
  }
  // DO 在 /internal/note 的响应里回传 changed[]：本次施加造成的**显著**状态跃变
  // （进入熔断/降权/被禁用、冷却类别切换、从冷却恢复）。把它们写进「系统」日志频道。
  //
  // 为什么由 proxy 写而不是 DO 自己写：DO 有严格并发约束，在选号热路径上插一次
  // D1 往返会拖慢每一个请求。proxy 侧写则落在已有的收尾流程里，且 DO 已经把
  // 「值不值得记」的判断做完了（changed 为空就是常态，不写）。
  const r: any = await poolRPC(env, "/internal/note", "POST", base).catch(() => null);
  const changed: string[] = Array.isArray(r?.changed) ? r.changed : [];
  if (changed.length) {
    // 被禁用属于 error 级；其余（熔断/降权/冷却/恢复）是 warn 级的状态变更。
    const severe = changed.some((m) => m.includes("禁用"));
    void logAccountEvent(env, severe ? "error" : "warn", uid, changed.join("；"));
  }
}

/**
 * costOf 把上游 usage 收敛成 /internal/release 的 cost 载荷（无用量返回 undefined）。
 *
 * 存在理由：记成本台账与释放在途原本是两次 poolRPC（model-cost + release），
 * 而 PoolDO 在独立 Worker 上——每一次都是跨 Worker HTTP 往返。两者永远前后脚
 * 发生在同一次收尾里，合并成一次即可。
 */
interface CostPayload {
  model: string;
  credit: number;
  tokens: number;
}

function costOf(usage: Usage | null | undefined, model: string): CostPayload | undefined {
  const total = Number((usage as any)?.total_tokens ?? 0);
  if (!(total > 0)) return undefined;
  return { model, credit: Number((usage as any)?.credit ?? 0), tokens: Math.floor(total) };
}

/** costArg 同上，用于非流式：无用量时给空对象（展开后不带 cost 字段）。 */
function costArg(usage: any, model: string): { cost: CostPayload } | Record<string, never> {
  const c = costOf(usage, model);
  return c ? { cost: c } : {};
}

/** parseRateReset 从 429 body 解析上游重置墙钟（epoch ms，UTC+8 解释）。 */
export function parseRateReset(body: string): number {
  // CN 文案优先：「将在 <时间> 重置」；global 域英文 "reset at YYYY-MM-DD HH:MM:SS"。
  const cn = /将在\s+(.+?)\s*重置/.exec(body);
  const en = /reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/i.exec(body);
  const raw = (cn?.[1] ?? en?.[1] ?? "").trim().replace(/\s*UTC\+8$/i, "");
  if (!raw) return 0;
  // 上游时间无时区后缀，固定按 UTC+8 解释。
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600_000;
}

/** dryUsage 把上游 usage 收敛成用量列。 Streaming 的 usage 字段名各家不统一：
 *  OpenAI 用 prompt_tokens/completion_tokens/total_tokens，Anthropic 风格用
 *  input_tokens/output_tokens——上游（workbuddy.ai）实测两类都可能出现，故全兼容；
 *  缓存读命中可能叫 prompt_tokens_details.cached_tokens 或 cache_read_input_tokens。
 *  若上游不给 prompt/completion 拆分（只给 total_tokens），则把总量记到 prompt 侧，
 *  保证「合计」不为 0（宁可少拆分，也不要让面板显示全 0）。 */
export function dryUsage(usage: Usage | null | undefined): {
  prompt_tokens: number;
  completion_tokens: number;
  credits: number;
  cache_read_tokens: number;
} {
  const u = usage as any;
  // prompt_cache_hit_tokens 排第一：它是上游（/v2/chat/completions）**实测唯一会返回**
  // 的命中字段——见 services/cachekey.ts 顶部逆向注记「带 key → prompt_cache_hit_tokens
  // =7808, credit≈0.02」。原先只认 OpenAI 口径的三种写法，于是这列真实数据被整体忽略、
  // 面板缓存维度恒为 0；其余写法仍保留兜底，别的兼容层走这条链路时不至于退化。
  const cached = Number(
    u?.prompt_cache_hit_tokens ??
      u?.prompt_tokens_details?.cached_tokens ??
      u?.cache_read_input_tokens ??
      u?.cache_creation_input_tokens ??
      0,
  );
  let prompt = Number(u?.prompt_tokens ?? u?.input_tokens ?? 0) || 0;
  let completion = Number(u?.completion_tokens ?? u?.output_tokens ?? 0) || 0;
  const total = Number(u?.total_tokens ?? 0) || 0;
  // 兜底：上游只给 total_tokens、没给拆分 → 记到 prompt 侧，至少合计不为 0。
  if (prompt === 0 && completion === 0 && total > 0) prompt = total;
  // 反向兜底：给了拆分但没给 total 时，补一个（成本台账/前端「合计」用得到）。
  if (completion === 0 && total > prompt && prompt > 0) completion = total - prompt;
  // 对称情形：上游只给了输出侧与总量，输入侧同样由差值反推——否则「输入 Token」
  // 会显示 0，而实际上只是没单独汇报。
  if (prompt === 0 && completion > 0 && total > completion) prompt = total - completion;
  return {
    prompt_tokens: Math.max(0, prompt),
    completion_tokens: Math.max(0, completion),
    credits: Math.max(0, Number(u?.credit ?? 0) || 0),
    cache_read_tokens: Number.isFinite(cached) ? Math.max(0, cached) : 0,
  };
}

/**
 * log 写一条请求日志（一次 INSERT 就把用量写清，不依赖后续 UPDATE 回填）。
 *
 * msg 用于携带上游原始 usage 或"为什么没有用量"的诊断标记，写在同一行里——
 * 早先它是靠第二次 UPDATE 补进去的，那条 UPDATE 一旦掉进 Workers 的 unprotected
 * 窗口就会被静默丢弃，症状是「有请求数、有延迟，但 token 全 0 且查不到原因」。
 *
 * 失败一律吞掉：日志是观测设施，它挂了不应该让用户的对话请求失败。代价是丢日志，
 * 这比让整个网关不可用划算得多。
 */
function log(
  env: Env,
  ip: string,
  ua: string,
  uid: string | undefined,
  model: string,
  actualModel: string,
  realm: Realm,
  outcome: string,
  status: number,
  start: number,
  usage?: any,
  msg?: string | null,
): Promise<number> {
  return insertRequestLog(env, {
    ts: Date.now(),
    channel: "chat",
    client_ip: ip,
    user_agent: ua,
    uid,
    model: actualModel || model,
    realm,
    outcome: outcome as any,
    status,
    ms: Date.now() - start,
    ...dryUsage(usage),
    ...(msg ? { msg: `usage=${msg.slice(0, 400)}` } : {}),
  }).catch((e: any) => {
    // 失败一律吞掉：日志是观测设施，它挂了不应该让用户的对话请求失败。
    // 但不能连声响都没有——写不进日志正是「用量页空」最容易被忽略的一环。
    console.error("[reqlog] 请求日志写入失败，该请求用量将丢失:", String(e?.message ?? e));
    return 0;
  });
}

/** 解析客户端 IP（尊重 X-Forwarded-For，当 trust_proxy）。 */
export function clientIP(request: Request, trustProxy = true): string {
  if (trustProxy) {
    const xff = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  return "0.0.0.0";
}
