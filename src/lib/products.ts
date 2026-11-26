/**
 * 商品 CRUD 服务（方案 5.2 / 9.3，阶段五）。
 *
 * 安全约束：
 * - 所有查询强制带 user_id；应用层过滤是主防线（Prisma 走 postgres 角色绕过 RLS）。
 * - 图片路径只能引用当前用户的上传件；draft 桶文件在商品落库时迁移到
 *   uploads/{userId}/{productId}/，替换/删除商品时清理不再引用的文件。
 * - 已有视频任务的商品禁止删除：video_jobs.product_id 无级联，且渲染快照需可追溯。
 */
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db, findUserProduct, listUserProducts } from "./db";
import { errors } from "./errors";
import { fileStorage, uploadRelativePath } from "./storage";
import { toDomainProduct } from "./product-mapper";
import {
  CreateProductSchema,
  UpdateProductSchema,
  type CreateProductInput,
  type UpdateProductInput,
  type Product,
} from "../shared/product.schema";

export type ProductPatch = UpdateProductInput;

function ownUploadPrefix(userId: string): string {
  return `uploads/${userId}/`;
}

/** 引用他人上传件直接拒绝；非上传路径（历史数据）保持原样。 */
function assertImageOwnership(relativePath: string | undefined, userId: string, field: string): void {
  if (relativePath?.startsWith("uploads/") && !relativePath.startsWith(ownUploadPrefix(userId))) {
    throw errors.validation("图片不属于当前用户", { [field]: "图片不属于当前用户" });
  }
}

/** 把 draft 上传件迁移到商品目录，返回最终相对路径。 */
async function settleImage(
  userId: string,
  productId: string,
  relativePath: string | undefined,
  field: string
): Promise<string | undefined> {
  if (!relativePath) return relativePath;
  assertImageOwnership(relativePath, userId, field);

  const draftPrefix = `${ownUploadPrefix(userId)}draft/`;
  if (!relativePath.startsWith(draftPrefix)) return relativePath;

  const storedName = relativePath.slice(draftPrefix.length);
  if (!storedName || storedName.includes("/") || storedName.includes("..")) {
    throw errors.validation("上传件路径非法", { [field]: "上传件路径非法" });
  }
  const target = uploadRelativePath(userId, productId, storedName);

  let moved = false;
  if (!(await fileStorage.exists(target))) {
    let bytes: Buffer;
    try {
      bytes = await fileStorage.read(relativePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw errors.validation("上传件不存在或已被清理", { [field]: "上传件不存在或已被清理" });
      }
      throw err;
    }
    await fileStorage.save(bytes, target);
    moved = true;
  }
  try {
    await fileStorage.delete(relativePath);
  } catch (err) {
    // 验收 P2-08：draft 删除失败时回滚本次新建的 target，
    // 否则「迁移成功但清理草稿失败」会留下一个没有任何记录引用的孤儿文件。
    if (moved) await fileStorage.delete(target).catch(() => undefined);
    throw err;
  }
  return target;
}

/** 只清理当前用户 own/uploads 目录下的文件，绝不触碰外部路径。 */
async function cleanupImage(relativePath: string | undefined, userId: string): Promise<void> {
  if (!relativePath || !relativePath.startsWith(ownUploadPrefix(userId))) return;
  await fileStorage.delete(relativePath);
}

async function requireOwnedProduct(userId: string, productId: string) {
  const row = await findUserProduct(userId, productId);
  if (!row) throw errors.notFound("商品不存在或不属于当前用户");
  return row;
}

export async function listProducts(
  userId: string,
  options: { take?: number; skip?: number } = {}
): Promise<Product[]> {
  const rows = await listUserProducts(userId, options);
  return rows.map(toDomainProduct);
}

export async function getProduct(userId: string, productId: string): Promise<Product> {
  return toDomainProduct(await requireOwnedProduct(userId, productId));
}

