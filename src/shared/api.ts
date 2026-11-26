import { z } from "zod";
import { RenderCopySchema, RenderOptionsSchema } from "./template.schema";

/** 统一响应包络（方案 5.2） */
export type ApiResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        fields?: Record<string, string>;
        /** 服务端建议的重试等待时间（毫秒），用于 AI 限流等可恢复错误。 */
        retryAfterMs?: number;
      };
    };

export const CreateVideoRequestSchema = z.object({
  productId: z.string().uuid(),
  templateId: z.string().uuid(),
  copy: RenderCopySchema,
  options: RenderOptionsSchema.optional(),
});

export type CreateVideoRequest = z.infer<typeof CreateVideoRequestSchema>;

/**
 * GET /api/videos 分页参数契约。
 * 显式校验 + 限幅：避免 Number("abc") = NaN 直接进 Prisma 触发 500，
 * 也防止无界 take 造成大查询。非法参数返回 400 而非 500。
 */
export const ListVideosQuerySchema = z.object({
  take: z.coerce
    .number({ error: "take 必须是 1–100 的整数" })
    .int("take 必须是整数")
    .min(1, "take 不能小于 1")
    .max(100, "take 最多 100 条")
    .default(20),
  skip: z.coerce
    .number({ error: "skip 必须是非负整数" })
    .int("skip 必须是整数")
    .min(0, "skip 不能为负数")
    .max(100_000, "skip 超出允许范围")
    .default(0),
});
export type ListVideosQuery = z.infer<typeof ListVideosQuerySchema>;

/**
 * 商品列表共用同一份分页契约（验收 P2-11）：
 * 不再用 Math.min/Math.max(Number(...)) 静默钳制 NaN，非法参数一律 400。
 */
export const ListProductsQuerySchema = ListVideosQuerySchema;
export type ListProductsQuery = ListVideosQuery;

export interface CreateVideoResponse {
  jobId: string;
  status: "pending";
}

/** 错误码常量（方案 5.2） */
export const ErrorCode = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  RATE_LIMITED: "RATE_LIMITED",
  AI_UNAVAILABLE: "AI_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 任务状态（方案 4.1 video_jobs.status CHECK 约束） */
export const JobStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type JobStatusValue = (typeof JobStatus)[keyof typeof JobStatus];
