import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BRAND_COLOR_PATTERN, BRAND_SWATCHES, DEFAULT_PICKER_COLOR,
  hexToRgbLabel, normalizeColor, normalizeHex,
} from "../src/lib/client/color";
import { BrandColorSchema } from "../src/shared/product.schema";

/**
 * 创作向导第 4 步品牌色解析（纯函数回归）。
 * 核心验收点：任何进入 options.brandColor 的值都必须满足后端 #RRGGBB 契约，
 * 避免「预览生效但提交被拒」的所见非所得。
 */
describe("normalizeColor：合法输入", () => {
  it("空白 = 使用模板默认配色，不是错误", () => {
    assert.deepEqual(normalizeColor("   "), { ok: true, hex: null, format: "empty" });
  });

  it("6 位 HEX 统一小写", () => {
    assert.deepEqual(normalizeColor("#1F4D3D"), { ok: true, hex: "#1f4d3d", format: "hex6" });
    assert.deepEqual(normalizeColor("1F4D3D"), { ok: true, hex: "#1f4d3d", format: "hex6" });
  });

  it("3 位 HEX 展开为 6 位", () => {
    assert.deepEqual(normalizeColor("#abc"), { ok: true, hex: "#aabbcc", format: "hex3" });
  });

  it("RGB 函数、空格分隔、纯三元组、中文逗号都能转 HEX", () => {
    const cases = ["rgb(31,77,61)", "rgb(31 77 61)", "31,77,61", "31 77 61", "31，77，61"];
    for (const raw of cases) {
      const parsed = normalizeColor(raw);
      assert.equal(parsed.ok, true, `${raw} 应解析成功`);
      if (parsed.ok) assert.equal(parsed.hex, "#1f4d3d");
    }
  });

  it("0 / 255 边界分量合法", () => {
    assert.deepEqual(normalizeColor("rgb(0,0,0)"), { ok: true, hex: "#000000", format: "rgb" });
    assert.deepEqual(normalizeColor("255, 255, 255"), { ok: true, hex: "#ffffff", format: "triplet" });
  });
});

describe("normalizeColor：非法输入必须只提示、不产出色值", () => {
  it("拒绝 CSS 颜色名（复现用例：red 曾让预览变红但提交被拒）", () => {
    const parsed = normalizeColor("red");
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /不支持颜色名称/);
  });

  it("拒绝非法 HEX 与错误位数", () => {
    for (const raw of ["#zzzzzz", "#12345", "#1234567", "#"]) {
      assert.equal(normalizeColor(raw).ok, false, `${raw} 应被拒绝`);
    }
  });

  it("拒绝越界分量、透明度与小数", () => {
    for (const raw of ["256,0,0", "rgb(31,77,999)", "rgba(31,77,61,0.5)", "31.5,77,61"]) {
      assert.equal(normalizeColor(raw).ok, false, `${raw} 应被拒绝`);
    }
  });

  it("拒绝可能拼进 CSS 的注入字符，且错误信息给出修正建议", () => {
    for (const raw of ["red;background:url(x)", "#fff}</style>", "<script>", "rgb(1,2,3);evil"]) {
      const parsed = normalizeColor(raw);
      assert.equal(parsed.ok, false, `${raw} 应被拒绝`);
      if (!parsed.ok) assert.match(parsed.error, /支持|不支持|格式/);
    }
  });
});

describe("与后端契约 / 预设色板的一致性", () => {
  it("所有合法输出都通过 BrandColorSchema", () => {
    const samples = ["#1f4d3d", "#ABC", "rgb(31,77,61)", "31,77,61", ...BRAND_SWATCHES.map((s) => s.hex)];
    for (const raw of samples) {
      const parsed = normalizeColor(raw);
      assert.equal(parsed.ok, true, raw);
      if (parsed.ok && parsed.hex) {
        assert.equal(BrandColorSchema.safeParse(parsed.hex).success, true, `${raw} → ${parsed.hex}`);
        assert.equal(BRAND_COLOR_PATTERN.test(parsed.hex), true);
      }
    }
  });

  it("预设色板与默认取色值均为合法 6 位 HEX，且无重复", () => {
    assert.equal(BRAND_SWATCHES.length, 8);
    assert.equal(new Set(BRAND_SWATCHES.map((s) => s.hex)).size, BRAND_SWATCHES.length);
    for (const swatch of [...BRAND_SWATCHES.map((s) => s.hex), DEFAULT_PICKER_COLOR]) {
      assert.equal(BrandColorSchema.safeParse(swatch).success, true, swatch);
      assert.equal(normalizeHex(swatch), swatch.toLowerCase());
    }
  });

  it("非法值经 normalizeHex 一律返回 null，不进入预览与提交", () => {
    for (const raw of ["red", "#zzzzzz", "", "rgba(1,2,3,0.5)"]) {
      assert.equal(normalizeHex(raw), null, raw);
    }
  });

  it("hexToRgbLabel 还原通道值，便于用户理解 HEX↔RGB", () => {
    assert.equal(hexToRgbLabel("#1f4d3d"), "RGB 31, 77, 61");
    assert.equal(hexToRgbLabel("#dc2626"), "RGB 220, 38, 38");
    assert.equal(hexToRgbLabel("red"), "");
  });
});
