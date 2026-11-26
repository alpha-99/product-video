import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ProductHighlight } from "../remotion/ProductHighlight";
import { ProductLaunch } from "../remotion/ProductLaunch";
import { ProductSale } from "../remotion/ProductSale";
import { PremiumShowcase } from "../remotion/PremiumShowcase";
import { resolveImageSrc } from "../remotion/lib/image-src";
import { TEMPLATES, buildVideoProps } from "../src/shared/template.schema";
import { ProductVideoPropsSchema } from "../src/shared/video-props.schema";

const ROOT = path.resolve(__dirname, "..");

describe("首批 4 个模板组件（PRD 5.4）", () => {
  it("4 个组件均导出可渲染的 React 函数组件", () => {
    for (const component of [
      ProductLaunch,
      ProductHighlight,
      ProductSale,
      PremiumShowcase,
    ]) {
      assert.equal(typeof component, "function");
      assert.equal(component.displayName, undefined);
    }
  });

  it("Root 按注册表挂载全部 4 个 Composition，时长由注册表推导", async () => {
    const root = await readFile(path.join(ROOT, "remotion", "Root.tsx"), "utf8");
    const componentMap = await readFile(
      path.join(ROOT, "remotion", "component-map.ts"),
      "utf8"
    );
    assert.match(root, /id=\{template\.compositionId\}/);
    assert.match(root, /COMPONENTS\[template\.id\]/);
    for (const template of TEMPLATES) {
      assert.ok(componentMap.includes(template.id), `组件映射缺少 ${template.id}`);
    }
    assert.match(root, /durationInFrames=\{template\.durationSec \* template\.fps\}/);
    assert.match(root, /width=\{template\.width\}/);
    assert.match(root, /height=\{template\.height\}/);
    assert.equal(root.match(/<Composition/g)?.length, 1, "通过 map 统一注册，不应重复写死");

    assert.deepEqual(
      TEMPLATES.map((t) => t.durationSec * t.fps),
      [450, 600, 450, 600]
    );
  });

  it("4 个模板的规格统一为 1080×1920 / 30fps / 9:16", () => {
    for (const template of TEMPLATES) {
      assert.equal(template.width, 1080);
      assert.equal(template.height, 1920);
      assert.equal(template.fps, 30);
      assert.equal(ProductVideoPropsSchema.safeParse(template.defaultProps).success, true);
    }
  });

  it("促销模板所需的原价/优惠文案已以可选字段进入共享契约与映射", () => {
    const props = buildVideoProps({
      templateId: "product-sale",
      product: {
        name: "面霜",
        imagePath: "products/u1/cream.png",
        price: "19.99",
        sellingPoints: ["保湿"],
      },
      copy: {
        title: "限时特惠",
        subtitle: "每日必备",
        sellingPoints: ["保湿"],
        cta: "立即抢购",
      },
      options: { originalPrice: "39.99", discountText: "五折来袭" },
    });
    assert.equal(props.price, "19.99");
    assert.equal(props.originalPrice, "39.99");
    assert.equal(props.discountText, "五折来袭");
    assert.equal(ProductVideoPropsSchema.safeParse(props).success, true);
  });
});

describe("渲染资源地址解析", () => {
  it("data URL 与相对路径可用，外部协议/穿越路径一律拒绝（验收 P1-08）", () => {
    assert.equal(
      resolveImageSrc("data:image/png;base64,AAAA"),
      "data:image/png;base64,AAAA"
    );
    assert.equal(resolveImageSrc("placeholder-product.svg"), "/placeholder-product.svg");
    assert.equal(resolveImageSrc("assets/logo.svg"), "/assets/logo.svg");
    for (const bad of [
      "https://example.com/a.png",
      "http://127.0.0.1/admin",
      "file:///etc/passwd",
      "blob:https://example.com/uuid",
      "//evil.example/a.png",
      "/etc/passwd",
      "assets\\logo.svg",
      "uploads/../../secret.png",
    ]) {
      assert.throws(() => resolveImageSrc(bad), /不受信任/, bad);
    }
  });

  it("预览占位图存在", async () => {
    const info = await stat(path.join(ROOT, "public", "placeholder-product.svg"));
    assert.ok(info.size > 100);
  });
});
