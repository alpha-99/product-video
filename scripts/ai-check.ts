/**
 * AI 配置自检：不依赖数据库，验证「密钥 → 地址 → 模型 → 真实出稿」四步。
 *
 *   npm run ai:check              # 只查配置与模型列表
 *   npm run ai:check -- --generate # 再跑一次真实文案生成（会产生 token 费用）
 *
 * 用途：换供应商（OpenAI / DeepSeek / 通义 / 智谱等）后，先确认 AI_MODEL
 * 是不是该 key 下真实可用的模型 id，避免运行时才 404/401。
 */
import process from "node:process";
import "../src/lib/env";
import { AiProviderError, createOpenAiProvider, readAiConfig } from "../src/lib/ai/client";
import { requestCopy } from "../src/lib/ai/copy";

const SAMPLE = {
  productName: "轻润保湿面霜 50g",
  description: "质地轻盈，早晚可用，适合干性与混合性肌肤",
  sellingPoints: ["轻盈不黏", "长效保湿"],
  price: "129.00",
};

function mask(key: string): string {
  if (key.length <= 12) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    fail(`无法访问 ${baseUrl}/models：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    fail(
      `${baseUrl}/models 返回 ${response.status}：${detail}\n` +
        "  401/403 → AI_API_KEY 不对或不属于该服务商；404 → AI_BASE_URL 少了/多了 /v1。"
    );
  }

  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? [])
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id))
    .sort();
}

async function main(): Promise<void> {
  let config;
  try {
    config = readAiConfig();
  } catch (error) {
    if (error instanceof AiProviderError) fail(`${error.message}（检查 .env.local）`);
    fail(error instanceof Error ? error.message : String(error));
  }

  console.log("配置：");
  console.log(`  地址  ${config.baseUrl}`);
  console.log(`  密钥  ${mask(config.apiKey)}`);
  console.log(`  模型  ${config.models.join(" → ")}（${config.timeoutMs}ms 超时）`);

  const models = await listModels(config.baseUrl, config.apiKey);
  console.log(`\n该 key 可用模型（${models.length} 个）：`);
  console.log(`  ${models.slice(0, 40).join(", ")}${models.length > 40 ? " …" : ""}`);

  const missing = config.models.filter((model) => models.length > 0 && !models.includes(model));
  if (missing.length) {
    console.warn(`\n⚠ 以下模型不在可用列表里，调用会失败：${missing.join(", ")}`);
    console.warn("  把 AI_MODEL 改成上面列表中的 id（如 deepseek-chat / gpt-4o-mini）。");
  } else {
    console.log("\n✓ AI_MODEL 在可用列表中");
  }

  if (!process.argv.includes("--generate")) {
    console.log("\n（加 --generate 可跑一次真实文案生成，验证结构化输出）");
    return;
  }

  console.log("\n生成示例文案…");
  try {
    const result = await requestCopy(
      SAMPLE,
      createOpenAiProvider(config),
      config.models
    );
    console.log(JSON.stringify(result.copy, null, 2));
    console.log(
      `ok model=${result.model} attempts=${result.attempts} tokens=${result.promptTokens}+${result.completionTokens} ${result.latencyMs}ms`
    );
  } catch (error) {
    fail(`生成失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

void main();
