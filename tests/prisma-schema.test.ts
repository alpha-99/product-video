import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Prisma Schema 与 DDL 对齐测试（不依赖真实数据库）。
 * 防止"改了迁移脚本却忘了改 Schema"造成读写字段漂移。
 */
const root = path.resolve(__dirname, "..");

async function readSchema() {
  return readFile(path.join(root, "prisma/schema.prisma"), "utf8");
}
async function readDdl() {
  return readFile(path.join(root, "db/migrations/001_init.sql"), "utf8");
}

describe("Prisma Schema 与 DDL 对齐", () => {
  it("datasource 使用 PostgreSQL 且从 DATABASE_URL 读取", async () => {
    const schema = await readSchema();
    assert.match(schema, /provider\s*=\s*"postgresql"/);
    assert.match(schema, /url\s*=\s*env\("DATABASE_URL"\)/);
  });

  it("6 张业务表均有对应 model 与 @@map", async () => {
    const schema = await readSchema();
    for (const table of [
      "users",
      "products",
      "video_templates",
      "video_jobs",
      "subscriptions",
      "usage_records",
    ]) {
      assert.match(schema, new RegExp(`@@map\\("${table}"\\)`), `缺少 @@map("${table}")`);
    }
    for (const model of [
      "model User ",
      "model Product ",
      "model VideoTemplate ",
      "model VideoJob ",
      "model Subscription ",
      "model UsageRecord ",
    ]) {
      assert.ok(schema.includes(model), `缺少 ${model}`);
    }
  });

  it("关键字段映射与约束一致", async () => {
    const schema = await readSchema();
    const pairs: Array<[string, string]> = [
      ["quotaLeft", "quota_left"],
      ["imagePath", "image_path"],
      ["sellingPoints", "selling_points"],
      ["compositionId", "composition_id"],
      ["durationSec", "duration_sec"],
      ["inputJson", "input_json"],
      ["idempotencyKey", "idempotency_key"],
      ["leasedAt", "leased_at"],
      ["leaseUntil", "lease_until"],
      ["completedAt", "completed_at"],
      ["videoJobId", "video_job_id"],
      ["usageType", "usage_type"],
    ];
    for (const [field, column] of pairs) {
      assert.match(
        schema,
        new RegExp(`${field}\\s+[^\\n]*@map\\("${column}"\\)`),
        `${field} 未映射到 ${column}`
      );
    }
    assert.match(schema, /@@unique\(\[userId, idempotencyKey\], name: "uq_jobs_idem"\)/);
  });

  it("DDL 中的索引在 Schema 中均有对应定义或已注明例外", async () => {
    const schema = await readSchema();
    const ddl = await readDdl();
    const indexNames = [...ddl.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? (\w+)/g)].map(
      (m) => m[1]
    );
    assert.equal(indexNames.length, 6, "DDL 应有 6 个索引");
    for (const name of indexNames) {
      if (name === "idx_jobs_claim") {
        // 部分索引（带 WHERE）Prisma Schema 无法表达，须有注释说明保留在迁移脚本中
        assert.match(schema, /idx_jobs_claim[\s\S]{0,120}部分索引/);
      } else {
        assert.ok(schema.includes(`name: "${name}"`), `Schema 缺少索引 ${name}`);
      }
    }
  });
});
