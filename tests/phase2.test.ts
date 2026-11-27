import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError } from "zod";
import {
  AiProductInputSchema,
  CreateProductSchema,
  ProductSchema,
  toAiProductInput,
  type Product,
} from "../src/shared/product.schema";
import {
  buildPropsFromAi,
  buildVideoProps,
  copyFromAi,
  getTemplate,
  normalizeCopy,
  RenderCopySchema,
  TEMPLATES,
  TEMPLATE_IDS,
  VIDEO_SPEC,
  type RenderCopy,
} from "../src/shared/template.schema";
import { ProductVideoPropsSchema } from "../src/shared/video-props.schema";
import { CreateVideoRequestSchema } from "../src/shared/api";
import { parseRequest } from "../src/shared/validation";

const product: Product = {
  name: "水润保湿面霜",
  imagePath: "products/u1/cream.png",
  description: "日常保湿护肤",
  price: "29.99",
  sellingPoints: ["轻盈质地", "日常护肤"],
  brandName: "AURA",
  brandLogoPath: "brands/u1/logo.png",
  brandColor: "#abcdef",
};

const copy: RenderCopy = {
  title: "每日水润必备",
  subtitle: "轻盈呵护每一天",
  sellingPoints: ["轻盈质地", "长效保湿"],
  cta: "立即购买",
};

describe("商品 JSON Schema（PRD 5.2）", () => {
  it("合法商品通过，字段对齐 products 表", () => {
    const parsed = ProductSchema.parse(product);
    assert.equal(parsed.name, product.name);
    assert.equal(parsed.sellingPoints.length, 2);
  });

  it("拒绝超长名称、超过 5 个卖点、非法价格", () => {
    assert.equal(ProductSchema.safeParse({ ...product, name: "x".repeat(201) }).success, false);
    assert.equal(
      ProductSchema.safeParse({ ...product, sellingPoints: Array(6).fill("卖点") }).success,
      false
    );
    assert.equal(ProductSchema.safeParse({ ...product, price: "12.345" }).success, false);
  });

  it("拒绝绝对路径与非法品牌色，防止越权路径与非法色值进入渲染", () => {
    assert.equal(ProductSchema.safeParse({ ...product, imagePath: "/etc/passwd" }).success, false);
    assert.equal(ProductSchema.safeParse({ ...product, brandColor: "blue" }).success, false);
  });

  it("新增商品请求不允许客户端自带 id / userId", () => {
    const parsed = CreateProductSchema.parse({
      name: "新品",
      imagePath: "products/u1/new.png",
    });
    assert.equal("id" in parsed, false);
    assert.equal("userId" in parsed, false);
    assert.deepEqual(parsed.sellingPoints, []);
  });

  it("AI 输入只暴露文案所需字段，且允许 $29.99 展示写法", () => {
    const aiInput = toAiProductInput(product);
    assert.deepEqual(aiInput, {
      productName: product.name,
      description: product.description,
      sellingPoints: product.sellingPoints,
      price: "29.99",
    });
    assert.equal("userId" in aiInput, false);
    assert.equal("imagePath" in aiInput, false);
    assert.equal(
      AiProductInputSchema.safeParse({
        productName: "Hydrating Face Cream",
        price: "$29.99",
        sellingPoints: ["Lightweight texture"],
      }).success,
      true
    );
  });
});

describe("模板注册表（PRD 5.4 / 方案 7.1）", () => {
  it("5 个模板的 compositionId、时长与统一规格正确", () => {
    assert.deepEqual(TEMPLATES.map((t) => t.id), [...TEMPLATE_IDS]);
    assert.deepEqual(
      TEMPLATES.map((t) => t.compositionId),
      ["product-launch", "product-highlight", "product-sale", "product-showcase", "product-story"]
    );
    assert.deepEqual(
      TEMPLATES.map((t) => t.durationSec),
      [15, 20, 15, 20, 20]
    );
    for (const t of TEMPLATES) {
      assert.equal(t.width, 1080);
      assert.equal(t.height, 1920);
      assert.equal(t.fps, 30);
      assert.equal(t.category, t.id.replace("product-", ""));
      assert.equal(ProductVideoPropsSchema.safeParse(t.defaultProps).success, true);
    }
    assert.equal(VIDEO_SPEC.aspectRatio, "9:16");
  });

  it("未知模板直接失败，不静默回退", () => {
    assert.throws(() => getTemplate("product-unknown"), /未知模板/);
  });
});

