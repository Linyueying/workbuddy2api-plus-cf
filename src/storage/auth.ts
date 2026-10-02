import type { Auth, Realm } from "../types";

// 凭证解析（替代 internal/auth.Parse）：兼容嵌套形与扁平形，realm 按 domain 后缀 backfill。

function inferRealm(domain: string): Realm {
  return domain.endsWith(".workbuddy.ai") ? "global" : "cn";
}

export function parseAuthText(text: string): Auth {
  const j = JSON.parse(text);
  return parseAuth(j);
}

export function parseAuth(j: any): Auth {
  // 嵌套形
  if (j.auth || j.account) {
    const a = j.auth ?? {};
    const ac = j.account ?? {};
    const domain = a.domain ?? (j.domain || "");
    const realm: Realm = a.realm || ac.realm || inferRealm(domain);
    return {
      accessToken: a.accessToken ?? "",
      refreshToken: a.refreshToken ?? "",
      expiresAt: Number(a.expiresAt ?? a.expiresIn ? (a.expiresAt ?? Date.now() + (a.expiresIn ?? 3600) * 1000) : Date.now() + 3600_000),
      domain,
      realm,
      uid: String(a.uid ?? ac.uid ?? ""),
      enterpriseId: String(a.enterpriseId ?? ac.enterpriseId ?? ""),
      nickname: String(a.nickname ?? ac.nickname ?? a.uid ?? "unknown"),
      device_token: a.device_token ?? j.device_token,
    };
  }
  // 扁平形
  const domain = j.domain ?? "";
  const realm: Realm = j.realm || inferRealm(domain);
  return {
    accessToken: j.accessToken ?? "",
    refreshToken: j.refreshToken ?? "",
    expiresAt: Number(j.expiresAt ?? Date.now() + (j.expiresIn ?? 3600) * 1000),
    domain,
    realm,
    uid: String(j.uid ?? ""),
    enterpriseId: String(j.enterpriseId ?? ""),
    nickname: String(j.nickname ?? j.uid ?? "unknown"),
    device_token: j.device_token,
  };
}

export function serializeAuth(a: Auth): string {
  // 落盘统一嵌套形
  return JSON.stringify(
    {
      auth: {
        accessToken: a.accessToken,
        refreshToken: a.refreshToken,
        expiresAt: a.expiresAt,
        domain: a.domain,
        realm: a.realm,
        device_token: a.device_token,
      },
      account: { uid: a.uid, enterpriseId: a.enterpriseId, nickname: a.nickname },
    },
    null,
    2,
  );
}
