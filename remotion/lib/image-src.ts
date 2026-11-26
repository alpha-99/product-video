import { staticFile } from "remotion";

/**
 * 渲染时的图片地址解析（验收 P1-08）。
 *
 * Worker 会把本地磁盘图片转成受控 data URL 再传给 Composition，
 * 这样渲染进程不依赖 VPS 目录结构；预览时用 public/ 下的相对路径。
 *
 * 安全约束：绝不再把 http(s): / file: / blob: / 协议相对 URL 原样交给
 * Chromium。此前这类地址会被引擎直接请求，形成 SSRF 与本地文件读取面。
 * 提交契约与 renderer.resolveAssetForRender 已先行拦截，这里是渲染侧
 * 的最后一道 fail-closed 防线，本函数只做地址归一，不下载、不读盘。
 */
export function resolveImageSrc(src: string): string {
  if (!src) return src;

  // data URL：MIME 白名单与脚本检查在 shared/asset-path.schema.ts 完成。
  if (/^data:/i.test(src)) return src;

  const untrusted =
    /^[a-z][a-z0-9+.-]*:/i.test(src) ||
    src.startsWith("//") ||
    src.startsWith("/") ||
    src.includes("\\") ||
    src.includes("..") ||
    /[\u0000-\u001f]/.test(src);
  if (untrusted) {
    throw new Error(`不受信任的素材地址，已拒绝渲染：${src.slice(0, 80)}`);
  }

  // 其余按 Remotion staticFile 处理（public 目录下的相对路径）
  return staticFile(src.replace(/^\/+/, ""));
}
