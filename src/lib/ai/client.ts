/**
 * AI Provider 客户端（方案 6.2）。
 *
 * 只对接 OpenAI 兼容的 `/chat/completions`，不引入 SDK：
 *   1. 密钥只从服务端环境变量读取，绝不下发前端；
 *   2. 强制 JSON mode（response_format=json_object），但拿到文本后仍由上层
 *      用 Zod 二次校验 —— JSON mode 只保证可解析，不保证符合 Schema；
 *   3. 错误分「可重试」与「致命」两类：401/403 是密钥问题，换模型重试无意义，
 *      直接失败；超时/网络/429/5xx/模型不存在才允许重试。
 */
import process from "node:process";

/** Provider 调用错误；retryable 决定上层是否继续消耗重试次数。 */
export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    /** 上游 Retry-After 折算出的等待时间（毫秒）。 */
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export interface AiCompletionRequest {
  model: string;
  system: string;
  user: string;
}

export interface AiCompletion {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/** 供测试注入假实现，生产环境用 createOpenAiProvider。 */
export interface AiProvider {
  complete(request: AiCompletionRequest): Promise<AiCompletion>;
}

export interface AiProviderConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** 主模型在前、备用模型在后；去重后至少 1 个。 */
  models: string[];
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 读取并校验 AI 配置。缺密钥/缺模型抛不可重试错误，由上层转 AI_UNAVAILABLE，
 * 前端据此走「手工填写文案」的降级路径。
 */
export function readAiConfig(
  env: Record<string, string | undefined> = process.env
): AiProviderConfig {
  const apiKey = env.AI_API_KEY?.trim();
  const models = Array.from(
    new Set([env.AI_MODEL?.trim(), env.AI_FALLBACK_MODEL?.trim()].filter(Boolean) as string[])
  );

  if (!apiKey) throw new AiProviderError("未配置 AI_API_KEY，无法生成文案", false);
  if (!models.length) throw new AiProviderError("未配置 AI_MODEL，无法生成文案", false);

  const timeoutRaw = Number(env.AI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw >= 1_000 ? timeoutRaw : DEFAULT_TIMEOUT_MS;

  return {
    apiKey,
    baseUrl: (env.AI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    timeoutMs,
    models,
  };
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** 解析标准 Retry-After（秒数或 HTTP 日期），上限 60s 防止上游误配拖死请求。 */
export function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1000), 60_000);
  }
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000);
  return undefined;
}

/** 关闭响应体，避免 keep-alive 连接悬挂；读取失败不影响错误上报。 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return "";
  }
}

export function createOpenAiProvider(
  config: AiProviderConfig,
  fetchImpl: typeof fetch = fetch
): AiProvider {
  return {
    async complete({ model, system, user }) {
      const url = `${config.baseUrl}/chat/completions`;
      let response: Response;

      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: 0.7,
            max_tokens: 500,
            response_format: { type: "json_object" },
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        // 网络错误 / DNS / 超时（AbortSignal.timeout 抛 TimeoutError）都可重试。
        const reason = error instanceof Error ? error.message : String(error);
        throw new AiProviderError(`AI 请求失败：${reason}`, true);
      }

      if (!response.ok) {
        const detail = await readErrorBody(response);
        // 401/403 是密钥或权限问题，换模型重试只会再烧 3 次请求。
        const fatal = response.status === 401 || response.status === 403;
        const retryAfterMs =
          response.status === 429 || response.status === 503
            ? parseRetryAfter(response.headers.get("retry-after"))
            : undefined;
        throw new AiProviderError(
          `AI 服务返回 ${response.status}${detail ? `：${detail}` : ""}`,
          !fatal,
          response.status,
          retryAfterMs
        );
      }

      let body: ChatCompletionResponse;
      try {
        body = (await response.json()) as ChatCompletionResponse;
      } catch {
        throw new AiProviderError("AI 响应不是合法 JSON", true);
      }

      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new AiProviderError("AI 返回内容为空", true);
      }

      return {
        content,
        model: body.model?.trim() || model,
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
      };
    },
  };
}
