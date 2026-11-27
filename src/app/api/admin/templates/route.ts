/** GET /api/admin/templates — 全量 + 筛选 + 分页 + 注册状态 + 统计（requireAdmin）。 */
import { NextRequest } from "next/server";
import { ok } from "../../../../lib/api-response";
import { adminHandler } from "../../../../lib/admin-route";
import { AdminListQuerySchema } from "../../../../lib/admin-schemas";
import { listAdminTemplates } from "../../../../lib/admin-templates";

export const runtime = "nodejs";

export const GET = adminHandler(async (_actorId, request: NextRequest) => {
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const query = AdminListQuerySchema.parse(params);
  return ok(await listAdminTemplates(query));
});
