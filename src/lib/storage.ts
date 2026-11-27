/**
 * 文件存储路径与抽象层（方案第 9 章）。
 *
 * 刻意与渲染引擎解耦：Web 层（鉴权下载 / 上传等 API）只需要路径解析和
 * 文件读写，不应把 @remotion/bundler 拉进 Next.js 的 Web bundle。
 * 因此 DATA_ROOT / resolveDataPath / FileStorage 都在这个零重依赖模块里，
 * renderer.ts 与所有 API 路由都从这里导入。
 *
 * 当前实现 LocalFileStorage；未来换 S3/R2 时只需实现同一接口，业务代码不变。
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
export const DATA_ROOT = path.resolve(
  process.env.STORAGE_ROOT || path.join(ROOT, "data")
);

/** 把受控相对路径解析到 DATA_ROOT 内，拒绝绝对路径与 .. 穿越。 */
export function resolveDataPath(relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("..")) {
    throw new Error(`非法相对路径: ${relativePath}`);
  }
  const resolved = path.resolve(DATA_ROOT, relativePath);
  const prefix = DATA_ROOT.endsWith(path.sep) ? DATA_ROOT : `${DATA_ROOT}${path.sep}`;
  if (resolved !== DATA_ROOT && !resolved.startsWith(prefix)) {
    throw new Error(`路径越出数据根目录: ${relativePath}`);
  }
  return resolved;
}

/** 拼接一个位于 DATA_ROOT 内的相对路径（由服务端按 userId/jobId 构造）。 */
export function toDataRelative(...segments: string[]): string {
  return path.posix.join(...segments);
}

/** 路径片段只允许单层名称，杜绝用户输入的 /、\、.. 混入。 */
function assertSegment(segment: string, label: string): void {
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    /[\u0000-\u001f]/.test(segment)
  ) {
    throw new Error(`非法${label}: ${segment}`);
  }
}

/** 服务端构造相对路径时统一走这里，保证入库的相对路径是 POSIX 风格。 */
function buildRelative(...segments: string[]): string {
  segments.forEach((segment, index) => assertSegment(segment, `路径片段#${index}`));
  const relative = toDataRelative(...segments);
  // resolveDataPath 再做一次落点校验，双保险。
  resolveDataPath(relative);
  return relative;
}

/** 方案 9.1 目录规范：上传件 / 临时渲染 / 成片 / 缩略图。 */
export function uploadRelativePath(userId: string, productId: string, storedName: string): string {
  return buildRelative("uploads", userId, productId, storedName);
}

export function renderRelativeDir(jobId: string): string {
  return buildRelative("renders", jobId);
}

export function videoRelativePath(userId: string, jobId: string): string {
  return buildRelative("videos", userId, `${jobId}.mp4`);
}

export function thumbnailRelativePath(userId: string, jobId: string): string {
  return buildRelative("thumbnails", userId, `${jobId}.jpg`);
}

/**
 * 模板缩略图受控路径：thumbnails/{templateId}/{uuid}.{ext}（方案 V1.0 §6.3）。
 * templateId 是服务端查库得到的 UUID，storedName 由 upload.ts 生成，均不含 / 与 ..。
 */
export function templateThumbnailRelativePath(templateId: string, storedName: string): string {
  return buildRelative("thumbnails", "templates", templateId, storedName);
}

/** 读取鉴权缩略图时确认路径属于模板目录，杜绝改 path 越权读取。 */
export function isTemplateThumbnailPath(relativePath: string, templateId: string): boolean {
  return (
    relativePath.startsWith(`thumbnails/templates/${templateId}/`) &&
    !relativePath.includes("..") &&
    !relativePath.includes("\\")
  );
}

/**
 * 存储抽象（方案 9.2）。相对路径一律由服务端构造，接口内部二次校验。
 * getSignedPath 仅返回受控相对路径，供鉴权接口内部解析；它不是公开 URL。
 */
export interface FileStorage {
  save(file: Buffer, relativePath: string): Promise<string>;
  read(relativePath: string): Promise<Buffer>;
  delete(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  getSignedPath(relativePath: string): string;
}

export class LocalFileStorage implements FileStorage {
  async save(file: Buffer, relativePath: string): Promise<string> {
    const absolute = resolveDataPath(relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file);
    return this.getSignedPath(relativePath);
  }

  read(relativePath: string): Promise<Buffer> {
    return readFile(resolveDataPath(relativePath));
  }

  async delete(relativePath: string): Promise<void> {
    await rm(resolveDataPath(relativePath), { force: true });
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      return (await stat(resolveDataPath(relativePath))).isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  getSignedPath(relativePath: string): string {
    // 规范化为 POSIX 相对路径；不拼接域名，也不绕过鉴权。
    return path.relative(DATA_ROOT, resolveDataPath(relativePath)).split(path.sep).join("/");
  }
}

/** 全局单例：切换实现时只改这里。 */
export const fileStorage: FileStorage = new LocalFileStorage();
