/**
 * GET /api/videos/:id/download — 鉴权下载成片（方案 5.2 / 10）。
 * 校验 JWT + 资源归属后读文件，绝不把 data 目录映射为公开静态目录。
 */
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveUserId } from "../../../../../lib/auth";
import { fail } from "../../../../../lib/api-response";
import { errors } from "../../../../../lib/errors";
import { getVideoJob } from "../../../../../lib/jobs";
import { fileStorage, resolveDataPath } from "../../../../../lib/storage";
import { JobStatus } from "../../../../../shared/api";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: { id: string } }
) {
  try {
    const userId = resolveUserId(request.headers);
    // 验收 P2-11：非法 id 在进 Prisma 之前就返回 400，避免底层异常变 500。
    const jobId = z.string().uuid().parse(context.params.id);
    const job = await getVideoJob(userId, jobId);
    if (job.status !== JobStatus.COMPLETED || !job.outputPath) {
      throw errors.notFound("成片尚未生成");
    }

    // output_path 由服务端按 userId/jobId 拼接后入库；存储层再走受控解析器二次校验。
    const file = await fileStorage.read(job.outputPath);
    const filename = path.basename(resolveDataPath(job.outputPath));
    // 验收第 9 章：<video> 播放时带上 inline=1，避免 attachment 触发下载而非播放。
    const inline = request.nextUrl.searchParams.get("inline") === "1";
    // Buffer 的底层是 ArrayBufferLike，转成 Uint8Array 才是标准 BodyInit。
    return new NextResponse(new Uint8Array(file), {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
        "Content-Length": String(file.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return fail(err);
  }
}
