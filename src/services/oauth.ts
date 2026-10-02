import type { Env } from "../../worker-configuration.d.ts";
import type { Auth, Realm } from "../types";
import { oauthState, oauthToken, oauthAccount, dailyCheckin, basesFor } from "./upstream";
import { refreshCredits } from "./tasks";
import { poolRPC } from "../durable/account-pool";
import { cacheKV, kvGetJSON, kvPutJSON, kvDelete } from "../storage/kv";

// OAuth 设备授权流（替代 internal/panel/login.go）。
// state 会话存 KV（非敏感，仅 state 串 + realm），TTL 15min 回收。

const TTL = 900;
interface LoginState {
  realm: Realm;
  createdAt: number;
}

export async function startLogin(env: Env, realm: Realm): Promise<{ ok: boolean; url: string; state: string; realm: Realm; error?: string }> {
  // 上游拒绝时让异常冒到路由层（那里会带上原因写进响应）；只有「拿到响应但
  // state/authUrl 为空」才算这里的 ok=false——那是上游的异常形态，不是网络故障。
  const r = await oauthState(env, realm);
  if (!r.state) return { ok: false, url: "", state: "", realm, error: "empty state" };
  await kvPutJSON(cacheKV(env), "login:" + r.state, { realm, createdAt: Date.now() } as LoginState, TTL);
  return { ok: true, url: r.authUrl, state: r.state, realm };
}

export interface PollResult {
  done: boolean;
  expired?: boolean;
  uid?: string;
  nickname?: string;
  realm?: Realm;
  credits?: number;
  credits_total?: number;
  checkin_message?: string;
}

export async function pollLogin(env: Env, state: string): Promise<PollResult> {
  const ls = await kvGetJSON<LoginState>(cacheKV(env), "login:" + state);
  if (!ls) return { done: false, expired: true };

  const tok = await oauthToken(env, ls.realm, state);
  if (!tok?.accessToken) return { done: false }; // pending

  const acct = await oauthAccount(env, ls.realm, state, String(tok.accessToken));
  const base = basesFor(ls.realm, env);
  const auth: Auth = {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken ?? "",
    expiresAt: Date.now() + (Number(tok.expiresIn ?? tok.expires_in ?? 3600)) * 1000,
    domain: base.chat.replace("https://", ""),
    realm: ls.realm,
    uid: String(acct?.uid ?? acct?.account?.uid ?? ""),
    enterpriseId: String(acct?.enterpriseId ?? acct?.account?.enterpriseId ?? ""),
    nickname: String(acct?.nickname ?? acct?.account?.nickname ?? acct?.uid ?? "unknown"),
  };
  // 防路径穿越：uid 仅允许安全字符
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(auth.uid)) return { done: false, expired: true };

  // 落池
  await poolRPC(env, "/internal/add", "POST", { auth }).catch(() => {});
  await poolRPC(env, "/internal/manage", "POST", { uid: auth.uid, action: "revive" }).catch(() => {});

  // 顺带签到 / 余额（新号入池即建成本台账基线，否则 credits 恒 undefined）
  let credits = 0, creditsTotal = 0, checkinMessage: string | undefined;
  try {
    const ci = await dailyCheckin(env, auth);
    checkinMessage = ci.message;
    const cr = await refreshCredits(env, auth);
    credits = cr.credits; creditsTotal = cr.creditsTotal;
  } catch { /* 不影响登录成功 */ }

  await kvDelete(cacheKV(env), "login:" + state);
  return { done: true, uid: auth.uid, nickname: auth.nickname, realm: auth.realm, credits, credits_total: creditsTotal, checkin_message: checkinMessage };
}

export async function loginRegions(): Promise<{ ok: boolean; regions: { code: string; name: string }[] }> {
  return {
    ok: true,
    regions: [
      { code: "HK", name: "香港" },
      { code: "MO", name: "澳门" },
      { code: "SG", name: "新加坡" },
      { code: "TH", name: "泰国" },
      { code: "PH", name: "菲律宾" },
      { code: "MY", name: "马来西亚" },
      { code: "ID", name: "印尼" },
    ],
  };
}
