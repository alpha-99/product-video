/** POST /api/admin/templates/:id/disable — 停用（可渲染启用数 > 1；requireAdmin）。 */
import { NextRequest } from "next/server";
import { ok } from "../../../../../../lib/api-response";
import { adminHandler } from "../../../../../../lib/admin-route";
import { DisableSchema } from "../../../../../../lib/admin-schemas";
import { errors } from "../../../../../../lib/errors";
import { disableTemplate } from "../../../../../../lib/admin-templates";

export const runtime = "nodejs";
type Ctx = { params: { id: string } };

export const POST = adminHandler(async (actorId, request: NextRequest, ctx: Ctx) => {
  const text = await request.text();
  let body: { reason?: string } = {};
  if (text.trim()) {
    try {
      body = DisableSchema.parse(JSON.parse(text));
    } catch (err) {
      throw errors.validation("停用请求体必须是合法 JSON", {
        body: (err as Error).message,
      });
    }
  }
  return ok(await disableTemplate(ctx.params.id, actorId, body.reason));
});
