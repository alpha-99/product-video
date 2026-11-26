/**
 * GET  /api/products — 当前用户的商品列表（分页）
 * POST /api/products — 新增商品（鉴权 + Zod 校验 + 图片归属处理）
 */
import { NextRequest } from "next/server";
import { resolveUserId } from "../../../lib/auth";
import { ok, fail } from "../../../lib/api-response";
import { createProduct, listProducts } from "../../../lib/products";
import { CreateProductSchema } from "../../../shared/product.schema";
import { ListProductsQuerySchema } from "../../../shared/api";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const userId = resolveUserId(request.headers);
    const { take, skip } = ListProductsQuerySchema.parse({
      take: request.nextUrl.searchParams.get("take") ?? undefined,
      skip: request.nextUrl.searchParams.get("skip") ?? undefined,
    });
    return ok(await listProducts(userId, { take, skip }));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const userId = resolveUserId(request.headers);
    const input = CreateProductSchema.parse(await request.json());
    return ok(await createProduct(userId, input), 201);
  } catch (err) {
    return fail(err);
  }
}
