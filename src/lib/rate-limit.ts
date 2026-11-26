/**
 * 进程内固定窗口限流（方案 5.2「AI 10 次/分钟」）。
 *
 * 定位：单 VPS + PM2 单实例下的应用层兜底，成本防线而非安全边界。
 * 多实例部署时各进程独立计数，需配合 Nginx 全局限流（方案 12.3），
 * 后续按 13.1 的阈值切 Redis 实现，调用方签名不变。
 */
import { errors } from "./errors";

interface Bucket {
  count: number;
  resetAt: number;
}

const globalForLimit = globalThis as unknown as { __pvRateBuckets?: Map<string, Bucket> };
const buckets = (globalForLimit.__pvRateBuckets ??= new Map<string, Bucket>());

const MAX_KEYS = 10_000;

/** 清掉过期桶，防止长期运行内存只增不减。 */
function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * 记一次访问。
 * @returns allowed=false 表示已超限，retryAfterMs 供 Retry-After 头使用。
 */
export function hitRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now()
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  if (buckets.size > MAX_KEYS) sweep(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: Math.max(limit - 1, 0), retryAfterMs: 0 };
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterMs: bucket.resetAt - now };
  }

  bucket.count += 1;
  return { allowed: true, remaining: limit - bucket.count, retryAfterMs: 0 };
}

/** 测试专用：清空计数，避免用例之间互相污染。 */
export function resetRateLimits(): void {
  buckets.clear();
}

/** AI 文案限流：10 次/分钟/用户（方案 5.2），超限抛 RATE_LIMITED → HTTP 429。 */
export function assertAiCopyRateLimit(userId: string, now?: number): void {
  const result = hitRateLimit(`ai-copy:${userId}`, 10, 60_000, now);
  if (!result.allowed) {
    throw errors.rateLimited(
      `AI 文案生成过于频繁，请 ${Math.ceil(result.retryAfterMs / 1000)} 秒后重试`
    );
  }
}
