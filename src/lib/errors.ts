import { ErrorCode, type ErrorCodeValue } from "../shared/api";

/** 领域错误：携带稳定的错误码，由 API 层统一映射为 HTTP 状态与响应包络。 */
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCodeValue,
    message: string,
    public readonly fields?: Record<string, string>,
    /** 可恢复错误（如上游 429）建议的重试等待，随响应包络下发。 */
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const errors = {
  unauthorized: (msg = "未认证") => new DomainError(ErrorCode.UNAUTHORIZED, msg),
  forbidden: (msg = "无权访问该资源") => new DomainError(ErrorCode.FORBIDDEN, msg),
  notFound: (msg = "资源不存在") => new DomainError(ErrorCode.NOT_FOUND, msg),
  validation: (msg = "参数校验失败", fields?: Record<string, string>) =>
    new DomainError(ErrorCode.VALIDATION_ERROR, msg, fields),
  quotaExceeded: (msg = "剩余额度不足") => new DomainError(ErrorCode.QUOTA_EXCEEDED, msg),
  rateLimited: (msg = "操作过于频繁，请稍后再试") =>
    new DomainError(ErrorCode.RATE_LIMITED, msg),
  aiUnavailable: (msg = "文案生成服务暂时不可用，请稍后重试或手工填写", retryAfterMs?: number) =>
    new DomainError(ErrorCode.AI_UNAVAILABLE, msg, undefined, retryAfterMs),
  internal: (msg = "服务内部错误") => new DomainError(ErrorCode.INTERNAL_ERROR, msg),
};

/** 错误码 → HTTP 状态（方案 5.2）。 */
export function httpStatusFor(code: ErrorCodeValue): number {
  switch (code) {
    case ErrorCode.UNAUTHORIZED:
      return 401;
    case ErrorCode.FORBIDDEN:
      return 403;
    case ErrorCode.NOT_FOUND:
      return 404;
    case ErrorCode.VALIDATION_ERROR:
      return 400;
    case ErrorCode.QUOTA_EXCEEDED:
      return 402;
    case ErrorCode.RATE_LIMITED:
      return 429;
    case ErrorCode.AI_UNAVAILABLE:
      return 503;
    default:
      return 500;
  }
}
