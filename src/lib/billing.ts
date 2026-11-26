/**
 * 额度账本：扣减与返还的唯一实现，供任务提交、重试、失败/取消共用。
 * 约定：consume 记 +1，refund 记 -1；全部在调用方事务内执行。
 */
import type { Prisma } from "@prisma/client";
import { errors } from "./errors";

/**
 * 原子扣 1 额度；不足抛 QUOTA_EXCEEDED，整笔事务回滚。
 * videoJobId 写入流水，使扣费与返还能按任务成对核对（验收 P2-10）。
 */
export async function consumeQuota(
  tx: Prisma.TransactionClient,
  userId: string,
  videoJobId?: string
): Promise<void> {
  const updated = await tx.user.updateMany({
    where: { id: userId, quotaLeft: { gte: 1 } },
    data: { quotaLeft: { decrement: 1 } },
  });
  if (updated.count === 0) throw errors.quotaExceeded();
  await tx.usageRecord.create({
    data: {
      userId,
      ...(videoJobId ? { videoJobId } : {}),
      usageType: "consume",
      amount: 1,
    },
  });
}

/** 返还 1 额度并写 refund 流水；调用方必须先用状态守卫确保只返一次。 */
export async function refundJobQuota(
  tx: Prisma.TransactionClient,
  jobId: string,
  userId: string
): Promise<void> {
  await tx.user.update({
    where: { id: userId },
    data: { quotaLeft: { increment: 1 } },
  });
  await tx.usageRecord.create({
    data: { userId, videoJobId: jobId, usageType: "refund", amount: -1 },
  });
}
