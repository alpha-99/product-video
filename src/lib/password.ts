/**
 * 内测本地登录的密码哈希（阶段九）。
 *
 * 正式环境按方案第 10 章应走 Supabase Auth；PV_AUTH_MODE=local 仅用于
 * 单 VPS 内测，避免「任意邮箱 + 任意 8 位密码」在公网等于无鉴权。
 * 使用 Node 内置 scrypt + 随机 salt，不新增依赖；存储格式自带算法标识，
 * 便于后续换算法时平滑升级。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

const ALGORITHM = "scrypt";
const KEY_LENGTH = 64;

/** 生成 `scrypt$<salt>$<hash>`，salt 每次随机。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `${ALGORITHM}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** 恒定时间比较；格式非法、缺哈希、算法不支持一律返回 false。 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined
): Promise<boolean> {
  if (!stored) return false;
  const [algorithm, saltPart, hashPart] = stored.split("$");
  if (algorithm !== ALGORITHM || !saltPart || !hashPart) return false;
  try {
    const expected = Buffer.from(hashPart, "base64url");
    if (expected.length !== KEY_LENGTH) return false;
    const actual = await scrypt(password, Buffer.from(saltPart, "base64url"), KEY_LENGTH);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
