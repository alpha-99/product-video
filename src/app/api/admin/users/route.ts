/**
 * GET /api/admin/users — 只读成员列表（精确 email + role 筛选 + 分页，限流 10 次/分）。
 * 查询行为写结构化告警日志（不含邮箱明文），PII 最小：仅 4 字段，不导出。
 */
import { NextRequest } from "next/server";
import { ok } from "../../../../lib/api-response";
import { adminHandler } from "../../../../lib/admin-route";
import { UserListQuerySchema } from "../../../../lib/admin-schemas";
import { hitRateLimit } from "../../../../lib/rate-limit";
import { errors } from "../../../../lib/errors";
import { listUsers } from "../../../../lib/admin-users";

export const runtime = "nodejs";

export const GET = adminHandler(async (actorId, request: NextRequest) => {
  const q = UserListQuerySchema.parse(
    Object.fromEntries(request.nextUrl.searchParams.entries())
  );
  const limit = hitRateLimit(`admin-user-list:${actorId}`, 10, 60_000);
  if (!limit.allowed) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "admin_user_list_rate_limited",
        actorUserId: actorId,
        requestedRole: q.role ?? null,
        retryAfterMs: limit.retryAfterMs,
      })
    );
    throw errors.rateLimited("成员查询过于频繁，请稍后再试");
  }
  // 结构化查询日志：只记 actor UUID 与筛选维度，不记 email 明文。
  console.info(
    JSON.stringify({
      level: "info",
      event: "admin_user_list",
      actorUserId: actorId,
      hasEmailFilter: Boolean(q.email),
      roleFilter: q.role ?? null,
    })
  );
  return ok(await listUsers(q));
});
