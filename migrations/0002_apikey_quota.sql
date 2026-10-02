-- 子密钥配额与管控字段（对齐 Go internal/apikeys.Key）
-- 用法：wrangler d1 execute WB2A_DB --remote --file=./migrations/0002_apikey_quota.sql
--
-- 与 0001 的差异：把 Go 侧 keys.json 的全字段搬进 D1，支撑
-- token 配额 / 积分配额 / IP 白名单与上限 / realm 限定 / 有效期 / 停用开关。
-- 所有新增列都有默认值，老行（只有 id/key_hash/name/models）读出来即
-- 「不限额、不限 IP、不过期、启用」，语义与 Go 的零值一致。

ALTER TABLE apikeys ADD COLUMN enabled     INTEGER NOT NULL DEFAULT 1;      -- 0 = 停用（403 key_disabled）
ALTER TABLE apikeys ADD COLUMN expires_at  INTEGER;                          -- epoch ms；NULL = 不过期
ALTER TABLE apikeys ADD COLUMN realm       TEXT NOT NULL DEFAULT '';         -- '' = 不限；cn / global
ALTER TABLE apikeys ADD COLUMN ip_allowlist TEXT NOT NULL DEFAULT '[]';     -- JSON 数组，支持精确 IP 与 CIDR
ALTER TABLE apikeys ADD COLUMN max_ips     INTEGER NOT NULL DEFAULT 0;      -- 0 = 不限
ALTER TABLE apikeys ADD COLUMN ips         TEXT NOT NULL DEFAULT '[]';       -- JSON 数组：历史使用过的 IP
ALTER TABLE apikeys ADD COLUMN last_ip     TEXT NOT NULL DEFAULT '';
ALTER TABLE apikeys ADD COLUMN req_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apikeys ADD COLUMN quota       INTEGER NOT NULL DEFAULT 0;      -- token 额度；0 = 不限
ALTER TABLE apikeys ADD COLUMN used_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apikeys ADD COLUMN quota_credit  REAL NOT NULL DEFAULT 0;       -- 积分额度；0 = 不限
ALTER TABLE apikeys ADD COLUMN used_credit   REAL NOT NULL DEFAULT 0;
ALTER TABLE apikeys ADD COLUMN seq         INTEGER NOT NULL DEFAULT 0;      -- 创建序号（同秒创建靠它分先后）

-- 按 quota 扫描（面板「配额告警」列表用）
CREATE INDEX IF NOT EXISTS idx_apikeys_seq ON apikeys(seq DESC);
