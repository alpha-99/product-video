/**
 * 登录会话接口（阶段八 + 阶段九）。
 *
 * POST   /api/auth/session — 邮箱注册/登录：首次写入 scrypt 密码，之后校验；写 HttpOnly 签名 Cookie
 * GET    /api/auth/session — 返回当前会话用户
 * DELETE /api/auth/session — 退出，清 Cookie
 *
 * 认证模式：
 *  - 开发环境：本地会话，任意邮箱 + ≥8 位密码即可注册（便于本地联调）。
 *  - 生产默认：只认 Supabase Auth 的 Bearer JWT，本接口 POST 返回 403（fail-closed）。
 *  - 生产内测：PV_AUTH_MODE=local + DEV_SESSION_SECRET(≥32) 显式开启本地会话，
 *    密码必须校验；已有但从未设置本地密码的账号一律拒绝登录。
 */
import { randomUUID } from "node:crypto";
import type { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { z } from "zod";
import { resolveUserId } from "../../../../lib/auth";
import { ok, fail } from "../../../../lib/api-response";
import { errors } from "../../../../lib/errors";
import { db } from "../../../../lib/db";
import { hashPassword, verifyPassword } from "../../../../lib/password";
import { hitRateLimit } from "../../../../lib/rate-limit";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  cookieSecure,
  isLocalAuthEnabled,
  signSession,
} from "../../../../lib/session";

export const runtime = "nodejs";

const LoginSchema = z.object({
  email: z.string().trim().email("请输入有效邮箱").max(255),
  password: z.string().min(8, "密码至少 8 位").max(128),
});

const isProd = process.env.NODE_ENV === "production";

function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

/** 登录限流：按 IP 20 次/分 + 按邮箱 10 次/分，Nginx 层另有全局兜底。 */
function assertLoginRateLimit(request: NextRequest, email: string): void {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  const checks = [
    hitRateLimit(`login:ip:${ip}`, 20, 60_000),
    hitRateLimit(`login:email:${email.toLowerCase()}`, 10, 60_000),
  ];
  const blocked = checks.find((check) => !check.allowed);
  if (blocked) {
    throw errors.rateLimited(
      `登录尝试过于频繁，请 ${Math.ceil(blocked.retryAfterMs / 1000)} 秒后重试`
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    if (isProd && !isLocalAuthEnabled()) {
      throw errors.forbidden("生产环境请使用 Supabase Auth 登录");
    }

    const { email, password } = LoginSchema.parse(await request.json());
    assertLoginRateLimit(request, email);

    const existing = await db.user.findUnique({
      where: { email },
      select: { id: true, email: true, quotaLeft: true, passwordHash: true },
    });

    let user: { id: string; email: string; quotaLeft: number };
    if (!existing) {
      user = await db.user.create({
        data: { id: randomUUID(), email, quotaLeft: 3, passwordHash: await hashPassword(password) },
        select: { id: true, email: true, quotaLeft: true },
      });
    } else {
      if (!existing.passwordHash) {
        if (isProd) {
          throw errors.forbidden("该账号未设置本地密码，请联系管理员重置");
        }
        // 开发环境兼容阶段八遗留账号：首次登录补设密码。
        await db.user.update({
          where: { id: existing.id },
          data: { passwordHash: await hashPassword(password) },
        });
      } else if (!(await verifyPassword(password, existing.passwordHash))) {
        throw errors.unauthorized("邮箱或密码错误");
      }
      user = { id: existing.id, email: existing.email, quotaLeft: existing.quotaLeft };
    }

    const response = ok(user);
    setSessionCookie(response, signSession(user.id, user.email));
    return response;
  } catch (error) {
    return fail(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const userId = resolveUserId(request.headers);
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, quotaLeft: true },
    });
    if (!user) throw errors.unauthorized("会话已失效，请重新登录");
    return ok({ ...user, session: isProd && !isLocalAuthEnabled() ? "jwt" : "local-cookie" });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE() {
  const response = ok({ loggedOut: true });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: "/",
    maxAge: 0,
  });
  return response;
}
