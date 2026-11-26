import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  Sequence,
  useCurrentFrame,
} from "remotion";
import type { ProductVideoProps } from "../src/shared/video-props.schema";
import { fadeIn, segmentProgress, slideUp } from "./lib/animations";
import { resolveImageSrc } from "./lib/image-src";

const POINT_START = 45;
const POINT_STEP = 100;

/** 单个卖点：序号 + 文案 + 生长进度条。Sequence 内的帧从 0 开始。 */
const HighlightPoint: React.FC<{
  point: string;
  index: number;
  brandColor: string;
}> = ({ point, index, brandColor }) => {
  const frame = useCurrentFrame();
  const opacity = fadeIn(0, 14);
  const y = slideUp(0, 18, 40);
  const progress = segmentProgress(frame, 8, 26);

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${y}px)`,
        display: "flex",
        alignItems: "center",
        gap: 28,
        padding: "22px 28px",
        borderRadius: 24,
        backgroundColor: "rgba(255,255,255,0.07)",
        border: "1px solid rgba(255,255,255,0.12)",
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: brandColor,
          color: "#ffffff",
          fontSize: 30,
          fontWeight: 800,
        }}
      >
        {index + 1}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 38, color: "#f8fafc", fontWeight: 600 }}>{point}</div>
        <div
          style={{
            marginTop: 14,
            height: 6,
            borderRadius: 999,
            backgroundColor: "rgba(255,255,255,0.14)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${progress * 100}%`,
              height: "100%",
              backgroundColor: brandColor,
            }}
          />
        </div>
      </div>
    </div>
  );
};

/**
 * 模板 B / Product Highlight 卖点介绍（20s）。
 * 内容：商品图片、卖点动画、动态字幕。
 */
export const ProductHighlight: React.FC<ProductVideoProps> = ({
  title,
  subtitle,
  imageUrl,
  price,
  sellingPoints,
  cta,
  brandColor,
}) => {
  const frame = useCurrentFrame();
  const activeIndex =
    frame < POINT_START
      ? -1
      : Math.min(sellingPoints.length - 1, Math.floor((frame - POINT_START) / POINT_STEP));
  const caption = activeIndex >= 0 ? sellingPoints[activeIndex] : subtitle;
  const captionOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#0f172a",
        backgroundImage: `radial-gradient(circle at 80% 0%, ${brandColor}44 0%, transparent 45%)`,
        color: "#f8fafc",
        fontFamily:
          '"Plus Jakarta Sans", "PingFang SC", "Microsoft YaHei", sans-serif',
        padding: "90px 84px",
      }}
    >
      <div style={{ height: 12, width: 180, backgroundColor: brandColor, borderRadius: 999 }} />
      <div style={{ marginTop: 34, opacity: fadeIn(0, 14) }}>
        <div style={{ fontSize: 66, fontWeight: 800, lineHeight: 1.15 }}>{title}</div>
        <div style={{ fontSize: 30, marginTop: 14, color: "#94a3b8" }}>{subtitle}</div>
      </div>

      <div
        style={{
          marginTop: 36,
          height: 520,
          borderRadius: 36,
          overflow: "hidden",
          backgroundColor: "rgba(255,255,255,0.05)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: fadeIn(10, 20),
        }}
      >
        <Img
          src={resolveImageSrc(imageUrl)}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      </div>

      <div style={{ marginTop: 38, display: "flex", flexDirection: "column", gap: 16 }}>
        {sellingPoints.map((point, i) => (
          <Sequence
            key={`${point}-${i}`}
            from={POINT_START + i * POINT_STEP}
            durationInFrames={POINT_STEP + 60}
            layout="none"
          >
            <HighlightPoint point={point} index={i} brandColor={brandColor} />
          </Sequence>
        ))}
      </div>

      <div
        style={{
          marginTop: "auto",
          opacity: captionOpacity,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: 24,
          borderTop: "1px solid rgba(255,255,255,0.16)",
        }}
      >
        <div style={{ fontSize: 30, color: "#e2e8f0" }}>{caption}</div>
        <div style={{ fontSize: 30, fontWeight: 800, color: brandColor }}>
          {price ? `${price} · ` : ""}
          {cta}
        </div>
      </div>
    </AbsoluteFill>
  );
};
