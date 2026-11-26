/**
 * FFmpeg 截帧生成缩略图（方案 7.2 / 9）。
 *
 * 从已渲染的 MP4 中抽取一帧，等比缩放到约定宽度，输出 JPEG 到
 * thumbnails/{userId}/{jobId}.jpg。参数固定、可复现，不依赖系统 PATH：
 * 优先使用 Remotion 自带的 FFmpeg 二进制（与渲染同源），也允许通过
 * FFMPEG_PATH 指定外部二进制。
 *
 * 截帧失败是"非致命"的：成片已落盘时不应因缩略图导致整个任务失败，
 * 由调用方决定降级策略（返回错误或忽略）。
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { RenderInternals } from "@remotion/renderer";

const execFileAsync = promisify(execFile);

/** 缩略图默认规格：宽度 360，等比高度（9:16 → 640），JPEG 质量 4（约 2~31，越小越清晰）。 */
export const THUMBNAIL_WIDTH = 360;
export const THUMBNAIL_QUALITY = 4;
export const THUMBNAIL_TIMEOUT_MS = 60_000;

/**
 * 截帧时间点（秒）：方案未规定，取视频时长的 20% 且不超过 duration-0.1，
 * 避开片头序幕与片尾，保证缩略图有实际内容。
 */
export function resolveSeekSecond(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const ratioPoint = Math.min(durationSec * 0.2, durationSec - 0.1);
  return Math.max(0, Math.round(ratioPoint * 100) / 100);
}

/** 解析 FFmpeg 二进制与动态库环境。优先 FFMPEG_PATH，否则用 Remotion 内置。 */
export function resolveFfmpeg(): { binary: string; env: NodeJS.ProcessEnv } {
  const override = process.env.FFMPEG_PATH;
  if (override) {
    return { binary: override, env: { ...process.env } };
  }
  const binary = RenderInternals.getExecutablePath({
    type: "ffmpeg",
    indent: false,
    logLevel: "error",
    binariesDirectory: null,
  });
  // Windows 上 Remotion 的 FFmpeg 依赖同目录 DLL；参照 Remotion CLI 的做法把目录加入 PATH。
  const libDir = path.dirname(binary);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform === "win32") {
    env.PATH = `${libDir};${env.PATH ?? ""}`;
  } else if (process.platform === "darwin") {
    env.DYLD_LIBRARY_PATH = libDir;
  } else {
    env.LD_LIBRARY_PATH = libDir;
  }
  return { binary, env };
}

/** 构建截帧参数（纯函数，便于单测）。 */
export function buildThumbnailArgs({
  videoPath,
  outputPath,
  seekSecond,
  width = THUMBNAIL_WIDTH,
  quality = THUMBNAIL_QUALITY,
}: {
  videoPath: string;
  outputPath: string;
  seekSecond: number;
  width?: number;
  quality?: number;
}): string[] {
  if (!Number.isInteger(width) || width <= 0) throw new Error(`非法缩略图宽度: ${width}`);
  if (!Number.isFinite(seekSecond) || seekSecond < 0) throw new Error(`非法截帧时间: ${seekSecond}`);
  if (!Number.isInteger(quality) || quality < 2 || quality > 31) {
    throw new Error(`非法 JPEG 质量: ${quality}`);
  }
  return [
    "-y",
    "-ss", seekSecond.toFixed(2),
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", `scale=${width}:-2`,
    "-q:v", String(quality),
    "-update", "1",
    outputPath,
  ];
}

export interface ThumbnailResult {
  /** 相对 DATA_ROOT 的缩略图路径 */
  outputPath: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * 从本地 MP4 截取一帧生成缩略图。视频与输出均为服务端拼接的绝对路径。
 * 截帧失败（FFmpeg 缺失、视频损坏、超时）时抛出异常，由调用方决定降级策略。
 */
export async function extractThumbnail({
  videoPath,
  outputPath,
  durationSec,
}: {
  videoPath: string;
  outputPath: string;
  durationSec: number;
}): Promise<ThumbnailResult> {
  const { binary, env } = resolveFfmpeg();
  const seekSecond = resolveSeekSecond(durationSec);
  const args = buildThumbnailArgs({ videoPath, outputPath, seekSecond });

  await execFileAsync(binary, args, {
    env,
    timeout: THUMBNAIL_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  const bytes = await readFile(outputPath);
  // JPEG SOF 段解析出真实尺寸，不信任参数推算。
  const size = readJpegSize(bytes);
  if (!size) throw new Error(`缩略图不是合法 JPEG: ${outputPath}`);

  return { outputPath, width: size.width, height: size.height, bytes: bytes.length };
}

/** 从 JPEG 二进制中读取宽高（SOF0/SOF2 段），失败返回 null。 */
export function readJpegSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (
      marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3 ||
      marker === 0xc5 || marker === 0xc6 || marker === 0xc7 ||
      marker === 0xc9 || marker === 0xca || marker === 0xcb ||
      marker === 0xcd || marker === 0xce || marker === 0xcf
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}
