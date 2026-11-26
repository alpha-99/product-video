/**
 * POST /api/videos/:id/regenerate — 已完成视频「以原参数新建任务」（C-06 双路径之一）。
 *
 * failed / cancelled → POST /retry（复用原 job，先返还再占用额度）
 * completed          → POST /regenerate（新建独立 job，重新占用 1 额度）
 *
 * 原参数取自服务端 input_json 快照，客户端只提供幂等键；额度扣减、归属校验与
 * 幂等保护全部复用 createVideoJob 的同一事务，避免前端拼参数造成口径漂移。
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveUserId } from "../../../../../lib/auth";
import { ok, fail } from "../../../../../lib/api-response";
import { DomainError } from "../../../../../lib/errors";
import { regenerateFromCompletedJob } from "../../../../../lib/jobs";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const userId = resolveUserId(request.headers);
    const jobId = z.string().uuid().parse(context.params.id);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) {
      throw new DomainError("VALIDATION_ERROR", "缺少 Idempotency-Key 请求头");
    }
    const { job, created } = await regenerateFromCompletedJob(userId, jobId, idempotencyKey);
    // 验收 P2-11：幂等命中（未新建任务）返回 200，只有真正创建了新任务才是 201。
    return ok({ jobId: job.id, status: job.status, created }, created ? 201 : 200);
  } catch (err) {
    return fail(err);
  }
}
