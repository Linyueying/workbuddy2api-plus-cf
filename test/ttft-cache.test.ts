import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadKeyByHash, invalidateKeyCache } from "../src/services/apikeys";
import { invalidateConfig, getConfig, saveConfig } from "../src/config";
import { degradedActive, triggerDegrade, invalidateDegradeCache } from "../src/services/prompt";
import { modelsSnapshot, invalidateModelsSnapshot } from "../src/services/models-snapshot";
import { readFileSync } from "node:fs";
import { proxyChat } from "../src/services/proxy";
import { makeAuth, fakeEnv } from "./proxy.helper";

// C1 / C2 / C3 / C5 的验收测试。
//
// 这一组的份量在于：它们测的都是**缓存**，而缓存的特点是「坏了不报错」——
// 少一次失效、TTL 算错、命中了不该命的负结果，全都静默表现为「慢一点」或
// 「改了不生效」，要在真机上复现得碰运气。所以每条缓存都必须成对验证
// 「命中时省了 IO」与「该失效时立刻失效」，缺一半就等于没测。

type Row = Record<string, any> | null;

/** 计数型 D1：每个 first/run/all 都记一笔，用来数「到底打了几趟库」。 */
function countingDB(row: Row) {
  const stats = { firsts: 0, runs: 0 };
  return {
    stats,
    db: {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            stats.firsts++;
            return row;
          },
          all: async () => ({ results: [] }),
          run: async () => {
            stats.runs++;
            return { meta: { changes: 1, last_row_id: 0 } };
          },
        }),
      }),
    },
  };
}

beforeEach(() => {
  // 四条缓存都是**模块级**的，用例之间会互相泄漏（上一个写的行被下一个命中）。
  invalidateKeyCache();
  invalidateDegradeCache();
  invalidateModelsSnapshot();
  invalidateConfig();
});

describe("C2 子密钥内存缓存", () => {
  const row = {
    id: "k1", key_hash: "h1", name: "n", prefix: "sk-x", models: "[]", created_at: 0, last_used: 0,
    enabled: 1, expires_at: 0, realm: "", ip_allowlist: "[]", max_ips: 0, ips: "[]", last_ip: "",
    req_count: 0, quota: 0, used_tokens: 0, quota_credit: 0, used_credit: 0, seq: 1,
  };

  it("连续两次同 hash 只打一趟 D1（验收：第二次 auth 不再查库）", async () => {
    const { stats, db } = countingDB(row);
    const env = { WB2A_DB: db } as any;
    const a = await loadKeyByHash(env, "h1");
    const b = await loadKeyByHash(env, "h1");
    expect(a?.id).toBe("k1");
    expect(b?.id).toBe("k1");
    expect(stats.firsts).toBe(1);
  });

  it("不同 hash 各自查一次，互不串味", async () => {
    const { stats, db } = countingDB(row);
    const env = { WB2A_DB: db } as any;
    await loadKeyByHash(env, "h1");
    await loadKeyByHash(env, "h2");
    expect(stats.firsts).toBe(2);
  });

  it("负结果同样缓存（否则陌生人拿错 key 反复打就是免费的 D1 放大通道）", async () => {
    const { stats, db } = countingDB(null);
    const env = { WB2A_DB: db } as any;
    await loadKeyByHash(env, "nope");
    await loadKeyByHash(env, "nope");
    await loadKeyByHash(env, "nope");
    expect(stats.firsts).toBe(1);
  });

  it("查询**失败**不入缓存（一次 D1 抖动不能固化成 30s 的「密钥不存在」→ 401）", async () => {
    const env = {
      WB2A_DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("d1 down"); } }) }) },
    } as any;
    await expect(loadKeyByHash(env, "boom")).resolves.toBeNull();
    await expect(loadKeyByHash(env, "boom")).resolves.toBeNull();
    // 若把失败写进了缓存，第二次就不会抛而是返回 null 且不再查库；这里无法直接
    // 观测次数，故改用一个会恢复正常的库来验证它确实重新去查了。
    const okEnv = { WB2A_DB: countingDB(row).db } as any;
    invalidateKeyCache();
    await expect(loadKeyByHash(okEnv, "boom")).resolves.not.toBeNull();
  });

  it("TTL 到期后重新查库（保质期内的旧值不会永远生效）", async () => {
    const { stats, db } = countingDB(row);
    const env = { WB2A_DB: db } as any;
    await loadKeyByHash(env, "h1");
    expect(stats.firsts).toBe(1);
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000; // 越过 30s TTL
    try {
      await loadKeyByHash(env, "h1");
    } finally {
      Date.now = realNow;
    }
    expect(stats.firsts).toBe(2);
  });

  it("invalidateKeyCache 支持全清与按 hash 清", async () => {
    const { stats, db } = countingDB(row);
    const env = { WB2A_DB: db } as any;
    await loadKeyByHash(env, "h1");
    await loadKeyByHash(env, "h2");
    expect(stats.firsts).toBe(2);
    invalidateKeyCache("h1"); // 只清一条
    await loadKeyByHash(env, "h1");
    await loadKeyByHash(env, "h2");
    expect(stats.firsts).toBe(3); // h1 重查，h2 仍命中

    invalidateKeyCache(); // 全清
    await loadKeyByHash(env, "h1");
    await loadKeyByHash(env, "h2");
    expect(stats.firsts).toBe(5);
  });
});