describe("参数化生成：文案 → 渲染参数", () => {
  it("AI 文案字段名映射正确（videoTitle → title）", () => {
    const mapped = copyFromAi({
      videoTitle: "AI 标题",
      subtitle: "AI 副标题",
      sellingPoints: ["卖点一"],
      cta: "AI CTA",
    });
    assert.deepEqual(mapped, {
      title: "AI 标题",
      subtitle: "AI 副标题",
      sellingPoints: ["卖点一"],
      cta: "AI CTA",
    });
    assert.equal(RenderCopySchema.safeParse(mapped).success, true);
  });

  it("超长文案按上限截断并给出提示，不把超长文本送进渲染", () => {
    const { copy: normalized, truncated } = normalizeCopy({
      title: "标".repeat(70),
      subtitle: "副".repeat(90),
      sellingPoints: ["卖".repeat(45), "正常卖点", "多".repeat(41), "A", "B", "C"],
      cta: "购".repeat(25),
    });
    assert.equal(normalized.title.length, 60);
    assert.equal(normalized.subtitle.length, 80);
    assert.equal(normalized.cta.length, 20);
    assert.equal(normalized.sellingPoints.length, 5);
    assert.ok(normalized.sellingPoints.every((p) => p.length <= 40));
    assert.ok(truncated.some((n) => n.includes("标题")));
    assert.ok(truncated.some((n) => n.includes("卖点超过 5 个")));
    assert.equal(ProductVideoPropsSchema.safeParse({
      title: normalized.title,
      subtitle: normalized.subtitle,
      imageUrl: product.imagePath,
      sellingPoints: normalized.sellingPoints,
      cta: normalized.cta,
      brandColor: "#2563eb",
    }).success, true);
  });

  it("buildVideoProps 把商品字段与文案映射成合法 Props", () => {
    const props = buildVideoProps({ templateId: "product-launch", product, copy });
    assert.deepEqual(props, {
      title: copy.title,
      subtitle: copy.subtitle,
      imageUrl: "products/u1/cream.png",
      price: "29.99",
      sellingPoints: copy.sellingPoints,
      cta: copy.cta,
      brandColor: "#abcdef",
      logoPath: "brands/u1/logo.png",
    });
    assert.equal(ProductVideoPropsSchema.safeParse(props).success, true);
  });

  it("配置优先级：用户选项 > 商品记录 > 模板默认值", () => {
    const withProductColor = buildVideoProps({
      templateId: "product-launch",
      product,
      copy,
    });
    assert.equal(withProductColor.brandColor, "#abcdef");

    const withOverride = buildVideoProps({
      templateId: "product-launch",
      product,
      copy,
      options: { brandColor: "#123456", logoPath: "brands/u1/alt.png", music: "audio/bgm.mp3" },
    });
    assert.equal(withOverride.brandColor, "#123456");
    assert.equal(withOverride.logoPath, "brands/u1/alt.png");
    assert.equal(withOverride.musicPath, "audio/bgm.mp3");

    const withTemplateDefault = buildVideoProps({
      templateId: "product-sale",
      product: { ...product, brandColor: undefined, brandLogoPath: undefined },
      copy,
    });
    assert.equal(withTemplateDefault.brandColor, "#dc2626");
    assert.equal(withTemplateDefault.logoPath, undefined);
  });

  it("非法文案与未知模板在进入渲染前抛错", () => {
    assert.throws(
      () => buildVideoProps({ templateId: "product-launch", product, copy: { ...copy, title: "" } }),
      (err: unknown) => err instanceof ZodError
    );
    assert.throws(
      () =>
        buildVideoProps({
          templateId: "product-unknown" as never,
          product,
          copy,
        }),
      (err: unknown) => err instanceof ZodError
    );
  });

  it("AI 文案一键生成：自动映射 + 截断 + 校验", () => {
    const result = buildPropsFromAi({
      templateId: "product-showcase",
      product,
      copy: {
        videoTitle: "长".repeat(65),
        subtitle: "副标题",
        sellingPoints: ["卖点"],
        cta: "了解更多",
      },
    });
    assert.equal(result.props.title.length, 60);
    assert.equal(result.props.brandColor, "#abcdef");
    assert.deepEqual(result.truncated, ["标题 超过 60 字，已截断"]);
    assert.equal(ProductVideoPropsSchema.safeParse(result.props).success, true);
  });
});

describe("请求边界校验（方案 5.2）", () => {
  it("合法提交请求通过", () => {
    const request = {
      productId: "00000000-0000-4000-8000-000000000001",
      templateId: "00000000-0000-4000-8000-000000000002",
      copy,
    };
    assert.equal(parseRequest(CreateVideoRequestSchema, request).ok, true);
  });

  it("非法请求返回 VALIDATION_ERROR 与字段级错误", () => {
    const result = parseRequest(CreateVideoRequestSchema, {
      productId: "not-a-uuid",
      templateId: "00000000-0000-4000-8000-000000000002",
      copy: { ...copy, cta: "" },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.response.ok, false);
    if (result.response.ok) return;
    assert.equal(result.response.error.code, "VALIDATION_ERROR");
    assert.ok(result.response.error.fields?.productId);
    assert.ok(result.response.error.fields?.["copy.cta"]);
  });
});
