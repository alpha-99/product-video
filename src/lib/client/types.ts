/** 前端 DTO：与后端 /api/* 响应对齐，避免页面里散落 any。 */

/**
 * 任务最大尝试次数，与 src/lib/queue.ts 的 MAX_ATTEMPTS 保持一致。
 * 前端据此决定「重试」按钮是否可用，避免展示后端必然拒绝的操作。
 */
export const MAX_JOB_ATTEMPTS = 3;

export interface Me {
  id: string;
  email: string;
  quotaLeft: number;
  /** 仅用于前端是否显示管理入口；权限一律由服务端查库判定，前端 role 不作数。 */
  role: "user" | "admin";
  createdAt: string;
}

export interface TemplateDto {
  id: string;
  name: string;
  category: string;
  compositionId: string;
  durationSec: number;
  thumbnailPath: string | null;
  /** 旧字段（保持兼容，值同步为 DB 新值） */
  label: string;
  description: string;
  tone: string;
  /** V1.0 新增：运营元数据（DB 单一真源） */
  displayName: string;
  englishName: string;
  cta: string;
  sortOrder: number;
  /** 鉴权缩略图地址；缺失为 null，前端降级 CSS 示意 */
  thumbnailUrl: string | null;
}

export interface ProductDto {
  id: string;
  name: string;
  imagePath: string;
  description?: string;
  price?: string;
  sellingPoints: string[];
  brandName?: string;
  brandLogoPath?: string;
  brandColor?: string;
}

export interface RenderCopy {
  title: string;
  subtitle: string;
  sellingPoints: string[];
  cta: string;
}

export interface AiCopyResponse {
  copy: {
    videoTitle: string;
    subtitle: string;
    sellingPoints: string[];
    cta: string;
  };
  model: string | null;
  cached: boolean;
  /** AI 输出被截断的字段说明（验收 P2-03）。 */
  truncated?: string[];
}

export interface RenderOptions {
  brandColor?: string;
  logoPath?: string;
  music?: string;
  originalPrice?: string;
  discountText?: string;
}

export interface CreateVideoBody {
  productId: string;
  templateId: string;
  copy: RenderCopy;
  options?: RenderOptions;
}

export interface CreateVideoResult {
  jobId: string;
  status: string;
  created: boolean;
}

/** 任务快照里的渲染 props，与 ProductVideoPropsSchema 对齐（前端只读展示用）。 */
export interface JobSnapshotProps {
  title: string;
  subtitle: string;
  imageUrl: string;
  price?: string;
  originalPrice?: string;
  discountText?: string;
  sellingPoints: string[];
  cta: string;
  brandColor: string;
  logoPath?: string;
  musicPath?: string;
}

/** 提交时写入 input_json 的快照；Worker 只读它，不回查商品。 */
export interface JobSnapshot {
  jobId: string;
  userId: string;
  compositionId: string;
  props: JobSnapshotProps;
}

export interface VideoJobDto {
  id: string;
  userId: string;
  productId: string;
  templateId: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  inputJson: JobSnapshot | null;
  outputPath: string | null;
  thumbnailPath: string | null;
  errorMessage: string | null;
  attempt: number;
  idempotencyKey: string;
  createdAt: string;
  completedAt: string | null;
}

export interface UploadResult {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

export const STATUS_META: Record<
  VideoJobDto["status"],
  { label: string; tone: "ok" | "processing" | "wait" | "fail" | "neutral" }
> = {
  completed: { label: "已完成", tone: "ok" },
  processing: { label: "渲染中", tone: "processing" },
  pending: { label: "等待中", tone: "wait" },
  failed: { label: "失败", tone: "fail" },
  cancelled: { label: "已取消", tone: "neutral" },
};
