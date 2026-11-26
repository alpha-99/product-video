/**
 * 上传校验（方案 9.3 / 15.2）。
 *
 * 三重校验：原文件名扩展名白名单 + 表单声明 MIME 与扩展名一致 + 文件头 sniff。
 * 另限制单文件 ≤ 10MB、拒绝空文件；落盘文件名一律由服务端重新生成 UUID，
 * 原文件名只用来取扩展名，绝不参与路径拼接。
 *
 * 只放服务端模块（src/lib），避免 node:crypto 被打包进浏览器 shared bundle。
 */
import { randomUUID } from "node:crypto";
import { DomainError } from "./errors";
import { ErrorCode } from "../shared/api";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 扩展名白名单；SVG 不接收（可携带脚本，且文件头无法可靠 sniff）。 */
export const ALLOWED_IMAGE_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

export type ImageExtension = keyof typeof ALLOWED_IMAGE_TYPES;

/** 抛给 API 层的校验错误，字段信息用于统一错误包络。 */
export class UploadValidationError extends DomainError {
  constructor(message: string, field = "file") {
    super(ErrorCode.VALIDATION_ERROR, message, { [field]: message });
    this.name = "UploadValidationError";
  }
}

export interface UploadCandidate {
  bytes: Buffer;
  /** multipart 部件声明的 Content-Type。 */
  mimeType: string;
  /** 原始文件名，仅用于取扩展名；不进入落盘路径。 */
  filename?: string;
}

export interface ValidatedImageUpload {
  buffer: Buffer;
  extension: ImageExtension;
  mimeType: string;
  /** 服务端生成的新文件名，不含目录。 */
  storedName: string;
}

/** 从原始文件名取小写扩展名；路径分隔符与引号都视为普通字符，只取最后一段。 */
export function extensionFromFilename(filename: string): ImageExtension | undefined {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const match = base.match(/\.([a-z0-9]+)$/i);
  if (!match) return undefined;
  const extension = match[1].toLowerCase();
  return extension in ALLOWED_IMAGE_TYPES ? (extension as ImageExtension) : undefined;
}

/** 按文件头识别真实图片类型；无法识别返回 undefined。 */
export function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function normalizeMime(raw: string): string {
  return raw.split(";")[0].trim().toLowerCase();
}

/** 校验上传件；任一项不满足抛 UploadValidationError。 */
export function validateImageUpload(input: UploadCandidate): ValidatedImageUpload {
  const { bytes, mimeType, filename = "" } = input;

  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new UploadValidationError("文件不能为空");
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadValidationError(`图片不能超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`);
  }

  const extension = extensionFromFilename(filename);
  if (!extension) {
    throw new UploadValidationError("仅支持 JPG / PNG / WebP 图片");
  }

  const expectedMime = ALLOWED_IMAGE_TYPES[extension];
  if (normalizeMime(mimeType) !== expectedMime) {
    throw new UploadValidationError("文件类型与扩展名不一致");
  }

  const sniffed = sniffImageMime(bytes);
  if (!sniffed) {
    throw new UploadValidationError("无法识别图片格式");
  }
  if (sniffed !== expectedMime) {
    throw new UploadValidationError("文件内容与声明的类型不一致");
  }

  return {
    buffer: bytes,
    extension,
    mimeType: expectedMime,
    storedName: `${randomUUID()}.${extension}`,
  };
}

/** GET 读取时确认相对路径归属当前用户，防止改 path 参数越权读他人上传件。 */
export function isOwnedUploadPath(relativePath: string, userId: string): boolean {
  return (
    relativePath.startsWith(`uploads/${userId}/`) &&
    !relativePath.includes("..") &&
    !relativePath.includes("\\")
  );
}
