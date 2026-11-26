/**
 * 任务状态机与额度副作用（方案 8.2 / 8.3）。
 *
 * 刻意与渲染引擎解耦：API 路由（重试/取消）只依赖本模块，
 * 不会把 @remotion/bundler 拉进 Next.js 的 Web bundle。
 * pipeline.ts 负责渲染编排，复用这里的状态迁移并重新导出以兼容既有调用。
 */
import type { Prisma } from "@prisma/client";
import { db, findUserJob, withTransaction } from "./db";
import { refundJobQuota, consumeQuota } from "./billing";
import { JobStatus } from "../shared/api";
import { errors } from "./errors";
import { MAX_ATTEMPTS } from "./queue";

/** 成功回写：completed + 路径 + 完成时间；带令牌时拒绝过期 Worker 的回写。 */
export async function completeJob(
  jobId: string,
  paths: { outputPath: string; thumbnailPath?: string },
  leaseToken?: Date
): Promise<void> {
  const where = leaseToken
    ? { id: jobId, status: JobStatus.PROCESSING, leasedAt: leaseToken }
    : { id: jobId };
  const updated = await db.videoJob.updateMany({
    where,
    data: {
      status: JobStatus.COMPLETED,
      outputPath: paths.outputPath,
      ...(paths.thumbnailPath ? { thumbnailPath: paths.thumbnailPath } : {}),
      completedAt: new Date(),
      errorMessage: null,
      leasedAt: null,
      leaseUntil: null,
    },
  });
  if (updated.count === 0) {
    throw new Error(`任务 ${jobId} 状态已变更，拒绝写入 completed`);
  }
}

/** 终态失败回写 + 额度返还：同一事务，保证状态与账本一致且不重复返还。 */
export async function failJob(
  jobId: string,
  reason: string,
  options: { leaseToken?: Date } = {}
): Promise<void> {
  await withTransaction(async (tx) => {
    const job = await tx.videoJob.findUnique({ where: { id: jobId } });
    if (!job) throw errors.notFound("任务不存在");
    if (
      job.status === JobStatus.COMPLETED ||
      job.status === JobStatus.FAILED ||
      job.status === JobStatus.CANCELLED
    ) {
      return;
    }
    if (options.leaseToken && job.leasedAt?.getTime() !== options.leaseToken.getTime()) {
      // 租约已被接管，旧 Worker 的失败回写无效。
      return;
    }

    await tx.videoJob.update({
      where: { id: jobId },
      data: {
        status: JobStatus.FAILED,
        errorMessage: reason.slice(0, 2000),
        completedAt: new Date(),
        leasedAt: null,
        leaseUntil: null,
      },
    });
    await refundJobQuota(tx, job.id, job.userId);
  });
}

/** 自动重试：保留已扣额度与 attempt，仅把任务重新放回 pending。 */
export async function scheduleAutoRetry(
  jobId: string,
  reason: string,
  leaseToken?: Date
): Promise<boolean> {
  const updated = await db.videoJob.updateMany({
    where: leaseToken
      ? { id: jobId, status: JobStatus.PROCESSING, leasedAt: leaseToken }
      : { id: jobId, status: JobStatus.PROCESSING },
    data: {
      status: JobStatus.PENDING,
      errorMessage: reason.slice(0, 2000),
      leasedAt: null,
      leaseUntil: null,
    },
  });
  return updated.count === 1;
}

/** 用户手动重试：仅 failed / cancelled 可重试，重新扣 1 额度并写 consume 流水。 */
export async function retryJob(userId: string, jobId: string) {
  const job = await findUserJob(userId, jobId);
  if (!job) throw errors.notFound("任务不存在或不属于当前用户");
  if (job.status !== JobStatus.FAILED && job.status !== JobStatus.CANCELLED) {
    throw errors.validation("仅失败或已取消的任务可重试");
  }
  if (job.attempt >= MAX_ATTEMPTS) {
    throw errors.validation(`已达最大尝试次数 ${MAX_ATTEMPTS}，无法重试`);
  }

  return withTransaction(async (tx) => {
    const reset = await tx.videoJob.updateMany({
      where: {
        id: jobId,
        userId,
        status: { in: [JobStatus.FAILED, JobStatus.CANCELLED] },
      },
      data: {
        status: JobStatus.PENDING,
        errorMessage: null,
        completedAt: null,
        leasedAt: null,
        leaseUntil: null,
      },
    });
    if (reset.count === 0) throw errors.validation("任务状态已变更，无法重试");
    await consumeQuota(tx, userId, jobId);
    return tx.videoJob.findUniqueOrThrow({ where: { id: jobId } });
  });
}

/** 取消 pending / processing 任务并返还额度；终态与重复取消不重复返还。 */
export async function cancelJob(userId: string, jobId: string) {
  return withTransaction(async (tx) => {
    const job = await findUserJob(userId, jobId);
    if (!job) throw errors.notFound("任务不存在或不属于当前用户");
    if (job.status !== JobStatus.PENDING && job.status !== JobStatus.PROCESSING) {
      return { id: jobId, status: job.status, cancelled: false };
    }

    const updated = await tx.videoJob.updateMany({
      where: {
        id: jobId,
        userId,
        status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] },
      },
      data: {
        status: JobStatus.CANCELLED,
        errorMessage: "用户取消",
        completedAt: new Date(),
        leasedAt: null,
        leaseUntil: null,
      },
    });
    if (updated.count === 0) return { id: jobId, status: job.status, cancelled: false };
    await refundJobQuota(tx, jobId, userId);
    return { id: jobId, status: JobStatus.CANCELLED, cancelled: true };
  });
}

/**
 * C-03 / US-19：删除终态任务的记录（成片文件由 API 层在事务外清理）。
 *
 * usage_records.video_job_id 是指向 video_jobs 的外键，删除前先解除引用，
 * 保留额度流水用于对账审计；整段在同一事务内，避免出现半删状态。
 * 进行中任务必须先走 cancelJob，不允许直接删除。
 */
export async function deleteFinishedJob(userId: string, jobId: string) {
  return withTransaction(async (tx) => {
    const job = await tx.videoJob.findFirst({ where: { id: jobId, userId } });
    if (!job) throw errors.notFound("任务不存在或不属于当前用户");
    if (job.status === JobStatus.PENDING || job.status === JobStatus.PROCESSING) {
      throw errors.validation("进行中的任务请先取消，再删除");
    }
    // 验收 P2-09：purge 后任务记录消失，把商品/模板溯源信息归档进额度流水。
    // 否则商品随后被删除时，「这条额度花在哪个商品上」将彻底无法对账。
    await tx.usageRecord.updateMany({
      where: { videoJobId: jobId },
      data: {
        videoJobId: null,
        meta: {
          purgedJobId: jobId,
          productId: job.productId,
          templateId: job.templateId,
          purgedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    await tx.videoJob.delete({ where: { id: jobId } });
    return {
      id: jobId,
      outputPath: job.outputPath,
      thumbnailPath: job.thumbnailPath,
    };
  });
}
