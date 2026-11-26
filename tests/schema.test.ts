import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { CopySchema } from "../src/shared/copy.schema";
import { ProductVideoPropsSchema } from "../src/shared/video-props.schema";
import { CreateVideoRequestSchema } from "../src/shared/api";

const validCopy = {
  videoTitle: "新品发布",
  subtitle: "让创作更简单",
  sellingPoints: ["一键生成", "高清出片"],
  cta: "立即体验",
};

describe("CopySchema（方案 6.1）", () => {
  it("接受合法 AI 文案", () => {
    assert.equal(CopySchema.safeParse(validCopy).success, true);
  });

  it("拒绝空卖点与超长标题", () => {
    assert.equal(CopySchema.safeParse({ ...validCopy, sellingPoints: [] }).success, false);
    assert.equal(CopySchema.safeParse({ ...validCopy, videoTitle: "x".repeat(61) }).success, false);
  });
});

describe("ProductVideoPropsSchema（方案 7.1）", () => {
  const validProps = {
    title: "新品发布",
    subtitle: "让创作更简单",
    imageUrl: "uploads/00000000-0000-4000-8000-000000000002/p/product.png",
    sellingPoints: ["一键生成"],
    cta: "立即体验",
    brandColor: "#2563eb",
  };

  it("接受合法渲染参数", () => {
    assert.equal(ProductVideoPropsSchema.safeParse(validProps).success, true);
  });

  it("拒绝非法品牌色", () => {
    assert.equal(
      ProductVideoPropsSchema.safeParse({ ...validProps, brandColor: "blue" }).success,
      false
    );
  });

  it("拒绝外部 URL / file: / 绝对路径类素材（验收 P1-08）", () => {
    for (const bad of [
      "https://evil.example/a.png",
      "file:///etc/passwd",
      "/tmp/product.png",
      "uploads/../../etc/passwd",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      assert.equal(
        ProductVideoPropsSchema.safeParse({ ...validProps, imageUrl: bad }).success,
        false,
        bad
      );
    }
  });
});

describe("CreateVideoRequestSchema（方案 5.2）", () => {
  it("校验 productId/templateId 为 UUID", () => {
    const base = {
      productId: "00000000-0000-4000-8000-000000000001",
      templateId: "00000000-0000-4000-8000-000000000002",
      copy: {
        title: "标题",
        subtitle: "副标题",
        sellingPoints: ["卖点"],
        cta: "购买",
      },
    };
    assert.equal(CreateVideoRequestSchema.safeParse(base).success, true);
    assert.equal(
      CreateVideoRequestSchema.safeParse({ ...base, productId: "not-a-uuid" }).success,
      false
    );
  });
});

describe("迁移脚本幂等性（方案 4.1 / 4.3）", () => {
  it("6 张业务表与索引均使用 IF NOT EXISTS", async () => {
    const sql = await readFile(
      path.resolve(__dirname, "../db/migrations/001_init.sql"),
      "utf8"
    );
    for (const table of [
      "users",
      "products",
      "video_templates",
      "video_jobs",
      "subscriptions",
      "usage_records",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
    }
    assert.ok(!/CREATE TABLE (?!IF NOT EXISTS)/.test(sql), "存在非幂等的 CREATE TABLE");
    assert.ok(!/CREATE INDEX (?!IF NOT EXISTS)/.test(sql), "存在非幂等的 CREATE INDEX");
    assert.match(sql, /DROP TRIGGER IF EXISTS/);
  });
});
