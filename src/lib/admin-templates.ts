/**
 * 模板管理服务层（方案 V1.0 §4/§5/§7）。
 *
 * 分层：route（解析 HTTP + 鉴权）→ 本模块（业务规则 + 事务）→ db（数据访问）。
 * 关键守卫：
 *  - 可渲染启用数 = enabled ∧ composition_id ∈ TEMPLATES，恒 ≥ 1（B3）；
 *  - 启停用走独立动作接口，改的是目标态（幂等），带 updatedAt/version CAS；
 *  - 每次写操作在同一事务内写 before/after 审计，审计失败整笔回滚（D4）。
 */
import { Prisma } from "@prisma/client";
import { db, withTransaction } from "./db";
import { errors } from "./errors";
import { TEMPLATES, TEMPLATE_IDS, type TemplateId } from "../shared/template.schema";
import { templateThumbnailRelativePath } from "./storage";
import type { AdminListQuery } from "./admin-schemas";
import type { TemplatePatchInput } from "./admin-template-types";

const REGISTERED = new Set<string>(TEMPLATE_IDS);

/** 审计动作枚举（含 r3 新增的自动停用）。 */
export type TemplateAuditAction =
  | "update_metadata"
  | "enabled"
  | "disabled"
  | "thumbnail_uploaded"
  | "sort_order_changed"
  | "auto_disabled_registry_missing"
  | "sync_registered";

function audit(
  tx: Prisma.TransactionClient,
  data: {
    templateId: string;
    actorUserId: string | null;
    action: TemplateAuditAction;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    reason?: string;
  }
) {
  return tx.templateAuditLog.create({
    data: {
      templateId: data.templateId,
      actorUserId: data.actorUserId,
      action: data.action,
      beforeJson: data.before ?? Prisma.JsonNull,
      afterJson: data.after ?? Prisma.JsonNull,
      reason: data.reason?.slice(0, 500) || null,
    },
  });
}

/** 当前可渲染启用数（只数注册表命中的行）。 */
export async function countRenderableEnabled(
  client: Prisma.TransactionClient | typeof db = db
): Promise<number> {
  return client.videoTemplate.count({
    where: { enabled: true, compositionId: { in: [...REGISTERED] } },
  });
}

function registryMissing(compositionId: string): boolean {
  return !REGISTERED.has(compositionId);
}

/** 管理端全量列表（含停用 / 注册缺失），筛选 + 分页 + 注册状态。 */
export async function listAdminTemplates(query: AdminListQuery) {
  const where: Prisma.VideoTemplateWhereInput = {};
  if (query.keyword) {
    where.OR = [
      { displayName: { contains: query.keyword, mode: "insensitive" } },
      { compositionId: { contains: query.keyword, mode: "insensitive" } },
    ];
  }
  if (query.category) where.category = query.category;
  if (query.enabled) where.enabled = query.enabled === "true";
  // status=missing 是注册缺失（注册表无对应项），在内存判定后过滤；
  // 先按注册命中范围缩小查询以复用索引。
  const [rows, total] = await Promise.all([
    db.videoTemplate.findMany({
      where,
      take: query.take,
      skip: query.skip,
      orderBy: [{ sortOrder: "asc" }, { compositionId: "asc" }],
    }),
    db.videoTemplate.count({ where }),
  ]);

  let view = rows.map((row) => ({
    id: row.id,
    name: row.displayName ?? row.name,
    compositionId: row.compositionId,
    category: row.category,
    durationSec: row.durationSec,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
    registered: !registryMissing(row.compositionId),
    version: row.version,
    thumbnailPath: row.thumbnailPath,
    displayName: row.displayName,
    englishName: row.englishName,
    description: row.description,
    cta: row.cta,
    tone: row.tone,
    updatedAt: row.updatedAt.toISOString(),
  }));

  if (query.status === "missing") view = view.filter((v) => !v.registered);
  if (query.status === "registered") view = view.filter((v) => v.registered);

  return {
    items: view,
    total: query.status ? view.length : total,
    take: query.take,
    skip: query.skip,
    stats: {
      total: await db.videoTemplate.count(),
      enabled: await db.videoTemplate.count({ where: { enabled: true } }),
      renderableEnabled: await countRenderableEnabled(),
      registryMissing: await db.videoTemplate.count({
        where: { compositionId: { notIn: [...REGISTERED] } },
      }),
    },
  };
}

