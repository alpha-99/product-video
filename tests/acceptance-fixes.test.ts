import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { friendlyMessage, QUOTA_EMPTY_MESSAGE } from "../src/lib/client/api";
import { aiFailureMessage, collectTruncationNotes } from "../src/lib/ai/copy";
import { parseRetryAfter } from "../src/lib/ai/client";
import { invalidateCache, readCacheEntry, writeCache } from "../src/lib/client/cache";
import { errors } from "../src/lib/errors";
import { fail } from "../src/lib/api-response";
import { COPY_LIMITS } from "../src/shared/copy.schema";

const ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => readFile(path.join(ROOT, relative), "utf8");

/**
 * 产品验收遗留问题整改回归：
 * P1-01 错误链路 / P1-06 删除引导 / P1-07 登录文案 / P2-01 额度口径 /
 * P2-02 AI 降级 / P2-03 截断提示 / P2-08 孤儿文件 / P2-09 purge 清理 /
 * P2-10 额度对账 / P2-12 交互与无障碍。
 */
describe("错误链路：服务端 message 优先于通用兜底（P1-01）", () => {
  it("保留服务端的具体原因，内部错误仍统一脱敏", () => {
    assert.equal(
      friendlyMessage("VALIDATION_ERROR", "该商品已关联 2 个视频任务，无法删除"),
      "该商品已关联 2 个视频任务，无法删除"
    );
    assert.equal(friendlyMessage("VALIDATION_ERROR"), "填写内容有误，请按提示修改后重试");
    assert.equal(
      friendlyMessage("INTERNAL_ERROR", "prisma.videoJob.findMany() userId=secret"),
      "服务暂时不可用，请稍后重试"
    );
  });

  it("未知错误码不会返回空文案", () => {
    assert.match(friendlyMessage("SOMETHING_NEW"), /操作失败/);
  });
});

describe("AI 降级细分与 Retry-After（P2-02）", () => {
  it("按上游状态给出不同原因，429 带出等待秒数", () => {
    assert.match(aiFailureMessage(401, "x"), /密钥或权限/);
    assert.match(aiFailureMessage(404, "x"), /模型不存在/);
    assert.match(aiFailureMessage(429, "x", 5000), /5 秒后重试/);
    assert.match(aiFailureMessage(503, "timeout"), /暂时不可用/);
  });

  it("Retry-After 支持秒数与日期，且有 60s 上限", () => {
    assert.equal(parseRetryAfter("3"), 3000);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter("not-a-date"), undefined);
    assert.equal(parseRetryAfter("999999"), 60_000);
  });

  it("503 响应包络与响应头都带 retryAfterMs", async () => {
    const response = fail(errors.aiUnavailable("请稍后重试", 5000));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "5");
    const body = await response.json();
    assert.equal(body.error.retryAfterMs, 5000);
    assert.equal(body.error.code, "AI_UNAVAILABLE");
  });
});

describe("截断提示有消费方（P2-03）", () => {
  it("超长标题与多余卖点都会生成中文提示", () => {
    const notes = collectTruncationNotes({
      videoTitle: "x".repeat(COPY_LIMITS.videoTitle + 3),
      subtitle: "正常",
      sellingPoints: ["a", "b", "c", "d", "e", "f"],
      cta: "购买",
    });
    assert.ok(notes.some((note) => note.includes("标题") && note.includes("截断")));
    assert.ok(notes.some((note) => note.includes("卖点超过")));
  });

  it("合法输出不产生提示", () => {
    assert.deepEqual(
      collectTruncationNotes({ videoTitle: "标题", subtitle: "副标题", sellingPoints: ["卖点"], cta: "购买" }),
      []
    );
  });
});

describe("共享缓存可按 key 失效（P2-12）", () => {
  it("提交/取消/重试后 videos 缓存可被单独清除", () => {
    writeCache("videos", [{ id: "old" }]);
    writeCache("me", { quotaLeft: 3 });
    assert.ok(readCacheEntry("videos"));
    invalidateCache("videos");
    assert.equal(readCacheEntry("videos"), null);
    assert.ok(readCacheEntry("me"), "其它 key 不受影响");
  });
});

