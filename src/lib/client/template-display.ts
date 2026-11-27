"use client";

/**
 * P1-6 / M1：compositionId 是内部渲染标识，绝不直接渲染给用户。
 * V1.0 起展示名与 CTA 由 DB 运营元数据下发（/api/templates），前端只做中性兜底，
 * 不再维护硬编码的「id → 文案」映射——改文案不再需要发版。
 */
export interface TemplateDisplay {
  /** 支持 \n 换行，配合 .tv-title 的 white-space: pre-line。 */
  englishName: string;
  cta: string;
}

interface DisplaySource {
  englishName?: string | null;
  cta?: string | null;
}

/** 未知/缺字段时用中性展示名兜底，绝不回退成内部 id（P1-6）。 */
export function displayFor(template: DisplaySource): TemplateDisplay {
  return {
    englishName: template.englishName?.trim() || "VIDEO\nTEMPLATE",
    cta: template.cta?.trim() || "Discover More",
  };
}
