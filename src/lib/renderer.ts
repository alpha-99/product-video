/**
 * 正式渲染封装（方案 7.2 / 9）。
 *
 * 流程：input.json → Zod 校验 → 素材转 data URL → 选择 Composition →
 * 渲染到 renders/{jobId}/temp.mp4 → FFmpeg 截帧 thumbnails/{userId}/{jobId}.jpg
 * → 原子移动到 videos/{userId}/{jobId}.mp4 → 清理临时目录。
 * 缩略图失败是降级的（成片已落盘不回滚），错误写入结果的 thumbnailError。
 *
 * 约束：单进程串行渲染；单任务 10 分钟超时；所有路径由服务端拼接，
 * 禁止用户输入直接作为路径。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { getCompositions, renderMedia } from "@remotion/renderer";
import {
  RenderJobInputSchema,
  type RenderJobInput,
  type RenderResult,
} from "../shared/render.schema";
import { getTemplate } from "../shared/template.schema";
import type { ProductVideoProps } from "../shared/video-props.schema";
import { isAllowedDataUrl, isOwnedUploadAssetPath } from "../shared/asset-path.schema";
import { extractThumbnail } from "./thumbnail";
import {
  renderRelativeDir,
  resolveDataPath,
  thumbnailRelativePath,
  videoRelativePath,
} from "./storage";

// re-export：保留既有调用方（render.test.ts 等）的导入路径。
export { resolveDataPath } from "./storage";

const ROOT = process.cwd();
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** 项目自带静态占位图：历史快照可能引用它，属于服务端资源而非用户可控路径。 */
const PUBLIC_PLACEHOLDER_ASSETS = new Set(["placeholder-product.svg"]);
const PUBLIC_DIR = path.join(ROOT, "public");

function describeAsset(src: string): string {
  return src.length > 120 ? `${src.slice(0, 120)}…` : src;
}

/**
 * 渲染素材 → data URL（验收 P1-08 的渲染层最后防线）。
 *
 * 只允许三类输入：
 *   - 白名单 MIME 且不含脚本的 data URL，原样交给 Chromium；
 *   - uploads/{userId}/ 下的站内相对路径，由服务端读盘转成 data URL；
 *   - 项目自带占位图白名单（历史快照兼容，从 public/ 读取后内联）。
 *
 * 外部 http(s): / file: / blob: / //host、绝对路径与路径穿越一律抛错，
 * 避免渲染进程向任意地址发起请求或读取本机任意文件。错误消息带上字段名与
 * 被拒的值，Worker 日志才能定位是 imageUrl 还是 logoPath、值是什么。
 */
