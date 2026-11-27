/**
 * 管理页服务端 gate（FR-10 / FR-14 / TC-12）。
 * 普通用户直输 /admin/** URL 由服务端拦下；不依赖前端隐藏入口。
 * JWT 合法但 users 无行 → 401「账号未初始化」，与普通接口语义一致。
 */
import { headers } from "next/headers";
import { resolveUserId } from "./auth";
import { db } from "./db";

export type AdminGate =
  | { ok: true; userId: string; email: string }
  | { ok: false; status: 401 | 403; message: string };

export async function checkAdminPage(): Promise<AdminGate> {
  let userId: string;
  try {
    userId = resolveUserId(headers());
  } catch {
    return { ok: false, status: 401, message: "请先登录后再访问管理后台" };
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true },
  });
  if (!user) {
    return { ok: false, status: 401, message: "账号未初始化，请联系管理员" };
  }
  if (user.role !== "admin") {
    return {
      ok: false,
      status: 403,
      message: "你的当前角色为「普通用户」，无权访问管理后台",
    };
  }
  return { ok: true, userId, email: user.email };
}
