/**
 * /api/admin/users/role-requests
 *  GET  — 提权申请列表（按 expires_at > now() 展示 pending，读取时惰性置 expired）
 *  POST — 发起提权申请 {targetUserId, role:"admin", reason}（不直接写 role）
 */
import { NextRequest } from "next/server";
import { ok } from "../../../../../lib/api-response";
import { adminHandler } from "../../../../../lib/admin-route";
import { RoleRequestSchema } from "../../../../../lib/admin-schemas";
import { listRoleRequests, requestGrant } from "../../../../../lib/admin-users";

export const runtime = "nodejs";

export const GET = adminHandler(async (actorId, _request: NextRequest) => {
  return ok(await listRoleRequests(actorId));
});

export const POST = adminHandler(async (actorId, request: NextRequest) => {
  const body = RoleRequestSchema.parse(await request.json());
  return ok(await requestGrant(actorId, body), 201);
});
