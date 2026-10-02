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

export function openAIError(status: number, code: string, message: string, hint?: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: "api_error", code, gateway_hint: hint } }),
    { status, headers: { "content-type": "application/json; charset=utf-8" } },
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
): Promise<Response> {
  await primeConfig(env);
  const cfg = await getConfig(env);
  const autoCfg = autoConfigOf(cfg);
  const start = Date.now();
  const signal = request.signal;

  // 子密钥请求级校验：realm 归属 + 模型白名单（读完 body 才判得着，故不进鉴权中间件）。
  // 400 + 具体原因，让客户端把「配置不对」与「密钥无效」区分开。
  if (keyRow) {
    const bad: KeyError | null = verifyKeyRequest(keyRow as any, rawModel, stripRealm(rawModel).realm);
    if (bad) return openAIError(bad.status, bad.code, bad.message);
  }

  // 系统提示词改写（出站前、轮转前；每个请求一次，对齐 Go handler.go）。
  // 必须在 conversation/轮级键派生之前——改写会动 messages 内容，之后取会键漂移。
  // 轮级键在 TS 侧由 pool 的 stickyKey 承担，不从 body 派生，故此处顺序无耦合。
  const promptCfg = cfg;
  const promptMode = String(promptCfg?.prompt?.mode ?? "passthrough").trim().toLowerCase();
  const policy = await applyPromptPolicy(env, body, promptCfg);
  let degradedApplied = policy.degraded;

  // ---- 模型编排：客户端写的模型名 → 候选链（链首首选）----
  const realExists = await realModelExists(env, rawModel).catch(() => false);
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
    try {
      pick = await poolRPC(env, "/internal/pick", "POST", { realm, model: bareModel, exclude: tried, stickyKey: sticky });
    } catch {
      pick = { error: "pool_unavailable" };
    }
    if (pick.error === "no_healthy_account" || pick.error === "pool_unavailable") {
      // 该模型在池里已无可用账号：换号已穷尽，有候选就降级换模型。
      if (Fallbackable(autoCfg, NO_HEALTHY_ACCOUNT) && advance()) continue;
      lastErr = {
        kind: "ErrClient",
        kindName: NO_HEALTHY_ACCOUNT,
        status: 503,
        code: "no_healthy_account",
        message: "no healthy account available",
        note: "none",
        passthrough: false,
        rotate: false,
      };
      break;
    }

    const uid: string = pick.uid;
    tried.push(uid);
    let auth = pick.auth;
    await poolRPC(env, "/internal/acquire", "POST", { uid }).catch(() => {});

    try {
      if (needsRefresh(auth)) {
        const r = await poolRPC(env, "/internal/refresh", "POST", { uid }).catch(() => null);
        if (r?.auth) auth = r.auth;
      }
      const up = await chatStream(env, auth, bareModel, work, request.headers);
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
          log(env, clientIP, userAgent, uid, rawModel, chain[ci], realm, "blocked", c.status, start);
          return openAIError(c.status, c.code, c.message, c.hint);
        }
        // 模型级降级：换号解决不了的错误 → 切下一个候选模型。
        if (Fallbackable(autoCfg, c.kindName) && advance()) continue;
        if (c.rotate && !(await sleep(backoffAfter(i), signal))) break; // 客户端断连
        if (i >= maxAttempts - 1) break;
        continue;
      }

      // 成功：清该 (账号,模型) 的 11102 负缓存 + 记成功。
      await poolRPC(env, "/internal/note", "POST", { uid, kind: "model_block_clear", model: bareModel }).catch(() => {});
      await poolRPC(env, "/internal/note", "POST", { uid, kind: "success" }).catch(() => {});

      const routed = chain[ci] !== rawModel;
      if (routed) log(env, clientIP, userAgent, uid, rawModel, chain[ci], realm, "ok", 200, start);

      if (body.stream) {
        // 流式：透传；成本台账在流结束后按 usage 记账（流内 usage 在末帧）。
        const res = streamChat(up, request, {
          onEnd: (usage) => {
            void recordCost(env, uid, bareModel, usage);
            if (keyRow) void consumeKey(env, keyRow.id, Number(usage?.credit ?? 0), Number(usage?.total_tokens ?? 0));
          },
        });
        if (routed) res.headers.set("X-WB2A-Routed-Model", chain[ci]);
        return res;
      }

      const merged = await aggregateChat(up);
      if (!merged.ok) {
        await poolRPC(env, "/internal/release", "POST", { uid }).catch(() => {});
        log(env, clientIP, userAgent, uid, rawModel, chain[ci], realm, "error", merged.status, start);
        return merged;
      }
      const payload: any = await merged.json().catch(() => null);

      // 空回复降级（auto_model.on_empty，默认开）：响应尚未写回，可直接换候选重试。
      if (autoCfg.on_empty && isEmptyCompletion(payload)) {
        // 空回复也是一次真实消耗：先记账再降级，否则换模型重试等于白嫖一次上游消耗。
        await recordCost(env, uid, bareModel, payload?.usage);
        if (keyRow) await consumeKey(env, keyRow.id, Number(payload?.usage?.credit ?? 0), Number(payload?.usage?.total_tokens ?? 0));
        await poolRPC(env, "/internal/release", "POST", { uid }).catch(() => {});
        if (advance()) {
          tried.push(uid); // 换模型后换一个号重试（同号第二次请求明显更慢且更易失败）
          continue;
        }
        await poolRPC(env, "/internal/release", "POST", { uid }).catch(() => {});
        log(env, clientIP, userAgent, uid, rawModel, chain[ci], realm, "error", 502, start);
        return openAIError(502, "empty_completion", "upstream returned empty completion");
      }

      await recordCost(env, uid, bareModel, payload?.usage);
      if (keyRow) await consumeKey(env, keyRow.id, Number(payload?.usage?.credit ?? 0), Number(payload?.usage?.total_tokens ?? 0));
      await poolRPC(env, "/internal/release", "POST", { uid }).catch(() => {});
      if (!routed) log(env, clientIP, userAgent, uid, rawModel, chain[ci], realm, "ok", 200, start);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...(routed ? { "X-WB2A-Routed-Model": chain[ci] } : {}),
        },
      });
    } catch (e: any) {
      // 传输层失败：不知道原因的失败 → 喂连败计数（降权兜底），并按 5xx 记熔断。
      await poolRPC(env, "/internal/note", "POST", { uid, kind: "failures" }).catch(() => {});
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

  log(env, clientIP, userAgent, undefined, rawModel, chain[ci], stripRealm(chain[ci]).realm, "error", lastErr?.status ?? 503, start);
  return openAIError(lastErr?.status ?? 503, lastErr?.code ?? "no_healthy_account", lastErr?.message ?? "no healthy account available");
}

