import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import "../src/lib/env";
import {
  MAX_ATTEMPTS,
  computeCacheKey,
  normalizeCopy,
  parseJsonObject,
  requestCopy,
} from "../src/lib/ai/copy";
import { AiProviderError, createOpenAiProvider, readAiConfig, type AiProvider } from "../src/lib/ai/client";
import { hitRateLimit, resetRateLimits } from "../src/lib/rate-limit";
import { DomainError } from "../src/lib/errors";

/**
 * 阶段七 AI 文案测试。
 * 纯函数与重试逻辑不打网；接口用例用本地 HTTP 假 Provider（OpenAI 兼容），
 * 走真实 fetch + 真实 DB，验证缓存命中与 ai_call 用量落库。
 */
const hasDb = Boolean(process.env.DATABASE_URL);
const pool = hasDb
  ? new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 })
  : null;
const userId = randomUUID();
const otherUserId = randomUUID();
const productId = randomUUID();
const MODEL = "test-model";

const VALID_COPY = {
  videoTitle: "水润面霜 日常保湿",
  subtitle: "轻盈好吸收，早晚可用",
  sellingPoints: ["轻盈不黏", "长效保湿"],
  cta: "立即选购",
};

const INPUT = {
  productName: "水润面霜",
  description: "日常保湿",
  sellingPoints: ["保湿"],
  price: "29.99",
};

function stubProvider(
  handler: (call: number) => Promise<{ content: string }> | { content: string }
): AiProvider & { calls: number } {
  const provider = {
    calls: 0,
    async complete() {
      provider.calls += 1;
      const { content } = await handler(provider.calls);
      return { content, model: MODEL, promptTokens: 10, completionTokens: 5 };
    },
  };
  return provider;
}

const noSleep = async () => {};

describe("AI 文案纯函数（阶段七）", () => {
  it("缓存键对字段顺序与首尾空白不敏感，随价格/模型变化", () => {
    const a = computeCacheKey(INPUT, [MODEL]);
    const b = computeCacheKey(
      { price: " 29.99 ", sellingPoints: [" 保湿 "], description: "日常保湿", productName: " 水润面霜 " },
      [MODEL]
    );
    assert.equal(a, b);
    assert.equal(a.length, 64);
    assert.notEqual(a, computeCacheKey({ ...INPUT, price: "30.00" }, [MODEL]));
    assert.notEqual(a, computeCacheKey(INPUT, ["another-model"]));
    // 空卖点与缺省卖点等价，避免同一商品因空数组产生两份缓存
    assert.equal(
      computeCacheKey({ productName: "A", sellingPoints: [] }, [MODEL]),
      computeCacheKey({ productName: "A" }, [MODEL])
    );
  });

  it("JSON 解析容忍代码围栏与前后解释文字", () => {
    const json = JSON.stringify(VALID_COPY);
    assert.deepEqual(parseJsonObject(json), VALID_COPY);
    assert.deepEqual(parseJsonObject("```json\n" + json + "\n```"), VALID_COPY);
    assert.deepEqual(parseJsonObject("好的，文案如下：" + json + " 希望有帮助"), VALID_COPY);
    assert.equal(parseJsonObject("完全不是 JSON"), null);
  });

  it("超长/超量字段被截断到 COPY_LIMITS，空字段判为非法", () => {
    const copy = normalizeCopy({
      videoTitle: "标".repeat(100),
      subtitle: "副".repeat(120),
      sellingPoints: ["卖".repeat(60), "  ", 123, "第二点", "第三点", "第四点", "第五点", "第六点"],
      cta: "购".repeat(30),
    });
    assert.ok(copy);
    assert.equal(Array.from(copy.videoTitle).length, 60);
    assert.equal(Array.from(copy.subtitle).length, 80);
    assert.equal(Array.from(copy.cta).length, 20);
    assert.equal(copy.sellingPoints.length, 5);
    assert.equal(Array.from(copy.sellingPoints[0]).length, 40);

    assert.equal(normalizeCopy({ videoTitle: "标题", subtitle: "副标题", sellingPoints: ["点"] }), null);
    assert.equal(normalizeCopy(null), null);
    assert.equal(normalizeCopy([]), null);
  });
});