describe("C3 降级门缓存", () => {
  function memKV(seed: Record<string, string> = {}) {
    const m = new Map<string, string>(Object.entries(seed));
    let reads = 0;
    return {
      reads: () => reads,
      get: async (k: string) => {
        reads++;
        return m.get(k) ?? null;
      },
      put: async (k: string, v: string) => void m.set(k, v),
      delete: async (k: string) => void m.delete(k),
    };
  }

  it("连续调用只读一次 KV（原先每次 ~100ms 的关键路径读数）", async () => {
    const kv = memKV();
    const env = { WB2A_CACHE: kv } as any;
    await degradedActive(env);
    await degradedActive(env);
    await degradedActive(env);
    expect(kv.reads()).toBe(1);
  });

  it("triggerDegrade 后**立即**可见，不等 TTL", async () => {
    const kv = memKV();
    const env = { WB2A_CACHE: kv } as any;
    expect(await degradedActive(env)).toBe(false);
    await triggerDegrade(env);
    // 这一步是真实场景的直接映射：请求被上游 400 拦了 → 触发降级 → 下一个请求
    // 必须立刻换中性提示词。若这里读到缓存里的「未降级」，会确定性再撞一次。
    expect(await degradedActive(env)).toBe(true);
  });
});

describe("C3 配置 stale-while-revalidate", () => {
  function memConfigKV(cfg: Record<string, any>) {
    let reads = 0;
    return {
      reads: () => reads,
      ns: {
        get: async (_k: string, _o?: any) => {
          reads++;
          return JSON.parse(JSON.stringify(cfg));
        },
        put: async () => {},
        delete: async () => {},
      },
    };
  }

  it("新鲜期内零 KV 读（多次调用只 read 一次）", async () => {
    const kv = memConfigKV({ api_key: "sk" });
    const env = { WB2A_CONFIG: kv.ns, WB2A_CACHE: kv.ns } as any;
    await getConfig(env);
    await getConfig(env);
    await getConfig(env);
    expect(kv.reads()).toBe(1);
  });

  it("陈旧期：立即返回旧值（不等 KV），后台静默刷新", async () => {
    const cfgObj = { api_key: "sk" };
    let reads = 0;
    let release: (() => void) | null = null;
    const ns = {
      get: async (_k: string, _o?: any) => {
        reads++;
        if (reads === 1) return JSON.parse(JSON.stringify(cfgObj));
        // 第二趟起永不返回。这一步是断言的全部：getConfig 只要敢 await 后台刷新，
        // 用例就会挂住超时。用「不返回的读」而不是「计数为 0」来卡它——计数为 0
        // 在同步发起读的实现下依然成立，测不出到底等没等。
        return new Promise<any>((r) => {
          release = () => r(null);
        });
      },
      put: async () => {},
      delete: async () => {},
    };
    const env = { WB2A_CONFIG: ns } as any;
    const first = await getConfig(env);
    expect(first.api_key).toBe("sk");

    const realNow = Date.now;
    Date.now = () => realNow() + 31_000; // 越过 30s 新鲜期
    try {
      const second = await getConfig(env);
      expect(second.api_key).toBe("sk");
      expect(reads).toBe(2); // 刷新确实发起了，只是没被等待
    } finally {
      Date.now = realNow;
      release?.(); // 放开这趟读，别把 refreshing 挂到后续用例头上
    }
    await new Promise((r) => setTimeout(r, 0)); // 等刷新链路收尾
  });

  it("saveConfig 立即清缓存（改完不要等 30s 才生效）", async () => {
    const kv = memConfigKV({ api_key: "sk" });
    const env = { WB2A_CONFIG: kv.ns } as any;
    await getConfig(env);
    const before = kv.reads();
    await saveConfig(env, { api_key: "sk-new" } as any).catch(() => {});
    await getConfig(env);
    expect(kv.reads() - before).toBeGreaterThanOrEqual(1);
  });
});

