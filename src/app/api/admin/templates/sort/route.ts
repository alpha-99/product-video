/** POST /api/admin/templates/sort — 批量调整排序（0~999，version CAS，整批同事务）。 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ok } from "../../../../../lib/api-response";
import { adminHandler } from "../../../../../lib/admin-route";
import { updateSortOrders } from "../../../../../lib/admin-templates";

export const runtime = "nodejs";

const SortBody = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().uuid(),
          sortOrder: z.number().int().min(0).max(999),
          version: z.number().int().min(1),
        })
      )
      .min(1)
      .max(100),
  })
  .strict();

export const POST = adminHandler(async (actorId, request: NextRequest) => {
  const body = SortBody.parse(await request.json());
  return ok(await updateSortOrders(body.items, actorId));
});
