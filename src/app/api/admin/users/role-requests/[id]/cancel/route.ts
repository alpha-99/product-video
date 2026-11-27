/** POST /api/admin/users/role-requests/:id/cancel — 发起人撤回 pending 申请（Should）。 */
import { NextRequest } from "next/server";
import { ok } from "../../../../../../../lib/api-response";
import { adminHandler } from "../../../../../../../lib/admin-route";
import { cancelGrant } from "../../../../../../../lib/admin-users";

export const runtime = "nodejs";
type Ctx = { params: { id: string } };

export const POST = adminHandler(async (actorId, _request: NextRequest, ctx: Ctx) => {
  return ok(await cancelGrant(actorId, ctx.params.id));
});
