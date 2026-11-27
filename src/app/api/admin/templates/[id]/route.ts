/** GET /api/admin/templates/:id 详情；PATCH 白名单字段更新 + version CAS（requireAdmin）。 */
import { NextRequest } from "next/server";
import { ok } from "../../../../../lib/api-response";
import { adminHandler } from "../../../../../lib/admin-route";
import { TemplatePatchSchema } from "../../../../../lib/admin-schemas";
import {
  getAdminTemplateDetail,
  updateTemplateMeta,
} from "../../../../../lib/admin-templates";

export const runtime = "nodejs";
type Ctx = { params: { id: string } };

export const GET = adminHandler(async (_actorId, _request: NextRequest, ctx: Ctx) => {
  return ok(await getAdminTemplateDetail(ctx.params.id));
});

export const PATCH = adminHandler(async (actorId, request: NextRequest, ctx: Ctx) => {
  const body = TemplatePatchSchema.parse(await request.json());
  const updated = await updateTemplateMeta(ctx.params.id, body, actorId);
  return ok(updated);
});