describe("AI 调用重试与降级（方案 6.2）", () => {
  it("首次输出非法 JSON，第二次成功：只重试一次且不重复扣时", async () => {
    const delays: number[] = [];
    const provider = stubProvider((call) =>
      call === 1 ? { content: "抱歉，我无法输出" } : { content: JSON.stringify(VALID_COPY) }
    );

    const result = await requestCopy(INPUT, provider, [MODEL], async (ms) => {
      delays.push(ms);
    });

    assert.equal(provider.calls, 2);
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.copy, VALID_COPY);
    assert.deepEqual(delays, [1_000]);
  });

  it("连续失败按 1s/2s 退避，用尽 3 次后抛 AI_UNAVAILABLE", async () => {
    const delays: number[] = [];
    const provider = stubProvider(() => {
      throw new AiProviderError("upstream 503", true, 503);
    });

    await assert.rejects(
      requestCopy(INPUT, provider, [MODEL], async (ms) => {
        delays.push(ms);
      }),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "AI_UNAVAILABLE" &&
        error.message.includes("upstream 503")
    );

    assert.equal(provider.calls, MAX_ATTEMPTS);
    assert.deepEqual(delays, [1_000, 2_000]);
  });

  it("主模型失败后切备用模型，最终用备用模型成功", async () => {
    const used: string[] = [];
    const provider: AiProvider = {
      async complete({ model }) {
        used.push(model);
        if (model === "primary") throw new AiProviderError("primary 超时", true);
        return { content: JSON.stringify(VALID_COPY), model, promptTokens: 1, completionTokens: 1 };
      },
    };

    const result = await requestCopy(INPUT, provider, ["primary", "backup"], noSleep);
    assert.deepEqual(used, ["primary", "backup"]);
    assert.equal(result.model, "backup");
    assert.equal(result.attempts, 2);
  });

  it("密钥类错误（不可重试）立即终止，不浪费剩余尝试", async () => {
    const provider = stubProvider(() => {
      throw new AiProviderError("AI 服务返回 401", false, 401);
    });

    await assert.rejects(
      requestCopy(INPUT, provider, [MODEL], noSleep),
      (error: unknown) => error instanceof DomainError && error.code === "AI_UNAVAILABLE"
    );
    assert.equal(provider.calls, 1);
  });
});

describe("AI 文案限流（方案 5.2）", () => {
  beforeEach(() => resetRateLimits());

  it("每用户 10 次/分钟，窗口到期后重置", () => {
    const user = "user-a";
    for (let i = 0; i < 10; i += 1) {
      assert.equal(hitRateLimit(user, 10, 60_000, 1_000).allowed, true);
    }
    const blocked = hitRateLimit(user, 10, 60_000, 1_000);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);

    // 不同用户互不影响
    assert.equal(hitRateLimit("user-b", 10, 60_000, 1_000).allowed, true);
    // 窗口过期后恢复
    assert.equal(hitRateLimit(user, 10, 60_000, 61_001).allowed, true);
  });
});

