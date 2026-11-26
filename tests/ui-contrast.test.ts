/**
 * UI 审核报告 §5.3 治理建议：把 token 对比度表固化为可执行的断言。
 *
 * 直接读取 src/app/globals.css 的 OKLCH token，按
 * OKLCH → OKLab → LMS′ → 线性 sRGB → WCAG 2.1 相对亮度实算，
 * 明/暗两套主题逐组校验。后续任何人改色，只要跌破阈值 CI 立即失败。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(__dirname, "..");
const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");

type Color = [number, number, number]; // OKLCH: L(0..1), C, h(deg)

function blockAfter(pattern: RegExp): string {
  const match = pattern.exec(css);
  assert.ok(match, `globals.css 缺少 ${pattern} 定义块`);
  const start = match.index + match[0].length;
  const end = css.indexOf("}", start);
  assert.ok(end > start, `${pattern} 定义块未闭合`);
  return css.slice(start, end);
}

function parseTokens(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(match[1], match[2].trim());
  }
  return map;
}

const light = parseTokens(blockAfter(/:root\s*\{/));
const dark = new Map([
  ...light,
  ...parseTokens(blockAfter(/:root\[data-theme="dark"\]\s*\{/)),
]);

function oklch(value: string): Color {
  const match = value.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  assert.ok(match, `不是可解析的 OKLCH 值: ${value}`);
  return [Number(match[1]) / 100, Number(match[2]), Number(match[3])];
}

function colorOf(tokens: Map<string, string>, name: string, seen = new Set<string>()): Color {
  assert.ok(!seen.has(name), `token 循环引用: ${name}`);
  const raw = tokens.get(name);
  assert.ok(raw, `缺少 token ${name}`);
  seen.add(name);
  if (raw.startsWith("var(")) {
    const ref = raw.slice(4, -1).trim();
    return colorOf(tokens, ref, seen);
  }
  return oklch(raw);
}

/** OKLab → 线性 sRGB（矩阵来自 Björn Ottosson 的 OKLab 定义）。 */
function toLinearRgb([L, C, h]: Color): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function relativeLuminance(color: Color): number {
  const [r, g, b] = toLinearRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: Color, bg: Color): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

interface Pair {
  label: string;
  fg: string;
  bg: string;
  min: number;
}

const TEXT_PAIRS: Pair[] = [
  { label: "正文 --ink / 纸底", fg: "--ink", bg: "--paper", min: 4.5 },
  { label: "次级正文 --ink-2 / 纸底", fg: "--ink-2", bg: "--paper", min: 4.5 },
  { label: "次要文字 --ink-3 / 纸底", fg: "--ink-3", bg: "--paper", min: 4.5 },
  { label: "次要文字 --ink-3 / 卡片", fg: "--ink-3", bg: "--surface", min: 4.5 },
  { label: "次要文字 --ink-3 / 浅灰底", fg: "--ink-3", bg: "--paper-2", min: 4.5 },
  { label: "徽章 · 已完成", fg: "--success-fg", bg: "--success-soft", min: 4.5 },
  { label: "徽章 · 渲染中", fg: "--info-fg", bg: "--info-soft", min: 4.5 },
  { label: "徽章 · 等待中", fg: "--warning-fg", bg: "--warning-soft", min: 4.5 },
  { label: "徽章 · 失败", fg: "--error-fg", bg: "--error-soft", min: 4.5 },
  { label: "品牌文字 --brand-fg / 纸底", fg: "--brand-fg", bg: "--paper", min: 4.5 },
  { label: "品牌文字 --brand-fg / 卡片", fg: "--brand-fg", bg: "--surface", min: 4.5 },
  { label: "焦点环 / 纸底", fg: "--focus-ring", bg: "--paper", min: 3 },
  { label: "焦点环 / 卡片", fg: "--focus-ring", bg: "--surface", min: 3 },
];

describe("UI 整改：globals.css token 定义完整", () => {
  it("浅色与暗色都定义了独立的语义前景与焦点环 token", () => {
    for (const name of [
      "--success-fg", "--info-fg", "--warning-fg", "--error-fg",
      "--brand-fg", "--focus-ring", "--error-solid",
    ]) {
      assert.ok(light.has(name), `浅色缺少 ${name}`);
    }
    // H-01：暗色必须重定义语义前景，不能只换 soft 底色。
    const darkOnly = parseTokens(blockAfter(/:root\[data-theme="dark"\]\s*\{/));
    for (const name of ["--success-fg", "--info-fg", "--warning-fg", "--error-fg", "--focus-ring"]) {
      assert.ok(darkOnly.has(name), `暗色必须单独重定义 ${name}`);
    }
  });

  it("字体为本地自托管，不再依赖 Google Fonts @import", () => {
    assert.doesNotMatch(css, /@import\s+url\(\s*["']?https:\/\/fonts\.googleapis\.com/);
    assert.match(css, /@font-face[\s\S]*?fraunces-latin-var\.woff2/);
    assert.match(css, /@font-face[\s\S]*?plus-jakarta-sans-latin-var\.woff2/);
    assert.match(css, /font-display:\s*swap/);
  });

  it("R-01 三档断点与 R-05 容器查询均已落地", () => {
    assert.match(css, /@media\s*\(min-width:\s*1024px\)/);
    assert.match(css, /@media\s*\(max-width:\s*1023px\)/);
    assert.match(css, /@media\s*\(max-width:\s*639px\)/);
    assert.match(css, /container-type:\s*inline-size/);
    assert.match(css, /@container/);
  });

  it("A-04 图标按钮与按钮变体不小于 44px", () => {
    const iconBtn = css.match(/\.icon-btn\s*\{([^}]+)\}/);
    assert.ok(iconBtn, "缺少 .icon-btn 定义");
    assert.match(iconBtn[1], /width:\s*44px/);
    assert.match(iconBtn[1], /height:\s*44px/);
    assert.doesNotMatch(css, /\.btn-sm\s*\{[^}]*min-height:\s*36px/);
  });
});

for (const [theme, tokens] of [["浅色", light], ["暗色", dark]] as const) {
  describe(`UI 整改：${theme}主题 WCAG 对比度（A-01 / A-02）`, () => {
    for (const pair of TEXT_PAIRS) {
      it(`${pair.label} ≥ ${pair.min}:1`, () => {
        const value = contrast(
          colorOf(tokens, pair.fg),
          colorOf(tokens, pair.bg)
        );
        assert.ok(
          value >= pair.min,
          `${theme} ${pair.label} 实测 ${value.toFixed(2)}:1，低于 ${pair.min}:1`
        );
      });
    }

    it("危险按钮/错误 Toast 的白字对实心底 ≥ 4.5:1", () => {
      const white: Color = [1, 0, 0];
      const value = contrast(white, colorOf(tokens, "--error-solid"));
      assert.ok(value >= 4.5, `白字/--error-solid 实测 ${value.toFixed(2)}:1`);
    });
  });
}
