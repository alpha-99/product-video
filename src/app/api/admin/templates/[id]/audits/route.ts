/** GET /api/admin/templates/:id/audits — 模板审计分页（requireAdmin）。 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ok } from "../../../../../../lib/api-response";
import { adminHandler } from "../../../../../../lib/admin-route";
import { listTemplateAudits } from "../../../../../../lib/admin-templates";

export const runtime = "nodejs";
type Ctx = { params: { id: string } };
const Query = z.object({
  take: z.coerce.number().int().min(1).max(100).default(20),
  skip: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const GET = adminHandler(async (_actorId, request: NextRequest, ctx: Ctx) => {
  const q = Query.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  return ok(await listTemplateAudits(ctx.params.id, q.take, q.skip));
});
