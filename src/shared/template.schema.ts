import { z } from "zod";
import { COPY_LIMITS, type Copy } from "./copy.schema";
import { RenderAssetSrcSchema } from "./asset-path.schema";
import { BrandColorSchema, ProductSchema, type Product } from "./product.schema";
import {
  ProductVideoPropsSchema,
  type ProductVideoProps,
} from "./video-props.schema";

/**
 * 模板参数契约（方案 7.1）与参数化生成（PRD 5.4）。
 *
 * 原则：AI 只产出文案 JSON，模板开发者维护视觉与动画。
 * 本文件负责三件事：
 *   1. 注册 4 个 Composition 及其规格 / 默认参数；
 *   2. 定义文案与可配置项的 Schema；
 *   3. 把「商品 + 文案 + 可选项」纯函数映射成统一的渲染 Props。
 */

// ---------------------------------------------------------------------------
// 文案与可配置项
// ---------------------------------------------------------------------------

/** API / 渲染侧的文案字段：CreateVideoRequest.copy 使用 title（方案 5.2）。 */
export const RenderCopySchema = z.object({
  title: z.string().min(1).max(COPY_LIMITS.videoTitle),
  subtitle: z.string().min(1).max(COPY_LIMITS.subtitle),
  sellingPoints: z
    .array(z.string().min(1).max(COPY_LIMITS.sellingPointLength))
    .min(1)
    .max(COPY_LIMITS.sellingPointCount),
  cta: z.string().min(1).max(COPY_LIMITS.cta),
});
export type RenderCopy = z.infer<typeof RenderCopySchema>;

/**
 * 用户在向导里可覆盖的配置；优先级高于商品记录与模板默认值。
 *
 * 验收 P1-08：logoPath / music 与渲染 Props 共用受控地址契约，
 * 外部 URL 与 file: 地址在提交阶段即被拒绝。
 * 验收 P2-07：本期向导只开放 brandColor；logoPath 仅部分模板消费，
 * music 尚未接入音频轨道，originalPrice / discountText 仅促销模板消费。
 * 未开放项保留在契约里是为了兼容历史快照，前端不提供输入入口。
 */
export const RenderOptionsSchema = z.object({
  brandColor: BrandColorSchema.optional(),
  logoPath: RenderAssetSrcSchema.optional(),
  music: RenderAssetSrcSchema.optional(),
  /** 促销模板可选项：原价与优惠文案。 */
  originalPrice: z.string().max(40).optional(),
  discountText: z.string().max(40).optional(),
});
export type RenderOptions = z.infer<typeof RenderOptionsSchema>;

/** AI 文案（videoTitle）→ 渲染文案（title）。仅字段名转换，不改内容。 */
export function copyFromAi(ai: Copy): RenderCopy {
  return {
    title: ai.videoTitle,
    subtitle: ai.subtitle,
    sellingPoints: ai.sellingPoints,
    cta: ai.cta,
  };
}

/**
 * 长度兜底（方案 6.1）：超长时按上限截断并返回提示，
 * 不允许把超长文本送进渲染导致版式溢出。
 */
export function normalizeCopy(copy: RenderCopy): {
  copy: RenderCopy;
  truncated: string[];
} {
  const notes: string[] = [];
  const cut = (value: string, max: number, label: string) => {
    if (value.length <= max) return value;
    notes.push(`${label} 超过 ${max} 字，已截断`);
    return value.slice(0, max);
  };

  const keep = copy.sellingPoints.slice(0, COPY_LIMITS.sellingPointCount);
  if (copy.sellingPoints.length > keep.length) {
    notes.push(`卖点超过 ${COPY_LIMITS.sellingPointCount} 个，已只保留前 ${keep.length} 个`);
  }

  return {
    copy: {
      title: cut(copy.title, COPY_LIMITS.videoTitle, "标题"),
      subtitle: cut(copy.subtitle, COPY_LIMITS.subtitle, "副标题"),
      sellingPoints: keep.map((point, i) =>
        cut(point, COPY_LIMITS.sellingPointLength, `卖点${i + 1}`)
      ),
      cta: cut(copy.cta, COPY_LIMITS.cta, "CTA"),
    },
    truncated: notes,
  };
}

// ---------------------------------------------------------------------------
// 模板注册表
// ---------------------------------------------------------------------------

export const TEMPLATE_IDS = [
  "product-launch",
  "product-highlight",
  "product-sale",
  "product-showcase",
] as const;
export const TemplateIdSchema = z.enum(TEMPLATE_IDS);
export type TemplateId = z.infer<typeof TemplateIdSchema>;

/** PRD 5.4 模板统一规格。 */
export const VIDEO_SPEC = {
  width: 1080,
  height: 1920,
  fps: 30,
  aspectRatio: "9:16",
  format: "MP4",
  codec: "H.264",
} as const;

export interface TemplateDefinition {
  id: TemplateId;
  name: string;
  category: "launch" | "highlight" | "sale" | "showcase";
  compositionId: TemplateId;
  durationSec: 15 | 20;
  width: number;
  height: number;
  fps: number;
  defaultProps: ProductVideoProps;
}