/** note 把分类结果落到账号池（含 6004 模型级冷却所需的重置时间解析）。 */
async function note(env: Env, uid: string, c: Classified, model: string, bodyText: string): Promise<void> {
  const base: Record<string, unknown> = { uid, kind: c.note, model, reason: bodyText.slice(0, 500) };
  if (c.kind === "ErrSoftRate") {
    const resetAt = parseRateReset(bodyText);
    if (resetAt) base.resetAt = resetAt;
  }
  await poolRPC(env, "/internal/note", "POST", base).catch(() => {});
}

/** recordCost 成本台账：按 usage.credit / total_tokens 记实测单价。 */
async function recordCost(env: Env, uid: string, model: string, usage: any): Promise<void> {
  const total = Number(usage?.total_tokens ?? 0);
  if (!(total > 0)) return;
  const credit = Number(usage?.credit ?? 0);
  await poolRPC(env, "/internal/model-cost", "POST", { uid, model, credit, tokens: Math.floor(total) }).catch(() => {});
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
): void {
  // 最佳努力：不阻塞响应
  Promise.resolve().then(() =>
    insertRequestLog(env, {
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
    }).catch(() => {}),
  );
  void model;
}

/** 解析客户端 IP（尊重 X-Forwarded-For，当 trust_proxy）。 */
export function clientIP(request: Request, trustProxy = true): string {
  if (trustProxy) {
    const xff = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  return "0.0.0.0";
}
