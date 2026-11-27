/** POST /api/admin/users/role-requests/:id/reject — 驳回（reason 必填）。 */
import { NextRequest } from "next/server";
import { ok } from "../../../../../../../lib/api-response";
import { adminHandler } from "../../../../../../../lib/admin-route";
import { RejectSchema } from "../../../../../../../lib/admin-schemas";
import { rejectGrant } from "../../../../../../../lib/admin-users";

export const runtime = "nodejs";
type Ctx = { params: { id: string } };

export const POST = adminHandler(async (actorId, request: NextRequest, ctx: Ctx) => {
  const body = RejectSchema.parse(await request.json());
  return ok(await rejectGrant(actorId, ctx.params.id, body.reason));
});
