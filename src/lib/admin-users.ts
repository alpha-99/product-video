/**
 * 成员与角色服务层（方案 V1.0 §8.2 / §5 FR-13~FR-18）。
 *
 * 安全要点：
 *  - L1：入口与每次写入都查 users.role（requireAdmin / requireAdminInTx）；
 *  - L2：本模块只暴露 role="user" 的降权；唯一写 role="admin" 的路径是 approveGrant；
 *  - L3：禁改自己、提权前置 admin ≥2、降权后 ≥1、reason 必填；
 *  - L4：双人复核（requested_by ≠ reviewed_by，DB CHECK 兜底）、24h 过期、条件更新 count===1；
 *  - 角色变更 + 审计 + 关单在同一事务，写失败整笔回滚。
 *
 * PII 最小化：成员列表只返回 id/email/role/createdAt 四个字段；审计与日志只记 UUID + requestId，
 * 不记邮箱明文。
 */
import type { Prisma } from "@prisma/client";
import { db, withTransaction } from "./db";
import { errors } from "./errors";
import {
  assertCanRequestGrant,
  assertNotSelf,
  countAdmins,
  requireAdminInTx,
} from "./admin";
import type { UserListQuery } from "./admin-schemas";

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

/** 只读成员列表：4 个最小字段，精确 email 匹配 + role 筛选 + 分页。 */
export async function listUsers(query: UserListQuery) {
  const where: Prisma.UserWhereInput = {};
  if (query.email) where.email = query.email; // 精确匹配，不做 contains（Q6）
  if (query.role) where.role = query.role;
  const [rows, total] = await Promise.all([
    db.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true,
      },
      take: query.take,
      skip: query.skip,
      orderBy: { createdAt: "desc" },
    }),
    db.user.count({ where }),
  ]);
  return {
    items: rows.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt.toISOString(),
    })),
    total,
    take: query.take,
    skip: query.skip,
    adminCount: await countAdmins(),
  };
}

/** 角色变更审计分页（source=web/script 全量）。 */
export async function listRoleAudits(take: number, skip: number) {
  const [items, total] = await Promise.all([
    db.userRoleAuditLog.findMany({
      take,
      skip,
      orderBy: { createdAt: "desc" },
    }),
    db.userRoleAuditLog.count(),
  ]);
  return {
    items: items.map((a) => ({
      id: a.id,
      targetUserId: a.targetUserId,
      actorUserId: a.actorUserId,
      actorLabel: a.actorLabel,
      source: a.source,
      requestId: a.requestId,
      fromRole: a.fromRole,
      toRole: a.toRole,
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
    })),
    total,
  };
}

function roleAudit(
  tx: Prisma.TransactionClient,
  data: {
    targetUserId: string;
    actorUserId: string | null;
    actorLabel?: string;
    source: "web" | "script";
    requestId?: string;
    fromRole: string;
    toRole: string;
    reason?: string;
  }
) {
  return tx.userRoleAuditLog.create({
    data: {
      targetUserId: data.targetUserId,
      actorUserId: data.actorUserId,
      actorLabel: data.actorLabel ?? null,
      source: data.source,
      requestId: data.requestId ?? null,
      fromRole: data.fromRole,
      toRole: data.toRole,
      reason: data.reason?.slice(0, 500) ?? null,
    },
  });
}

/**
 * 提权申请列表：按 expires_at > now() 展示 pending，读取时批量把过期 pending 置 expired（D2）。
 * 不依赖定时任务；发起人仍可看到自己发起的（含 expired），但不可见「批准」操作（前端判定）。
 */
export async function listRoleRequests(actorId: string) {
  const now = new Date();
  return withTransaction(async (tx) => {
    await requireAdminInTx(tx, actorId);
    // 惰性置位：所有已过期但仍 pending 的单统一关为 expired。
    await tx.userRoleChangeRequest.updateMany({
      where: { status: "pending", expiresAt: { lte: now } },
      data: { status: "expired", decidedAt: now },
    });
    const rows = await tx.userRoleChangeRequest.findMany({
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        targetUserId: r.targetUserId,
        fromRole: r.fromRole,
        toRole: r.toRole,
        requestedBy: r.requestedBy,
        reason: r.reason,
        status: r.status,
        reviewedBy: r.reviewedBy,
        reviewReason: r.reviewReason,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        /** 前端据此隐藏「批准」按钮：发起人不可自批。 */
        canApprove: r.status === "pending" && r.requestedBy !== actorId,
      })),
      adminCount: await countAdmins(tx),
    };
  });
}

/** 发起提权申请：仅创建 pending 单，绝不直接写 role=admin。 */
export async function requestGrant(
  actorId: string,
  input: { targetUserId: string; reason: string }
) {
  return withTransaction(async (tx) => {
    await requireAdminInTx(tx, actorId);
    assertNotSelf(actorId, input.targetUserId); // L3：不能给自己申请
    await assertCanRequestGrant(tx); // L3：admin 数 ≥ 2

    const target = await tx.user.findUnique({
      where: { id: input.targetUserId },
      select: { id: true, role: true },
    });
    if (!target) throw errors.notFound("目标账号不存在");
    if (target.role !== "user") throw errors.validation("目标账号当前不是普通用户");

    // 同一 target 仅 1 条 pending（DB 部分唯一索引兜底，这里先给明确 409）。
    const dup = await tx.userRoleChangeRequest.findFirst({
      where: { targetUserId: input.targetUserId, status: "pending" },
      select: { id: true },
    });
    if (dup) throw errors.roleRequestConflict();

    const req = await tx.userRoleChangeRequest.create({
      data: {
        targetUserId: input.targetUserId,
        fromRole: "user",
        toRole: "admin",
        requestedBy: actorId,
        reason: input.reason,
        status: "pending",
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
      },
    });
    return {
      id: req.id,
      status: req.status,
      expiresAt: req.expiresAt.toISOString(),
    };
  });
}

