"use client";

import dynamic from "next/dynamic";
import React from "react";

/** 外框默认宽度（方案 7.1 的 480×854）。不从 ./VideoPreview 引入，避免把播放器打进首包。 */
const DEFAULT_PREVIEW_WIDTH = 480;

/**
 * 预览仅在浏览器渲染：Remotion Player 依赖 DOM 尺寸与媒体能力，
 * 服务端渲染既不产出有效画面，还会触发 SSR 阶段的 ref 告警。
 */
const VideoPreviewLazy = dynamic(
  () => import("./VideoPreview").then((mod) => mod.VideoPreview),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#6b7280",
          fontSize: 13,
        }}
      >
        预览加载中…
      </div>
    ),
  }
);

export interface VideoPreviewClientProps
  extends React.ComponentProps<typeof VideoPreviewLazy> {
  /** 外框宽度，默认 480。外框固定 9:16，播放器加载前后高度一致，不跳动。 */
  width?: number | string;
  /** 外框圆角（px），默认 12；卡片内叠加预览时传 0 以贴合卡片自身圆角。 */
  radius?: number;
}

export const VideoPreviewClient: React.FC<VideoPreviewClientProps> = ({
  width = DEFAULT_PREVIEW_WIDTH,
  radius = 12,
  style,
  ...props
}) => (
  <div
    style={{
      position: "relative",
      width,
      aspectRatio: "9 / 16",
      overflow: "hidden",
      borderRadius: radius,
      backgroundColor: "#e9e6e0",
    }}
  >
    <VideoPreviewLazy {...props} style={{ width: "100%", ...style }} />
  </div>
);
