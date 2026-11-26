/**
 * POST /api/uploads/products — 商品图片上传（方案 5.2 / 9.3）。
 *
 * 流程：鉴权 → multipart 解析 → 三重校验（扩展名/MIME/文件头 + ≤10MB）
 * → 服务端生成新文件名 → FileStorage 落盘 uploads/{userId}/{productId|draft}/。
 * 原文件名只用于取扩展名，绝不参与路径拼接。
 *
 * GET  /api/uploads/products?path=... — 鉴权读取上传件，仅允许读当前用户目录。
 * 禁止把 DATA_ROOT 暴露为静态目录。
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveUserId } from "../../../../lib/auth";
import { ok, fail } from "../../../../lib/api-response";
import { errors } from "../../../../lib/errors";
import { db } from "../../../../lib/db";
import { fileStorage, uploadRelativePath } from "../../../../lib/storage";
import {
  isOwnedUploadPath,
  sniffImageMime,
  validateImageUpload,
  MAX_UPLOAD_BYTES,
} from "../../../../lib/upload";

export const runtime = "nodejs";

/** 草稿桶：商品 CRUD（阶段五）尚未创建商品时先落到该目录，后续可迁移。 */
const DRAFT_BUCKET = "draft";

export async function POST(request: NextRequest) {
  try {
    const userId = resolveUserId(request.headers);

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
    // 提前拦截超大 body，避免把 10MB+ 的内容读进内存。
    if (file.size > MAX_UPLOAD_BYTES) {
      throw errors.validation("图片不能超过 10MB", { file: "图片不能超过 10MB" });
    }

    const productIdRaw = form.get("productId");
    let bucket = DRAFT_BUCKET;
    if (typeof productIdRaw === "string" && productIdRaw.trim()) {
      const productId = z.string().uuid().parse(productIdRaw.trim());
      const owned = await db.product.findFirst({
        where: { id: productId, userId },
        select: { id: true },
      });
      if (!owned) throw errors.notFound("商品不存在或不属于当前用户");
      bucket = productId;
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const validated = validateImageUpload({
      bytes,
      mimeType: file.type || "application/octet-stream",
      filename: file.name,
    });

    const relativePath = uploadRelativePath(userId, bucket, validated.storedName);
    await fileStorage.save(validated.buffer, relativePath);

    return ok(
      {
        path: relativePath,
        filename: validated.storedName,
        mimeType: validated.mimeType,
        size: validated.buffer.length,
      },
      201
    );
  } catch (err) {
    return fail(err);
  }
}

export async function GET(request: NextRequest) {
  try {
    const userId = resolveUserId(request.headers);
    const relativePath = request.nextUrl.searchParams.get("path")?.trim();
    if (!relativePath) {
      throw errors.validation("缺少 path 参数", { path: "缺少 path 参数" });
    }
    if (!isOwnedUploadPath(relativePath, userId)) {
      throw errors.notFound("文件不存在或不属于当前用户");
    }

    let buffer: Buffer;
    try {
      buffer = await fileStorage.read(relativePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw errors.notFound("文件不存在");
      }
      throw err;
    }

    // Buffer 的底层是 ArrayBufferLike，转成 Uint8Array 才是标准 BodyInit。
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": sniffImageMime(buffer) ?? "application/octet-stream",
        "Content-Length": String(buffer.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  } catch (err) {
    return fail(err);
  }
}
