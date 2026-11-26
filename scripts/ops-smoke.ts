/**
 * 线上冒烟（方案 12.5「注册登录 → 上传 → 生成 → 渲染 → 下载 → 额度核对」）。
 *
 *   npx tsx scripts/ops-smoke.ts                       基础链路（不调 AI、不等渲染）
 *   npx tsx scripts/ops-smoke.ts --with-ai            额外验证真实 AI 文案接口
 *   npx tsx scripts/ops-smoke.ts --wait-render        等到任务完成并下载成片
 *   npx tsx scripts/ops-smoke.ts --full               两者都做（部署验收推荐）
 *   npx tsx scripts/ops-smoke.ts --keep               保留测试数据供排查
 *
 * 环境变量：BASE_URL（默认 http://127.0.0.1:3000）、HEALTH_TOKEN、
 *          SMOKE_EMAIL / SMOKE_PASSWORD、DATABASE_URL（用于清理测试用户）。
 * 生产执行请用一次性随机邮箱；脚本默认自动生成并在结束时清理。
 */
import { randomUUID } from "node:crypto";
import process from "node:process";
import { Pool } from "pg";
import "../src/lib/env";
import type { Copy } from "../src/shared/copy.schema";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = process.env.HEALTH_TOKEN;
const EMAIL = process.env.SMOKE_EMAIL || `smoke-${randomUUID()}@example.invalid`;
const PASSWORD = process.env.SMOKE_PASSWORD || "Sm0ke-Test!2026";
const WITH_AI = process.argv.includes("--with-ai") || process.argv.includes("--full");
const WAIT_RENDER = process.argv.includes("--wait-render") || process.argv.includes("--full");
const KEEP = process.argv.includes("--keep");