/**
 * 批准提权：唯一能把 role 写成 admin 的 Web 路径（D1 条件更新 count===1）。
 * 复核时重查发起人/目标当前状态；审批人 ≠ 发起人；重复批准幂等返回、不重复写审计。
 */
export async function approveGrant(actorId: string, requestId: string) {
  return withTransaction(async (tx) => {
    await requireAdminInTx(tx, actorId);
    const req = await tx.userRoleChangeRequest.findUnique({ where: { id: requestId } });
    if (!req) throw errors.notFound("提权申请不存在");
    if (req.requestedBy === actorId) throw errors.roleApproverConflict();

    // 重复批准幂等：已 approved 且 reviewed_by === actor 时直接返回成功，不写第二条审计。
    if (req.status === "approved") {
      return { id: req.id, status: "approved", idempotent: true };
    }
    if (req.status !== "pending") throw errors.roleRequestConflict();
    if (req.expiresAt <= new Date()) throw errors.roleRequestExpired();

    // 复核时发起人必须仍为 admin（可能在此期间被撤权）。
    const requester = await tx.user.findUnique({
      where: { id: req.requestedBy },
      select: { role: true },
    });
    if (!requester || requester.role !== "admin") {
      throw errors.forbidden("发起人已失去管理员权限，该申请不再有效");
    }
    const target = await tx.user.findUnique({
      where: { id: req.targetUserId },
      select: { role: true },
    });
    if (!target || target.role !== "user" || req.toRole !== "admin") {
      throw errors.roleRequestConflict();
    }

    // D1：条件更新替代「先 assert 再 update」，消灭无锁窗口。
    const granted = await tx.user.updateMany({
      where: { id: req.targetUserId, role: "user" },
      data: { role: "admin" },
    });
    if (granted.count !== 1) throw errors.roleRequestConflict();

    await roleAudit(tx, {
      targetUserId: req.targetUserId,
      actorUserId: actorId,
      source: "web",
      requestId: req.id,
      fromRole: "user",
      toRole: "admin",
      reason: req.reason,
    });
    // 状态 CAS：并发批准仅一个成功（DB 唯一 pending 索引 + 此处 count 断言）。
    const closed = await tx.userRoleChangeRequest.updateMany({
      where: { id: req.id, status: "pending" },
      data: { status: "approved", reviewedBy: actorId, decidedAt: new Date() },
    });
    if (closed.count !== 1) throw errors.roleRequestConflict();

    return { id: req.id, status: "approved", idempotent: false };
  });
}

/** 驳回提权申请：reason 必填，仅 pending 可驳回，记 review_reason。 */
export async function rejectGrant(
  actorId: string,
  requestId: string,
  reason: string
) {
  return withTransaction(async (tx) => {
    await requireAdminInTx(tx, actorId);
    const req = await tx.userRoleChangeRequest.findUnique({ where: { id: requestId } });
    if (!req) throw errors.notFound("提权申请不存在");
    if (req.status !== "pending") throw errors.roleRequestConflict();
    const closed = await tx.userRoleChangeRequest.updateMany({
      where: { id: requestId, status: "pending" },
      data: {
        status: "rejected",
        reviewedBy: actorId,
        reviewReason: reason,
        decidedAt: new Date(),
      },
    });
    if (closed.count !== 1) throw errors.roleRequestConflict();
    return { id: requestId, status: "rejected" };
  });
}

/** 发起人撤回 pending 申请（Should）。 */
export async function cancelGrant(actorId: string, requestId: string) {
  return withTransaction(async (tx) => {
    await requireAdminInTx(tx, actorId);
    const req = await tx.userRoleChangeRequest.findUnique({ where: { id: requestId } });
    if (!req) throw errors.notFound("提权申请不存在");
    if (req.requestedBy !== actorId) throw errors.forbidden("只能撤回自己发起的申请");
    if (req.status !== "pending") throw errors.roleRequestConflict();
    await tx.userRoleChangeRequest.update({
      where: { id: requestId },
      data: { status: "cancelled", decidedAt: new Date() },
    });
    return { id: requestId, status: "cancelled" };
  });
}

/** 降权：仅 role=user；禁改自己；admin 数 ≥1 条件更新；审计与更新同事务。 */
export async function revokeAdmin(
  actorId: string,
  targetUserId: string,
  reason: string
) {
  return withTransaction(async (tx) => {
    await requireAdminInTx(tx, actorId);
    assertNotSelf(actorId, targetUserId);
    const target = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { role: true },
    });
    if (!target) throw errors.notFound("目标账号不存在");
    if (target.role !== "admin") throw errors.validation("目标账号当前不是管理员");
    if (await countAdmins(tx) < 2) throw errors.roleLastAdmin();

    // 条件更新：并发互相撤销时先到者生效，后到者 count===0 → 409。
    const demoted = await tx.user.updateMany({
      where: { id: targetUserId, role: "admin" },
      data: { role: "user" },
    });
    if (demoted.count !== 1) throw errors.roleLastAdmin();

    await roleAudit(tx, {
      targetUserId,
      actorUserId: actorId,
      source: "web",
      fromRole: "admin",
      toRole: "user",
      reason,
    });
    return { id: targetUserId, role: "user" };
  });
}

/** 静态守卫辅助：唯一写 role=admin 的 Web 函数是 approveGrant。 */
export const ROLE_WRITE_FUNCTIONS = { revoke: revokeAdmin, approve: approveGrant } as const;
