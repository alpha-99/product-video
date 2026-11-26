import React from "react";
import { AbsoluteFill, Img, interpolate, useCurrentFrame } from "remotion";
import type { ProductVideoProps } from "../src/shared/video-props.schema";
import { resolveImageSrc } from "./lib/image-src";

/**
 * 模板 D / Premium Showcase 高级品牌展示（20s）。
 * 内容：品牌视觉、商品特写、优雅转场、品牌宣传文案。
 * 三段式转场：品牌序幕 → 商品特写 → 品牌宣言，全部用帧驱动的交叉淡化。
 */
export const PremiumShowcase: React.FC<ProductVideoProps> = ({
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
  const range = (start: number, end: number) =>
    interpolate(frame, [start, end], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const phase1 = 1 - range(150, 210);
  const phase2 = range(150, 210) * (1 - range(420, 480));
  const phase3 = range(420, 480);
  const kenBurns = interpolate(frame, [150, 600], [1, 1.14], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#090a0c",
        backgroundImage: `radial-gradient(circle at 50% 35%, ${brandColor}33 0%, transparent 55%)`,
        color: "#f5f2ec",
        fontFamily: '"Fraunces", "Songti SC", "SimSun", serif',
        overflow: "hidden",
      }}
    >
      {/* 品牌序幕 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          opacity: phase1,
          gap: 40,
        }}
      >
        <div
          style={{
            width: 260,
            height: 260,
            borderRadius: "50%",
            border: `2px solid ${brandColor}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 120,
            color: brandColor,
          }}
        >
          {title.slice(0, 1)}
        </div>
        <div style={{ fontSize: 28, letterSpacing: 14, color: "#a8a29a" }}>PRESENTING</div>
        <div style={{ fontSize: 64, textAlign: "center", padding: "0 80px" }}>{title}</div>
      </div>

      {/* 商品特写 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          opacity: phase2,
          gap: 46,
        }}
      >
        <div
          style={{
            width: 860,
            height: 1040,
            overflow: "hidden",
            borderRadius: 8,
            border: `1px solid ${brandColor}66`,
            transform: `scale(${kenBurns})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Img
            src={resolveImageSrc(imageUrl)}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        </div>
        <div style={{ fontSize: 40, color: "#d6d0c6" }}>{subtitle}</div>
      </div>

      {/* 品牌宣言 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          opacity: phase3,
          padding: "0 100px",
          gap: 34,
          textAlign: "center",
        }}
      >
        {logoPath ? (
          <Img
            src={resolveImageSrc(logoPath)}
            style={{ width: 130, height: 130, objectFit: "contain" }}
          />
        ) : null}
        <div style={{ fontSize: 62, lineHeight: 1.35 }}>{subtitle}</div>
        <div style={{ fontSize: 34, color: "#a8a29a", lineHeight: 1.7 }}>
          {sellingPoints.slice(0, 3).join(" · ")}
        </div>
        <div
          style={{
            marginTop: 24,
            fontSize: 34,
            letterSpacing: 6,
            color: brandColor,
            borderBottom: `2px solid ${brandColor}`,
            paddingBottom: 14,
          }}
        >
          {price ? `${price} · ` : ""}
          {cta}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 60,
          left: 90,
          right: 90,
          height: 2,
          backgroundColor: "rgba(255,255,255,0.12)",
        }}
      >
        <div
          style={{
            width: `${(frame / 600) * 100}%`,
            height: "100%",
            backgroundColor: brandColor,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
