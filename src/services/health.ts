import type { Env } from "../../worker-configuration.d.ts";
import { getConfigFresh } from "../config";
import { ensureSchema } from "../storage/migrate";

// 部署自检（启动期一次性告警）。
//
// 存在理由：`api_key` 默认空串，靠 `WB2A_API_KEY` Secret 注入。漏设时
// `wrangler pages deploy` **照样成功**，但面板与所有 API 的鉴权恒 401——
// 表现为"部署完成但什么都打不开"，且日志里没有任何线索指向根因。
// 这里把该状态变成一行显式告警，并让 /healthz 报 unhealthy。

let warned = false;

/** HealthCheck 单项检查结果。 */
export interface Check {
  name: string;
  ok: boolean;
  /** 失败时的可操作提示（成功时省略）。 */
  hint?: string;
  /** 仅提示不算失败（如"没配 device_token"）。 */
  warn?: boolean;
}

/**
 * runHealthChecks 就绪自检。任一项失败 → 视为 not ready。
 *
 * 刻意不抛错：healthz 端点必须在任何绑定缺失时仍能返回（否则探针只会拿到
 * 连接错误，看不出是配置问题还是服务挂了）。
 */
export async function runHealthChecks(env: Env): Promise<{ ready: boolean; checks: Check[] }> {
  const checks: Check[] = [];

  // 1. 管理员总钥匙。用 getConfigFresh 绕过 5s 缓存——自检必须反映真实现场，
  //    读到旧缓存会把"没配"误判成"已配"（或反过来），让告警不可信。
  let apiKey = "";
  try {
    apiKey = (await getConfigFresh(env)).api_key ?? "";
  } catch (e: any) {
    // 防御性分支：getConfig 当前会吞掉 KV 读取异常并回落默认配置，所以这里
    // 理论上不会走到。留着是因为「配置归一化本身抛错」是可能的（例如未来
    // mergeDeep 改动），届时自检必须能报出原因而不是整体崩掉。
    checks.push({
      name: "config_readable",
      ok: false,
      hint: `读配置失败：${String(e?.message ?? e)}（WB2A_CONFIG KV 未绑定？）`,
    });
    return { ready: false, checks };
  }
  checks.push({ name: "config_readable", ok: true });

  if (!apiKey) {
    checks.push({
      name: "admin_api_key",
      ok: false,
      hint:
        "管理员总钥匙为空，所有 /panel/api/* 与 /v1/* 都会 401 —— 面板完全打不开。" +
        "修复：npx wrangler pages secret put WB2A_API_KEY --project-name <name>",
    });
  } else if (apiKey.length < 16) {
    // 不阻断：短钥匙可能是用户故意的。只提示，因为弱钥匙是真实风险。
    checks.push({
      name: "admin_api_key_strength",
      ok: true,
      warn: true,
      hint: `管理员钥匙仅 ${apiKey.length} 字符，建议至少 16 位随机串。`,
    });
  } else {
    checks.push({ name: "admin_api_key", ok: true });
  }

  // 2. D1 可读且表已建（最常见的"部署成功但首个写请求 500"根因）
  try {
    await env.WB2A_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' LIMIT 1").first();
    checks.push({ name: "d1_reachable", ok: true });
    const row = await env.WB2A_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='apikeys'",
    ).first<{ name: string }>();
    if (!row?.name) {
      // 自动迁移本应在首个请求就建好表。走到这里说明它失败了
      // ——把原因带上，别让人对着"缺表"干瞪眼。
      const m = await ensureSchema(env).catch(() => null);
      checks.push({
        name: "d1_schema",
        ok: false,
        hint:
          `D1 里没有 apikeys 表，API 写操作会 500。` +
          (m?.status === "error" ? `自动迁移失败：${m.error}。` : "") +
          `修复：核对 wrangler.toml 的 database_id，或手工跑 node scripts/db-init.mjs --remote`,
      });
    } else {
      checks.push({ name: "d1_schema", ok: true });
    }
  } catch (e: any) {
    checks.push({
      name: "d1_reachable",
      ok: false,
      hint: `D1 不可用：${String(e?.message ?? e)}（WB2A_DB 未绑定或 database_id 仍是占位符？）`,
    });
  }

  // 3. KV 可读（模型目录缓存写在这里，不通只是首次探测变慢，不阻断）
  try {
    await env.WB2A_CACHE.get("__healthcheck__");
    checks.push({ name: "kv_cache", ok: true });
  } catch {
    checks.push({
      name: "kv_cache",
      ok: true,
      warn: true,
      hint: "WB2A_CACHE 不可读：模型目录将每次实时探测（更慢且易被上游限流）。",
    });
  }

  // 4. 账号池：空池不算故障（新部署本来就没有号），但要能连上 DO
  try {
    await env.POOL.get(env.POOL.idFromName("main"));
    checks.push({ name: "pool_do", ok: true });
  } catch (e: any) {
    checks.push({
      name: "pool_do",
      ok: false,
      hint: `账号池 DO 不可用：${String(e?.message ?? e)}（engine worker 的 [[migrations]] 是否用 new_sqlite_classes 注册了 PoolDO？）`,
    });
  }

  const blocking = checks.filter((c) => !c.ok);
  if (blocking.length && !warned) {
    // 只打一次：getConfig 有 5s 缓存，自检会被反复触发，日志会被刷爆。
    warned = true;
    console.error(
      "[wb2api] ⚠️ 就绪自检未通过：\n" +
        blocking.map((c) => `  - ${c.name}: ${c.hint ?? "失败"}`).join("\n"),
    );
  }

  return { ready: blocking.length === 0, checks };
}

/**
 * healthReport /healthz 的响应体。
 *
 * `ready: false` 时仍返回 200（HTTP 层是通的，只是配置有问题），
 * 这样外部探针能拿到**具体哪一项坏了**，而不是只能看到"挂了"。
 */
export async function healthReport(env: Env): Promise<Record<string, unknown>> {
  const { ready, checks } = await runHealthChecks(env);
  return {
    ok: true,
    ready,
    checks: checks.map((c) => ({
      name: c.name,
      ok: c.ok,
      ...(c.warn ? { warn: true } : {}),
      ...(c.hint ? { hint: c.hint } : {}),
    })),
    ts: Date.now(),
  };
}