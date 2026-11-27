-- ProductVideo AI — 初始表结构（方案第 4 章）
-- 幂等设计：本文件可重复执行，不会因已存在对象而报错，也不会丢失已有数据。

-- gen_random_uuid() 在 PostgreSQL 13+ 内置；方案基线为 PostgreSQL 15+，无需额外扩展。

-- ---------------------------------------------------------------------------
-- 1. 用户：主键直接复用 Supabase Auth 的 user UUID
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY,                  -- 与 auth.users.id 一致
  email       VARCHAR(255) NOT NULL UNIQUE,
  quota_left  INTEGER NOT NULL DEFAULT 3,        -- 剩余免费额度
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. 商品
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           VARCHAR(200) NOT NULL,
  description    TEXT,
  price          NUMERIC(12,2),
  image_path     TEXT NOT NULL,                   -- 相对路径，见方案第 9 章
  selling_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  brand_name     VARCHAR(120),
  brand_logo_path TEXT,
  brand_color    VARCHAR(16),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id, created_at DESC);

-- updated_at 自动更新（方案 4.2）
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. 视频模板
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS video_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(120) NOT NULL,
  category      VARCHAR(60) NOT NULL,             -- launch/highlight/sale/showcase/story
  composition_id VARCHAR(80) NOT NULL,            -- Remotion Composition ID
  duration_sec  SMALLINT NOT NULL DEFAULT 15,
  thumbnail_path TEXT,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_templates_enabled ON video_templates(enabled, category);

-- ---------------------------------------------------------------------------
-- 4. 视频任务（队列核心表）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS video_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id),
  template_id   UUID NOT NULL REFERENCES video_templates(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','completed','failed','cancelled')),
  input_json    JSONB NOT NULL,                   -- 已校验的渲染参数快照
  output_path   TEXT,
  thumbnail_path TEXT,
  error_message TEXT,
  attempt       SMALLINT NOT NULL DEFAULT 0,      -- 已尝试次数
  idempotency_key VARCHAR(128) NOT NULL,          -- 提交幂等键
  leased_at     TIMESTAMPTZ,                      -- Worker 领取心跳
  lease_until   TIMESTAMPTZ,                      -- 租约到期，用于超时回收
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

-- 领取队列的部分索引（方案 4.1 / 8.1）
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON video_jobs(status, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_jobs_user ON video_jobs(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_idem ON video_jobs(user_id, idempotency_key);

-- ---------------------------------------------------------------------------
-- 5. 订阅（V1.0 后置，先建表占位）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan        VARCHAR(20) NOT NULL CHECK (plan IN ('starter','pro','agency')),
  status      VARCHAR(20) NOT NULL DEFAULT 'active',
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 6. 用量记录：扣减与返还都记账，便于对账
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_records (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_job_id UUID REFERENCES video_jobs(id),
  usage_type   VARCHAR(20) NOT NULL CHECK (usage_type IN ('consume','refund','grant')),
  amount       INTEGER NOT NULL,                  -- 扣减为正/返还为负，口径全系统统一
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_records(user_id, created_at DESC);
