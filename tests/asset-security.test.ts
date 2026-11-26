import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAllowedDataUrl,
  isOwnedUploadAssetPath,
  isSafeRelativeAssetPath,
} from "../src/shared/asset-path.schema";
import { ProductVideoPropsSchema } from "../src/shared/video-props.schema";
import { RenderOptionsSchema } from "../src/shared/template.schema";
import { CreateVideoRequestSchema, ListProductsQuerySchema, ListVideosQuerySchema } from "../src/shared/api";
import { ProductSchema } from "../src/shared/product.schema";

/**
 * 验收 P1-08 / P2-11 回归：
 * 之前 options.logoPath / music 是宽松 z.string()，外部 URL 与 file: 会原样
 * 进入渲染快照并被 Remotion Chromium 请求；products 列表分页用 Number() 钳制。
 */
const EXTERNAL = [
  "https://evil.example/a.png",
  "http://127.0.0.1:8080/admin",
  "file:///etc/passwd",
  "file://C:/Windows/win.ini",
  "blob:https://example.com/uuid",
  "javascript:alert(1)",
  "//evil.example/a.png",
  "/etc/passwd",
  "C:\\Windows\\win.ini",
  "uploads/../../etc/passwd",
  "uploads\\..\\secret.png",
  "data:text/html,<script>alert(1)</script>",
];

describe("受控素材地址守卫", () => {
  it("data URL 只允许白名单图片/音频，且拒绝携带脚本的 SVG", () => {
    assert.equal(isAllowedDataUrl("data:image/png;base64,AA=="), true);
    assert.equal(isAllowedDataUrl("data:image/svg+xml;utf8,%3Csvg%2F%3E"), true);
    assert.equal(isAllowedDataUrl("data:image/svg+xml;utf8,%3Cscript%3Ealert(1)%3C%2Fscript%3E"), false);
    assert.equal(isAllowedDataUrl("data:text/html,<h1>x</h1>"), false);
  });

  it("相对路径守卫拒绝所有协议、绝对路径与穿越", () => {
    assert.equal(isSafeRelativeAssetPath("uploads/u1/p/logo.png"), true);
    for (const bad of EXTERNAL) {
      assert.equal(isSafeRelativeAssetPath(bad), false, bad);
    }
  });

  it("渲染层进一步要求 uploads/{用户目录}/ 前缀", () => {
    assert.equal(isOwnedUploadAssetPath("uploads/u1/p/logo.png"), true);
    assert.equal(isOwnedUploadAssetPath("videos/u1/j1.mp4"), false);
    assert.equal(isOwnedUploadAssetPath("uploads/logo.png"), false);
    assert.equal(isOwnedUploadAssetPath("https://evil.example/a.png"), false);
  });
});

describe("提交契约拒绝不安全的素材", () => {
  const props = {
    title: "标题",
    subtitle: "副标题",
    imageUrl: "uploads/u1/p/product.png",
    sellingPoints: ["卖点"],
    cta: "购买",
    brandColor: "#2563eb",
  };

  it("ProductVideoPropsSchema 的 imageUrl / logoPath / musicPath 全部受限", () => {
    for (const field of ["imageUrl", "logoPath", "musicPath"] as const) {
      for (const bad of EXTERNAL) {
        assert.equal(
          ProductVideoPropsSchema.safeParse({ ...props, [field]: bad }).success,
          false,
          `${field}=${bad}`
        );
      }
    }
  });

  it("RenderOptionsSchema 的 logoPath / music 全部受限", () => {
    for (const field of ["logoPath", "music"] as const) {
      for (const bad of EXTERNAL) {
        assert.equal(RenderOptionsSchema.safeParse({ [field]: bad }).success, false, `${field}=${bad}`);
      }
    }
  });

  it("CreateVideoRequestSchema 拒绝夹带外部 URL 的 options", () => {
    const base = {
      productId: "00000000-0000-4000-8000-000000000001",
      templateId: "00000000-0000-4000-8000-000000000002",
      copy: { title: "标题", subtitle: "副标题", sellingPoints: ["卖点"], cta: "购买" },
      options: { logoPath: "https://evil.example/logo.png" },
    };
    assert.equal(CreateVideoRequestSchema.safeParse(base).success, false);
    assert.equal(
      CreateVideoRequestSchema.safeParse({ ...base, options: { logoPath: "uploads/u1/p/logo.png" } }).success,
      true
    );
  });

  it("ProductSchema.brandLogoPath 不接受外部 URL", () => {
    const product = {
      name: "面霜",
      imagePath: "uploads/u1/p/cream.png",
      brandLogoPath: "file:///etc/passwd",
    };
    assert.equal(ProductSchema.safeParse(product).success, false);
  });
});

describe("products 与 videos 共用同一分页契约", () => {
  it("非法参数一律拒绝，合法参数正常转换", () => {
    for (const raw of [{ take: "abc" }, { take: "0" }, { take: "999" }, { skip: "-1" }]) {
      assert.equal(ListProductsQuerySchema.safeParse(raw).success, false, JSON.stringify(raw));
    }
    assert.deepEqual(ListProductsQuerySchema.parse({ take: "5" }), { take: 5, skip: 0 });
    assert.deepEqual(ListVideosQuerySchema.parse({ take: "5" }), { take: 5, skip: 0 });
  });
});
