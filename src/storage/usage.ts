import type { Env } from "../../worker-configuration.d.ts";
import { recordUsage as d1RecordUsage, queryUsage } from "./d1";

// 用量记录（替代 usage.json）。D1 为主，R2 归档由 r2.ts 负责。

export async function recordUsage(env: Env, model: string, realm: string, tokens: number, ts: number): Promise<void> {
  await d1RecordUsage(env, model, realm, tokens, ts);
}

export async function getUsage(env: Env, from: number, to: number): Promise<any[]> {
  return queryUsage(env, from, to);
}
