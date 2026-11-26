/**
 * 健康检查（方案 11 / 阶段九验收）。
 *
 * GET /api/health → { ok, data: HealthReport }
 *   ok / degraded → 200；down → 503（Nginx/PM2 可据此摘节点）
 *   ok 字段表示「探测本身执行成功」，业务健康度看 data.status 与 HTTP 状态码。
 *
 * 安全：可选 HEALTH_TOKEN，配置后必须带 x-health-token 头或 ?token=；
 * 响应不返回连接串、绝对路径等敏感信息。
 */
import { NextRequest, NextResponse } from "next/server";
import type { ApiResponse } from "@/shared";
import { collectHealth, type HealthReport } from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const token = process.env.HEALTH_TOKEN;
  if (token) {
    const supplied =
      request.headers.get("x-health-token") ??
      new URL(request.url).searchParams.get("token");
    if (supplied !== token) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "UNAUTHORIZED", message: "健康检查凭据无效" },
        } satisfies ApiResponse<HealthReport>,
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  const report = await collectHealth();
  return NextResponse.json({ ok: true, data: report } satisfies ApiResponse<HealthReport>, {
    status: report.status === "down" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
