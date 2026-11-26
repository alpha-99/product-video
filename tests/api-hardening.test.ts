import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ListVideosQuerySchema } from "../src/shared/api";
import { fail } from "../src/lib/api-response";

/**
 * 验收整改回归：
 * - GET /api/videos?take=abc 曾因 Number() 产出 NaN 触发 Prisma 500，
 *   并把含 userId 的 Prisma 调用信息回传给客户端；
 * - 终态任务的「取消」曾返回 200 假成功。
 */
describe("ListVideosQuerySchema：分页参数显式校验", () => {
  it("未传参数使用默认值 20 / 0", () => {
    assert.deepEqual(ListVideosQuerySchema.parse({}), { take: 20, skip: 0 });
  });

  it("合法字符串正常转换", () => {
    assert.deepEqual(ListVideosQuerySchema.parse({ take: "5", skip: "7" }), { take: 5, skip: 7 });
  });

  it("非法值、越界值、负数一律拒绝（不再落到 Prisma）", () => {
    for (const raw of [
      { take: "abc" }, { take: "0" }, { take: "999" }, { take: "1.5" },
      { skip: "-1" }, { skip: "nan" },
    ]) {
      assert.equal(ListVideosQuerySchema.safeParse(raw).success, false, JSON.stringify(raw));
    }
  });
});

describe("统一 500 响应不得外泄内部细节", () => {
  it("原始错误只进日志，客户端只收到统一文案", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const response = fail(new Error("Invalid `prisma.videoJob.findMany()` userId=secret-token"));
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "INTERNAL_ERROR");
      assert.equal(body.error.message, "服务暂时不可用，请稍后重试");
      assert.equal(JSON.stringify(body).includes("prisma"), false);
      assert.equal(JSON.stringify(body).includes("secret-token"), false);
    } finally {
      console.error = original;
    }
  });

  it("DomainError / ZodError 仍返回各自的可读信息", async () => {
    const { errors } = await import("../src/lib/errors");
    const response = fail(errors.validation("任务已结束，无法取消"));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.message, "任务已结束，无法取消");
  });
});
