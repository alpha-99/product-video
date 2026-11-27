/** POST /api/admin/templates/:id/enable — 启用（注册表命中 + 元数据完整；requireAdmin）。 */
import { NextRequest } from "next/server";
import { ok } from "../../../../../../lib/api-response";
import { adminHandler } from "../../../../../../lib/admin-route";
import { enableTemplate } from "../../../../../../lib/admin-templates";

export const runtime = "nodejs";
type Ctx = { params: { id: string } };

export const POST = adminHandler(async (actorId, _request: NextRequest, ctx: Ctx) => {
  return ok(await enableTemplate(ctx.params.id, actorId));
});
