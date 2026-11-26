-- 002_ai_usage.sql
-- 阶段七：AI 文案的用量与缓存。
--
-- 1) usage_records 增加 meta，承载 AI 调用的 model / token / 来源，
--    避免为「一次 AI 调用」再开一张宽表；
-- 2) usage_type 放宽到 'ai_call'（AI 调用只记流水、不扣额度，amount 固定 0）；
-- 3) ai_copy_cache 以「商品内容哈希 + 模板 + 模型」为键缓存文案，TTL 24h。
--
-- 全部语句幂等，可重复执行。

ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS meta JSONB;

-- 001 里的内联 CHECK 约束名为 usage_records_usage_type_check。
ALTER TABLE usage_records DROP CONSTRAINT IF EXISTS usage_records_usage_type_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'usage_records_usage_type_check'
      AND conrelid = 'usage_records'::regclass
  ) THEN
    ALTER TABLE usage_records
      ADD CONSTRAINT usage_records_usage_type_check
      CHECK (usage_type IN ('consume', 'refund', 'grant', 'ai_call'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_copy_cache (
  -- sha256(输入 JSON + 模板 + 模型列表)，64 位十六进制
  cache_key   VARCHAR(64) PRIMARY KEY,
  payload     JSONB NOT NULL,                 -- 已通过 CopySchema 校验的文案
  model       VARCHAR(120),                   -- 命中时的模型；本地降级为 NULL
  source      VARCHAR(20) NOT NULL DEFAULT 'model',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_cache_expires ON ai_copy_cache (expires_at);
