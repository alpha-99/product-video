import { z } from "zod";
import { RenderAssetSrcSchema } from "./asset-path.schema";

/**
 * Remotion Composition 统一 Props 契约（方案 7.1）。
 * 所有模板共用此结构；模板内部决定视觉与动画，AI 只填字段。
 *
 * 验收 P1-08：所有素材地址统一走 RenderAssetSrcSchema。
 * 历史上 imageUrl / logoPath / musicPath 是宽松的 z.string()，
 * 外部 http(s):、file: 会原样进入 Remotion Chromium，形成 SSRF 面。
 */
export const ProductVideoPropsSchema = z.object({
  title: z.string().min(1).max(60),
  subtitle: z.string().min(1).max(80),
  /** 受控 data URL 或 uploads/{userId}/ 下的站内相对路径（渲染时转成 data URL）。 */
  imageUrl: RenderAssetSrcSchema,
  price: z.string().optional(),
  /** 促销模板专用：划线原价与优惠文案，不提供时不显示。 */
  originalPrice: z.string().optional(),
  discountText: z.string().optional(),
  sellingPoints: z.array(z.string().min(1).max(40)).min(1).max(5),
  cta: z.string().min(1).max(20),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "brandColor 必须是 #RRGGBB"),
  /** 品牌 Logo：与 imageUrl 同一套受控地址约束。 */
  logoPath: RenderAssetSrcSchema.optional(),
  /** 背景音乐：本期模板尚未接入音频轨道，但地址仍必须先过安全校验。 */
  musicPath: RenderAssetSrcSchema.optional(),
});

export type ProductVideoProps = z.infer<typeof ProductVideoPropsSchema>;

/** 模板注册表条目：compositionId → React Component + 时长 + 默认配置 */
export interface TemplateRegistration {
  compositionId: string;
  durationSec: number;
  width: number;
  height: number;
  defaultProps: ProductVideoProps;
}
