/**
 * 请求鉴权（方案第 10 章）。
 *
 * 生产环境：校验 Supabase Auth 签发的 HS256 JWT（SUPABASE_JWT_SECRET），
 * 从 sub claim 取 user UUID；无需引入 supabase SDK，用 node:crypto 自校验。
 *
 * 本地开发 / E2E：未配置 JWT_SECRET 时允许 X-Dev-User-Id 头注入用户，
 * 仅当 NODE_ENV !== "production" 时生效，生产环境严格 fail-closed。
 *
 * 阶段九：PV_AUTH_MODE=local（内测）时，生产也接受签名 Cookie 会话，
 * 但必须由 isLocalAuthEnabled() 判定，且登录接口校验 scrypt 密码。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import process from "node:process";
import { errors } from "./errors";
import { isLocalAuthEnabled, readSessionFromCookieHeader } from "./session";

function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface JwtPayload {
  sub?: string;
  exp?: number;
  role?: string;
}

/** 校验 HS256 JWT 的签名与有效期，返回 payload；失败抛 UNAUTHORIZED。 */
export function verifySupabaseJwt(token: string, secret: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw errors.unauthorized("JWT 格式错误");

  const [headerSeg, payloadSeg, signatureSeg] = parts;
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerSeg).toString("utf8")) as typeof header;
  } catch {
    throw errors.unauthorized("JWT 头部非法");
  }
  if (header.alg !== "HS256") throw errors.unauthorized("不支持的 JWT 算法");

  const expected = createHmac("sha256", secret)
    .update(`${headerSeg}.${payloadSeg}`)
    .digest();
  const actual = base64UrlDecode(signatureSeg);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw errors.unauthorized("JWT 签名无效");
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadSeg).toString("utf8")) as JwtPayload;
  } catch {
    throw errors.unauthorized("JWT 载荷非法");
  }
  if (!payload.sub) throw errors.unauthorized("JWT 缺少 sub");
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    throw errors.unauthorized("JWT 已过期");
  }
  return payload;
}

/** 从请求头解析当前用户 UUID。 */
export function resolveUserId(headers: Headers): string {
  const auth = headers.get("authorization");
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (auth?.startsWith("Bearer ") && secret) {
    const payload = verifySupabaseJwt(auth.slice(7).trim(), secret);
    return payload.sub as string;
  }
  if (process.env.NODE_ENV !== "production") {
    const devUserId = headers.get("x-dev-user-id");
    if (devUserId) return devUserId;
  }

  // HttpOnly 签名 Cookie：开发环境恒可用；生产仅 PV_AUTH_MODE=local 且密钥合格时可用。
  const session = readSessionFromCookieHeader(headers.get("cookie"));
  if (session && (process.env.NODE_ENV !== "production" || isLocalAuthEnabled())) {
    return session.sub;
  }
  throw errors.unauthorized("缺少有效的认证凭据");
}