export async function resolveAssetForRender(src: string, field = "素材"): Promise<string> {
  if (!src) return src;
  if (isAllowedDataUrl(src)) return src;

  // 历史任务可能引用项目静态占位图（不在 uploads/ 下）。按白名单从 public/
  // 读取，不接受任意相对路径，避免把 DATA_ROOT 下其它文件带进渲染进程。
  if (PUBLIC_PLACEHOLDER_ASSETS.has(src)) {
    const buffer = await readFile(path.join(PUBLIC_DIR, src));
    return `data:image/svg+xml;base64,${buffer.toString("base64")}`;
  }

  if (!isOwnedUploadAssetPath(src)) {
    throw new Error(
      `素材地址不受信任（${field}=${describeAsset(src)}）：仅允许受控 data URL 或 uploads/{userId}/ 相对路径`
    );
  }

  const absolute = resolveDataPath(src);
  const buffer = await readFile(absolute);
  const ext = path.extname(absolute).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw new Error(`不支持的图片格式: ${ext || "(无扩展名)"}`);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * 只把图片类字段转成 data URL；音频路径本期模板未接入，保持原样不参与渲染。
 * Logo 属于装饰素材：历史商品可能带非 uploads/ 前缀的路径，单独降级为
 * 「不显示 Logo」并记结构化告警，不让整条出片任务因此失败。
 */
export async function prepareInputProps(
  props: ProductVideoProps
): Promise<ProductVideoProps> {
  let logoPath: string | undefined;
  if (props.logoPath) {
    try {
      logoPath = await resolveAssetForRender(props.logoPath, "logoPath");
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "logo_asset_rejected",
          reason: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
  return {
    ...props,
    imageUrl: await resolveAssetForRender(props.imageUrl, "imageUrl"),
    ...(logoPath ? { logoPath } : {}),
  };
}

// Bundle 一次即可被多个任务复用；失败时清空缓存以允许重试。
let bundlePromise: Promise<string> | undefined;
export function getBundleLocation(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = bundle({
      entryPoint: path.join(ROOT, "remotion", "index.ts"),
      publicDir: path.join(ROOT, "public"),
      outDir: path.join(os.tmpdir(), `product-video-remotion-${process.pid}`),
    }).catch((err: unknown) => {
      bundlePromise = undefined;
      throw err;
    });
  }
  return bundlePromise;
}

/** 串行队列：MVP 单任务并发，避免多个 Chrome 进程打爆 VPS。 */
let queue: Promise<unknown> = Promise.resolve();
export function withRenderLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function renderVideo(input: RenderJobInput): Promise<RenderResult> {
  return withRenderLock(async () => {
    const job = RenderJobInputSchema.parse(input);
    const template = getTemplate(job.compositionId);

    const tempDirRel = renderRelativeDir(job.jobId);
    const outputRel = videoRelativePath(job.userId, job.jobId);
    const thumbnailRel = thumbnailRelativePath(job.userId, job.jobId);
    const tempDir = resolveDataPath(tempDirRel);
    const tempVideo = path.join(tempDir, "temp.mp4");
    const tempThumb = path.join(tempDir, "thumb.jpg");
    const outputPath = resolveDataPath(outputRel);
    const thumbnailPath = resolveDataPath(thumbnailRel);

    // 上次进程崩溃 / EPIPE 可能在 renders/{jobId}/ 留下 temp.mp4 与残留句柄；
    // Windows 上覆盖被占用文件会让预启动 ffmpeg 直接退出、写帧通道报 EPIPE，
    // 形成「重启 Worker → 同一任务再崩」的循环。每次渲染从干净目录开始。
    await rm(tempDir, { recursive: true, force: true });
    await mkdir(tempDir, { recursive: true });
    await writeFile(
      path.join(tempDir, "input.json"),
      JSON.stringify(job, null, 2),
      "utf8"
    );

    const inputProps = await prepareInputProps(job.props);
    const serveUrl = await getBundleLocation();
    const compositions = await getCompositions(serveUrl, { inputProps });
    const composition = compositions.find((c) => c.id === job.compositionId);
    if (!composition) throw new Error(`Composition 不存在: ${job.compositionId}`);

    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: tempVideo,
      inputProps,
      timeoutInMilliseconds: RENDER_TIMEOUT_MS,
    });

    // 截帧：临时文件放在同一 tempDir，成片落盘失败时缩略图也不会泄漏到正式目录。
    let thumbInfo: { outputPath: string; width: number; height: number } | undefined;
    let thumbnailError: string | undefined;
    try {
      const result = await extractThumbnail({
        videoPath: tempVideo,
        outputPath: tempThumb,
        durationSec: template.durationSec,
      });
      await mkdir(path.dirname(thumbnailPath), { recursive: true });
      await rename(tempThumb, thumbnailPath);
      thumbInfo = result;
    } catch (err) {
      // 降级：成片已渲染成功，截帧失败不回滚视频，只记录原因供 Worker 告警/重试。
      thumbnailError = err instanceof Error ? err.message : String(err);
    }

    // 同文件系统内 rename 是原子操作；落盘完成后才清理临时目录。
    await mkdir(path.dirname(outputPath), { recursive: true });
    await rename(tempVideo, outputPath);
    await rm(tempDir, { recursive: true, force: true }).catch(() => {
      // 清理失败不影响成片，交给阶段九的定期清理任务兜底。
    });

    return {
      jobId: job.jobId,
      outputPath: outputRel,
      durationSec: template.durationSec,
      width: template.width,
      height: template.height,
      fps: template.fps,
      ...(thumbInfo ? { thumbnailPath: thumbnailRel } : {}),
      ...(thumbnailError ? { thumbnailError } : {}),
    };
  });
}
