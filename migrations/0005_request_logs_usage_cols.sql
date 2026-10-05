-- request_logs 用量列迁移（对应 src/storage/migrate.ts 的 COLS_REQLOGS）。
--
-- 这 4 列在 0001 建表时尚不存在：prompt_tokens / completion_tokens（OpenAI 口径用量）、
-- credits（积分消耗）、cache_read_tokens（前缀缓存读命中，用于算缓存命中率）。
-- 它们的写入由 insertRequestLog 在 d1.ts 里完成；早期实现靠首条日志 INSERT 失败时的
-- 懒自愈（ensureUsageColumns）补列，此处改为启动期主动补齐，与 0002/0003/0004 的列
-- 迁移保持一致——Pages 的 Git 集成不会执行手工 SQL，新环境必须靠运行时迁移拿到列。
--
-- 约束：SQLite 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，重复执行会报
-- "duplicate column name"。这里让每条 ADD COLUMN 在「列已存在」时幂等：手工在 D1
-- Console 重跑时若撞重复列名，DROP 掉重复执行的报错即可（运行时 migrate.ts 已吞掉）。

ALTER TABLE request_logs ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN credits REAL NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
