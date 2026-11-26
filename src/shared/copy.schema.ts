import { z } from "zod";

/**
 * AI 输出契约（方案 6.1）：AI 输出必须严格符合此 Schema。
 * Zod 校验失败即重试，绝不把非法文案送进渲染管线。
 */
export const CopySchema = z.object({
  videoTitle: z.string().min(1).max(60),
  subtitle: z.string().min(1).max(80),
  sellingPoints: z.array(z.string().min(1).max(40)).min(1).max(5),
  cta: z.string().min(1).max(20),
});

export type Copy = z.infer<typeof CopySchema>;

/** 文案长度上限，供 Prompt 模板与截断兜底共用，避免数字散落各处。 */
export const COPY_LIMITS = {
  videoTitle: 60,
  subtitle: 80,
  sellingPointLength: 40,
  sellingPointCount: 5,
  cta: 20,
} as const;

/**
 * POST /api/ai/copy 请求（方案 5.1）。
 * 只接受商品 id：文案输入由服务端按 user_id 查库组装，避免前端伪造商品信息
 * 绕过归属校验，也保证「商品 → 文案」口径唯一。
 */
export const AiCopyRequestSchema = z.object({
  productId: z.string().uuid("商品 id 必须是 UUID"),
});

export type AiCopyRequest = z.infer<typeof AiCopyRequestSchema>;

/** 文案接口响应：cached 供前端展示「复用」提示，model 供排查与成本追溯。 */
export interface AiCopyResponse {
  copy: Copy;
  model: string | null;
  cached: boolean;
  /** 被截断字段的中文说明；前端需展示，避免文案悄悄变短（验收 P2-03）。 */
  truncated?: string[];
}
