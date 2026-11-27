/**
 * PATCH /api/admin/users/:id/role — 仅降权（role:"user"），禁改自己、admin 数 ≥1。
 * 任何 role:"admin" 请求在此被 Zod 直接拒绝（ROLE_DIRECT_GRANT_FORBIDDEN 语义 = 400）。
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ok } from "../../../../../../lib/api-response";
import { adminHandler } from "../../../../../../lib/admin-route";
import { errors } from "../../../../../../lib/errors";
import { revokeAdmin } from "../../../../../../lib/admin-users";

export const runtime = "nodejs";
type Ctx = { params: { id: string } };
const RevokeBody = z
  .object({
    role: z.literal("user"),
    reason: z.string().trim().min(1).max(500),
    confirmEmail: z.string().trim().email().optional(),
  })
  .strict();

export const PATCH = adminHandler(async (actorId, request: NextRequest, ctx: Ctx) => {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw errors.validation("请求体必须是合法 JSON");
  }
  // 任何试图把 role 写成 admin 的请求，统一 400（无单步提权接口）。
  if (json && typeof json === "object" && (json as Record<string, unknown>).role === "admin") {
    throw errors.roleDirectGrantForbidden();
  }
  const body = RevokeBody.parse(json);
  return ok(await revokeAdmin(actorId, ctx.params.id, body.reason));
});
