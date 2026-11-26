/**
 * GET /api/videos/:id/thumbnail — 鉴权读取成片缩略图（验收 P2-06）。
 *
 * 此前 video_jobs.thumbnail_path 已入库但没有任何对外访问路径，
 * 列表只能用渐变占位。这里复用与 download 相同的归属校验，
 * 不把 data 目录映射成公开静态目录。
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveUserId } from "../../../../../lib/auth";
import { fail } from "../../../../../lib/api-response";
import { errors } from "../../../../../lib/errors";
import { getVideoJob } from "../../../../../lib/jobs";
import { fileStorage } from "../../../../../lib/storage";
import { JobStatus } from "../../../../../shared/api";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const userId = resolveUserId(request.headers);
    const jobId = z.string().uuid().parse(context.params.id);
    const job = await getVideoJob(userId, jobId);
    if (job.status !== JobStatus.COMPLETED || !job.thumbnailPath) {
      throw errors.notFound("缩略图尚未生成");
    }

    let file: Buffer;
    try {
      file = await fileStorage.read(job.thumbnailPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw errors.notFound("缩略图文件不存在");
      }
      throw err;
    }

    // Buffer 的底层是 ArrayBufferLike，转成 Uint8Array 才是标准 BodyInit。
    return new NextResponse(new Uint8Array(file), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(file.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  } catch (err) {
    return fail(err);
  }
}
