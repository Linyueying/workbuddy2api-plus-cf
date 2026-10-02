import type { Env } from "../../worker-configuration.d.ts";
import type { RequestLogEntry } from "../types";

// 请求日志归档到 R2（替代 request-logs/*.jsonl）。
// 按日期分片：logs/YYYY-MM-DD.jsonl（追加模式：先读后写）。

export async function archiveLogs(env: Env, entries: RequestLogEntry[]): Promise<void> {
  if (!entries.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const key = "logs/" + day + ".jsonl";
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
  const listed = await env.WB2A_LOGS.list({ prefix: "logs/" });
  return listed.objects.map((o) => o.key);
}
