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

CREATE TABLE IF NOT EXISTS usage (
  hour   INTEGER NOT NULL,
  model  TEXT NOT NULL,
  realm  TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cnt    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, model, realm)
);

-- 任务中心队列（可选，用于跨实例共享任务状态）
CREATE TABLE IF NOT EXISTS task_queue (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  uid      TEXT NOT NULL,
  task_id  TEXT NOT NULL,
  status   TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_taskqueue_uid ON task_queue(uid, status);
