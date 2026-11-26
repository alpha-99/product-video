/** GET /api/me — 当前用户信息与剩余额度（方案 5.1）。 */
import { NextRequest } from "next/server";
import { resolveUserId } from "../../../lib/auth";
import { ok, fail } from "../../../lib/api-response";
import { errors } from "../../../lib/errors";
import { db } from "../../../lib/db";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const userId = resolveUserId(request.headers);
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, quotaLeft: true, createdAt: true },
    });
    if (!user) throw errors.unauthorized("用户不存在，请重新登录");
    return ok({
      id: user.id,
      email: user.email,
      quotaLeft: user.quotaLeft,
      createdAt: user.createdAt.toISOString(),
    });
  } catch (error) {
    return fail(error);
  }
}
