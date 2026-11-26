/**
 * POST /api/videos — 提交生成任务（方案 5.2）。
 * 必带 Idempotency-Key 请求头；鉴权 → 校验 → 事务（扣额度+建任务+写用量）。
 * GET  /api/videos — 当前用户的任务列表（分页参数走统一契约校验）。
 */
import { NextRequest } from "next/server";
import { resolveUserId } from "../../../lib/auth";
import { ok, fail } from "../../../lib/api-response";
import { DomainError } from "../../../lib/errors";
import { createVideoJob, listVideoJobs } from "../../../lib/jobs";
import { CreateVideoRequestSchema, ListVideosQuerySchema } from "../../../shared/api";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const userId = resolveUserId(request.headers);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) {
      throw new DomainError("VALIDATION_ERROR", "缺少 Idempotency-Key 请求头");
    }

    const body = CreateVideoRequestSchema.parse(await request.json());
    const { job, created } = await createVideoJob(userId, body, idempotencyKey);
    return ok({ jobId: job?.id, status: job?.status, created }, created ? 201 : 200);
  } catch (err) {
    return fail(err);
  }
}

export async function GET(request: NextRequest) {
  try {
    const userId = resolveUserId(request.headers);
    const { take, skip } = ListVideosQuerySchema.parse({
      take: request.nextUrl.searchParams.get("take") ?? undefined,
      skip: request.nextUrl.searchParams.get("skip") ?? undefined,
    });
    const jobs = await listVideoJobs(userId, { take, skip });
    return ok(jobs);
  } catch (err) {
    return fail(err);
  }
}
