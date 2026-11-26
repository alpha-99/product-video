/**
 * GET    /api/videos/:id — 任务详情与状态（前端轮询）
 * DELETE /api/videos/:id — 取消 pending/processing 任务并返还额度（方案 8.2）
 * DELETE /api/videos/:id?purge=1 — 删除终态任务记录与成片文件（C-03 / US-19）
 * 强制 user_id 归属校验，禁止跨用户操作。
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveUserId } from "../../../../lib/auth";
import { ok, fail } from "../../../../lib/api-response";
import { errors } from "../../../../lib/errors";
import { getVideoJob } from "../../../../lib/jobs";
import { cancelJob, deleteFinishedJob } from "../../../../lib/job-state";
import { cleanupFilesWithRetry } from "../../../../lib/file-cleanup";

export const runtime = "nodejs";

type Context = { params: { id: string } };

export async function GET(request: NextRequest, context: Context) {
  try {
    const userId = resolveUserId(request.headers);
    const job = await getVideoJob(userId, z.string().uuid().parse(context.params.id));
    return ok(job);
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const userId = resolveUserId(request.headers);
    const jobId = z.string().uuid().parse(context.params.id);

    // purge=1：删除已完成/失败/已取消任务的记录与文件；默认行为仍是「取消」。
    if (request.nextUrl.searchParams.get("purge") === "1") {
      const removed = await deleteFinishedJob(userId, jobId);
      // 验收 P2-09：清理在 DB 事务外，改为幂等重试 + 死信日志；
      // 溯源信息已在 deleteFinishedJob 内归档到额度流水。
      const report = await cleanupFilesWithRetry(
        [removed.outputPath, removed.thumbnailPath],
        { jobId }
      );
      return ok({
        id: jobId,
        deleted: true,
        cleanupPending: report.failed.length > 0,
      });
    }

    const result = await cancelJob(userId, jobId);
    // 终态任务不能取消：返回 400 明确拒绝，不再返回 200「假成功」。
    if (!result.cancelled) {
      throw errors.validation("任务已结束，无法取消；已完成任务可删除记录");
    }
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
