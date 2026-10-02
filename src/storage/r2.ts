import type { Env } from "../../worker-configuration.d.ts";
import type { RequestLogEntry } from "../types";

// 请求日志归档到 R2（替代 request-logs/*.jsonl）。
// 按日期分片：logs/YYYY-MM-DD.jsonl（追加模式：先读后写）。

/**
 * @param day 覆盖分片日期（YYYY-MM-DD）。默认今天。
 *   归档历史数据时必须传——否则 7 天前的日志会被写进"今天"的分片，
 *   文件名与内容日期不符，事后无法按日期定位。
 */
export async function archiveLogs(env: Env, entries: RequestLogEntry[], day?: string): Promise<void> {
  if (!entries.length) return;
  // R2 是可选绑定：没绑就静默跳过，不能让「没开日志归档」拖垮主流程。
  // （桶不存在时 wrangler 部署会直接失败，所以绑定段可能被构建机摘掉）
  if (!env.WB2A_LOGS) return;
  const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date().toISOString().slice(0, 10);
  const key = "logs/" + d + ".jsonl";
  let existing = "";
  try {
    const obj = await env.WB2A_LOGS.get(key);
    if (obj) existing = await obj.text();
  } catch {
    existing = "";
  }
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  const next = (existing ? existing + "\n" : "") + lines + "\n";
  await env.WB2A_LOGS.put(key, next, { httpMetadata: { contentType: "application/x-ndjson" } });
}

export async function listLogDays(env: Env): Promise<string[]> {
  if (!env.WB2A_LOGS) return [];
  try {
    const listed = await env.WB2A_LOGS.list({ prefix: "logs/" });
    return listed.objects.map((o) => o.key);
  } catch {
    return [];
  }
}