/** 1×1 透明 PNG：满足上传三重校验（扩展名 / MIME / 文件头 sniff）。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const MANUAL_COPY: Copy = {
  videoTitle: "冒烟测试商品",
  subtitle: "端到端链路验证",
  sellingPoints: ["上传成功", "任务已提交", "额度已扣减"],
  cta: "立即查看",
};

let cookie = "";
let failures = 0;
let step = 0;
let productId = "";
let jobId = "";

function url(pathname: string): string {
  return `${BASE}${pathname}`;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...(cookie ? { cookie } : {}), ...extra };
}

async function request(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url(pathname), {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...authHeaders() },
    signal: AbortSignal.timeout(30_000),
  });
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  step += 1;
  try {
    await fn();
    console.log(`[smoke] ${step}. ${name} ... PASS`);
  } catch (error) {
    failures += 1;
    console.error(`[smoke] ${step}. ${name} ... FAIL: ${(error as Error).message}`);
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { ok?: boolean; data?: T; error?: { message?: string } };
  expect(response.ok && body.ok, `HTTP ${response.status} ${body.error?.message ?? ""}`.trim());
  return body.data as T;
}

async function cleanup(): Promise<void> {
  if (KEEP) {
    console.log(`[smoke] --keep 已指定，保留测试数据：${EMAIL}`);
    return;
  }
  if (jobId) {
    await request(`/api/videos/${jobId}`, { method: "DELETE" }).catch(() => undefined);
  }
  if (productId) {
    await request(`/api/products/${productId}`, { method: "DELETE" }).catch(() => undefined);
  }
  if (process.env.DATABASE_URL) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 8_000,
    });
    try {
      await pool.query("DELETE FROM users WHERE email = $1", [EMAIL]);
      console.log(`[smoke] 已清理测试用户 ${EMAIL}`);
    } catch (error) {
      console.warn(`[smoke] 清理测试用户失败（可手动删除）：${(error as Error).message}`);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
}

async function main(): Promise<void> {
  console.log(`[smoke] target=${BASE} email=${EMAIL} ai=${WITH_AI} render=${WAIT_RENDER}`);

  await check("健康检查 /api/health 非 down", async () => {
    const response = await fetch(url("/api/health"), {
      headers: TOKEN ? { "x-health-token": TOKEN } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const data = await json<{ status: string }>(response);
    expect(data.status !== "down", `服务状态 ${data.status}`);
  });

  await check("登录 /api/auth/session 并写 HttpOnly Cookie", async () => {
    const response = await request("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    await json<{ id: string }>(response);
    const raw = response.headers.get("set-cookie") ?? "";
    expect(raw.includes("pv_session=") && raw.toLowerCase().includes("httponly"), "未写会话 Cookie");
    cookie = raw.split(";")[0];
  });

  let quotaBefore = 0;
  await check("GET /api/me 返回额度", async () => {
    const me = await json<{ quotaLeft: number }>(await request("/api/me"));
    expect(typeof me.quotaLeft === "number" && me.quotaLeft >= 1, "额度不足，无法提交任务");
    quotaBefore = me.quotaLeft;
  });

  let templateId = "";
  await check("GET /api/templates 返回 4 套模板", async () => {
    const list = await json<Array<{ id: string }>>(await request("/api/templates"));
    expect(list.length === 4, `模板数量 ${list.length}`);
    templateId = list[0].id;
  });

  let imagePath = "";
  await check("上传商品图片（multipart 三重校验）", async () => {
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "smoke.png");
    const response = await request("/api/uploads/products", { method: "POST", body: form });
    const data = await json<{ path: string }>(response);
    expect(data.path.startsWith("uploads/"), `非法图片路径 ${data.path}`);
    imagePath = data.path;
  });

  await check("POST /api/products 建立商品", async () => {
    const response = await request("/api/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `冒烟商品 ${randomUUID().slice(0, 8)}`,
        imagePath,
        description: "阶段九部署冒烟",
        price: "9.90",
        sellingPoints: ["端到端验证"],
      }),
    });
    const product = await json<{ id: string }>(response);
    expect(Boolean(product.id), "未返回商品 id");
    productId = product.id;
  });

  let copy: Copy = MANUAL_COPY;
  if (WITH_AI) {
    await check("POST /api/ai/copy 真实生成文案", async () => {
      const response = await request("/api/ai/copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      const data = await json<{ copy: Copy; model: string | null }>(response);
      expect(data.copy.videoTitle && data.copy.sellingPoints.length > 0, "文案为空");
      copy = data.copy;
    });
  }

  await check("POST /api/videos 幂等提交任务", async () => {
    const key = `smoke-${randomUUID()}`;
    const payload = JSON.stringify({ productId, templateId, copy });
    const first = await json<{ jobId: string; created: boolean }>(
      await request("/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: payload,
      })
    );
    const again = await json<{ jobId: string; created: boolean }>(
      await request("/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: payload,
      })
    );
    expect(first.created === true && again.created === false, "幂等键未生效");
    expect(first.jobId === again.jobId, "重复提交返回了不同任务");
    jobId = first.jobId;
  });

  await check("GET /api/videos 列表含新任务、额度已扣减", async () => {
    const jobs = await json<Array<{ id: string }>>(await request("/api/videos"));
    expect(jobs.some((job) => job.id === jobId), "列表未包含新任务");
    const me = await json<{ quotaLeft: number }>(await request("/api/me"));
    expect(me.quotaLeft === quotaBefore - 1, `额度 ${quotaBefore} → ${me.quotaLeft}，预期 -1`);
  });

  if (WAIT_RENDER) {
    await check("等待 Worker 渲染完成并下载成片", async () => {
      const deadline = Date.now() + 6 * 60_000;
      let status = "pending";
      while (Date.now() < deadline) {
        const job = await json<{ status: string; errorMessage?: string }>(
          await request(`/api/videos/${jobId}`)
        );
        status = job.status;
        if (status === "completed") break;
        if (status === "failed" || status === "cancelled") {
          throw new Error(`任务 ${status}: ${job.errorMessage ?? ""}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      expect(status === "completed", `等待 6 分钟后状态仍为 ${status}（Worker 是否启动？）`);
      const download = await request(`/api/videos/${jobId}/download`);
      expect(download.ok, `下载 HTTP ${download.status}`);
      expect((download.headers.get("content-type") ?? "").includes("video"), "下载内容不是视频");
    });
  }

  await cleanup();
  console.log(
    `[smoke] 完成：${step - failures}/${step} 通过${failures ? `，${failures} 项失败` : ""}`
  );
  if (failures) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(`[smoke] 未捕获异常：${(error as Error).message}`);
  process.exitCode = 1;
});
