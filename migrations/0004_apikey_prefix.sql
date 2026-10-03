-- 子密钥展示掩码 prefix（对齐 Go internal/apikeys.Key.Prefix）
-- 用法：wrangler d1 execute WB2A_DB --remote --file=./migrations/0004_apikey_prefix.sql
--
-- 与 0002 的差异：补一列 encrypt-safe 的展示掩码。Go 侧 Key.Prefix 存的是明文
-- 前 12 字符（`plain[:12]`），面板列表据此显示 `wbk_1a2b3c…` —— 既不落明文，
-- 管理员又能认出是哪一把钥匙。CF 移植时漏了这一列，前端那些 <code>…</code>
-- 一直是空白（x.prefix 取不到值）。
--
-- 已部署的实例不必手工执行：Worker 启动时的自动迁移
-- （src/storage/migrate.ts 的 COLS_0004）会探测并补列。此文件供手工 bootstrap
-- 或 d1 export/import 场景使用。

ALTER TABLE apikeys ADD COLUMN prefix TEXT NOT NULL DEFAULT '';  -- 明文前 12 字符，仅展示
