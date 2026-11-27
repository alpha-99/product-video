import { z } from "zod";
import { TemplatePatchSchema } from "./admin-schemas";

/** 编辑模板运营元数据的入参（version 必填用于乐观锁）。 */
export type TemplatePatchInput = z.infer<typeof TemplatePatchSchema>;

export { TemplatePatchSchema };
