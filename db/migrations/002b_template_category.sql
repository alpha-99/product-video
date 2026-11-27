-- 002b_template_category.sql
-- 新增第 5 套模板 product-story（category=story），放开 video_templates.category 枚举。
-- 文件名排序在 003_seed_templates.sql 之前：已应用 005（4 值 CHECK）的环境重跑种子时，
-- 若约束未放开，story 种子行会被拒绝。本文件先 DROP 再 ADD 5 值约束，幂等且事务内完成。
BEGIN;

ALTER TABLE video_templates DROP CONSTRAINT IF EXISTS chk_templates_category;

ALTER TABLE video_templates
  ADD CONSTRAINT chk_templates_category CHECK (
    category IN ('launch', 'highlight', 'sale', 'showcase', 'story')
  );

COMMIT;