/** 详情 + 最近审计摘要。 */
export async function getAdminTemplateDetail(id: string) {
  const row = await db.videoTemplate.findUnique({ where: { id } });
  if (!row) throw errors.notFound("模板不存在");
  const audits = await db.templateAuditLog.findMany({
    where: { templateId: id },
    take: 20,
    orderBy: { createdAt: "desc" },
  });
  return {
    id: row.id,
    name: row.displayName ?? row.name,
    compositionId: row.compositionId,
    category: row.category,
    durationSec: row.durationSec,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
    registered: !registryMissing(row.compositionId),
    version: row.version,
    thumbnailPath: row.thumbnailPath,
    displayName: row.displayName,
    englishName: row.englishName,
    description: row.description,
    cta: row.cta,
    tone: row.tone,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    audits: audits.map((a) => ({
      id: a.id,
      action: a.action,
      before: a.beforeJson,
      after: a.afterJson,
      reason: a.reason,
      actorUserId: a.actorUserId,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

/** 编辑运营元数据：只接受白名单字段 + version CAS；审计与主操作同事务。 */
export async function updateTemplateMeta(
  id: string,
  input: TemplatePatchInput,
  actorId: string
) {
  return withTransaction(async (tx) => {
    const row = await tx.videoTemplate.findUnique({ where: { id } });
    if (!row) throw errors.notFound("模板不存在");
    if (row.version !== input.version) throw errors.templateConflict();

    const before: Prisma.JsonObject = {
      displayName: row.displayName,
      englishName: row.englishName,
      description: row.description,
      cta: row.cta,
      tone: row.tone,
      sortOrder: row.sortOrder,
      version: row.version,
    };
    const data: Prisma.VideoTemplateUpdateInput = { version: { increment: 1 } };
    const keys: (keyof TemplatePatchInput)[] = [
      "displayName",
      "englishName",
      "description",
      "cta",
      "tone",
      "sortOrder",
    ];
    for (const key of keys) {
      if (input[key] !== undefined) {
        (data as Record<string, unknown>)[key] = input[key];
      }
    }
    data.updatedBy = actorId;
    data.updatedAt = new Date();

    const updated = await tx.videoTemplate.update({ where: { id }, data });
    await audit(tx, {
      templateId: id,
      actorUserId: actorId,
      action: "update_metadata",
      before,
      after: {
        displayName: updated.displayName,
        englishName: updated.englishName,
        description: updated.description,
        cta: updated.cta,
        tone: updated.tone,
        sortOrder: updated.sortOrder,
        version: updated.version,
      } as Prisma.InputJsonObject,
    });
    return {
      id: updated.id,
      version: updated.version,
      updatedAt: updated.updatedAt.toISOString(),
    };
  });
}

/** 批量调整排序：逐条带 version CAS 更新 + 审计，整批同事务（全成功或全回滚）。 */
export async function updateSortOrders(
  items: Array<{ id: string; sortOrder: number; version: number }>,
  actorId: string
) {
  return withTransaction(async (tx) => {
    const results: Array<{ id: string; version: number }> = [];
    for (const item of items) {
      const row = await tx.videoTemplate.findUnique({ where: { id: item.id } });
      if (!row) throw errors.notFound(`模板 ${item.id} 不存在`);
      if (row.version !== item.version) throw errors.templateConflict();
      const updated = await tx.videoTemplate.update({
        where: { id: item.id },
        data: {
          sortOrder: item.sortOrder,
          version: { increment: 1 },
          updatedBy: actorId,
          updatedAt: new Date(),
        },
      });
      await audit(tx, {
        templateId: item.id,
        actorUserId: actorId,
        action: "sort_order_changed",
        before: { sortOrder: row.sortOrder, version: row.version } as Prisma.InputJsonObject,
        after: { sortOrder: updated.sortOrder, version: updated.version } as Prisma.InputJsonObject,
      });
      results.push({ id: updated.id, version: updated.version });
    }
    return results;
  });
}

/** 启用：要求注册表命中 + 必填元数据完整。 */
export async function enableTemplate(id: string, actorId: string) {
  return withTransaction(async (tx) => {
    const row = await tx.videoTemplate.findUnique({ where: { id } });
    if (!row) throw errors.notFound("模板不存在");
    if (registryMissing(row.compositionId)) throw errors.templateNotRegistered();
    if (!row.displayName || !row.englishName) {
      throw errors.validation("请先补全展示名称（中文与英文）后再启用", {
        displayName: "展示名称（中文）必填",
        englishName: "展示名称（英文）必填",
      });
    }
    if (row.enabled) return { id, enabled: true, unchanged: true };

    await tx.videoTemplate.update({
      where: { id },
      data: {
        enabled: true,
        version: { increment: 1 },
        updatedBy: actorId,
        updatedAt: new Date(),
      },
    });
    await audit(tx, {
      templateId: id,
      actorUserId: actorId,
      action: "enabled",
      before: { enabled: false } as Prisma.InputJsonObject,
      after: { enabled: true } as Prisma.InputJsonObject,
    });
    return { id, enabled: true, unchanged: false };
  });
}

/** 停用：可渲染启用数必须 > 1；幂等（已停用的直接返回 unchanged）。 */
export async function disableTemplate(id: string, actorId: string, reason?: string) {
  return withTransaction(async (tx) => {
    const row = await tx.videoTemplate.findUnique({ where: { id } });
    if (!row) throw errors.notFound("模板不存在");
    if (!row.enabled) return { id, enabled: false, unchanged: true };

    // 守卫计数带注册命中条件（B3）：只有「可渲染」行才占用名额。
    if (!(await countRenderableEnabled(tx) > 1)) throw errors.templateLastEnabled();

    await tx.videoTemplate.update({
      where: { id },
      data: {
        enabled: false,
        version: { increment: 1 },
        updatedBy: actorId,
        updatedAt: new Date(),
      },
    });
    await audit(tx, {
      templateId: id,
      actorUserId: actorId,
      action: "disabled",
      before: { enabled: true } as Prisma.InputJsonObject,
      after: { enabled: false } as Prisma.InputJsonObject,
      reason,
    });
    return { id, enabled: false, unchanged: false };
  });
}

/** 缩略图上传：落盘后写库 + 审计同事务；失败清理文件由调用方在事务外处理。 */
export async function saveThumbnail(
  id: string,
  stored: { relativePath: string; mimeType: string; size: number },
  actorId: string
) {
  return withTransaction(async (tx) => {
    const row = await tx.videoTemplate.findUnique({ where: { id } });
    if (!row) throw errors.notFound("模板不存在");
    const updated = await tx.videoTemplate.update({
      where: { id },
      data: {
        thumbnailPath: stored.relativePath,
        version: { increment: 1 },
        updatedBy: actorId,
        updatedAt: new Date(),
      },
    });
    await audit(tx, {
      templateId: id,
      actorUserId: actorId,
      action: "thumbnail_uploaded",
      before: { thumbnailPath: row.thumbnailPath } as Prisma.InputJsonObject,
      after: {
        thumbnailPath: updated.thumbnailPath,
        mimeType: stored.mimeType,
        size: stored.size,
      } as Prisma.InputJsonObject,
    });
    return { path: updated.thumbnailPath, version: updated.version };
  });
}

/** 缩略图相对路径（供路由层落盘，统一走受控构造）。 */
export function thumbnailPathFor(id: string, storedName: string): string {
  return templateThumbnailRelativePath(id, storedName);
}

export interface SyncResult {
  created: Array<{ id: string; compositionId: string; name: string }>;
  skipped: string[];
  autoDisabled: Array<{ id: string; compositionId: string }>;
  errors: Array<{ compositionId: string; message: string }>;
}

/**
 * 从注册表同步（FR-08）：
 *  - 注册表有、DB 无 → 新增行（默认停用，展示元数据待补全）；
 *  - DB 有、注册表无且 enabled=true → 自动停用 + 写审计；
 *  - durationSec 不一致 → 以注册表为准回填 + 审计；
 *  全程不覆盖已编辑元数据；整批同事务。
 */
export async function syncRegistry(actorId: string): Promise<SyncResult> {
  return withTransaction(async (tx) => {
    const rows = await tx.videoTemplate.findMany();
    const byComposition = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!byComposition.has(row.compositionId)) byComposition.set(row.compositionId, row);
    }

    const result: SyncResult = { created: [], skipped: [], autoDisabled: [], errors: [] };

    for (const def of TEMPLATES) {
      const existing = byComposition.get(def.compositionId);
      if (!existing) {
        try {
          const created = await tx.videoTemplate.create({
            data: {
              name: def.name,
              category: def.category,
              compositionId: def.compositionId,
              durationSec: def.durationSec,
              config: {},
              enabled: false,
              sortOrder: 0,
              displayName: def.name,
            },
          });
          await audit(tx, {
            templateId: created.id,
            actorUserId: actorId,
            action: "sync_registered",
            after: {
              compositionId: created.compositionId,
              enabled: false,
            } as Prisma.InputJsonObject,
            reason: "从注册表同步新增（默认停用）",
          });
          result.created.push({
            id: created.id,
            compositionId: created.compositionId,
            name: def.name,
          });
        } catch (err) {
          result.errors.push({
            compositionId: def.compositionId,
            message: (err as Error).message,
          });
        }
      } else {
        result.skipped.push(def.compositionId);
        if (existing.durationSec !== def.durationSec) {
          await tx.videoTemplate.update({
            where: { id: existing.id },
            data: { durationSec: def.durationSec },
          });
          await audit(tx, {
            templateId: existing.id,
            actorUserId: actorId,
            action: "update_metadata",
            before: { durationSec: existing.durationSec } as Prisma.InputJsonObject,
            after: { durationSec: def.durationSec } as Prisma.InputJsonObject,
            reason: "同步注册表时长镜像",
          });
        }
      }
    }

    // DB 有、注册表无且启用：自动停用并写审计（B3 / TC-21）
    for (const row of rows) {
      if (registryMissing(row.compositionId) && row.enabled) {
        await tx.videoTemplate.update({
          where: { id: row.id },
          data: { enabled: false, updatedBy: actorId, updatedAt: new Date() },
        });
        await audit(tx, {
          templateId: row.id,
          actorUserId: actorId,
          action: "auto_disabled_registry_missing",
          before: { enabled: true } as Prisma.InputJsonObject,
          after: { enabled: false } as Prisma.InputJsonObject,
          reason: "注册表已移除该 Composition",
        });
        result.autoDisabled.push({
          id: row.id,
          compositionId: row.compositionId,
        });
      }
    }

    return result;
  });
}

/** 审计分页（模板维度）。 */
export async function listTemplateAudits(id: string, take: number, skip: number) {
  const template = await db.videoTemplate.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!template) throw errors.notFound("模板不存在");
  const [items, total] = await Promise.all([
    db.templateAuditLog.findMany({
      where: { templateId: id },
      take,
      skip,
      orderBy: { createdAt: "desc" },
    }),
    db.templateAuditLog.count({ where: { templateId: id } }),
  ]);
  return {
    items: items.map((a) => ({
      id: a.id,
      action: a.action,
      before: a.beforeJson,
      after: a.afterJson,
      reason: a.reason,
      actorUserId: a.actorUserId,
      createdAt: a.createdAt.toISOString(),
    })),
    total,
  };
}

/** 供静态守卫：所有模板写操作都必须经本模块的 withTransaction + audit。 */
export const ADMIN_TEMPLATE_WRITE_FNS = [
  updateTemplateMeta,
  updateSortOrders,
  enableTemplate,
  disableTemplate,
  saveThumbnail,
  syncRegistry,
] as const;

export type { TemplateId };
