/**
 * 管理端输入契约（方案 V1.0 §7.2 / §10）。
 * 所有边界输入先 Zod 校验再进 Prisma，避免 NaN / 超长 / 非法枚举触发 500。
 */
import { z } from "zod";

export const TONE_VALUES = [
  "energetic",
  "calm",
  "premium",
  "playful",
  "urgent",
] as const;
export const CATEGORY_VALUES = ["launch", "highlight", "sale", "showcase"] as const;

export const TemplatePatchSchema = z
  .object({
    // 乐观锁必填：version 过期返回 TEMPLATE_CONFLICT（TC-07）
    version: z.number().int().min(1),
    displayName: z.string().trim().min(1).max(120).optional(),
    englishName: z.string().trim().max(120).optional(),
    description: z.string().trim().max(300).optional(),
    cta: z.string().trim().max(60).optional(),
    tone: z.enum(TONE_VALUES).optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  .strict();

export const DisableSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

export const AdminListQuerySchema = z.object({
  keyword: z.string().trim().max(120).optional(),
  category: z.enum(CATEGORY_VALUES).optional(),
  enabled: z.enum(["true", "false"]).optional(),
  status: z.enum(["all", "registered", "missing"]).optional(),
  take: z.coerce.number().int().min(1).max(100).default(20),
  skip: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type AdminListQuery = z.infer<typeof AdminListQuerySchema>;

export const UserListQuerySchema = z.object({
  // Q6 默认精确 email 匹配 + 10 次/分限流（在路由层执行）
  email: z.string().trim().max(255).optional(),
  role: z.enum(["user", "admin"]).optional(),
  take: z.coerce.number().int().min(1).max(100).default(20),
  skip: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type UserListQuery = z.infer<typeof UserListQuerySchema>;

export const RoleRequestSchema = z
  .object({
    targetUserId: z.string().uuid(),
    role: z.literal("admin"), // 本期仅支持授予 admin；任何其它值都是 400
    reason: z.string().trim().min(1, "请填写申请原因").max(500),
  })
  .strict();

export const RejectSchema = z
  .object({ reason: z.string().trim().min(1, "请填写驳回理由").max(500) })
  .strict();

export const RevokeSchema = z
  .object({
    role: z.literal("user"), // 降权接口只接受 user；role=admin 走这里一律 400
    reason: z.string().trim().min(1, "请填写撤销原因").max(500),
    confirmEmail: z.string().trim().email().optional(), // 体验层二次确认，服务端独立校验
  })
  .strict();
