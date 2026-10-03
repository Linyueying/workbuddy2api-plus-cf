-- 0003_usage_metrics.sql — request_logs 增加用量指标列
--
-- 为什么会缺这些列：0001 的 request_logs 只记「一次请求的结果」（模型/域/状态码/耗时），
-- 用量需要的 token 与积分粒度没在表结构里。此前 /panel/api/usage 走的是另一张
-- usage 表（hour,model,realm,tokens,cnt），但它：
--   1) 按小时预聚合，丢掉了 uid —— 面板「按账号」维度根本出不来；
--   2) 只有 tokens 一列，拆不出 prompt/completion，更没有 credit；
--   3) recordUsage 这个写入函数全项目零调用点（架构遗留），表自建成起就是空的。
-- 与其补一条残缺的数据流，不如让唯一真实在写的表（request_logs）带上用量列，
-- 用量页改为从它聚合——写入即生效，不需要第二条记路径。
--
-- ALTER TABLE ADD COLUMN 不可重复执行；scripts/db-init.mjs 会先 PRAGMA table_info
-- 探测列是否已存在，全存在则跳过。
--   远程执行：npx wrangler d1 execute WB2A_DB --remote --file=./migrations/0003_usage_metrics.sql
--   无 CLI 时：CF Dashboard → D1 → WB2A_DB → Console，粘贴本文件 all 执行。

ALTER TABLE request_logs ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
-- credits 为 REAL：上游 usage.credit 是小数（如 0.0123），按整数存会把小额请求抹成 0。
ALTER TABLE request_logs ADD COLUMN credits REAL NOT NULL DEFAULT 0;
-- 前缀缓存读命中（issue #92：命中率低意味着计费 Token 被放大数倍）。
ALTER TABLE request_logs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;

-- 用量页的聚合是「按时间窗全扫 + 按 uid/model/realm 分组」，窗口可达 90 天。
-- ts 已有 DESC 索引，但分组键不在索引里仍要回表；补两个复合索引让分组走覆盖扫描。
CREATE INDEX IF NOT EXISTS idx_reqlogs_usage ON request_logs(ts DESC, model, realm);
CREATE INDEX IF NOT EXISTS idx_reqlogs_usage_uid ON request_logs(ts DESC, uid);
