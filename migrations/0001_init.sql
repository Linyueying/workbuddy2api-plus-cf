-- workbuddy2api-pages D1 schema
-- 用法：wrangler d1 execute WB2A_DB --local --file=./migrations/0001_init.sql
--       wrangler d1 execute WB2A_DB --remote --file=./migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS apikeys (
  id        TEXT PRIMARY KEY,
  key_hash  TEXT NOT NULL,
  name      TEXT NOT NULL,
  models    TEXT NOT NULL DEFAULT '[]',   -- JSON 数组
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_apikeys_hash ON apikeys(key_hash);

CREATE TABLE IF NOT EXISTS request_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'chat',
  client_ip  TEXT,
  user_agent TEXT,
  uid        TEXT,
  model      TEXT,
  realm      TEXT,
  outcome    TEXT NOT NULL,
  status     INTEGER NOT NULL,
  ms         INTEGER NOT NULL,
  msg        TEXT
);
CREATE INDEX IF NOT EXISTS idx_reqlogs_ts ON request_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_reqlogs_uid ON request_logs(uid);

-- 0006_drop_unused_tables.sql 会清掉早期版本在这里建过、但从未有任何代码读写的
-- 两张表（usage 按小时预聚合用量 / task_queue 任务中心队列）。它们在本项目中恒为空。
-- 新库不再创建这两张表；已存在的旧库由自动迁移（或手工执行 0006）DROP 掉。
