/**
 * AI 文案编排（方案 6 章）。
 *
 * 一条链路做四件事，顺序不能变：
 *   缓存命中 → 调用（重试 + 主备切换）→ 校验/截断 → 回写缓存 + 记用量
 *
 * 关键约定：
 *   - 校验失败也算一次失败尝试，必须重试；绝不把非法文案返回给前端。
 *   - 超长字段按 COPY_LIMITS 截断后再校验，避免版式溢出，也不为「多了 3 个字」
 *     白烧一次调用。
 *   - 全部尝试失败抛 AI_UNAVAILABLE，**不扣额度**（AI 调用本就不扣额度，
 *     只记 amount=0 的流水），前端据此降级为手工填写。
 *   - 缓存键不含 user_id：文案只由商品内容 + prompt 版本 + 模型决定，
 *     跨用户复用不会泄漏任何用户数据。
 */
import { createHash } from "node:crypto";
import process from "node:process";
import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { errors } from "../errors";
import { COPY_LIMITS, CopySchema, type Copy } from "../../shared/copy.schema";
import type { AiProductInput } from "../../shared/product.schema";
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import {
  AiProviderError,
  createOpenAiProvider,
  readAiConfig,
  type AiProvider,
} from "./client";

/** 缓存 TTL（方案 6.2 建议 24h）。 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 首次 + 重试 2 次 = 总尝试上限 3 次（方案 6.2）。 */
export const MAX_ATTEMPTS = 3;
/** 指数退避，与方案 6.2 的 1s / 2s 对齐。 */
const BACKOFF_MS = [1_000, 2_000];

export interface GenerateCopyResult {
  copy: Copy;
  /** 命中的模型；缓存读出的地方保留原模型，历史数据缺失时为 null。 */
  model: string | null;
  cached: boolean;
  /** 被截断的字段说明，需透传给用户，避免「文案悄悄变短」（验收 P2-03）。 */
  truncated: string[];
}

export interface CopyAttempt {
  copy: Copy;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** 实际消耗的尝试次数，从 1 开始。 */
  attempts: number;
  latencyMs: number;
  truncated: string[];
}

/** 只保留 Schema 关心的字段，并去掉 undefined / 空数组，保证缓存键稳定。 */
function canonicalInput(input: AiProductInput) {
  const sellingPoints = (input.sellingPoints ?? []).map((p) => p.trim()).filter(Boolean);
  return {
    productName: input.productName.trim(),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.price?.trim() ? { price: input.price.trim() } : {}),
    ...(sellingPoints.length ? { sellingPoints } : {}),
  };
}

/**
 * 缓存键 = sha256(prompt 版本 + 模型列表 + 规范化商品内容)。
 * 模型列表参与计算：切换模型后的结果不应被旧缓存命中。
 */
