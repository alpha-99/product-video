/**
 * 管理端鉴权与角色守卫（方案 V1.0 §8.1 / §8.2.3）。
 *
 * 四条不信任：
 *  ① 不认 JWT role claim / Cookie / 请求头里的角色声明——每次查 users.role；
 *  ② 前端隐藏入口不算安全边界，接口与页面双层 gate；
 *  ③ 不提供任何单账号自助提权路径；
 *  ④ 不设「临时跳过鉴权」开关。
 *
 * JWT 合法但 users 无行 → 401「账号未初始化」（B4），与 /api/me 语义一致。
 * 角色撤销后下一次请求立即失效（不缓存 role）。
 */
import type { Prisma } from "@prisma/client";
import { resolveUserId } from "./auth";
import { errors } from "./errors";
import { db } from "./db";

/** 需要管理员角色的请求：返回当前管理员 user id，非管理员 403。 */
export async function requireAdmin(headers: Headers): Promise<string> {
  const userId = resolveUserId(headers); // 未登录 → 401
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!user) throw errors.unauthorized("账号未初始化，请联系管理员");
  if (user.role !== "admin") throw errors.forbidden("仅管理员可操作后台配置");
  return userId;
}

/**
 * 事务内重查管理员身份：复核/降权等敏感写入必须在同一事务里再次确认，
 * 避免调用方在读到 actor 后其角色被并发撤销。
 */
export async function requireAdminInTx(
  tx: Prisma.TransactionClient,
  actorId: string
): Promise<void> {
  const user = await tx.user.findUnique({
    where: { id: actorId },
    select: { role: true },
  });
  if (!user) throw errors.unauthorized("账号未初始化，请联系管理员");
  if (user.role !== "admin") throw errors.forbidden("仅管理员可操作后台配置");
}

/** 统计当前管理员数（事务内）。 */
export async function countAdmins(
  client: Prisma.TransactionClient | typeof db = db
): Promise<number> {
  return client.user.count({ where: { role: "admin" } });
}

/** L3 主体约束：禁止改自己角色。 */
export function assertNotSelf(actorId: string, targetId: string): void {
  if (actorId === targetId) throw errors.roleSelfChange();
}

/** L3：发起提权前置管理员数 ≥ 2。 */
export async function assertCanRequestGrant(
  client: Prisma.TransactionClient | typeof db = db
): Promise<void> {
  if ((await countAdmins(client)) < 2) throw errors.roleNeedsSecondAdmin();
}

/** L3：降权后管理员数 ≥ 1（条件更新在调用方做，这里给明确文案）。 */
export function assertRoleLastAdmin(wouldBeZero: boolean): void {
  if (wouldBeZero) throw errors.roleLastAdmin();
}
