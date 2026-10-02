import type { Env } from "../../worker-configuration.d.ts";
import type { RequestLogEntry } from "../types";
import { insertRequestLog, queryRequestLogs } from "./d1";
import { archiveLogs } from "./r2";

// 请求日志（替代 request-logs/*.jsonl）。D1 落库 + 可选 R2 归档。

export async function logRequest(env: Env, e: RequestLogEntry): Promise<void> {
  await insertRequestLog(env, e);
}

export async function queryLogs(env: Env, q: Parameters<typeof queryRequestLogs>[1]): Promise<RequestLogEntry[]> {
  return queryRequestLogs(env, q);
}

export async function archiveRequestLogs(env: Env, entries: RequestLogEntry[]): Promise<void> {
  await archiveLogs(env, entries);
}
