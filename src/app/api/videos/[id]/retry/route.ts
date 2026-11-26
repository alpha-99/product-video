/**
 * POST /api/videos/:id/retry — 用户手动重试失败/已取消的任务（方案 8.2）。
 * 重新扣 1 额度（失败时已返还）并重置为 pending；attempt 不清零，达到上限后拒绝。
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveUserId } from "../../../../../lib/auth";
import { ok, fail } from "../../../../../lib/api-response";
import { retryJob } from "../../../../../lib/job-state";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const userId = resolveUserId(request.headers);
    const jobId = z.string().uuid().parse(context.params.id);
    const job = await retryJob(userId, jobId);
    // 验收 P2-11：复用既有 job 的状态变更返回 200，不伪装成「创建资源」的 201。
    return ok({ jobId: job.id, status: job.status, attempt: job.attempt });
  } catch (err) {
    return fail(err);
  }
}
