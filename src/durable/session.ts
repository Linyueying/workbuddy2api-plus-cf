// 会话粘性（原 internal/session）：聚合键 -> uid 绑定，TTL 复用同账号。
// 纯原生 DO Storage 实现（已无 Redis 依赖），存于 PoolDO 实例内。

const stickyKey = (key: string) => `sticky:${key}`;

export async function resolveSticky(
  ctx: DurableObjectState,
  key: string,
): Promise<string | null> {
  return (await ctx.storage.get<string>(stickyKey(key))) ?? null;
}

export async function bindSticky(
  ctx: DurableObjectState,
  key: string,
  uid: string,
  ttlSec: number,
): Promise<void> {
  await ctx.storage.put(stickyKey(key), uid, { expirationTtl: Math.max(1, Math.floor(ttlSec)) } as any);
}

export async function unbindSticky(ctx: DurableObjectState, key: string): Promise<void> {
  await ctx.storage.delete(stickyKey(key));
}

export async function countSticky(ctx: DurableObjectState): Promise<number> {
  return (await ctx.storage.list({ prefix: "sticky:" })).size;
}
