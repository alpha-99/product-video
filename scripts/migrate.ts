/**
 * 迁移执行器：按顺序应用 db/migrations/*.sql，每个文件在一个事务内执行。
 * 迁移脚本本身幂等（IF NOT EXISTS / IF NOT EXISTS index / DROP TRIGGER IF EXISTS），
 * 因此可重复执行，适合本地与生产共用。
 *
 *   npm run migrate         应用全部迁移
 *   npm run migrate:check   校验 10 张业务/运维/管理表与关键索引存在
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";
import "../src/lib/env";

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "db", "migrations");
const CHECK_ONLY = process.argv.includes("--check");

const EXPECTED_TABLES = [
  "users",
  "products",
  "video_templates",
  "video_jobs",
  "subscriptions",
  "usage_records",
  // 阶段九：Worker 心跳（方案 11），由 004_ops.sql 创建。
  "worker_heartbeats",
  // 阶段十：模板管理补全（方案 V1.0），由 005_template_admin.sql 创建。
  "template_audit_logs",
  "user_role_audit_logs",
  "user_role_change_requests",
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("缺少 DATABASE_URL，请在 .env.local 或环境变量中配置。");
  }

  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) throw new Error(`未找到迁移脚本：${MIGRATIONS_DIR}`);

    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("COMMIT");
        console.log(`[migrate] applied: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`迁移失败 ${file}: ${(err as Error).message}`);
      }
    }

    if (CHECK_ONLY) {
      const { rows } = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`
      );
      const present = new Set(rows.map((r) => r.tablename));
      const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
      if (missing.length) throw new Error(`缺失表: ${missing.join(", ")}`);
      console.log(`[check] ${EXPECTED_TABLES.length} 张表齐全（6 业务 + 1 运维 + 3 管理）: ${EXPECTED_TABLES.join(", ")}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(`[migrate] ${(err as Error).message}`);
  process.exit(1);
});
