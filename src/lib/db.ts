import { Prisma, PrismaClient } from "@prisma/client";
import "./env";

/**
 * Web 与 Worker 共用的数据访问入口（方案第 3 / 10 章）。
 *
 * 设计约束：
 * - 单例复用连接，避免 Next.js 热重载导致连接泄漏。
 * - 懒初始化：缺少 DATABASE_URL 时模块仍可被导入（类型检查/单测不需要真库）。
 * - 应用层所有查询必须显式带 user_id：Prisma 走 DATABASE_URL（Supabase 的
 *   postgres 角色会绕过 RLS），因此应用层过滤是这条路径上的主防线；
 *   RLS 是 PostgREST / Supabase 客户端直连路径的兜底防线，两者互不替代。
 */
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

/**
 * 跨境数据库连接（本机 → Supabase 悉尼 pooler）首次握手实测约 5s，
 * Prisma 默认 10s 的池等待容易被误判成「数据库不可达」；Supavisor session
 * pool 上限约 15，而 Prisma 默认按 CPU 算出 connection_limit=9，
 * Web / Worker / 测试进程一起开会立刻打满（Worker 日志里的
 * "Timed out fetching a new connection from the connection pool"）。
 *
 * 只在 Prisma 侧追加这几个参数，不影响 pg 直连脚本与迁移；
 * DATABASE_URL 已显式配置的参数一律尊重，可用 PV_DB_* 覆盖默认值。
 */
export function prismaUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const defaults: Record<string, string> = {
      connect_timeout: "15",
      connection_limit: process.env.PV_DB_CONNECTION_LIMIT ?? "4",
      pool_timeout: process.env.PV_DB_POOL_TIMEOUT ?? "20",
    };
    for (const [key, value] of Object.entries(defaults)) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function createPrisma(): PrismaClient {
  const url = prismaUrl();
  return new PrismaClient({
    ...(url ? { datasources: { db: { url } } } : {}),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

function getPrisma(): PrismaClient {
  if (!globalForPrisma.__prisma) globalForPrisma.__prisma = createPrisma();
  return globalForPrisma.__prisma;
}

/** 带完整 PrismaClient 类型的懒代理：首次访问 model 时才建连接。 */
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrisma();
    const value = client[prop as keyof PrismaClient];
    return typeof value === "function" ? value.bind(client) : value;
  },
});

/** 事务边界封装（方案 8.3）：建任务 + 扣额度 + 写用量在同一事务内完成。 */
export function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return db.$transaction(fn);
}

// ---------------------------------------------------------------------------
// 作用域查询：所有对外读接口强制传 user_id，调用方无法构造跨用户查询
// ---------------------------------------------------------------------------

type ProductOrderBy = Prisma.ProductOrderByWithRelationInput[];
type JobOrderBy = Prisma.VideoJobOrderByWithRelationInput[];

export function listUserProducts(
  userId: string,
  options: { take?: number; skip?: number; orderBy?: ProductOrderBy } = {}
) {
  return db.product.findMany({
    where: { userId },
    take: options.take,
    skip: options.skip,
    orderBy: options.orderBy ?? [{ createdAt: "desc" }],
  });
}

export function findUserProduct(userId: string, productId: string) {
  return db.product.findFirst({ where: { id: productId, userId } });
}

export function listUserJobs(
  userId: string,
  options: { take?: number; skip?: number; status?: string; orderBy?: JobOrderBy } = {}
) {
  return db.videoJob.findMany({
    where: {
      userId,
      ...(options.status ? { status: options.status } : {}),
    },
    take: options.take,
    skip: options.skip,
    orderBy: options.orderBy ?? [{ createdAt: "desc" }],
  });
}

export function findUserJob(userId: string, jobId: string) {
  return db.videoJob.findFirst({ where: { id: jobId, userId } });
}

export function listUserUsage(userId: string, take = 50) {
  return db.usageRecord.findMany({
    where: { userId },
    take,
    orderBy: [{ createdAt: "desc" }],
  });
}

/** 幂等查询：按 (user_id, idempotency_key) 找回既有任务。 */
export function findJobByIdempotencyKey(userId: string, key: string) {
  return db.videoJob.findUnique({
    where: { uq_jobs_idem: { userId, idempotencyKey: key } },
  });
}
