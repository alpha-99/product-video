/**
 * PostgreSQL 轻量队列协议（方案 8.1 / 8.2）。
 *
 * 领取：FOR UPDATE SKIP LOCKED，多 Worker 不会抢到同一任务；
 * 租约：leased_at 心跳 + lease_until 到期；leased_at 同时作为 CAS 令牌，
 *       过期任务被回收后，旧 Worker 的完成/失败回写会被令牌守卫拒绝。
 * 回收：processing 且租约过期 → attempt 未达上限则重新入队，否则转 failed 并返还额度。
 */
import { db, withTransaction } from "./db";
import { refundJobQuota } from "./billing";

/** 总尝试上限：首次执行 + 最多 2 次自动重试。 */
export const MAX_ATTEMPTS = 3;
/** 与方案 8.1 的 SQL 保持一致；改这里还需同步下方 interval 字面量。 */
export const LEASE_MINUTES = 2;
/** 单次扫描最多回收多少个超时任务，避免长事务。 */
export const RECLAIM_LIMIT = 20;

export interface ClaimedJob {
  id: string;
  attempt: number;
  leasedAt: Date;
}

/** 按创建时间顺序领取一条 pending 任务。 */
export async function claimNextJob(): Promise<ClaimedJob | null> {
  const rows = await db.$queryRaw<ClaimedJob[]>`
    WITH claimed AS (
      SELECT id FROM video_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE video_jobs j
    SET status = 'processing',
        leased_at = date_trunc('milliseconds', now()),
        lease_until = now() + interval '2 minutes',
        attempt = attempt + 1,
        error_message = NULL
    FROM claimed c
    WHERE j.id = c.id
    RETURNING j.id, j.attempt, j.leased_at AS "leasedAt"
  `;
  return rows[0] ?? null;
}

/** 领取指定任务（保留 processJob(jobId) 的调用方式）。 */
export async function claimJobById(jobId: string): Promise<ClaimedJob | null> {
  const rows = await db.$queryRaw<ClaimedJob[]>`
    WITH claimed AS (
      SELECT id FROM video_jobs
      WHERE id = ${jobId}::uuid AND status = 'pending'
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE video_jobs j
    SET status = 'processing',
        leased_at = date_trunc('milliseconds', now()),
        lease_until = now() + interval '2 minutes',
        attempt = attempt + 1,
        error_message = NULL
    FROM claimed c
    WHERE j.id = c.id
    RETURNING j.id, j.attempt, j.leased_at AS "leasedAt"
  `;
  return rows[0] ?? null;
}

/**
 * 续租：只有持有当前 leased_at 令牌的 Worker 能续约。
 * 返回新的令牌（供后续心跳与回写使用）；任务已被回收/完成时返回 null。
 */
export async function renewLease(jobId: string, leaseToken: Date): Promise<Date | null> {
  const rows = await db.$queryRaw<Array<{ leasedAt: Date }>>`
    UPDATE video_jobs
    SET leased_at = date_trunc('milliseconds', now()),
        lease_until = now() + interval '2 minutes'
    WHERE id = ${jobId}::uuid
      AND status = 'processing'
      AND leased_at = ${leaseToken}
    RETURNING leased_at AS "leasedAt"
  `;
  return rows[0]?.leasedAt ?? null;
}

export interface ReclaimResult {
  requeued: string[];
  failed: string[];
}

/** 扫描过期租约：未达上限重新入队，达到上限转 failed 并返还额度。 */
export async function reclaimExpiredJobs(): Promise<ReclaimResult> {
  return withTransaction(async (tx) => {
    const requeued = await tx.$queryRaw<Array<{ id: string }>>`
      WITH expired AS (
        SELECT id FROM video_jobs
        WHERE status = 'processing'
          AND lease_until < now()
          AND attempt < ${MAX_ATTEMPTS}
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${RECLAIM_LIMIT}
      )
      UPDATE video_jobs j
      SET status = 'pending',
          leased_at = NULL,
          lease_until = NULL,
          error_message = '租约超时，已重新入队'
      FROM expired e
      WHERE j.id = e.id
      RETURNING j.id
    `;

    const finalFailures = await tx.$queryRaw<Array<{ id: string; userId: string }>>`
      WITH expired AS (
        SELECT id FROM video_jobs
        WHERE status = 'processing'
          AND lease_until < now()
          AND attempt >= ${MAX_ATTEMPTS}
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${RECLAIM_LIMIT}
      )
      UPDATE video_jobs j
      SET status = 'failed',
          error_message = '租约超时且超过最大尝试次数',
          completed_at = now(),
          leased_at = NULL,
          lease_until = NULL
      FROM expired e
      WHERE j.id = e.id
      RETURNING j.id, j.user_id AS "userId"
    `;

    for (const job of finalFailures) {
      await refundJobQuota(tx, job.id, job.userId);
    }
    return {
      requeued: requeued.map((row) => row.id),
      failed: finalFailures.map((row) => row.id),
    };
  });
}
