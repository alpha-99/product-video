/**
 * 管理端路由统一封装：每个 handler 首行 requireAdmin，避免漏挂鉴权（TC-12 静态守卫）。
 * 未登录 401 / 非管理员 403 / JWT 合法但无 users 行 401，全部走统一错误包络。
 */
import { NextRequest } from "next/server";
import { requireAdmin } from "./admin";
import { fail } from "./api-response";

export function adminHandler<T extends unknown[]>(
  fn: (actorId: string, request: NextRequest, ...rest: T) => Promise<Response>
) {
  return async (request: NextRequest, ...rest: T): Promise<Response> => {
    try {
      const actorId = await requireAdmin(request.headers);
      return await fn(actorId, request, ...rest);
    } catch (error) {
      return fail(error);
    }
  };
}
