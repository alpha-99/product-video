/**
 * 类型化 API 客户端（阶段八）。
 *
 * 约定：
 *   - 所有请求带 same-origin Cookie（HttpOnly 会话），前端不接触任何令牌；
 *   - 统一解包 {ok,data} / {ok:false,error}，错误映射为中文文案；
 *   - 4xx 不重试；5xx 与网络错误最多重试 3 次（300/600/1200ms 退避）；
 *   - 401 自动跳登录；离线时给出明确提示。
 */
import type { ApiResponse } from "../../shared/api";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly fields?: Record<string, string>,
    /** 服务端建议的重试等待（毫秒），用于 429 等可恢复错误。 */
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 面向用户的兜底文案（验收 P1-01 / P2-01）。
 * 这些文案只在「服务端没有给出具体原因」时使用；不再整体覆盖服务端 message，
 * 否则「删除被关联商品」「已达重试上限」等具体原因会被吞成一句通用提示。
 */
const MESSAGES: Record<string, string> = {
  UNAUTHORIZED: "登录已过期，请重新登录",
  FORBIDDEN: "没有权限执行此操作",
  NOT_FOUND: "资源不存在或已被删除",
  VALIDATION_ERROR: "填写内容有误，请按提示修改后重试",
  QUOTA_EXCEEDED: "剩余额度不足，请联系管理员增加额度",
  RATE_LIMITED: "操作过于频繁，请稍后再试",
  AI_UNAVAILABLE: "AI 文案服务暂时不可用，可手工填写后继续",
  INTERNAL_ERROR: "服务暂时不可用，请稍后重试",
  TEMPLATE_CONFLICT: "模板已被他人修改，请刷新后重试",
  TEMPLATE_LAST_ENABLED: "这是最后一套可渲染的启用模板，无法停用",
  TEMPLATE_NOT_REGISTERED: "该模板未注册到渲染注册表，无法启用",
  ROLE_SELF_CHANGE: "不能修改自己的角色",
  ROLE_DIRECT_GRANT_FORBIDDEN: "管理员权限必须通过复核流程授予",
  ROLE_APPROVER_CONFLICT: "不能批准自己发起的提权申请",
  ROLE_NEEDS_SECOND_ADMIN: "管理员不足 2 名，提权入口已冻结",
  ROLE_LAST_ADMIN: "不能撤销最后一名管理员",
  ROLE_REQUEST_EXPIRED: "提权申请已过期，请重新发起",
  ROLE_REQUEST_CONFLICT: "提权申请状态已变更，请刷新后重试",
};

/** 全站统一的额度耗尽口径，避免出现「升级套餐 / 暂无升级入口」等误导表述。 */
export const QUOTA_EMPTY_MESSAGE = MESSAGES.QUOTA_EXCEEDED;

/**
 * 服务端 message 优先于通用兜底；INTERNAL_ERROR 永远用统一文案，
 * 避免把内部细节（即使服务端已脱敏）展示给终端用户。
 */
