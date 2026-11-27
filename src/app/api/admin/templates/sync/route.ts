/** POST /api/admin/templates/sync — 注册表同步（新增缺失 + 自动停用注册缺失行；requireAdmin）。 */
import { NextRequest } from "next/server";
import { ok } from "../../../../../lib/api-response";
import { adminHandler } from "../../../../../lib/admin-route";
import { syncRegistry } from "../../../../../lib/admin-templates";

export const runtime = "nodejs";

export const POST = adminHandler(async (actorId, _request: NextRequest) => {
  return ok(await syncRegistry(actorId));
});
