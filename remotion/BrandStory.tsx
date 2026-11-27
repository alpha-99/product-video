import React from "react";
import { AbsoluteFill, Img, useCurrentFrame } from "remotion";
import type { ProductVideoProps } from "../src/shared/video-props.schema";
import { breathe, fadeIn, popIn, slideUp } from "./lib/animations";
import { resolveImageSrc } from "./lib/image-src";

/**
 * 模板 E / Brand Story 品牌故事（20s / 600 帧）。
 * 内容：品牌叙事标题、商品主视觉、卖点列表、价格与 CTA。
 * 动画：标题上浮弹入 → 主图淡入 → 卖点渐显 → 底部价格与 CTA。
 */
export const BrandStory: React.FC<ProductVideoProps> = ({
  title,
  subtitle,
  imageUrl,
  price,
  sellingPoints,
  cta,
  brandColor,
  logoPath,
}) => {
  const frame = useCurrentFrame();
  const titleY = slideUp(10, 24, 80);
  const titleScale = popIn(10, 14);
  const imageOpacity = fadeIn(24, 24);
  const imageScale = 0.96 + popIn(24, 16) * 0.04;
  const pointsOpacity = fadeIn(90, 30);
  const ctaScale = breathe(frame, 45, 0.025);

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#f8f7ff",
        color: "#111827",
        fontFamily:
          '"Plus Jakarta Sans", "PingFang SC", "Microsoft YaHei", sans-serif',
        padding: "90px 84px",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 18,
          backgroundColor: brandColor,
        }}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          opacity: fadeIn(0, 12),
        }}
      >
        {logoPath ? (
          <Img
            src={resolveImageSrc(logoPath)}
            style={{ width: 70, height: 70, objectFit: "contain" }}
          />
        ) : (
          <div
            style={{
              width: 70,
              height: 70,
              borderRadius: 20,
              backgroundColor: brandColor,
              color: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 38,
              fontWeight: 700,
            }}
          >
            {title.slice(0, 1)}
          </div>
        )}
        <div style={{ fontSize: 26, letterSpacing: 8, color: "#6b7280" }}>
          BRAND STORY
        </div>
      </div>

      <div
        style={{
          marginTop: 50,
          transform: `translateY(${titleY}px) scale(${0.96 + titleScale * 0.04})`,
          transformOrigin: "left center",
        }}
      >
        <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.12, color: brandColor }}>
          {title}
        </div>
        <div style={{ fontSize: 34, marginTop: 20, color: "#5b6472" }}>{subtitle}</div>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: imageOpacity,
          transform: `scale(${imageScale})`,
        }}
      >
        <Img
          src={resolveImageSrc(imageUrl)}
          style={{
            width: "100%",
            height: 760,
            objectFit: "contain",
            filter: "drop-shadow(0 24px 44px rgba(30, 24, 60, 0.16))",
          }}
        />
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
          opacity: pointsOpacity,
        }}
      >
        {sellingPoints.slice(0, 3).map((point, i) => (
          <div
            key={`${point}-${i}`}
            style={{
              fontSize: 26,
              padding: "12px 22px",
              borderRadius: 999,
              border: `2px solid ${brandColor}33`,
              color: "#596273",
              backgroundColor: "#ffffffaa",
            }}
          >
            {point}
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: 36,
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
        }}
      >
        <div style={{ fontSize: 58, fontWeight: 800, color: "#111827" }}>
          {price ?? ""}
        </div>
        <div
          style={{
            backgroundColor: brandColor,
            color: "#ffffff",
            fontSize: 34,
            fontWeight: 700,
            padding: "22px 46px",
            borderRadius: 999,
            transform: `scale(${ctaScale})`,
          }}
        >
          {cta}
        </div>
      </div>
    </AbsoluteFill>
  );
};
