import type { FC } from "react";
import { ProductHighlight } from "./ProductHighlight";
import { ProductLaunch } from "./ProductLaunch";
import { ProductSale } from "./ProductSale";
import { PremiumShowcase } from "./PremiumShowcase";
import type { TemplateId } from "../src/shared/template.schema";
import type { ProductVideoProps } from "../src/shared/video-props.schema";

/**
 * compositionId → React 组件。Root（正式渲染）与 Player（低分辨率预览）
 * 共用同一张表，确保「预览与渲染共用同一套组件」（方案 7.1）。
 */
export const COMPONENTS: Record<TemplateId, FC<ProductVideoProps>> = {
  "product-launch": ProductLaunch,
  "product-highlight": ProductHighlight,
  "product-sale": ProductSale,
  "product-showcase": PremiumShowcase,
};
