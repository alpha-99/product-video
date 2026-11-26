import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CreateProductSchema, UpdateProductSchema } from "../src/shared/product.schema";

/**
 * 回归：Zod 4 的 `.partial()` 不会剥离 `.default([])`。
 * 实测曾出现「只 PATCH 商品图片 → sellingPoints 被静默清空」的数据丢失缺陷。
 * 本组用例锁死 PATCH 契约：未传字段必须保持 undefined。
 */
describe("UpdateProductSchema：局部更新不得注入默认值", () => {
  const patches = [
    { name: "新名称" },
    { imagePath: "uploads/u/p/a.png" },
    { brandColor: "#1f4d3d" },
    { price: "99.90" },
  ];

  for (const patch of patches) {
    it(`${JSON.stringify(patch)} 不得带出 sellingPoints`, () => {
      const parsed = UpdateProductSchema.parse(patch);
      assert.equal(
        Object.prototype.hasOwnProperty.call(parsed, "sellingPoints"),
        false,
        "未显式传入的卖点必须保持 undefined，否则 updateProduct 会覆盖成空数组"
      );
    });
  }

  it("空 PATCH 不产生任何字段", () => {
    assert.deepEqual(UpdateProductSchema.parse({}), {});
  });

  it("显式传入的卖点被保留并参与校验", () => {
    const parsed = UpdateProductSchema.parse({ sellingPoints: ["温和亲肤", "日常保湿"] });
    assert.deepEqual(parsed.sellingPoints, ["温和亲肤", "日常保湿"]);
  });

  it("显式传空数组 = 用户主动清空，仍然合法", () => {
    assert.deepEqual(UpdateProductSchema.parse({ sellingPoints: [] }).sellingPoints, []);
  });

  it("超量卖点与非法品牌色仍被拒绝", () => {
    assert.equal(
      UpdateProductSchema.safeParse({ sellingPoints: ["1", "2", "3", "4", "5", "6"] }).success,
      false
    );
    assert.equal(UpdateProductSchema.safeParse({ brandColor: "red" }).success, false);
  });

  it("新建商品仍保留默认空卖点（创建语义不受影响）", () => {
    const created = CreateProductSchema.parse({ name: "新品", imagePath: "a.png" });
    assert.deepEqual(created.sellingPoints, []);
  });
});
