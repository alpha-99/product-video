"use client";

/**
 * P1-6：compositionId 是内部渲染标识，绝不直接渲染给用户。
 * 这里集中维护「内部 id → 面向用户的英文模板名 + CTA 文案」映射，
 * 文案取自设计稿 06（ProductVideo_AI_UI设计方案.html:639-642）。
 */
export interface TemplateDisplay {
  /** 支持 \n 换行，配合 .tv-title 的 white-space: pre-line。 */
  englishName: string;
  cta: string;
}

export const TEMPLATE_DISPLAY: Readonly<Record<string, TemplateDisplay>> = {
  "product-launch": { englishName: "Product\nLaunch", cta: "Discover More" },
  "product-highlight": { englishName: "Product\nHighlight", cta: "Learn More" },
  "product-sale": { englishName: "Summer\nSale 30%", cta: "Shop Now" },
  "product-showcase": { englishName: "Premium\nShowcase", cta: "The Collection" },
};

/** 未知模板用中性展示名兜底，绝不回退成内部 id。 */
export function displayFor(compositionId: string): TemplateDisplay {
  return TEMPLATE_DISPLAY[compositionId] ?? { englishName: "Video\nTemplate", cta: "Discover More" };
}
