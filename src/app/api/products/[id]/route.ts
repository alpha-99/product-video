/**
 * GET    /api/products/:id — 商品详情
 * PATCH  /api/products/:id — 编辑商品（局部更新）
 * DELETE /api/products/:id — 删除商品（含上传件清理；有视频任务时拒绝）
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveUserId } from "../../../../lib/auth";
import { ok, fail } from "../../../../lib/api-response";
import { deleteProduct, getProduct, updateProduct } from "../../../../lib/products";
import { UpdateProductSchema } from "../../../../shared/product.schema";

export const runtime = "nodejs";

type Context = { params: { id: string } };

/** 非法 UUID 直接 400，避免 Prisma 抛底层错误变成 500。 */
function parseId(context: Context): string {
  return z.string().uuid().parse(context.params.id);
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const userId = resolveUserId(request.headers);
    return ok(await getProduct(userId, parseId(context)));
  } catch (err) {
    return fail(err);
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const userId = resolveUserId(request.headers);
    const patch = UpdateProductSchema.parse(await request.json());
    return ok(await updateProduct(userId, parseId(context), patch));
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const userId = resolveUserId(request.headers);
    return ok(await deleteProduct(userId, parseId(context)));
  } catch (err) {
    return fail(err);
  }
}
