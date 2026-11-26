import { z } from "zod";
import { ErrorCode, type ApiResponse } from "./api";

/**
 * API 边界校验：把 ZodError 转成方案 5.2 的统一错误包络。
 * 字段级错误直接回填 fields，前端可精确定位到具体输入框。
 */
export function toFieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: ApiResponse<never> };

export function parseRequest<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown
): ParseResult<z.infer<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };

  return {
    ok: false,
    response: {
      ok: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: "参数校验失败",
        fields: toFieldErrors(result.error),
      },
    },
  };
}
