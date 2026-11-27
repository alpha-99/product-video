/**
 * POST /api/admin/templates/:id/thumbnail — 缩略图上传（requireAdmin）。
 * 复用 upload.ts 三重校验（扩展名白名单 + MIME 一致 + magic sniff + ≤10MB）。
 * 落盘受控路径 thumbnails/templates/:templateId/:uuid.ext；审计与元数据写同事务。
 */
import { NextRequest, NextResponse } from "next/server";
import { ok, fail } from "../../../../../../lib/api-response";
import { adminHandler } from "../../../../../../lib/admin-route";
import { requireAdmin } from "../../../../../../lib/admin";
import { errors } from "../../../../../../lib/errors";
import { db } from "../../../../../../lib/db";
import { fileStorage, isTemplateThumbnailPath } from "../../../../../../lib/storage";
import {
  validateImageUpload,
  sniffImageMime,
  MAX_UPLOAD_BYTES,
} from "../../../../../../lib/upload";
import {
  saveThumbnail,
  thumbnailPathFor,
} from "../../../../../../lib/admin-templates";

export const runtime = "nodejs";
type Ctx = { params: { id: string } };

export const POST = adminHandler(async (actorId, request: NextRequest, ctx: Ctx) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw errors.validation("请求必须是 multipart/form-data");
  }
  const file = form.get("file");
  if (!file || typeof file === "string") {
    throw errors.validation("缺少 file 文件字段", { file: "缺少 file 文件字段" });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw errors.validation("图片不能超过 10MB", { file: "图片不能超过 10MB" });
  }

  const validated = validateImageUpload({
    bytes: Buffer.from(await file.arrayBuffer()),
    mimeType: file.type || "application/octet-stream",
    filename: file.name,
  });
  const relativePath = thumbnailPathFor(ctx.params.id, validated.storedName);
  await fileStorage.save(validated.buffer, relativePath);

  try {
    return ok(
      await saveThumbnail(ctx.params.id, {
        relativePath,
        mimeType: validated.mimeType,
        size: validated.buffer.length,
      }, actorId)
    );
  } catch (err) {
    // 写库失败时清理已落盘文件，避免孤儿文件；审计失败事务回滚也不会留下半写状态。
    await fileStorage.delete(relativePath).catch(() => undefined);
    throw err;
  }
});

/** GET：管理员读取模板缩略图二进制（受控路径 + nosniff + CSP）。 */
export async function GET(request: NextRequest, ctx: Ctx) {
  try {
    await requireAdmin(request.headers);
    const row = await db.videoTemplate.findUnique({
      where: { id: ctx.params.id },
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
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  } catch (err) {
    return fail(err);
  }
}