/** 新增商品；productId 由服务端生成，客户端不得指定。 */
export async function createProduct(
  userId: string,
  input: CreateProductInput
): Promise<Product> {
  const data = CreateProductSchema.parse(input);
  const productId = randomUUID();

  let imagePath: string | undefined;
  let brandLogoPath: string | undefined;
  try {
    imagePath = await settleImage(userId, productId, data.imagePath, "imagePath");
    brandLogoPath = await settleImage(userId, productId, data.brandLogoPath, "brandLogoPath");
  } catch (err) {
    await Promise.all([
      cleanupImage(imagePath, userId),
      cleanupImage(brandLogoPath, userId),
    ]);
    throw err;
  }

  try {
    const row = await db.product.create({
      data: {
        id: productId,
        userId,
        name: data.name,
        imagePath: imagePath as string,
        description: data.description ?? null,
        price: data.price ?? null,
        sellingPoints: data.sellingPoints as Prisma.InputJsonValue,
        brandName: data.brandName ?? null,
        brandLogoPath: brandLogoPath ?? null,
        brandColor: data.brandColor ?? null,
      },
    });
    return toDomainProduct(row);
  } catch (err) {
    await Promise.all([
      cleanupImage(imagePath, userId),
      cleanupImage(brandLogoPath, userId),
    ]);
    throw err;
  }
}

/** 编辑商品；只更新客户端显式传入的字段。 */
export async function updateProduct(
  userId: string,
  productId: string,
  patch: ProductPatch
): Promise<Product> {
  const data = UpdateProductSchema.parse(patch);
  const existing = await requireOwnedProduct(userId, productId);

  let imagePath = existing.imagePath;
  let brandLogoPath = existing.brandLogoPath ?? undefined;
  try {
    if (data.imagePath !== undefined) {
      imagePath = (await settleImage(userId, productId, data.imagePath, "imagePath")) as string;
    }
    if (data.brandLogoPath !== undefined) {
      brandLogoPath = await settleImage(userId, productId, data.brandLogoPath, "brandLogoPath");
    }
  } catch (err) {
    // 验收 P2-08：清理的是「已经迁移到商品目录的 target」，
    // 而不是客户端传来的 draft 原始路径（它此时已被 settleImage 删除）。
    const settled: string[] = [];
    if (data.imagePath !== undefined && imagePath !== existing.imagePath) {
      settled.push(imagePath);
    }
    if (
      data.brandLogoPath !== undefined &&
      brandLogoPath &&
      brandLogoPath !== existing.brandLogoPath
    ) {
      settled.push(brandLogoPath);
    }
    await Promise.all(settled.map((file) => cleanupImage(file, userId)));
    throw err;
  }

  try {
    const row = await db.product.update({
      where: { id: productId, userId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.price !== undefined ? { price: data.price } : {}),
        ...(data.imagePath !== undefined ? { imagePath } : {}),
        ...(data.sellingPoints !== undefined
          ? { sellingPoints: data.sellingPoints as Prisma.InputJsonValue }
          : {}),
        ...(data.brandName !== undefined ? { brandName: data.brandName } : {}),
        ...(data.brandLogoPath !== undefined ? { brandLogoPath: brandLogoPath ?? null } : {}),
        ...(data.brandColor !== undefined ? { brandColor: data.brandColor } : {}),
      },
    });

    // 仅当旧文件被新路径取代时才删除，避免误删仍被其他字段引用的文件。
    const stale: string[] = [];
    if (data.imagePath !== undefined && imagePath !== existing.imagePath) {
      stale.push(existing.imagePath);
    }
    if (data.brandLogoPath !== undefined && brandLogoPath !== existing.brandLogoPath) {
      if (existing.brandLogoPath) stale.push(existing.brandLogoPath);
    }
    await Promise.all(stale.map((file) => cleanupImage(file, userId)));
    return toDomainProduct(row);
  } catch (err) {
    if (data.imagePath !== undefined && imagePath !== existing.imagePath) {
      await cleanupImage(imagePath, userId);
    }
    if (data.brandLogoPath !== undefined && brandLogoPath !== existing.brandLogoPath) {
      await cleanupImage(brandLogoPath, userId);
    }
    throw err;
  }
}

/** 删除商品及其上传件；已关联视频任务时拒绝删除。 */
export async function deleteProduct(userId: string, productId: string): Promise<{ id: string }> {
  const existing = await requireOwnedProduct(userId, productId);
  const jobs = await db.videoJob.count({ where: { productId, userId } });
  if (jobs > 0) {
    // 验收 P1-06：给出数量与可执行的引导，不再让前端只看到一句「无法删除」。
    const message = `该商品已关联 ${jobs} 个视频任务，无法删除；请先在「视频管理」删除这些任务的记录，再删除商品`;
    throw errors.validation(message, { productId: message });
  }

  await db.product.delete({ where: { id: productId, userId } });
  await Promise.all([
    cleanupImage(existing.imagePath, userId),
    cleanupImage(existing.brandLogoPath ?? undefined, userId),
  ]);
  return { id: productId };
}
