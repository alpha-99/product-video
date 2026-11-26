import React from "react";
import { AbsoluteFill, Img, interpolate, useCurrentFrame } from "remotion";
import type { ProductVideoProps } from "../src/shared/video-props.schema";
import { fadeIn, popIn, slideUp } from "./lib/animations";
import { resolveImageSrc } from "./lib/image-src";

/**
 * 模板 A / Product Launch 新品展示（15s）。
 * 内容：商品主视觉、动态标题、品牌 Logo、商品名称。
 * 动画：标题弹入 → 主图淡入微缩放 → 底部价格与 CTA 上浮。
 */
export const ProductLaunch: React.FC<ProductVideoProps> = ({
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
  const titleScale = popIn(10, 16);
  const imageOpacity = fadeIn(22, 24);
  const imageScale = interpolate(frame, [22, 90], [0.94, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const bottomOpacity = fadeIn(60, 24);
  const bottomY = slideUp(60, 24, 50);

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#faf7f2",
        backgroundImage:
          "linear-gradient(160deg, #ffffff 0%, #faf7f2 55%, #efe8dd 100%)",
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

      <div style={{ display: "flex", alignItems: "center", gap: 24, opacity: fadeIn(0, 12) }}>
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
        <div style={{ fontSize: 26, letterSpacing: 8, color: "#8d8375" }}>NEW ARRIVAL</div>
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
            height: 820,
            objectFit: "contain",
            filter: "drop-shadow(0 30px 50px rgba(40, 30, 20, 0.18))",
          }}
        />
      </div>

      <div style={{ opacity: bottomOpacity, transform: `translateY(${bottomY}px)` }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
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
            {price ? price : ""}
          </div>
          <div
            style={{
              backgroundColor: brandColor,
              color: "#ffffff",
              fontSize: 34,
              fontWeight: 700,
              padding: "22px 46px",
              borderRadius: 999,
            }}
          >
            {cta}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
