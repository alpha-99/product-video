/**
 * 数据库接入自检：验证 DATABASE_URL 连通、业务表 + 心跳表存在、RLS 状态、关键索引。
 * 只读，不修改任何数据。
 *
 *   npm run db:check
 */
import process from "node:process";
import { PrismaClient } from "@prisma/client";
import "../src/lib/env";

const EXPECTED_TABLES = [
  "users",
  "products",
  "video_templates",
  "video_jobs",
  "subscriptions",
  "usage_records",
  "worker_heartbeats",
];

const RLS_TABLES = ["products", "video_jobs", "usage_records"];
const EXPECTED_INDEXES = [
  "idx_products_user",
  "idx_templates_enabled",
  "idx_jobs_claim",
  "idx_jobs_user",
  "uq_jobs_idem",
  "idx_usage_user",
];

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("缺少 DATABASE_URL，请在 .env.local 中配置后重试。");
  }

  const prisma = new PrismaClient();
  try {
    // 1. 连通性
    const ping = await prisma.$queryRaw<{ ok: boolean }[]>`SELECT 1 AS ok`;
    if (!ping[0]?.ok) throw new Error("SELECT 1 未返回预期结果");
    console.log("[1/4] 连接成功");

    // 2. 业务表 + 运维表
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    `;
    const present = new Set(tables.map((r) => r.table_name));
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
    if (missing.length) throw new Error(`缺失表: ${missing.join(", ")}`);
    console.log(`[2/4] ${EXPECTED_TABLES.length} 张表齐全（含 worker_heartbeats）`);

    // 3. RLS 状态（未启用时给出告警，不阻断：RLS 由迁移/Supabase 侧管理）
    const rls = await prisma.$queryRaw<
      { relname: string; relrowsecurity: boolean }[]
    >`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace
        AND relname IN ('products', 'video_jobs', 'usage_records')
    `;
    const rlsMap = new Map(rls.map((r) => [r.relname, r.relrowsecurity]));
    for (const table of RLS_TABLES) {
      const enabled = rlsMap.get(table);
      console.log(
        `[3/4] RLS ${table}: ${enabled === undefined ? "未查询到" : enabled ? "已启用" : "未启用（告警：应用层仍强制按 user_id 过滤）"}`
      );
    }

    // 4. 关键索引
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
    `;
    const idxNames = new Set(indexes.map((r) => r.indexname));
    const missingIdx = EXPECTED_INDEXES.filter((i) => !idxNames.has(i));
    if (missingIdx.length) throw new Error(`缺失索引: ${missingIdx.join(", ")}`);
    console.log("[4/4] 6 个关键索引齐全");

    console.log("✅ 数据访问层自检通过");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`❌ db:check 失败：${(err as Error).message}`);
  process.exit(1);
});
