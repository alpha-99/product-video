/**
 * 任务提交链路（方案 5.2 / 8.3）：校验 + 鉴权 + 幂等 + 事务。
 *
 * 提交时把「商品 + 文案 + 选项 + 模板 compositionId」合成一个已校验的
 * RenderJobInput 快照写入 input_json，Worker 处理时只读快照，不再回查商品，
 * 保证任务可复现、商品后续被编辑也不影响已提交的任务。
 *
 * 事务边界：扣额度（UPDATE ... WHERE quota_left >= 1）+ 建任务 + 写用量
 * 同城事务；额度不足抛 QUOTA_EXCEEDED，整单回滚。
 */
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db, findJobByIdempotencyKey, listUserJobs, findUserJob } from "./db";
import { toDomainProduct } from "./product-mapper";
import { consumeQuota } from "./billing";
import { errors } from "./errors";
import {
  buildVideoProps,
  getTemplate,
  type TemplateId,
} from "../shared/template.schema";
import { CreateVideoRequestSchema, JobStatus, type CreateVideoRequest } from "../shared/api";
import { RenderJobInputSchema, type RenderJobInput } from "../shared/render.schema";

export type VideoJobRecord = NonNullable<Awaited<ReturnType<typeof findUserJob>>>;

export interface CreateJobResult {
  job: VideoJobRecord;
  created: boolean;
}

/**
 * 提交生成任务。幂等键命中时返回既有任务（不重复扣额度）。
 * @returns job 与 created（是否本次新建）
 */
export async function createVideoJob(
  userId: string,
  request: CreateVideoRequest,
  idempotencyKey: string
): Promise<CreateJobResult> {
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw errors.validation("Idempotency-Key 缺失或过长");
  }

  // 幂等：同一用户相同键直接返回既有任务。
  const existing = await findJobByIdempotencyKey(userId, idempotencyKey);
  if (existing) return { job: existing, created: false };

  // 归属校验：商品必须是当前用户的；模板必须存在且启用。
  const productRow = await db.product.findFirst({
    where: { id: request.productId, userId },
  });
  if (!productRow) throw errors.notFound("商品不存在或不属于当前用户");

  const templateRow = await db.videoTemplate.findFirst({
    where: { id: request.templateId, enabled: true },
  });
  if (!templateRow) throw errors.notFound("模板不存在或已停用");

  const compositionId = templateRow.compositionId;
  // 只接受已注册的 compositionId，避免提交时写入无效快照。
  const template = getTemplate(compositionId);

  const product = toDomainProduct(productRow);
  const props = buildVideoProps({
    templateId: template.id as TemplateId,
    product,
    copy: request.copy,
    options: request.options,
  });

  const jobId = randomUUID();
  const input: RenderJobInput = {
    jobId,
    userId,
    compositionId: template.compositionId,
    props,
  };
  // 快照入事前再校验一次，保证 input_json 一定是合法 RenderJobInput。
  const snapshot = RenderJobInputSchema.parse(input);

  try {
    const job = await db.$transaction(async (tx) => {
      // usage_records.video_job_id 是指向 video_jobs 的外键，
      // 因此先建任务再扣额度并写流水；三者仍在同一事务，额度不足整单回滚。
      const createdJob = await tx.videoJob.create({
        data: {
          id: jobId,
          userId,
          productId: productRow.id,
          templateId: templateRow.id,
          status: JobStatus.PENDING,
          inputJson: snapshot as unknown as Prisma.InputJsonValue,
          idempotencyKey,
        },
      });
      await consumeQuota(tx, userId, createdJob.id);
      return createdJob;
    });
    return { job, created: true };
  } catch (err) {
    // 并发提交同一幂等键：唯一索引冲突时回读既有任务。
    if (err instanceof Error && /uq_jobs_idem|Unique constraint|P2002/i.test(err.message)) {
      const raced = await findJobByIdempotencyKey(userId, idempotencyKey);
      if (raced) return { job: raced, created: false };
    }
    throw err;
  }
}

/** 任务详情（强制 user_id 归属）。 */
export async function getVideoJob(userId: string, jobId: string) {
  const job = await findUserJob(userId, jobId);
  if (!job) throw errors.notFound("任务不存在或不属于当前用户");
  return job;
}

/** 任务列表（强制 user_id）。 */
export function listVideoJobs(userId: string, options: { take?: number; skip?: number } = {}) {
  return listUserJobs(userId, options);
}

/**
 * 纯函数：从渲染快照反解出「新建任务」所需的请求参数，便于单测且不依赖数据库。
 * 注意 props 里的 musicPath 在请求契约里叫 music，logoPath 同名，属于易错映射。
 */
export function createRequestFromSnapshot(input: {
  productId: string;
  templateId: string;
  snapshot: RenderJobInput;
}): CreateVideoRequest {
  const props = input.snapshot.props;
  return CreateVideoRequestSchema.parse({
    productId: input.productId,
    templateId: input.templateId,
    copy: {
      title: props.title,
      subtitle: props.subtitle,
      sellingPoints: props.sellingPoints,
      cta: props.cta,
    },
    options: {
      ...(props.brandColor ? { brandColor: props.brandColor } : {}),
      ...(props.logoPath ? { logoPath: props.logoPath } : {}),
      ...(props.musicPath ? { music: props.musicPath } : {}),
      ...(props.originalPrice ? { originalPrice: props.originalPrice } : {}),
      ...(props.discountText ? { discountText: props.discountText } : {}),
    },
  });
}

/**
 * C-06 / P1-3：已完成视频「以原参数新建任务」。
 *
 * 与 retry 的区别：retry 复用同一条 job（仅 failed / cancelled，先返还再占用）；
 * regenerate 读取原任务提交时写入的 input_json 快照，创建一条全新的 job，
 * 由 createVideoJob 的事务重新扣 1 额度并写 consume 流水。
 *
 * 参数一律来自服务端快照，绝不接受客户端传来的 copy / options，
 * 避免伪造参数或绕过归属校验；新幂等键由调用方提供以防重复提交重复扣费。
 */
export async function regenerateFromCompletedJob(
  userId: string,
  sourceJobId: string,
  idempotencyKey: string
): Promise<CreateJobResult> {
  const source = await findUserJob(userId, sourceJobId);
  if (!source) throw errors.notFound("任务不存在或不属于当前用户");
  if (source.status !== JobStatus.COMPLETED) {
    throw errors.validation("仅已完成的视频可按原参数重新生成");
  }

  const snapshot = RenderJobInputSchema.parse(source.inputJson);
  const request = createRequestFromSnapshot({
    productId: source.productId,
    templateId: source.templateId,
    snapshot,
  });
  return createVideoJob(userId, request, idempotencyKey);
}
