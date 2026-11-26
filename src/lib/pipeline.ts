/**
 * 渲染编排（方案 7.2 / 8.1 / 8.2）。
 *
 * processJob(jobId)  / processNextJob()
 *   1) SKIP LOCKED 领取（写 leased_at / lease_until 租约，attempt+1）
 *   2) 处理中每 30s 续租；leased_at 作为 CAS 令牌防止旧 Worker 回写
 *   3) input_json 快照 → renderVideo（MP4 + 缩略图）
 *   4) 成功：processing → completed + 路径 + 完成时间
 *   5) 失败：attempt < 3 自动重回 pending（额度仍占用）；否则 failed + 事务内返还额度
 *
 * 纯状态迁移在 job-state.ts，Web 路由直接引用它，不会把 Remotion 引擎打进 Web bundle。
 */
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { renderVideo } from "./renderer";
import { RenderJobInputSchema } from "../shared/render.schema";
import { errors } from "./errors";
import {
  claimJobById,
  claimNextJob,
  MAX_ATTEMPTS,
  renewLease,
  type ClaimedJob,
} from "./queue";
import {
  completeJob,
  failJob,
  scheduleAutoRetry,
} from "./job-state";

// 兼容既有调用方（CLI / 测试）从 pipeline 导入状态操作。
export {
  completeJob,
  failJob,
  scheduleAutoRetry,
  retryJob,
  cancelJob,
} from "./job-state";

const HEARTBEAT_MS = 30 * 1000;

/** 兼容既有调用：`claimJob(jobId)` 表示领取指定任务。 */
export async function claimJob(jobId: string): Promise<boolean> {
  return (await claimJobById(jobId)) !== null;
}

export interface ProcessResult {
  jobId: string;
  status: "completed" | "failed" | "skipped" | "retry_scheduled";
  outputPath?: string;
  thumbnailPath?: string;
  error?: string;
}

/** 处理单个已领取任务：渲染 + 回写 + 心跳；异常转状态，不打挂 Worker。 */
async function processClaimed(claim: ClaimedJob): Promise<ProcessResult> {
  let leaseToken = claim.leasedAt;
  let heartbeatPromise: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    heartbeatPromise = renewLease(claim.id, leaseToken)
      .then((next) => {
        if (next) leaseToken = next;
      })
      .catch(() => {
        // 续租失败由下一次 loop + 超时回收兜底。
      });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    const job = await db.videoJob.findUnique({ where: { id: claim.id } });
    if (!job) throw errors.notFound("任务不存在");

    const input = RenderJobInputSchema.parse(job.inputJson as Prisma.JsonValue);
    // 以数据库记录为准，防止快照被篡改导致越权或跨任务落盘。
    const normalized: typeof input = {
      ...input,
      jobId: job.id,
      userId: job.userId,
    };

    const result = await renderVideo(normalized);
    // 停止心跳并等待在飞的续约结束，确保回写使用最新令牌。
    clearInterval(heartbeat);
    await heartbeatPromise;
    await completeJob(
      claim.id,
      {
        outputPath: result.outputPath,
        ...(result.thumbnailPath ? { thumbnailPath: result.thumbnailPath } : {}),
      },
      leaseToken
    );
    return {
      jobId: claim.id,
      status: "completed",
      outputPath: result.outputPath,
      ...(result.thumbnailPath ? { thumbnailPath: result.thumbnailPath } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (claim.attempt < MAX_ATTEMPTS) {
      await scheduleAutoRetry(claim.id, message, leaseToken);
      return { jobId: claim.id, status: "retry_scheduled", error: message };
    }
    await failJob(claim.id, message, { leaseToken });
    return { jobId: claim.id, status: "failed", error: message };
  } finally {
    clearInterval(heartbeat);
  }
}

/** 按 jobId 处理（CLI 入口）：非 pending 直接跳过，不重复渲染/扣返额度。 */
export async function processJob(jobId: string): Promise<ProcessResult> {
  const claim = await claimJobById(jobId);
  if (!claim) {
    const current = await db.videoJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    return {
      jobId,
      status: "skipped",
      error: `任务非 pending（当前 ${current?.status ?? "unknown"}）`,
    };
  }
  return processClaimed(claim);
}

/** Worker 主循环调用：领取下一条 pending 任务；队列空时返回 null。 */
export async function processNextJob(): Promise<ProcessResult | null> {
  const claim = await claimNextJob();
  if (!claim) return null;
  return processClaimed(claim);
}