describe("前端交互与文案整改（静态回归）", () => {
  it("额度耗尽口径全站统一，不再出现「暂无升级入口」", async () => {
    assert.equal(QUOTA_EMPTY_MESSAGE, "剩余额度不足，请联系管理员增加额度");
    for (const file of ["src/app/(app)/page.tsx", "src/app/(app)/create/page.tsx"]) {
      const source = await read(file);
      assert.match(source, /QUOTA_EMPTY_MESSAGE/, file);
      assert.doesNotMatch(source, /暂无升级入口/, file);
    }
  });

  it("向导精简为 5 步、有预选反馈与 aria-current=step", async () => {
    const source = await read("src/app/(app)/create/page.tsx");
    assert.match(source, /const STEPS = \["选商品", "选模板", "文案", "参数", "确认并提交"\]/);
    assert.match(source, /aria-current=\{index === step \? "step" : undefined\}/);
    assert.match(source, /已预选/);
    assert.doesNotMatch(source, /右侧为 9:16/);
    assert.match(source, /invalidateAsyncCache\("videos"\)/);
    assert.match(source, /暂无可用模板/);
    assert.match(source, /setSubmitError\(null\)[\s\S]{0,120}setSubmitFields/);
  });

  it("面向用户文案不再泄露运维命令", async () => {
    for (const file of [
      "src/app/(app)/videos/page.tsx",
      "src/app/(app)/templates/page.tsx",
      "src/app/(app)/create/page.tsx",
    ]) {
      assert.doesNotMatch(await read(file), /npm run (worker|migrate)/, file);
    }
  });

  it("重试语义统一：cancelled 可重试、额度明示、cancel 检查返回值", async () => {
    const source = await read("src/app/(app)/videos/page.tsx");
    assert.match(source, /canRetry/);
    assert.match(source, /MAX_JOB_ATTEMPTS/);
    assert.match(source, /result\.cancelled === false/);
    assert.match(source, /消耗 1 次额度/);
    assert.match(source, /download\?inline=1/);
    assert.match(source, /refreshError/);
  });

  it("删除关联商品前有数量预判与可点击引导", async () => {
    const source = await read("src/app/(app)/products/page.tsx");
    assert.match(source, /relatedCount/);
    assert.match(source, /前往「视频管理」/);
    assert.match(source, /confirmDisabled/);
  });

  it("登录页把 401 明确为密码错误", async () => {
    assert.match(await read("src/app/login/page.tsx"), /邮箱或密码错误/);
  });

  it("模板页 radiogroup 支持方向键与 roving tabindex", async () => {
    const source = await read("src/app/(app)/templates/page.tsx");
    assert.match(source, /ArrowLeft/);
    assert.match(source, /ArrowUp/);
    assert.match(source, /tabIndex=\{isActive \? 0 : -1\}/);
  });

  it("预览联调页要求登录会话", async () => {
    const source = await read("src/app/preview/page.tsx");
    assert.match(source, /resolveUserId/);
    assert.match(source, /redirect\("\/login"\)/);
  });
});

describe("业务数据链路整改（静态回归）", () => {
  it("扣费流水带 videoJobId，且建任务先于写流水以满足外键", async () => {
    const billing = await read("src/lib/billing.ts");
    const jobs = await read("src/lib/jobs.ts");
    assert.match(billing, /videoJobId/);
    assert.match(jobs, /consumeQuota\(tx, userId, createdJob\.id\)/);
    assert.ok(
      jobs.indexOf("await tx.videoJob.create") < jobs.indexOf("await consumeQuota"),
      "必须先创建任务再写带外键的额度流水"
    );
  });

  it("商品编辑失败清理迁移后的 target，settleImage 会回滚孤儿文件", async () => {
    const source = await read("src/lib/products.ts");
    assert.match(source, /验收 P2-08/);
    assert.match(source, /moved/);
    assert.doesNotMatch(source, /cleanupImage\(data\.imagePath, userId\)/);
  });

  it("purge 归档溯源信息，文件清理改为幂等重试", async () => {
    assert.match(await read("src/lib/job-state.ts"), /purgedJobId/);
    assert.match(await read("src/app/api/videos/\[id\]/route.ts"), /cleanupFilesWithRetry/);
    assert.match(await read("src/lib/file-cleanup.ts"), /file_cleanup_dead_letter/);
  });

  it("缩略图有鉴权访问路径且被列表消费", async () => {
    const route = await read("src/app/api/videos/[id]/thumbnail/route.ts");
    assert.match(route, /getVideoJob/);
    assert.match(route, /z\.string\(\)\.uuid\(\)/);
    assert.match(await read("src/app/(app)/videos/page.tsx"), /\/thumbnail/);
    assert.match(await read("src/app/(app)/page.tsx"), /\/thumbnail/);
  });

  it("幂等命中返回 200，download 校验 uuid，products 分页复用契约", async () => {
    assert.match(await read("src/app/api/videos/[id]/regenerate/route.ts"), /created \? 201 : 200/);
    assert.match(await read("src/app/api/videos/[id]/download/route.ts"), /z\.string\(\)\.uuid\(\)/);
    assert.match(await read("src/app/api/products/route.ts"), /ListProductsQuerySchema/);
  });
});
