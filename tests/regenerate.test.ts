/**
 * C-06 双路径的参数映射单测：不连数据库，只验证「已完成任务的 input_json
 * 快照 → 新建任务请求」这一段纯函数，覆盖 musicPath → music 等易错映射。
 * 额度扣减与幂等由 createVideoJob 的事务负责，已在 queue.test.ts 覆盖。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createRequestFromSnapshot } from "../src/lib/jobs";
import { RenderJobInputSchema, type RenderJobInput } from "../src/shared/render.schema";

const productId = randomUUID();
const templateId = randomUUID();

function snapshot(overrides: Partial<RenderJobInput["props"]> = {}): RenderJobInput {
  return RenderJobInputSchema.parse({
    jobId: randomUUID(),
    userId: randomUUID(),
    compositionId: "product-sale",
    props: {
      title: "夏季促销短片",
      subtitle: "清爽一夏",
      imageUrl: "uploads/u/p/product.jpg",
      sellingPoints: ["轻盈质地", "日常保湿"],
      cta: "立即抢购",
      brandColor: "#1f4d3d",
      ...overrides,
    },
  });
}

describe("C-06：已完成视频按原参数新建任务", () => {
  it("文案与归属 id 从快照还原，imageUrl/price 不进入请求（由当前商品重算）", () => {
    const request = createRequestFromSnapshot({
      productId,
      templateId,
      snapshot: snapshot({ price: "129.00" }),
    });

    assert.equal(request.productId, productId);
    assert.equal(request.templateId, templateId);
    assert.equal(request.copy.title, "夏季促销短片");
    assert.equal(request.copy.subtitle, "清爽一夏");
    assert.deepEqual(request.copy.sellingPoints, ["轻盈质地", "日常保湿"]);
    assert.equal(request.copy.cta, "立即抢购");
    assert.equal(request.options?.brandColor, "#1f4d3d");
    assert.ok(!("imageUrl" in (request.options ?? {})));
    assert.ok(!("price" in (request.options ?? {})));
  });

  it("可选参数完整还原，musicPath 正确映射为请求契约的 music", () => {
    const request = createRequestFromSnapshot({
      productId,
      templateId,
      snapshot: snapshot({
        logoPath: "uploads/u/p/logo.png",
        musicPath: "audio/brand-track.mp3",
        originalPrice: "199.00",
        discountText: "限时 7 折",
      }),
    });

    assert.equal(request.options?.logoPath, "uploads/u/p/logo.png");
    assert.equal(request.options?.music, "audio/brand-track.mp3");
    assert.equal(request.options?.originalPrice, "199.00");
    assert.equal(request.options?.discountText, "限时 7 折");
  });

  it("最小快照只带必填品牌色，不产生 undefined 或多余字段", () => {
    const request = createRequestFromSnapshot({ productId, templateId, snapshot: snapshot() });
    assert.deepEqual(request.options, { brandColor: "#1f4d3d" });
    assert.equal(Object.values(request.options ?? {}).some((v) => v === undefined), false);
  });

  it("非法品牌色在边界被拒绝，不会把脏参数送进扣额度事务", () => {
    assert.throws(() =>
      createRequestFromSnapshot({
        productId,
        templateId,
        snapshot: { ...snapshot(), props: { ...snapshot().props, brandColor: "red" } },
      })
    );
  });
});
