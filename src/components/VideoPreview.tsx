"use client";

import React from "react";
import { Player } from "@remotion/player";
import { COMPONENTS } from "../../remotion/component-map";
import { getTemplate, type TemplateId } from "../shared/template.schema";
import type { ProductVideoProps } from "../shared/video-props.schema";

/** 方案 7.1：预览固定 480×854（9:16），渲染仍是 1080×1920。 */
export const PREVIEW_SIZE = { width: 480, height: 854 } as const;

export interface VideoPreviewProps {
  compositionId: TemplateId;
  props: ProductVideoProps;
  autoPlay?: boolean;
  loop?: boolean;
}

/**
 * 低分辨率预览：与正式渲染共用组件映射、Props 契约和模板规格，
 * 只改变播放器的显示尺寸。参数变化会直接反映到预览，不产生渲染费用。
 */
export const VideoPreview: React.FC<VideoPreviewProps> = ({
  compositionId,
  props,
  autoPlay = false,
  loop = true,
}) => {
  const template = getTemplate(compositionId);
  const Component = COMPONENTS[compositionId];

  return (
    <Player
      component={Component as React.ComponentType<Record<string, unknown>>}
      inputProps={props as unknown as Record<string, unknown>}
      durationInFrames={template.durationSec * template.fps}
      fps={template.fps}
      compositionWidth={template.width}
      compositionHeight={template.height}
      style={{ width: PREVIEW_SIZE.width, height: PREVIEW_SIZE.height }}
      controls
      autoPlay={autoPlay}
      loop={loop}
      acknowledgeRemotionLicense
    />
  );
};
