/** POST /api/admin/users/role-requests/:id/approve — 另一名 admin 批准（事务 + 条件更新 + 审计）。 */
import { NextRequest } from "next/server";
import { ok } from "../../../../../../../lib/api-response";
import { adminHandler } from "../../../../../../../lib/admin-route";
import { approveGrant } from "../../../../../../../lib/admin-users";

export const runtime = "nodejs";
type Ctx = { params: { id: string } };

export const POST = adminHandler(async (actorId, _request: NextRequest, ctx: Ctx) => {
  return ok(await approveGrant(actorId, ctx.params.id));
});
