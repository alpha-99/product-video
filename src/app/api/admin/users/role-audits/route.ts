/** GET /api/admin/users/role-audits — 角色变更审计分页（requireAdmin）。 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ok } from "../../../../../lib/api-response";
import { adminHandler } from "../../../../../lib/admin-route";
import { listRoleAudits } from "../../../../../lib/admin-users";

export const runtime = "nodejs";
const Query = z.object({
  take: z.coerce.number().int().min(1).max(100).default(20),
  skip: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const GET = adminHandler(async (_actorId, request: NextRequest) => {
  const q = Query.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  return ok(await listRoleAudits(q.take, q.skip));
});
