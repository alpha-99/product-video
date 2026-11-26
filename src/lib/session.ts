/**
 * 会话签名与内测登录开关（阶段八 + 阶段九）。
 *
 * 正式环境按方案第 10 章走 Supabase Auth 签发的 Bearer JWT（见 auth.ts）；
 * 本地/内测用 HMAC 签名的 HttpOnly Cookie：
 *   - 密钥来自 DEV_SESSION_SECRET / SUPABASE_JWT_SECRET，绝不硬编码进前端；
 *   - 生产默认 fail-closed：只有显式 PV_AUTH_MODE=local 且密钥长度 ≥32 才开放，
 *     且未配置密钥时用进程内随机密钥，杜绝用默认字符串伪造 Cookie；
 *   - 生产本地模式仍校验 scrypt 密码（见 lib/password.ts），不是免密登录。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import process from "node:process";

export const SESSION_COOKIE = "pv_session";
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

interface SessionPayload {
  sub: string;
  email: string;
  exp: number;
}

let ephemeralSecret: string | undefined;

function secret(): string {
  const configured = process.env.DEV_SESSION_SECRET || process.env.SUPABASE_JWT_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    // 生产不允许用公开默认密钥签名会话；随机密钥会让未配置环境的 Cookie 全部失效。
    return (ephemeralSecret ??= randomBytes(32).toString("hex"));
  }
  return "pv-local-dev-session-secret";
}

/** 生产是否允许本地邮箱密码登录：必须显式开启且密钥足够强（fail-closed）。 */
export function isLocalAuthEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  if (env.NODE_ENV !== "production") return true;
  return env.PV_AUTH_MODE === "local" && (env.DEV_SESSION_SECRET?.length ?? 0) >= 32;
}

/** Cookie 的 Secure 标记：纯 HTTP 内测可用 PV_COOKIE_SECURE=0 显式关闭。 */
export function cookieSecure(
  env: Record<string, string | undefined> = process.env
): boolean {
  if (env.PV_COOKIE_SECURE === "0" || env.PV_COOKIE_SECURE === "false") return false;
  return env.NODE_ENV === "production";
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export function signSession(userId: string, email: string): string {
  const payload: SessionPayload = {
    sub: userId,
    email,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifySession(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.sub || typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** 从 Cookie 请求头里取出会话（resolveUserId 用，避免引入 Next 专属类型）。 */
export function readSessionFromCookieHeader(header: string | null): SessionPayload | null {
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  return verifySession(decodeURIComponent(match[1]));
}