describe("AI Provider 客户端（本地假服务，不依赖数据库）", () => {
  let server: Server;
  let baseUrl: string;
  let lastRequest: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
  let nextStatus = 200;

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        lastRequest = {
          url: req.url,
          auth: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
        };
        if (nextStatus !== 200) {
          res.writeHead(nextStatus, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "boom" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: "real-model-name",
            choices: [{ message: { content: JSON.stringify(VALID_COPY) } }],
            usage: { prompt_tokens: 12, completion_tokens: 34 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("假服务启动失败");
    baseUrl = `http://127.0.0.1:${address.port}/v1/`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  const provider = () =>
    createOpenAiProvider({
      apiKey: "sk-test",
      baseUrl: baseUrl.replace(/\/+$/, ""),
      timeoutMs: 5_000,
      models: ["m1"],
    });

  it("请求 OpenAI 兼容契约：路径、鉴权头、JSON mode、usage 解析", async () => {
    nextStatus = 200;
    const completion = await provider().complete({
      model: "m1",
      system: "SYS",
      user: "USER",
    });

    assert.equal(lastRequest.url, "/v1/chat/completions");
    assert.equal(lastRequest.auth, "Bearer sk-test");
    assert.equal(lastRequest.body?.model, "m1");
    assert.deepEqual(lastRequest.body?.response_format, { type: "json_object" });
    assert.deepEqual(lastRequest.body?.messages, [
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);

    assert.deepEqual(JSON.parse(completion.content), VALID_COPY);
    assert.equal(completion.model, "real-model-name");
    assert.equal(completion.promptTokens, 12);
    assert.equal(completion.completionTokens, 34);
  });

  it("401 判为不可重试，5xx 判为可重试", async () => {
    nextStatus = 401;
    await assert.rejects(
      provider().complete({ model: "m1", system: "s", user: "u" }),
      (error: unknown) => error instanceof AiProviderError && error.retryable === false
    );

    nextStatus = 500;
    await assert.rejects(
      provider().complete({ model: "m1", system: "s", user: "u" }),
      (error: unknown) => error instanceof AiProviderError && error.retryable === true
    );
    nextStatus = 200;
  });

  it("缺密钥/缺模型、备用模型去重由配置层兜底", () => {
    assert.throws(
      () => readAiConfig({ AI_MODEL: "m1" }),
      (error: unknown) => error instanceof AiProviderError && error.retryable === false
    );
    assert.throws(
      () => readAiConfig({ AI_API_KEY: "k" }),
      (error: unknown) => error instanceof AiProviderError && !error.retryable
    );

    const config = readAiConfig({
      AI_API_KEY: " k ",
      AI_MODEL: "m1",
      AI_FALLBACK_MODEL: "m1",
      AI_BASE_URL: "",
    });
    assert.deepEqual(config.models, ["m1"]);
    assert.equal(config.baseUrl, "https://api.openai.com/v1");
    assert.equal(config.timeoutMs, 20_000);
  });
});

describe("AI 文案接口（真库 + 假 Provider）", { skip: !hasDb }, () => {
  let server: Server;
  let route: typeof import("../src/app/api/ai/copy/route");
  let providerCalls = 0;
  /** Supabase 直连域名可能只解析出 IPv6；不可达时整组跳过而不是报假失败。 */
  let dbReady = false;

  const auth = { "x-dev-user-id": userId, "content-type": "application/json" };

  before(async () => {
    try {
      await pool!.query("SELECT 1");
      dbReady = true;
    } catch (error) {
      console.warn(
        "[ai-copy] 数据库不可达，跳过集成用例：",
        error instanceof Error ? error.message : error
      );
      await pool!.end().catch(() => undefined);
      return;
    }

    // 本地 OpenAI 兼容假服务：记录调用次数，固定返回合法文案。
    server = createServer((req, res) => {
      providerCalls += 1;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: MODEL,
            choices: [{ message: { content: JSON.stringify(VALID_COPY) } }],
            usage: { prompt_tokens: 120, completion_tokens: 60 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("假 Provider 启动失败");

    process.env.AI_API_KEY = "test-key";
    process.env.AI_MODEL = MODEL;
    delete process.env.AI_FALLBACK_MODEL;
    process.env.AI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;

    await pool!.query(
      "INSERT INTO users (id, email, quota_left) VALUES ($1,$2,10),($3,$4,10)",
      [userId, `ai-${userId}@example.invalid`, otherUserId, `ai-${otherUserId}@example.invalid`]
    );
    await pool!.query(
      `INSERT INTO products (id, user_id, name, description, price, image_path, selling_points)
       VALUES ($1,$2,'水润面霜','日常保湿',29.99,'uploads/x/a.png','["保湿"]'::jsonb)`,
      [productId, userId]
    );

    route = await import("../src/app/api/ai/copy/route");
  });

  after(async () => {
    if (!dbReady) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await pool!.query("DELETE FROM ai_copy_cache WHERE cache_key = $1", [
      computeCacheKey(INPUT, [MODEL]),
    ]);
    await pool!.query("DELETE FROM users WHERE id IN ($1,$2)", [userId, otherUserId]);
    await pool!.end();
  });

  const call = (headers: Record<string, string>, body: unknown) =>
    route.POST(
      new NextRequest("http://localhost/api/ai/copy", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
    );

  it("首次调用生成文案并落 ai_call 用量；二次调用命中缓存不再请求模型", async (t) => {
    if (!dbReady) return t.skip("数据库不可达");
    resetRateLimits();
    const first = await call(auth, { productId });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      ok: boolean;
      data: { copy: typeof VALID_COPY; cached: boolean };
    };
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.data.cached, false);
    assert.deepEqual(firstBody.data.copy, VALID_COPY);
    assert.equal(providerCalls, 1);

    const usage = await pool!.query(
      "SELECT amount, meta FROM usage_records WHERE user_id=$1 AND usage_type='ai_call'",
      [userId]
    );
    assert.equal(usage.rowCount, 1);
    assert.equal(usage.rows[0].amount, 0);
    assert.equal(usage.rows[0].meta.model, MODEL);
    assert.equal(usage.rows[0].meta.totalTokens, 180);
    assert.equal(usage.rows[0].meta.promptVersion, "copy-v1");

    const second = await call(auth, { productId });
    const secondBody = (await second.json()) as { ok: boolean; data: { cached: boolean } };
    assert.equal(secondBody.data.cached, true);
    assert.equal(providerCalls, 1, "缓存命中不应再调用模型");
  });

  it("未鉴权 401、商品 id 非法 400、跨用户商品 404", async (t) => {
    if (!dbReady) return t.skip("数据库不可达");
    resetRateLimits();
    const anonymous = await call({ "content-type": "application/json" }, { productId });
    assert.equal(anonymous.status, 401);

    const invalid = await call(auth, { productId: "not-a-uuid" });
    assert.equal(invalid.status, 400);
    const invalidBody = (await invalid.json()) as { error: { fields?: Record<string, string> } };
    assert.ok(invalidBody.error.fields?.productId);

    const foreign = await call({ ...auth, "x-dev-user-id": otherUserId }, { productId });
    assert.equal(foreign.status, 404);
  });

  it("超过 10 次/分钟返回 429 RATE_LIMITED", async (t) => {
    if (!dbReady) return t.skip("数据库不可达");
    resetRateLimits();
    for (let i = 0; i < 10; i += 1) {
      const response = await call(auth, { productId: "00000000-0000-4000-8000-000000000000" });
      assert.notEqual(response.status, 429);
    }
    const blocked = await call(auth, { productId: "00000000-0000-4000-8000-000000000000" });
    assert.equal(blocked.status, 429);
    const body = (await blocked.json()) as { error: { code: string } };
    assert.equal(body.error.code, "RATE_LIMITED");
  });
});
