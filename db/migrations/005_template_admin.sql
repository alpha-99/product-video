-- 005_template_admin.sql
-- 模板管理补全：运营元数据层 / 角色主体层 / 审计凭据层（设计方案 V1.0 §6.1）
--
-- 设计原则：
--  1) 全部幂等，可重复执行（ALTER ADD COLUMN IF NOT EXISTS / DO $$ 守卫约束与索引）。
--  2) 加唯一约束 prior 先归并重复 composition_id，把 video_jobs 外键重指到保留行，避免 FK 违规。
--  3) DDL 唯一真源；prisma/schema.prisma 只用于生成类型化客户端，禁止 migrate dev。
--  4) 审计与主操作同事务由应用层保证，本迁移只负责表结构。

-- ---------------------------------------------------------------------------
-- 1. users.role —— 管理员唯一判定依据（user / admin 二值）
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'user';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. video_templates —— 运营元数据列 + 乐观锁列
-- ---------------------------------------------------------------------------
ALTER TABLE video_templates ADD COLUMN IF NOT EXISTS display_name VARCHAR(120);
ALTER TABLE video_templates ADD COLUMN IF NOT EXISTS english_name VARCHAR(120);
ALTER TABLE video_templates ADD COLUMN IF NOT EXISTS description VARCHAR(300);
ALTER TABLE video_templates ADD COLUMN IF NOT EXISTS cta VARCHAR(60);
ALTER TABLE video_templates ADD COLUMN IF NOT EXISTS tone VARCHAR(20);
ALTER TABLE video_templates ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE video_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE video_templates ADD COLUMN IF NOT EXISTS updated_by UUID;
ALTER TABLE video_templates ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- 归并重复 composition_id：保留 created_at 最早的行，把其它行上的任务外键重指过来。
-- 仅在存在重复行时执行；data 迁移后加 UNIQUE 约束。
DO $$
BEGIN
  IF EXISTS (
    SELECT composition_id FROM video_templates
    GROUP BY composition_id HAVING count(*) > 1
  ) THEN
    -- 先把引用被淘汰行的任务重指到保留行（同一 composition_id、created_at 最早）
    UPDATE video_jobs vj
       SET template_id = keep.id
      FROM video_templates dup
      JOIN video_templates keep
        ON keep.composition_id = dup.composition_id
       AND keep.id <> dup.id
     WHERE vj.template_id = dup.id
       AND keep.id = (
         SELECT k2.id FROM video_templates k2
          WHERE k2.composition_id = dup.composition_id
          ORDER BY k2.created_at ASC, k2.id ASC
          LIMIT 1
       );

    -- 删除被淘汰的重复行（保留每组最早一行）
    DELETE FROM video_templates dup
     WHERE dup.id <> (
       SELECT k2.id FROM video_templates k2
        WHERE k2.composition_id = dup.composition_id
        ORDER BY k2.created_at ASC, k2.id ASC
        LIMIT 1
     );
  END IF;
END $$;

