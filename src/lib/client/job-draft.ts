/**
 * 失败任务「重新编辑」的草稿反解（纯函数，不碰数据库、不碰 DOM）。
 *
 * 数据源是提交时写入 input_json 的 RenderJobInput 快照：服务端已按
 * ProductVideoPropsSchema 校验过，这里再做一次防御性读取，避免历史脏数据
 * 或字段缺失把创作页表单带进非法状态。
 *
 * 安全边界：本函数只产出「回填表单的初值」，不参与提交。用户确认后仍走标准
 * POST /api/videos，由 createVideoJob 完整校验商品归属、模板启用与参数 schema。
 */
import type { RenderCopy, VideoJobDto } from "./types";

/** 创作页能回填的字段；Logo / 音乐 / 促销文案本期未开放输入，见 P2-07。 */
export interface JobDraft {
  productId: string;
  templateId: string;
  copy: RenderCopy;
  pointsText: string;
  brandColor: string;
  /** 快照里存在但创作页不开放的高级参数，回填后需在界面提示会丢失。 */
  droppedAdvanced: string[];
}

const ADVANCED_LABELS: Array<[keyof NonNullable<VideoJobDto["inputJson"]>["props"], string]> = [
  ["logoPath", "品牌 Logo"],
  ["musicPath", "背景音乐"],
  ["originalPrice", "划线原价"],
  ["discountText", "促销文案"],
];

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 从任务详情反解创作页草稿。任何必需字段缺失或不合法都返回 null，
 * 调用方据此降级为普通新建，绝不把半截草稿塞进表单。
 */
export function draftFromJob(job: VideoJobDto | null | undefined): JobDraft | null {
  const props = job?.inputJson?.props;
  if (!job || !props) return null;

  const { title, subtitle, sellingPoints, cta, brandColor } = props;
  if (!nonEmptyString(title) || !nonEmptyString(subtitle) || !nonEmptyString(cta)) return null;
  if (!Array.isArray(sellingPoints) || sellingPoints.length === 0) return null;
  const points = sellingPoints.filter(nonEmptyString);
  if (points.length === 0) return null;
  if (typeof brandColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(brandColor)) return null;
  if (!nonEmptyString(job.productId) || !nonEmptyString(job.templateId)) return null;

  const droppedAdvanced = ADVANCED_LABELS.filter(([key]) => nonEmptyString(props[key])).map(
    ([, label]) => label
  );

  return {
    productId: job.productId,
    templateId: job.templateId,
    copy: {
      title: title.trim(),
      subtitle: subtitle.trim(),
      sellingPoints: points.map((p) => p.trim()),
      cta: cta.trim(),
    },
    pointsText: points.map((p) => p.trim()).join(" · "),
    brandColor,
    droppedAdvanced,
  };
}
