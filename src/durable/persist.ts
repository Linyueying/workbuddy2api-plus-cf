import type { DurableObjectState } from "@cloudflare/workers-types";
import type { AccountState } from "../types";

// 账号池状态快照读写（替代原 state.json）。用于导出/备份与紧急恢复。
// 快照整体存单个 Storage 键，便于一次性 dump / restore。

const SNAPSHOT_KEY = "snapshot";

export async function saveSnapshot(ctx: DurableObjectState, accounts: AccountState[]): Promise<void> {
  await ctx.storage.put(SNAPSHOT_KEY, { ts: Date.now(), accounts });
}

export async function loadSnapshot(ctx: DurableObjectState): Promise<{ ts: number; accounts: AccountState[] } | null> {
  return (await ctx.storage.get(SNAPSHOT_KEY)) ?? null;
}

export async function exportAll(ctx: DurableObjectState, accounts: AccountState[]): Promise<string> {
  return JSON.stringify({ ts: Date.now(), accounts }, null, 2);
}