/** 预览默认值用内联 SVG data URL，避免 Composition 依赖 public/ 下的具体文件。 */
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800">' +
  '<rect width="600" height="800" fill="#f4efe7"/>' +
  '<text x="300" y="410" font-family="serif" font-size="48" fill="#9c8f7e" text-anchor="middle">PRODUCT</text>' +
  "</svg>";
const PLACEHOLDER_IMAGE_URL = `data:image/svg+xml;utf8,${encodeURIComponent(PLACEHOLDER_SVG)}`;

const baseDefaultProps: ProductVideoProps = {
  title: "产品标题",
  subtitle: "产品副标题",
  imageUrl: PLACEHOLDER_IMAGE_URL,
  sellingPoints: ["核心卖点"],
  cta: "立即购买",
  brandColor: "#2563eb",
};

/** compositionId → React Component + 时长 + 默认配置；组件在 remotion/ 侧绑定。 */
export const TEMPLATES: readonly TemplateDefinition[] = [
  {
    id: "product-launch",
    name: "Product Launch 新品展示",
    category: "launch",
    compositionId: "product-launch",
    durationSec: 15,
    ...VIDEO_SPEC,
    defaultProps: { ...baseDefaultProps },
  },
  {
    id: "product-highlight",
    name: "Product Highlight 卖点介绍",
    category: "highlight",
    compositionId: "product-highlight",
    durationSec: 20,
    ...VIDEO_SPEC,
    defaultProps: {
      ...baseDefaultProps,
      subtitle: "三大理由，值得拥有",
      brandColor: "#0f766e",
    },
  },
  {
    id: "product-sale",
    name: "Product Sale 促销活动",
    category: "sale",
    compositionId: "product-sale",
    durationSec: 15,
    ...VIDEO_SPEC,
    defaultProps: { ...baseDefaultProps, cta: "立即抢购", brandColor: "#dc2626" },
  },
  {
    id: "product-showcase",
    name: "Premium Showcase 高级品牌展示",
    category: "showcase",
    compositionId: "product-showcase",
    durationSec: 20,
    ...VIDEO_SPEC,
    defaultProps: { ...baseDefaultProps, brandColor: "#1f2937" },
  },
];

/** 未知模板必须在进入渲染前失败，不能静默回退到默认模板。 */
export function getTemplate(id: string): TemplateDefinition {
  const found = TEMPLATES.find((t) => t.id === id);
  if (!found) throw new Error(`未知模板: ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// 参数化生成
// ---------------------------------------------------------------------------

export const BuildVideoPropsInputSchema = z.object({
  templateId: TemplateIdSchema,
  product: ProductSchema,
  copy: RenderCopySchema,
  options: RenderOptionsSchema.default({}),
});
/**
 * 显式入参类型：z.infer 属于「解析输出」，会把带 default 的 options 变必填；
 * 调用方应能省略 options，因此这里单独声明输入形状。
 */
export interface BuildVideoPropsInput {
  templateId: TemplateId;
  product: Product;
  copy: RenderCopy;
  options?: RenderOptions;
}

/**
 * 纯函数：商品 + 文案 + 可选项 → ProductVideoProps。
 * 优先级：用户选项 > 商品记录 > 模板默认值。
 * 输出一定经过 ProductVideoPropsSchema 校验，非法参数在渲染前抛错。
 */
export function buildVideoProps(input: BuildVideoPropsInput): ProductVideoProps {
  const parsed = BuildVideoPropsInputSchema.parse(input);
  const { templateId, product, copy, options } = parsed;
  const template = getTemplate(templateId);

  const props: ProductVideoProps = {
    title: copy.title,
    subtitle: copy.subtitle,
    imageUrl: product.imagePath,
    ...(product.price ? { price: product.price } : {}),
    ...(options.originalPrice ? { originalPrice: options.originalPrice } : {}),
    ...(options.discountText ? { discountText: options.discountText } : {}),
    sellingPoints: copy.sellingPoints,
    cta: copy.cta,
    brandColor:
      options.brandColor ?? product.brandColor ?? template.defaultProps.brandColor,
    ...(options.logoPath || product.brandLogoPath
      ? { logoPath: options.logoPath ?? product.brandLogoPath }
      : {}),
    ...(options.music ? { musicPath: options.music } : {}),
  };

  return ProductVideoPropsSchema.parse(props);
}

/** 便捷入口：AI 文案 + 商品 → 已归一化的渲染参数与提示。 */
export function buildPropsFromAi(input: {
  templateId: TemplateId;
  product: Product;
  copy: Copy;
  options?: RenderOptions;
}): { props: ProductVideoProps; truncated: string[] } {
  const { copy, truncated } = normalizeCopy(copyFromAi(input.copy));
  return {
    props: buildVideoProps({
      templateId: input.templateId,
      product: input.product,
      copy,
      options: input.options,
    }),
    truncated,
  };
}
