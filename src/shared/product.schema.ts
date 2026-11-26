import { z } from "zod";
import { SafeRelativePathSchema } from "./asset-path.schema";

/**
 * 商品 JSON 契约。
 *
 * 字段来源：PRD 5.2「商品信息字段」+ 方案 4.1 products 表 DDL。
 * 这是新增/编辑商品与 AI 文案输入的单一 Schema 来源；Web、Worker、测试
 * 共用，避免字段名与长度上限在各处漂移。
 */
export const PRODUCT_LIMITS = {
  name: 200,
  description: 2000,
  brandName: 120,
  sellingPointCount: 5,
  sellingPointLength: 40,
} as const;

/** 品牌色：统一 #RRGGBB，与 brand_color VARCHAR(16) 对齐。 */
export const BrandColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "品牌色必须是 #RRGGBB 格式");

/**
 * 图片路径：products.image_path 存相对路径（方案 9.1）。
 * 复用统一路径守卫：拒绝协议、绝对路径、.. 穿越与反斜杠，
 * 避免后续下载接口 / 渲染器拼出非预期磁盘位置（验收 P1-08）。
 */
export const ProductImagePathSchema = SafeRelativePathSchema;

/** 价格字符串：对齐 NUMERIC(12,2)，整数部分最多 10 位、小数最多 2 位。 */
export const ProductPriceSchema = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, "价格必须是 NUMERIC(12,2) 合法格式");

export const ProductSchema = z.object({
  id: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  name: z.string().trim().min(1, "商品名称不能为空").max(PRODUCT_LIMITS.name),
  imagePath: ProductImagePathSchema,
  description: z.string().max(PRODUCT_LIMITS.description).optional(),
  price: ProductPriceSchema.optional(),
  sellingPoints: z
    .array(z.string().trim().min(1).max(PRODUCT_LIMITS.sellingPointLength))
    .max(PRODUCT_LIMITS.sellingPointCount, "卖点最多 5 个")
    .default([]),
  brandName: z.string().max(PRODUCT_LIMITS.brandName).optional(),
  /** 品牌 Logo 会进入渲染快照，同样必须是受控站内相对路径。 */
  brandLogoPath: SafeRelativePathSchema.optional(),
  brandColor: BrandColorSchema.optional(),
});

export type Product = z.infer<typeof ProductSchema>;

/** 新增商品请求：id / userId / 时间戳由服务端生成，客户端不得提供。 */
export const CreateProductSchema = ProductSchema.omit({ id: true, userId: true });
export type CreateProductInput = z.infer<typeof CreateProductSchema>;

/**
 * 编辑商品请求（PATCH 专用，局部更新）。
 *
 * Zod 4 的 `.partial()` 不会剥离字段上的 `.default([])`：解析 `{ name: "新名称" }`
 * 会额外产出 `sellingPoints: []`，使「只改名 / 只换图」把卖点静默清空。
 * 这里显式 unwrap 掉默认值，保证未传字段保持 undefined，
 * 与 updateProduct「只更新客户端显式传入的字段」的语义一致。
 */
export const UpdateProductSchema = CreateProductSchema.partial().extend({
  sellingPoints: CreateProductSchema.shape.sellingPoints.unwrap().optional(),
});
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;

/**
 * AI 文案输入 JSON（方案 6.1 / PRD 5.3）。
 * 字段名与 Prompt 模板一致；price 在此处允许 "$29.99" 这类展示写法，
 * 因为 AI 只消费它生成文案，不写回数据库。
 */
export const AiProductInputSchema = z.object({
  productName: z.string().min(1).max(PRODUCT_LIMITS.name),
  description: z.string().max(PRODUCT_LIMITS.description).optional(),
  sellingPoints: z
    .array(z.string().min(1).max(PRODUCT_LIMITS.sellingPointLength))
    .max(PRODUCT_LIMITS.sellingPointCount)
    .optional(),
  price: z.string().min(1).max(40).optional(),
});
export type AiProductInput = z.infer<typeof AiProductInputSchema>;

/** 商品记录 → AI 输入：只暴露文案生成所需字段，不泄漏 user_id / 磁盘路径。 */
export function toAiProductInput(product: Product): AiProductInput {
  return {
    productName: product.name,
    ...(product.description ? { description: product.description } : {}),
    ...(product.sellingPoints.length ? { sellingPoints: product.sellingPoints } : {}),
    ...(product.price ? { price: product.price } : {}),
  };
}
