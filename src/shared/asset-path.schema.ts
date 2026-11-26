import { z } from "zod";

/**
 * 渲染素材地址契约（验收 P1-08）。
 *
 * 背景：options.logoPath / music 之前是宽松的 z.string()，renderer.ts 与
 * remotion/lib/image-src.ts 又对 `https?:` / `blob:` / `file:` 原样透传，
 * 客户端可以绕过前端直接把外部 URL 写进渲染快照，让 Remotion Chromium
 * 向任意地址发起请求（SSRF / 内网探测 / 本地文件读取）。
 *
 * 防线分两层：
 *   1) 提交契约：只接受「受控 data URL」或「站内相对路径」，任何 scheme
 *      与绝对路径在入库前就被拒绝；
 *   2) 渲染层：resolveAssetForRender 进一步要求相对路径必须位于
 *      uploads/{userId}/ 受控目录，杜绝读 DATA_ROOT 下其它文件。
 */

/** 允许进入渲染进程的 data URL 媒体类型；不含 text/html、application/* 等。 */
const ALLOWED_DATA_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
]);

/** data URL 里携带脚本的 SVG 会被引擎执行，必须拒绝。 */
function containsScript(text: string): boolean {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // 非法百分号编码按原文检查即可。
  }
  return /<script|javascript:|on\w+\s*=/i.test(decoded);
}

export function isAllowedDataUrl(src: string): boolean {
  if (!src.startsWith("data:")) return false;
  const header = /^data:([a-z0-9.+/-]+);([^,]*),/i.exec(src);
  if (!header) return false;
  if (!ALLOWED_DATA_MIME.has(header[1].toLowerCase())) return false;
  return !containsScript(src.slice(header[0].length));
}

/**
 * 站内相对路径：拒绝任何协议（含 file: / https: / javascript:）、
 * 协议相对 URL、绝对路径、路径穿越与反斜杠，避免拼出非预期磁盘位置。
 */
export function isSafeRelativeAssetPath(src: string): boolean {
  if (!src || src.length > 2048) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false;
  if (src.startsWith("//") || src.startsWith("/") || src.startsWith("\\")) return false;
  if (src.includes("..") || src.includes("\\") || /[\u0000-\u001f]/.test(src)) return false;
  return true;
}

/** 渲染层专用：相对素材必须落在 uploads/{用户目录}/ 下，且至少有两级目录。 */
export function isOwnedUploadAssetPath(src: string): boolean {
  return isSafeRelativeAssetPath(src) && /^uploads\/[^/]+\/[^/]+/.test(src);
}

/** 提交 / 快照契约：data URL 或站内相对路径，二者之外一律拒绝。 */
export const RenderAssetSrcSchema = z
  .string()
  .min(1, "素材地址不能为空")
  .refine(
    (src) => isAllowedDataUrl(src) || isSafeRelativeAssetPath(src),
    "素材必须是受控 data URL 或站内相对路径，不接受外部链接、file: 地址与绝对路径"
  );

/** 商品图片只接受站内相对路径（必须是上传件，不允许内联 data URL）。 */
export const SafeRelativePathSchema = z
  .string()
  .min(1, "路径不能为空")
  .refine(isSafeRelativeAssetPath, "必须是站内相对路径，不接受外部链接、file: 地址与绝对路径");
