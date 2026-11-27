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

  // ---- 模板管理 ----
  templateConflict: (msg = "模板已被他人修改，请刷新后重试") =>
    new DomainError(ErrorCode.TEMPLATE_CONFLICT, msg),
  templateLastEnabled: (msg = "这是最后一套可渲染的启用模板，停用后全站将无法创作") =>
    new DomainError(ErrorCode.TEMPLATE_LAST_ENABLED, msg),
  templateNotRegistered: (msg = "模板未注册到渲染注册表，禁止启用") =>
    new DomainError(ErrorCode.TEMPLATE_NOT_REGISTERED, msg),

  // ---- 角色与提权复核 ----
  roleSelfChange: (msg = "不能修改自己的角色") =>
    new DomainError(ErrorCode.ROLE_SELF_CHANGE, msg),
  roleDirectGrantForbidden: (msg = "禁止绕过复核单直接授予管理员权限") =>
    new DomainError(ErrorCode.ROLE_DIRECT_GRANT_FORBIDDEN, msg),
  roleApproverConflict: (msg = "不能批准自己发起的提权申请") =>
    new DomainError(ErrorCode.ROLE_APPROVER_CONFLICT, msg),
  roleNeedsSecondAdmin: (msg = "管理员不足 2 名，请通过运维脚本补齐备用账号后再发起提权") =>
    new DomainError(ErrorCode.ROLE_NEEDS_SECOND_ADMIN, msg),
  roleLastAdmin: (msg = "不能撤销最后一名管理员") =>
    new DomainError(ErrorCode.ROLE_LAST_ADMIN, msg),
  roleRequestExpired: (msg = "提权申请已超过 24 小时有效期，请重新发起") =>
    new DomainError(ErrorCode.ROLE_REQUEST_EXPIRED, msg),
  roleRequestConflict: (msg = "提权申请状态已变更，请刷新后重试") =>
    new DomainError(ErrorCode.ROLE_REQUEST_CONFLICT, msg),
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
    case ErrorCode.TEMPLATE_CONFLICT:
    case ErrorCode.TEMPLATE_LAST_ENABLED:
    case ErrorCode.TEMPLATE_NOT_REGISTERED:
    case ErrorCode.ROLE_NEEDS_SECOND_ADMIN:
    case ErrorCode.ROLE_LAST_ADMIN:
    case ErrorCode.ROLE_REQUEST_EXPIRED:
    case ErrorCode.ROLE_REQUEST_CONFLICT:
      return 409;
    case ErrorCode.ROLE_SELF_CHANGE:
    case ErrorCode.ROLE_APPROVER_CONFLICT:
      return 403;
    case ErrorCode.ROLE_DIRECT_GRANT_FORBIDDEN:
      return 400;
    default:
      return 500;
  }
}