export function computeCacheKey(input: AiProductInput, models: string[]): string {
  const payload = JSON.stringify({
    v: PROMPT_VERSION,
    models,
    input: canonicalInput(input),
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** 从模型输出里取出 JSON 对象：容忍代码围栏、前后解释文字。 */
export function parseJsonObject(text: string): unknown {
  const cleaned = text
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // 模型偶尔会写「好的，文案如下：{...}」。取首尾花括号再试一次。
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 按 Unicode 码点截断，避免把 emoji / 中文代理对切坏。 */
function clamp(value: string, max: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("");
}

/**
 * 把模型输出修成合法文案：超长截断、去空卖点、卖点超 5 条丢弃多余部分。
 * 修不出来（字段缺失/类型错误/正文为空）返回 null，交给上层重试。
 */
export function normalizeCopy(raw: unknown): Copy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const videoTitle =
    typeof record.videoTitle === "string" ? clamp(record.videoTitle, COPY_LIMITS.videoTitle) : "";
  const subtitle =
    typeof record.subtitle === "string" ? clamp(record.subtitle, COPY_LIMITS.subtitle) : "";
  const cta = typeof record.cta === "string" ? clamp(record.cta, COPY_LIMITS.cta) : "";

  const sellingPoints = (Array.isArray(record.sellingPoints) ? record.sellingPoints : [])
    .filter((point): point is string => typeof point === "string")
    .map((point) => clamp(point, COPY_LIMITS.sellingPointLength))
    .filter((point) => point.length > 0)
    .slice(0, COPY_LIMITS.sellingPointCount);

  const parsed = CopySchema.safeParse({ videoTitle, subtitle, sellingPoints, cta });
  return parsed.success ? parsed.data : null;
}

/**
 * 找出模型原始输出里被 clamp 截断的字段（验收 P2-03）。
 * normalizeCopy 保持纯 Copy 返回不变，截断说明由这里单独产出并随响应下发。
 */
export function collectTruncationNotes(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  const notes: string[] = [];
  const check = (value: unknown, max: number, label: string) => {
    if (typeof value === "string" && Array.from(value.trim()).length > max) {
      notes.push(`${label} 超过 ${max} 字，已截断`);
    }
  };

  check(record.videoTitle, COPY_LIMITS.videoTitle, "标题");
  check(record.subtitle, COPY_LIMITS.subtitle, "副标题");
  check(record.cta, COPY_LIMITS.cta, "行动号召");
  if (Array.isArray(record.sellingPoints)) {
    if (record.sellingPoints.length > COPY_LIMITS.sellingPointCount) {
      notes.push(`卖点超过 ${COPY_LIMITS.sellingPointCount} 个，已只保留前 ${COPY_LIMITS.sellingPointCount} 个`);
    }
    record.sellingPoints
      .slice(0, COPY_LIMITS.sellingPointCount)
      .forEach((point, index) => check(point, COPY_LIMITS.sellingPointLength, `卖点${index + 1}`));
  }
  return notes;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 按上游状态给出可执行的降级文案，不再把所有失败都说成「AI 不可用请手填」。 */
export function aiFailureMessage(
  status: number | undefined,
  reason: string,
  retryAfterMs?: number
): string {
  if (status === 401 || status === 403) {
    return "AI 服务密钥或权限配置有误，请联系管理员；可先手工填写文案";
  }
  if (status === 404) {
    return "AI 模型不存在或已下线，请联系管理员检查配置；可先手工填写文案";
  }
  if (status === 429) {
    const seconds = retryAfterMs ? Math.ceil(retryAfterMs / 1000) : null;
    return `AI 服务请求过于频繁${seconds ? `，请 ${seconds} 秒后重试` : "，请稍后重试"}，也可先手工填写文案`;
  }
  return `文案生成服务暂时不可用（${reason}），请稍后重试或手工填写`;
}

/**
 * 纯调用逻辑（不碰数据库，便于单测）：重试 + 主备模型轮换 + 校验。
 * 第 n 次尝试用 models[n % models.length]，即主模型 → 备用模型 → 主模型。
 * 上游 429/503 带 Retry-After 时按下发值退避，并把等待时间随错误传给前端。
 */
export async function requestCopy(
  input: AiProductInput,
  provider: AiProvider,
  models: string[],
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<CopyAttempt> {
  if (!models.length) throw errors.aiUnavailable("没有可用的 AI 模型配置");

  const user = buildUserPrompt(input);
  let lastReason = "AI 文案生成失败";
  let lastStatus: number | undefined;
  let lastRetryAfterMs: number | undefined;
  let nextBackoffMs: number | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(nextBackoffMs ?? BACKOFF_MS[attempt - 1] ?? 2_000);
      nextBackoffMs = undefined;
    }

    const model = models[attempt % models.length];
    const startedAt = Date.now();

    try {
      const completion = await provider.complete({ model, system: SYSTEM_PROMPT, user });
      const raw = parseJsonObject(completion.content);
      const copy = normalizeCopy(raw);
      if (!copy) {
        lastReason = "AI 输出未通过文案 Schema 校验";
        continue;
      }
      return {
        copy,
        model: completion.model,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        attempts: attempt + 1,
        latencyMs: Date.now() - startedAt,
        truncated: collectTruncationNotes(raw),
      };
    } catch (error) {
      if (error instanceof AiProviderError) {
        lastReason = error.message;
        lastStatus = error.status;
        if (error.retryAfterMs) {
          lastRetryAfterMs = error.retryAfterMs;
          nextBackoffMs = Math.min(Math.max(error.retryAfterMs, BACKOFF_MS[0]), 60_000);
        }
        // 密钥/权限问题换模型也没用，立即终止，不浪费剩余尝试。
        if (!error.retryable) break;
      } else {
        lastReason = error instanceof Error ? error.message : String(error);
      }
    }
  }

  throw errors.aiUnavailable(
    aiFailureMessage(lastStatus, lastReason, lastRetryAfterMs),
    lastRetryAfterMs
  );
}

async function readCache(cacheKey: string): Promise<{ copy: Copy; model: string | null } | null> {
  // 缓存是优化不是主链路：数据库抖动时按未命中处理，继续调模型，不让用户拿 500。
  let row;
  try {
    row = await db.aiCopyCache.findUnique({ where: { cacheKey } });
  } catch (error) {
    console.warn("[ai-copy] 缓存读取失败，按未命中处理", error instanceof Error ? error.message : error);
    return null;
  }
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;

  // 缓存可能被历史版本写入过，读出后仍要过一遍 Schema；不合法就当未命中。
  const parsed = CopySchema.safeParse(row.payload);
  if (!parsed.success) return null;
  return { copy: parsed.data, model: row.model ?? null };
}

/** 缓存/用量写失败不影响本次文案返回，只记 warn，避免用户白等一次调用。 */
async function writeCache(cacheKey: string, copy: Copy, model: string): Promise<void> {
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
  try {
    await db.aiCopyCache.upsert({
      where: { cacheKey },
      update: { payload: copy, model, source: "model", createdAt: new Date(), expiresAt },
      create: { cacheKey, payload: copy, model, source: "model", expiresAt },
    });
  } catch (error) {
    console.warn("[ai-copy] 缓存写入失败", error instanceof Error ? error.message : error);
  }
}

/**
 * 费用估算（方案 6.2 成本监控）：单价随供应商调整，只从环境变量读取，
 * 不写死数字；未配置单价时 meta 里不带 costUsd，不影响调用。
 */
function estimateCostUsd(promptTokens: number, completionTokens: number): number | undefined {
  const inputPrice = Number(process.env.AI_PRICE_INPUT_PER_1K);
  const outputPrice = Number(process.env.AI_PRICE_OUTPUT_PER_1K);
  if (!(inputPrice > 0) || !(outputPrice > 0)) return undefined;

  const cost = (promptTokens / 1_000) * inputPrice + (completionTokens / 1_000) * outputPrice;
  return Number(cost.toFixed(6));
}

async function writeUsage(
  userId: string,
  attempt: CopyAttempt,
  meta: { cached: boolean }
): Promise<void> {
  const costUsd = estimateCostUsd(attempt.promptTokens, attempt.completionTokens);
  const payload: Prisma.InputJsonValue = {
    model: attempt.model,
    promptTokens: attempt.promptTokens,
    completionTokens: attempt.completionTokens,
    totalTokens: attempt.promptTokens + attempt.completionTokens,
    ...(costUsd === undefined ? {} : { costUsd }),
    attempts: attempt.attempts,
    latencyMs: attempt.latencyMs,
    promptVersion: PROMPT_VERSION,
    cached: meta.cached,
  };
  try {
    await db.usageRecord.create({
      data: { userId, usageType: "ai_call", amount: 0, meta: payload },
    });
  } catch (error) {
    console.warn("[ai-copy] 用量记录写入失败", error instanceof Error ? error.message : error);
  }
}

export interface GenerateCopyOptions {
  /** 测试注入假 Provider；与 models 同时提供时不再读环境变量。 */
  provider?: AiProvider;
  models?: string[];
  sleep?: (ms: number) => Promise<void>;
}

/** 解析依赖：测试注入优先，否则读环境变量（缺配置转 AI_UNAVAILABLE）。 */
function resolveDeps(options: GenerateCopyOptions): { provider: AiProvider; models: string[] } {
  if (options.provider && options.models?.length) {
    return { provider: options.provider, models: options.models };
  }

  let config;
  try {
    config = readAiConfig();
  } catch (error) {
    if (error instanceof AiProviderError) throw errors.aiUnavailable(error.message);
    throw error;
  }

  return {
    provider: options.provider ?? createOpenAiProvider(config),
    models: options.models?.length ? options.models : config.models,
  };
}

/**
 * 生成商品文案：缓存 → 调用 → 回写缓存 + 记用量。
 * AI 调用不扣额度（额度只在提交视频任务时扣），因此这里没有事务。
 */
export async function generateCopy(
  userId: string,
  input: AiProductInput,
  options: GenerateCopyOptions = {}
): Promise<GenerateCopyResult> {
  const { provider, models } = resolveDeps(options);

  const cacheKey = computeCacheKey(input, models);
  const hit = await readCache(cacheKey);
  if (hit) return { copy: hit.copy, model: hit.model, cached: true, truncated: [] };

  const attempt = await requestCopy(input, provider, models, options.sleep);
  await writeCache(cacheKey, attempt.copy, attempt.model);
  await writeUsage(userId, attempt, { cached: false });
  return {
    copy: attempt.copy,
    model: attempt.model,
    cached: false,
    truncated: attempt.truncated,
  };
}
