/**
 * GET /api/templates — 已启用模板列表（方案 5.1 / V1.0 FR-11）。
 *
 * r3 变更：运营元数据（展示名/英文名/描述/CTA/tone/排序/缩略图）改为 DB 单一真源，
 * 删除硬编码 DISPLAY 映射。compositionId 必须命中注册表，否则不返回。
 * 响应「只增字段」：旧字段 label/description/tone 仍存在并同步为新值，新增
 * displayName/englishName/cta/sortOrder/thumbnailUrl；不加 ETag（无消费方，D5）。
 */
import { NextRequest } from "next/server";
import { resolveUserId } from "../../../lib/auth";
import { ok, fail } from "../../../lib/api-response";
import { db } from "../../../lib/db";
import { TEMPLATES } from "../../../shared/template.schema";

export const runtime = "nodejs";

/** 未知/缺字段时的中性兜底：不回退成内部 compositionId（P1-6）。 */
const NEUTRAL = {
  displayName: "视频模板",
  englishName: "VIDEO TEMPLATE",
  description: "视频模板",
  cta: "了解更多",
  tone: "g1",
} as const;

/** tone 枚举 → CSS 视觉类（运营可改，映射固定）。 */
const TONE_VISUAL: Record<string, string> = {
  energetic: "g2",
  calm: "g4",
  premium: "g1",
  playful: "g3",
  urgent: "g2",
};

export async function GET(request: NextRequest) {
  try {
    resolveUserId(request.headers);
    const rows = await db.videoTemplate.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: "asc" }, { compositionId: "asc" }],
      select: {
        id: true,
        name: true,
        category: true,
        compositionId: true,
        durationSec: true,
        thumbnailPath: true,
        displayName: true,
        englishName: true,
        description: true,
        cta: true,
        tone: true,
        sortOrder: true,
      },
    });

    const registered = new Set<string>(TEMPLATES.map((t) => t.id));
    const seen = new Set<string>();
    const templates = rows
      .filter((row) => registered.has(row.compositionId))
      .filter((row) => {
        if (seen.has(row.compositionId)) return false;
        seen.add(row.compositionId);
        return true;
      })
      .map((row) => {
        const displayName = row.displayName || NEUTRAL.displayName;
        const englishName = row.englishName || NEUTRAL.englishName;
        const description = row.description || NEUTRAL.description;
        const cta = row.cta || NEUTRAL.cta;
        const tone = row.tone || NEUTRAL.tone;
        return {
          // 旧字段（保持兼容，值同步为 DB 新值）
          id: row.id,
          name: row.name,
          category: row.category,
          compositionId: row.compositionId,
          durationSec: row.durationSec,
          thumbnailPath: row.thumbnailPath,
          label: displayName,
          description,
          tone: TONE_VISUAL[tone] ?? NEUTRAL.tone,
          // 新增字段
          displayName,
          englishName,
          cta,
          sortOrder: row.sortOrder,
          thumbnailUrl: row.thumbnailPath ? `/api/templates/${row.id}/thumbnail` : null,
        };
      });

    return ok(templates);
  } catch (error) {
    return fail(error);
  }
}
