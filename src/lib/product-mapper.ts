/**
 * 数据库商品行 → 领域 Product 的唯一映射点。
 * Prisma 的 Decimal 转回字符串，JSONB 只接受数组，避免各服务重复处理。
 */
import type { Prisma } from "@prisma/client";
import { ProductSchema, type Product } from "../shared/product.schema";

export interface ProductRow {
  id: string;
  userId: string;
  name: string;
  imagePath: string;
  description: string | null;
  price: unknown;
  sellingPoints: Prisma.JsonValue;
  brandName: string | null;
  brandLogoPath: string | null;
  brandColor: string | null;
}

export function toDomainProduct(row: ProductRow): Product {
  return ProductSchema.parse({
    id: row.id,
    userId: row.userId,
    name: row.name,
    imagePath: row.imagePath,
    ...(row.description ? { description: row.description } : {}),
    ...(row.price != null ? { price: String(row.price) } : {}),
    sellingPoints: Array.isArray(row.sellingPoints) ? row.sellingPoints : [],
    ...(row.brandName ? { brandName: row.brandName } : {}),
    ...(row.brandLogoPath ? { brandLogoPath: row.brandLogoPath } : {}),
    ...(row.brandColor ? { brandColor: row.brandColor } : {}),
  });
}