-- 回填运营元数据：仅对空值写入（与种子/注册表展示逐字一致），不覆盖已编辑数据。
UPDATE video_templates
   SET display_name = COALESCE(display_name, name),
       english_name = COALESCE(
         english_name,
         CASE composition_id
           WHEN 'product-launch' THEN 'Product Launch'
           WHEN 'product-highlight' THEN 'Product Highlight'
           WHEN 'product-sale' THEN 'Summer Sale 30%'
           WHEN 'product-showcase' THEN 'Premium Showcase'
           WHEN 'product-story' THEN 'Brand Story'
           ELSE NULL
         END
       ),
       description = COALESCE(
         description,
         CASE composition_id
           WHEN 'product-launch' THEN '主视觉 + 动态标题'
           WHEN 'product-highlight' THEN '卖点动画 + 字幕'
           WHEN 'product-sale' THEN '原价 / 折扣 / CTA'
           WHEN 'product-showcase' THEN '品牌视觉 + 优雅转场'
           WHEN 'product-story' THEN '品牌叙事 + 氛围转场'
           ELSE NULL
         END
       ),
       cta = COALESCE(
         cta,
         CASE composition_id
           WHEN 'product-launch' THEN 'Discover More'
           WHEN 'product-highlight' THEN 'Learn More'
           WHEN 'product-sale' THEN 'Shop Now'
           WHEN 'product-showcase' THEN 'The Collection'
           WHEN 'product-story' THEN 'Explore More'
           ELSE NULL
         END
       ),
       tone = COALESCE(
         tone,
         CASE composition_id
           WHEN 'product-launch' THEN 'energetic'
           WHEN 'product-highlight' THEN 'premium'
           WHEN 'product-sale' THEN 'urgent'
           WHEN 'product-showcase' THEN 'calm'
           WHEN 'product-story' THEN 'premium'
           ELSE NULL
         END
       ),
       sort_order = CASE
         WHEN sort_order = 0 THEN CASE composition_id
           WHEN 'product-launch' THEN 10
           WHEN 'product-highlight' THEN 20
           WHEN 'product-sale' THEN 30
           WHEN 'product-showcase' THEN 40
           WHEN 'product-story' THEN 50
           ELSE 0
         END
         ELSE sort_order
       END
 WHERE display_name IS NULL
    OR english_name IS NULL
    OR description IS NULL
    OR cta IS NULL
    OR tone IS NULL
    OR sort_order = 0;

-- 约束：唯一 composition_id、tone 枚举、category 四值枚举、sort_order 0~999
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_templates_composition_id') THEN
    ALTER TABLE video_templates
      ADD CONSTRAINT uq_templates_composition_id UNIQUE (composition_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_templates_tone') THEN
    ALTER TABLE video_templates
      ADD CONSTRAINT chk_templates_tone CHECK (
        tone IS NULL OR tone IN ('energetic','calm','premium','playful','urgent')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_templates_category') THEN
    ALTER TABLE video_templates
      ADD CONSTRAINT chk_templates_category CHECK (
        category IN ('launch','highlight','sale','showcase','story')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_templates_sort_order') THEN
    ALTER TABLE video_templates
      ADD CONSTRAINT chk_templates_sort_order CHECK (sort_order >= 0 AND sort_order <= 999);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_templates_sort ON video_templates(sort_order, composition_id);

-- ---------------------------------------------------------------------------
-- 3. template_audit_logs —— 模板写操作审计（与主操作同事务）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS template_audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   UUID NOT NULL REFERENCES video_templates(id) ON DELETE RESTRICT,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action        VARCHAR(32) NOT NULL,
  before_json   JSONB,
  after_json    JSONB,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpl_audit_template
  ON template_audit_logs(template_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. user_role_audit_logs —— 角色变更留痕（web / script 全量；不记邮箱明文）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_role_audit_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_label    VARCHAR(120),
  source         VARCHAR(20) NOT NULL,
  request_id     UUID,
  from_role      VARCHAR(20) NOT NULL,
  to_role        VARCHAR(20) NOT NULL,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_role_audit_source CHECK (source IN ('web','script')),
  CONSTRAINT chk_role_audit_actor CHECK (
    actor_user_id IS NOT NULL OR (actor_label IS NOT NULL AND length(actor_label) > 0)
  )
);
CREATE INDEX IF NOT EXISTS idx_role_audit_target
  ON user_role_audit_logs(target_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. user_role_change_requests —— 提权双人复核凭据
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_role_change_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  from_role     VARCHAR(20) NOT NULL DEFAULT 'user',
  to_role       VARCHAR(20) NOT NULL,
  requested_by  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason        TEXT NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  reviewed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  review_reason TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  CONSTRAINT chk_role_req_status CHECK (
    status IN ('pending','approved','rejected','expired','cancelled')
  ),
  CONSTRAINT chk_role_req_role CHECK (from_role IN ('user','admin') AND to_role IN ('user','admin')),
  -- DB 层兜底：审批人不得等于发起人
  CONSTRAINT chk_role_req_reviewer CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by)
);
-- 同一 target 最多一条 pending（部分唯一索引）
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_req_pending
  ON user_role_change_requests(target_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_role_req_status_expiry
  ON user_role_change_requests(status, expires_at);
