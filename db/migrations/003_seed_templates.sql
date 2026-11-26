-- 003_seed_templates.sql
-- 阶段八：video_templates 种子数据（4 套模板，与 src/shared/template.schema.ts 注册表一一对应）。
-- 幂等：按 composition_id 判重，重复执行不产生重复行；id 固定便于环境间一致。
-- 前端 /api/templates 与 POST /api/videos 的 templateId 都指向这里。

INSERT INTO video_templates (id, name, category, composition_id, duration_sec, config, enabled)
SELECT * FROM (VALUES
  ('11111111-1111-4111-8111-111111111111'::uuid, 'Product Launch 新品展示',      'launch',    'product-launch',    15::smallint, '{}'::jsonb, true),
  ('22222222-2222-4222-8222-222222222222'::uuid, 'Product Highlight 卖点介绍',  'highlight', 'product-highlight', 20::smallint, '{}'::jsonb, true),
  ('33333333-3333-4333-8333-333333333333'::uuid, 'Product Sale 促销活动',        'sale',      'product-sale',      15::smallint, '{}'::jsonb, true),
  ('44444444-4444-4444-8444-444444444444'::uuid, 'Premium Showcase 高级品牌展示','showcase', 'product-showcase',  20::smallint, '{}'::jsonb, true)
) AS seed(id, name, category, composition_id, duration_sec, config, enabled)
WHERE NOT EXISTS (
  SELECT 1 FROM video_templates t WHERE t.composition_id = seed.composition_id
);
