-- 004_ops.sql
-- 阶段九：运维可观测性与内测登录。
--
-- 1) worker_heartbeats：方案 11「Worker 心跳写数据库」，供 /api/health 与告警脚本
--    判断 Worker 是否存活；一行一个 Worker，UPSERT 更新 last_seen_at。
-- 2) users.password_hash：生产启用 PV_AUTH_MODE=local 时的本地密码凭据
--    （scrypt，格式见 src/lib/password.ts）。可空以兼容已有 Supabase Auth 用户，
--    空值在生产本地模式禁止登录，不产生「任意邮箱可冒用」的降级入口。
--
-- 全部语句幂等，可重复执行。

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id    VARCHAR(120) PRIMARY KEY,
  hostname     VARCHAR(255),
  status       VARCHAR(20)  NOT NULL DEFAULT 'running',
  last_seen_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  meta         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_seen
  ON worker_heartbeats (last_seen_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