export function friendlyMessage(code: string, serverMessage?: string): string {
  if (code === "INTERNAL_ERROR" || code === "OFFLINE") {
    return MESSAGES[code] ?? "操作失败，请稍后重试";
  }
  const text = serverMessage?.trim();
  return text ? text : (MESSAGES[code] ?? "操作失败，请稍后重试");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 只在浏览器里跳转，服务端渲染 / 测试环境不触发。 */
function handleUnauthorized(path: string) {
  if (typeof window === "undefined" || path.startsWith("/api/auth/")) return;
  window.location.assign("/login");
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  /** POST /api/videos 必带幂等键。 */
  idempotencyKey?: string;
  /** 5xx 重试次数，默认 3。 */
  retries?: number;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, headers = {}, idempotencyKey, retries = 3, signal } = options;
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;

  const init: RequestInit = {
    method,
    credentials: "same-origin",
    signal,
    headers: {
      ...(isForm ? {} : body !== undefined ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: isForm ? body : JSON.stringify(body) } : {}),
  };

  const maxAttempts = Math.max(retries, 1);
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await sleep(300 * 2 ** (attempt - 1));

    let response: Response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts - 1) {
        throw new ApiError(
          "OFFLINE",
          typeof navigator !== "undefined" && navigator.onLine === false
            ? "网络已断开，请检查连接后重试"
            : "无法连接服务器，请稍后重试",
          0
        );
      }
      continue;
    }

    // 5xx 才重试；4xx 立即抛给页面，避免重复提交/重复扣费。
    if (response.status >= 500 && attempt < maxAttempts - 1) {
      lastError = new Error(`HTTP ${response.status}`);
      continue;
    }

    // 下载/文件接口不是 JSON 包络，交给调用方处理。
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      if (response.ok) return response as unknown as T;
      throw new ApiError("INTERNAL_ERROR", MESSAGES.INTERNAL_ERROR, response.status);
    }

    const payload = (await response.json()) as ApiResponse<T>;
    if (payload.ok) return payload.data;

    const { code, message, fields, retryAfterMs } = payload.error;
    // 401 统一在解包后处理：既保留服务端的具体原因（如「邮箱或密码错误」），
    // 又不会在登录页把密码错误误报成「登录已过期」（验收 P1-07）。
    if (code === "UNAUTHORIZED" || response.status === 401) handleUnauthorized(path);
    throw new ApiError(
      code,
      friendlyMessage(code, message),
      response.status,
      fields,
      retryAfterMs
    );
  }

  throw new ApiError(
    "INTERNAL_ERROR",
    MESSAGES.INTERNAL_ERROR,
    0,
    lastError instanceof Error ? { detail: lastError.message } : undefined
  );
}

/**
 * 同一时刻对同一 path 的 GET 合并为一个请求。
 * 菜单预热与页面自身的加载常常同时发出，去重后不会重复打数据库。
 * 带 AbortSignal 的请求保持独立，避免被别的调用方取消。
 */
const inflightGet = new Map<string, Promise<unknown>>();

function getOnce<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (signal) return request<T>(path, { signal });
  const hit = inflightGet.get(path);
  if (hit) return hit as Promise<T>;
  const pending = request<T>(path).finally(() => {
    inflightGet.delete(path);
  });
  inflightGet.set(path, pending);
  return pending;
}

export const api = {
  get: getOnce,
  post: <T>(path: string, body?: unknown, extra?: RequestOptions) =>
    request<T>(path, { method: "POST", body, ...extra }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: "POST", body: form, retries: 1 }),
};

/** 保留给需要原始 Response 的场景（视频流）。 */
export async function fetchRaw(path: string): Promise<Response> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (response.status === 401) handleUnauthorized(path);
  if (!response.ok) throw new ApiError("INTERNAL_ERROR", MESSAGES.INTERNAL_ERROR, response.status);
  return response;
}

/**
 * P1-4：带上传进度的 multipart 请求。fetch 不暴露 upload progress，
 * 因此这里用 XHR，但仍复用统一响应包络、错误码映射与 401 处理，
 * 4xx 立即失败不重试，避免重复上传。
 */
export function uploadWithProgress<T>(
  path: string,
  form: FormData,
  onProgress: (percent: number) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path, true);
    xhr.withCredentials = true;
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status === 401) {
        handleUnauthorized(path);
        reject(new ApiError("UNAUTHORIZED", MESSAGES.UNAUTHORIZED, 401));
        return;
      }
      let payload: ApiResponse<T> | null = null;
      try {
        payload = JSON.parse(xhr.responseText) as ApiResponse<T>;
      } catch {
        payload = null;
      }
      if (payload?.ok) {
        onProgress(100);
        resolve(payload.data);
        return;
      }
      const error = payload && !payload.ok ? payload.error : undefined;
      const code = error?.code ?? "INTERNAL_ERROR";
      reject(
        new ApiError(
          code,
          friendlyMessage(code, error?.message),
          xhr.status,
          error?.fields,
          error?.retryAfterMs
        )
      );
    });
    xhr.addEventListener("error", () =>
      reject(new ApiError("OFFLINE", "网络已断开，上传未完成，请重试", 0))
    );
    xhr.addEventListener("abort", () =>
      reject(new ApiError("OFFLINE", "上传已取消", 0))
    );
    xhr.send(form);
  });
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误，请重试";
}
