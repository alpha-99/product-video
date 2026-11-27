/**
 * GET /api/templates/:id/thumbnail — 前台鉴权读取模板缩略图（FR-07 / §7.1）。
 * 仅返回已启用且注册表命中的模板缩略图；无缩略图返回 404，前端降级 CSS 示意。
 * 读取走受控相对路径，不把 data 目录暴露为静态资源。
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveUserId } from "../../../../../lib/auth";
import { fail } from "../../../../../lib/api-response";
import { errors } from "../../../../../lib/errors";
import { db } from "../../../../../lib/db";
import { TEMPLATE_IDS } from "../../../../../shared/template.schema";
import { fileStorage, isTemplateThumbnailPath } from "../../../../../lib/storage";
import { sniffImageMime } from "../../../../../lib/upload";

export const runtime = "nodejs";
type Ctx = { params: { id: string } };

export async function GET(request: NextRequest, ctx: Ctx) {
  try {
    resolveUserId(request.headers);
    const row = await db.videoTemplate.findFirst({
      where: {
        id: ctx.params.id,
        enabled: true,
        compositionId: { in: [...TEMPLATE_IDS] },
      },
      select: { thumbnailPath: true },
    });
    if (!row?.thumbnailPath || !isTemplateThumbnailPath(row.thumbnailPath, ctx.params.id)) {
      throw errors.notFound("缩略图不存在");
    }
    let bytes: Buffer;
    try {
      bytes = await fileStorage.read(row.thumbnailPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw errors.notFound("缩略图文件不存在");
      }
      throw err;
    }
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": sniffImageMime(bytes) ?? "application/octet-stream",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  } catch (err) {
    return fail(err);
  }
}
