/**
 * GET /api/templates — 已启用模板列表（方案 5.1）。
 *
 * 模板元数据（展示名、描述、配色）来自设计稿，DB 行提供 UUID 与时长；
 * compositionId 必须命中 shared 注册表，否则不返回，避免前端选到无法渲染的模板。
 */
import { NextRequest } from "next/server";
import { resolveUserId } from "../../../lib/auth";
import { ok, fail } from "../../../lib/api-response";
import { db } from "../../../lib/db";
import { TEMPLATES } from "../../../shared/template.schema";

export const runtime = "nodejs";

const DISPLAY: Record<string, { label: string; description: string; tone: string }> = {
  "product-launch": { label: "新品展示", description: "主视觉 + 动态标题", tone: "g1" },
  "product-highlight": { label: "卖点介绍", description: "卖点动画 + 字幕", tone: "g3" },
  "product-sale": { label: "促销活动", description: "原价 / 折扣 / CTA", tone: "g2" },
  "product-showcase": { label: "高级品牌展示", description: "品牌视觉 + 优雅转场", tone: "g4" },
};

export async function GET(request: NextRequest) {
  try {
    resolveUserId(request.headers);
    const rows = await db.videoTemplate.findMany({
      where: { enabled: true },
      orderBy: { category: "asc" },
      select: {
        id: true,
        name: true,
        category: true,
        compositionId: true,
        durationSec: true,
        thumbnailPath: true,
      },
    });

    // 同一 compositionId 在库里可能有多行（历史数据/并行测试夹具），
    // 前端只应看到 4 张卡片，这里按注册表 id 去重，保留排序最靠前的一行。
    const seen = new Set<string>();
    const templates = rows
      .filter((row) => TEMPLATES.some((t) => t.id === row.compositionId))
      .filter((row) => {
        if (seen.has(row.compositionId)) return false;
        seen.add(row.compositionId);
        return true;
      })
      .map((row) => {
        const meta = DISPLAY[row.compositionId] ?? {
          label: row.name,
          description: "视频模板",
          tone: "g1",
        };
        return {
          id: row.id,
          name: row.name,
          category: row.category,
          compositionId: row.compositionId,
          durationSec: row.durationSec,
          thumbnailPath: row.thumbnailPath,
          ...meta,
        };
      });

    return ok(templates);
  } catch (error) {
    return fail(error);
  }
}
