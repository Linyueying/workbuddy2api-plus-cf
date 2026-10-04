import type { Auth } from "../src/types";

// proxy 相关测试共享的夹具。
//
// 从 proxy.test.ts 提出来，是为了让 workers-lifecycle 之类的新测试复用同一份 env。
// 两处各自造一个 fakeDB 的话，它们的 D1 行为会悄悄漂移——而用量链路恰恰是靠
// 那条 INSERT 的 SQL 与参数顺序来断言的（单写：用量随 INSERT 一次落清），口径必须一致。

export function makeAuth(uid: string): Auth {
  return {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: Date.now() + 3600_000,
    domain: "copilot.tencent.com",
    realm: "cn",
    uid,
    enterpriseId: "e",
    nickname: "n",
  };
}

export function fakeEnv(auth: Auth) {
  let releaseCount = 0;
  const poolStub = {
    async fetch(req: Request) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/internal/pick") return new Response(JSON.stringify({ uid: auth.uid, auth }), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/internal/release") releaseCount++;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  // 可读写的内存 KV：降级门（prompt:degraded_until）要能落盘并读回。
  const kvMap = new Map<string, string>();
  const fakeKV = {
    m: kvMap,
    get: async (k: string) => kvMap.get(k) ?? null,
    put: async (k: string, v: string) => void kvMap.set(k, v),
    delete: async (k: string) => void kvMap.delete(k),
  };
  // SQL 记录器：用量链路要靠 INSERT（占位）+ UPDATE（回填）两条语句验证，
  // 光看返回值看不出来。sidecar 形态不影响既有测试——它们不检查 SQL。
  const sqlWrites: Array<{ sql: string; params: any[] }> = [];
  const fakeDB = {
    prepare: (sql: string) => ({
      bind: (...params: any[]) => ({
        run: async () => {
          sqlWrites.push({ sql, params });
          // last_row_id 给个固定值，回填时能否把用了同一 id 就有得验。
          return { meta: { last_row_id: 42, changes: 1 } };
        },
        all: async () => ({ results: [] }),
        first: async () => null,
      }),
    }),
  };
  const env = {
    POOL: { get: () => poolStub, idFromName: () => ({}) },
    WB2A_CONFIG: fakeKV,
    WB2A_CACHE: fakeKV,
    WB2A_DB: fakeDB,
    WB2A_LOGS: {},
    writes: sqlWrites,
    releaseCount: () => releaseCount,
  } as any;
  return env;
}
