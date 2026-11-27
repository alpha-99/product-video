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
      select: { id: true, email: true, quotaLeft: true, role: true, createdAt: true },
    });
    if (!user) throw errors.unauthorized("账号未初始化，请联系管理员");
    return ok({
      id: user.id,
      email: user.email,
      quotaLeft: user.quotaLeft,
      // 仅用于前端是否显示管理入口；权限一律由服务端查库判定，前端 role 不作数。
      role: user.role,
      createdAt: user.createdAt.toISOString(),
    });
  } catch (error) {
    return fail(error);
  }
}
