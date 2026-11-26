/**
 * 品牌色输入解析（创作向导第 4 步「渲染参数」）。
 *
 * 产品规则：
 * - 主路径是「直接选色」（预设色板 + 原生取色器），不需要用户懂色值格式；
 * - 高级路径允许手工输入 HEX / RGB，属于进阶玩法，默认折叠；
 * - 无论哪种输入，对外只输出规范化的 `#rrggbb` 或空（= 使用模板默认配色），
 *   与后端 BrandColorSchema / RenderOptionsSchema 契约保持一致，
 *   Remotion 模板里 `${brandColor}33` 这类 8 位 HEX 拼接也依赖 6 位格式。
 *
 * 本模块是纯函数，零运行时依赖，便于单测直接覆盖。
 */

export const BRAND_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
export const DEFAULT_PICKER_COLOR = "#1f4d3d";

export interface BrandSwatch {
  hex: string;
  label: string;
}

/** 预设品牌色板：取自项目设计 token 与 4 套模板默认色，均为 6 位 HEX。 */
export const BRAND_SWATCHES: readonly BrandSwatch[] = [
  { hex: "#1f4d3d", label: "深墨绿" },
  { hex: "#0f766e", label: "青绿" },
  { hex: "#2563eb", label: "品牌蓝" },
  { hex: "#dc2626", label: "促销红" },
  { hex: "#1f2937", label: "墨黑" },
  { hex: "#c8a45c", label: "香槟金" },
  { hex: "#f4efe7", label: "暖白" },
  { hex: "#6d5bd0", label: "雅紫" },
];

export type ColorFormat = "empty" | "hex3" | "hex6" | "rgb" | "triplet";

export type ParsedColor =
  | { ok: true; hex: string | null; format: ColorFormat }
  | { ok: false; error: string };

const FORMAT_HINT = "支持 #RRGGBB、#RGB、rgb(31,77,61) 或 31,77,61（每个分量 0–255）";

function channelToHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function fromChannels(parts: string[], format: "rgb" | "triplet"): ParsedColor {
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return { ok: false, error: `RGB 每个分量必须是 0–255 的整数；${FORMAT_HINT}` };
  }
  return {
    ok: true,
    hex: `#${numbers.map(channelToHex).join("")}`,
    format,
  };
}

/**
 * 解析用户输入 → 规范化色值。
 * - 空字符串视为「清除，使用模板默认」，不是错误；
 * - 拒绝 CSS 颜色名（如 red）与任何可能拼进 CSS 的额外字符，
 *   避免出现「预览生效但提交被后端拒绝」的所见非所得；
 * - 解析失败时返回可直接展示给用户的中文原因。
 */
export function normalizeColor(raw: string): ParsedColor {
  const value = raw.trim();
  if (!value) return { ok: true, hex: null, format: "empty" };

  // 注入防护：除 rgb(...) 形式外，禁止括号/分号/尖括号/引号/斜杠等字符。
  if (!/^rgba?\(/i.test(value) && /[;{}<>()\[\]"'`\\/]/.test(value)) {
    return { ok: false, error: `色值包含不支持的字符；${FORMAT_HINT}` };
  }

  const hex = value.startsWith("#") ? value.slice(1) : value;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const expanded = hex
      .split("")
      .map((ch) => ch + ch)
      .join("")
      .toLowerCase();
    return { ok: true, hex: `#${expanded}`, format: "hex3" };
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return { ok: true, hex: `#${hex.toLowerCase()}`, format: "hex6" };
  }

  // rgb(31,77,61) / rgb(31 77 61)；rgba 与 4 分量不进入此分支，统一给出明确提示。
  const rgbMatch = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)$/i.exec(value);
  if (rgbMatch) return fromChannels(rgbMatch.slice(1, 4), "rgb");
  if (/^rgba?\(/i.test(value)) {
    return { ok: false, error: `不支持透明度或该 RGB 写法；${FORMAT_HINT}` };
  }

  // 31,77,61 / 31 77 61 / 31，77，61
  const triplet = /^(\d{1,3})\s*[,，\s]\s*(\d{1,3})\s*[,，\s]\s*(\d{1,3})$/.exec(value);
  if (triplet) return fromChannels(triplet.slice(1, 4), "triplet");

  if (/^[a-zA-Z]+$/.test(value)) {
    return { ok: false, error: `不支持颜色名称「${value}」，请改用数值色值；${FORMAT_HINT}` };
  }
  return { ok: false, error: `色值格式不正确；${FORMAT_HINT}` };
}

/** 把规范化 HEX 转成便于阅读的 RGB 文案，例如 RGB 31, 77, 61。 */
export function hexToRgbLabel(hex: string): string {
  const parsed = normalizeColor(hex);
  if (!parsed.ok || !parsed.hex) return "";
  const value = parsed.hex.slice(1);
  const channels = [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
  return `RGB ${channels.join(", ")}`;
}

/** 原生取色器 / 色板的值统一转小写 6 位 HEX，非法值不得进入后续链路。 */
export function normalizeHex(hex: string): string | null {
  const parsed = normalizeColor(hex);
  return parsed.ok ? parsed.hex : null;
}
