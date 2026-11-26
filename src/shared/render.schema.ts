import { z } from "zod";
import { TemplateIdSchema } from "./template.schema";
import { ProductVideoPropsSchema } from "./video-props.schema";

/**
 * 渲染任务输入契约（方案 7.2）：Worker 把 input.json 写到
 * renders/{jobId}/input.json，渲染器只读这个文件，不依赖 HTTP 请求体。
 */
export const RenderJobInputSchema = z.object({
  jobId: z.string().uuid(),
  userId: z.string().uuid(),
  compositionId: TemplateIdSchema,
  props: ProductVideoPropsSchema,
});
export type RenderJobInput = z.infer<typeof RenderJobInputSchema>;

/** 渲染结果：路径均为相对 DATA_ROOT 的相对路径，便于入库与鉴权读取。 */
export interface RenderResult {
  jobId: string;
  outputPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  /** 缩略图相对路径；截帧失败时为 undefined，成片仍有效。 */
  thumbnailPath?: string;
  /** 缩略图生成失败原因（降级），便于 Worker 记录告警或重试。 */
  thumbnailError?: string;
}
