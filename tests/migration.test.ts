import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";

/**
 * 用嵌入式 PostgreSQL 真实执行迁移两遍，验证幂等性（验收标准：迁移可重复执行）。
 */
describe("001_init.sql 在真实 PostgreSQL 引擎上执行", () => {
  it("连续执行两次均成功，且 6 张表数据与索引不丢失", async () => {
    const sql = await readFile(
      path.resolve(__dirname, "../db/migrations/001_init.sql"),
      "utf8"
    );
    const db = new PGlite();
    try {
      await db.exec(sql);
      await db.exec(sql); // 第二遍：幂等验证

      const tables = await db.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`
      );
      const names = tables.rows.map((r) => r.tablename);
      for (const t of [
        "users",
        "products",
        "video_templates",
        "video_jobs",
        "subscriptions",
        "usage_records",
      ]) {
        assert.ok(names.includes(t), `缺少表 ${t}`);
      }

      const indexes = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname`
      );
      const indexNames = indexes.rows.map((r) => r.indexname);
      for (const idx of [
        "idx_products_user",
        "idx_templates_enabled",
        "idx_jobs_claim",
        "idx_jobs_user",
        "uq_jobs_idem",
        "idx_usage_user",
      ]) {
        assert.ok(indexNames.includes(idx), `缺少索引 ${idx}`);
      }

      // 关键约束仍生效：非法 status 被 CHECK 拒绝
      await db.exec(
        `INSERT INTO users (id, email) VALUES ('00000000-0000-4000-8000-000000000001', 'a@example.com')`
      );
      await db.exec(
        `INSERT INTO products (id, user_id, name, image_path)
         VALUES ('00000000-0000-4000-8000-000000000002',
                 '00000000-0000-4000-8000-000000000001', 'demo', '/tmp/a.png')`
      );
      await db.exec(
        `INSERT INTO video_templates (id, name, category, composition_id)
         VALUES ('00000000-0000-4000-8000-000000000003', 't', 'launch', 'product-launch')`
      );
      await db.exec(
        `INSERT INTO video_jobs (user_id, product_id, template_id, input_json, idempotency_key)
         VALUES ('00000000-0000-4000-8000-000000000001',
                 '00000000-0000-4000-8000-000000000002',
                 '00000000-0000-4000-8000-000000000003', '{}', 'k1')`
      );
      await assert.rejects(
        db.exec(
          `UPDATE video_jobs SET status = 'bogus' WHERE idempotency_key = 'k1'`
        )
      );
    } finally {
      await db.close();
    }
  });
});
