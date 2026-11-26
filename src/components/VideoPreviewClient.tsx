"use client";

import dynamic from "next/dynamic";
import React from "react";

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
          width: 480,
          height: 854,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          backgroundColor: "#e9e6e0",
          color: "#6b7280",
          fontSize: 13,
        }}
      >
        预览加载中…
      </div>
    ),
  }
);

export const VideoPreviewClient: React.FC<
  React.ComponentProps<typeof VideoPreviewLazy>
> = (props) => <VideoPreviewLazy {...props} />;
