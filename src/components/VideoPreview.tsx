"use client";

import React from "react";
import { Player } from "@remotion/player";
import { COMPONENTS } from "../../remotion/component-map";
import { getTemplate, type TemplateId } from "../shared/template.schema";
import type { ProductVideoProps } from "../shared/video-props.schema";

/** 方案 7.1：预览默认 480 宽（9:16），渲染仍是 1080×1920。 */
export const PREVIEW_SIZE = { width: 480, height: 854 } as const;

export interface VideoPreviewProps {
  compositionId: TemplateId;
  props: ProductVideoProps;
  autoPlay?: boolean;
  loop?: boolean;
  /** 默认 true，显示播放 / 进度条等控件；卡片悬停预览关闭后仅作画面展示。 */
  controls?: boolean;
  /** 覆盖播放器尺寸。只给 width 时按 9:16 自动算高。 */
  style?: React.CSSProperties;
  /**
   * 空格键播放/暂停，默认 true。开启时 Player 会在挂载和每次播放状态变化时
   * 把焦点移到播放按钮；嵌入其它可聚焦内容（如模板卡片组）的页面应关闭，避免抢焦点。
   */
  spaceKeyToPlayOrPause?: boolean;
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
  controls = true,
  spaceKeyToPlayOrPause = true,
  style,
}) => {
  const template = getTemplate(compositionId);
  const Component = COMPONENTS[compositionId];
  // 调用方给了宽度却没给高度时，去掉默认高度，交给 Player 按 9:16 推算。
  const sizeStyle: React.CSSProperties =
    style?.width !== undefined && style.height === undefined
      ? { height: undefined, ...style }
      : { width: PREVIEW_SIZE.width, height: PREVIEW_SIZE.height, ...style };

  return (
    <Player
      component={Component as React.ComponentType<Record<string, unknown>>}
      inputProps={props as unknown as Record<string, unknown>}
      durationInFrames={template.durationSec * template.fps}
      fps={template.fps}
      compositionWidth={template.width}
      compositionHeight={template.height}
      style={sizeStyle}
      controls={controls}
      clickToPlay={controls}
      spaceKeyToPlayOrPause={controls && spaceKeyToPlayOrPause}
      doubleClickToFullscreen={false}
      // 本期模板没有音频轨道（P2-07），不展示一个按了没有效果的静音按钮。
      showVolumeControls={false}
      autoPlay={autoPlay}
      loop={loop}
      acknowledgeRemotionLicense
    />
  );
};