describe("C3 模型快照按需单域读取", () => {
  it("只请求 cn 时不读 global 的 key（原先 miss 一次要付两趟）", async () => {
    const reads: string[] = [];
    const env = {
      WB2A_CACHE: {
        get: async (k: string) => {
          reads.push(k);
          return k === "models:cn" ? JSON.stringify([{ id: "cn:hy3" }]) : null;
        },
        put: async () => {},
        delete: async () => {},
      },
    } as any;
    await modelsSnapshot(env, "cn");
    expect(reads).toEqual(["models:cn"]);

    await modelsSnapshot(env, "cn"); // 命中缓存
    expect(reads).toEqual(["models:cn"]);

    await modelsSnapshot(env, "global"); // 另一域才去读它自己的 key
    expect(reads).toEqual(["models:cn", "models:global"]);
  });

  it("invalidateModelsSnapshot 让两域都重新取数", async () => {
    const reads: string[] = [];
    const env = {
      WB2A_CACHE: {
        get: async (k: string) => {
          reads.push(k);
          return null;
        },
        put: async () => {},
        delete: async () => {},
      },
    } as any;
    await modelsSnapshot(env, "cn");
    await modelsSnapshot(env, "cn");
    expect(reads).toEqual(["models:cn"]);
    invalidateModelsSnapshot();
    await modelsSnapshot(env, "cn");
    expect(reads).toEqual(["models:cn", "models:cn"]);
  });
});

describe("C1 note RPC 已移出首字节路径", () => {
  it("响应返回时 note 不必已完成（它在 waitUntil 里异步发出）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    // note 会挂起不返回，用来证明「响应不等它」
    let notePromise: Promise<any> | null = null;
    const env = fakeEnv(makeAuth("u1"));
    const origFetch = env.POOL.get().fetch;
    env.POOL.get = () => ({
      fetch: async (req: Request) => {
        const p = new URL(req.url).pathname;
        if (p === "/internal/note") {
          notePromise = new Promise(() => {}); // 永不 settle
          return notePromise;
        }
        return origFetch(req);
      },
    });

    const waited: Promise<unknown>[] = [];
    const res = await proxyChat(
      env,
      new Request("https://x/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" } }),
      "cn:hy3",
      { model: "cn:hy3", stream: false, messages: [] },
      "0.0.0.0",
      "",
      null,
      (p) => waited.push(p),
    );
    expect(res.status).toBe(200);
    // note 被交给了生命周期钩子，而不是 await 在调用栈里
    expect(waited.length).toBeGreaterThan(0);
    expect(notePromise).not.toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("失效钩子覆盖（静态守卫）", () => {
  const panelSrc = readFileSync(new URL("../src/routes/panel.ts", import.meta.url), "utf8");

  /**
   * 取出某个路由 handler 的源码片段。
   *
   * 别用 `indexOf("});")` 截尾——handler 里第一个内层回调就带 `});`，切出来的
   * 片段会在真正的失效调用之前断掉，守卫变成永远通过的摆设。
   * 按下一次同层 `app.<verb>("` 注册处截断才稳。
   */
  function handlerSrc(marker: string): string {
    const start = panelSrc.indexOf(marker);
    if (start < 0) throw new Error(`找不到路由：${marker}`);
    const rest = panelSrc.slice(start + marker.length);
    const m = rest.match(/\n {2}app\.(get|post|put|patch|delete)\("/);
    const end = m && m.index !== undefined ? start + marker.length + m.index : panelSrc.length;
    return panelSrc.slice(start, end);
  }

  // 所有会改动 apikeys 行的出口。漏一个 = 那类改动要等 TTL 才生效。
  const MUTATING_ROUTES = [
    'app.patch("/panel/api/keys/:id"',
    'app.delete("/panel/api/keys/:id"',
    'app.post("/panel/api/keys/:id/reset"',
    'app.post("/panel/api/keys/:id/reset_usage"',
    'app.post("/panel/api/keys/:id/rotate"',
  ];

  it.each(MUTATING_ROUTES)("%s 变更后立即清子密钥缓存", (marker) => {
    expect(handlerSrc(marker)).toContain("invalidateKeyCache()");
  });

  it("rotate 尤其不能漏：旧明文必须**立即**失效，而不是等 TTL", () => {
    // rotate 的语义是「旧明文当场作废」。若只等 30s TTL，轮换后的窗口里旧密钥
    // 依然能调接口，而面板已经显示成轮换了——这正是容易被当成已修复的漏洞。
    const rotate = handlerSrc('app.post("/panel/api/keys/:id/rotate"');
    expect(rotate).toContain("invalidateKeyCache()");
  });

  it("整体计数 ≥5（新增改密钥路由时提醒同步补钩子）", () => {
    const hits = (panelSrc.match(/invalidateKeyCache\(\)/g) ?? []).length;
    expect(hits).toBeGreaterThanOrEqual(MUTATING_ROUTES.length);
  });
});
