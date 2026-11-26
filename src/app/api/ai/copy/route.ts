/**
 * POST /api/ai/copy — 生成商品营销文案（方案 5.1 / 6.1）。
 *
 * 顺序：鉴权 → 限流（10 次/分/用户）→ 请求校验 → 商品归属 → 生成。
 * 只接受 productId，商品字段由服务端查库组装，前端无法伪造商品内容。
 * 失败返回统一错误包络；AI_UNAVAILABLE(503) 时前端应降级为手工填写。
 */
import { NextRequest } from "next/server";
import { resolveUserId } from "../../../../lib/auth";
import { ok, fail } from "../../../../lib/api-response";
import { getProduct } from "../../../../lib/products";
import { generateCopy } from "../../../../lib/ai/copy";
import { assertAiCopyRateLimit } from "../../../../lib/rate-limit";
import { AiCopyRequestSchema, type AiCopyResponse } from "../../../../shared/copy.schema";
import { toAiProductInput } from "../../../../shared/product.schema";

export const runtime = "nodejs";
/** 最坏情况：3 次尝试 × 20s 超时 + 3s 退避，给 75s 上限。 */
export const maxDuration = 75;

export async function POST(request: NextRequest) {
  try {
    const userId = resolveUserId(request.headers);
    assertAiCopyRateLimit(userId);

    const { productId } = AiCopyRequestSchema.parse(await request.json());
    const product = await getProduct(userId, productId);

    const result = await generateCopy(userId, toAiProductInput(product));
    return ok(result satisfies AiCopyResponse);
  } catch (error) {
    return fail(error);
  }
}
