import { NextResponse } from "next/server";
import { ZodError } from "zod";
import type { ApiResponse } from "../shared/api";
import { DomainError, httpStatusFor } from "./errors";

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data } satisfies ApiResponse<T>, { status });
}

export function fail(error: unknown): NextResponse {
  if (error instanceof DomainError) {
    const response = NextResponse.json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
          ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
        },
      } satisfies ApiResponse<never>,
      { status: httpStatusFor(error.code) }
    );
    // 上游限流时给标准重试头，便于网关 / 客户端退避。
    if (error.retryAfterMs) {
      response.headers.set("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
    }
    return response;
  }
  if (error instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = issue.path.join(".") || "body";
      fields[key] = issue.message;
    }
    return NextResponse.json(
      {
        ok: false,
        error: { code: "VALIDATION_ERROR", message: "参数校验失败", fields },
      } satisfies ApiResponse<never>,
      { status: 400 }
    );
  }
  // 未预期异常：原文只写服务端日志，禁止把 Prisma/SQL/用户 ID 等内部细节回传客户端。
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(JSON.stringify({ level: "error", event: "unhandled_api_error", error: detail }));
  return NextResponse.json(
    {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试" },
    } satisfies ApiResponse<never>,
    { status: 500 }
  );
}
