import React from "react";
import { AbsoluteFill, Img, useCurrentFrame } from "remotion";
import type { ProductVideoProps } from "../src/shared/video-props.schema";
import { breathe, fadeIn, popIn, segmentProgress, slideUp } from "./lib/animations";
import { resolveImageSrc } from "./lib/image-src";

/**
 * 模板 C / Product Sale 促销活动（15s）。
 * 内容：原价、折扣价、优惠文案、购买 CTA。
 * originalPrice / discountText 为可选字段，未提供时只展示活动价与 CTA。
 */
export const ProductSale: React.FC<ProductVideoProps> = ({
  title,
  subtitle,
  imageUrl,
  price,
  originalPrice,
  discountText,
  sellingPoints,
  cta,
  brandColor,
}) => {
  const frame = useCurrentFrame();
  const badgeScale = popIn(0, 11);
  const priceScale = popIn(18, 13);
  const ctaScale = breathe(frame, 40, 0.03);
  const imageY = slideUp(30, 24, 60);
  const pointsProgress = segmentProgress(frame, 60, 30);

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        backgroundColor: brandColor,
        color: "#ffffff",
        fontFamily:
          '"Plus Jakarta Sans", "PingFang SC", "Microsoft YaHei", sans-serif',
        padding: "90px 84px",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 700,
          height: 700,
          borderRadius: "50%",
          right: -280,
          top: -220,
          backgroundColor: "rgba(255,255,255,0.08)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 480,
          height: 480,
          borderRadius: "50%",
          left: -240,
          bottom: -180,
          backgroundColor: "rgba(0,0,0,0.08)",
        }}
      />

      <div
        style={{
          alignSelf: "flex-start",
          transform: `scale(${badgeScale}) rotate(-4deg)`,
          backgroundColor: "#ffffff",
          color: brandColor,
          fontSize: 30,
          fontWeight: 800,
          letterSpacing: 4,
          padding: "16px 34px",
          borderRadius: 999,
        }}
      >
        {discountText || "限时特惠"}
      </div>

      <div style={{ marginTop: 48, opacity: fadeIn(8, 16) }}>
        <div style={{ fontSize: 74, fontWeight: 800, lineHeight: 1.12 }}>{title}</div>
        <div style={{ fontSize: 32, marginTop: 16, color: "rgba(255,255,255,0.82)" }}>
          {subtitle}
        </div>
      </div>

      <div
        style={{
          marginTop: 40,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 40,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 26, color: "rgba(255,255,255,0.75)", letterSpacing: 3 }}>
            SALE PRICE
          </div>
          <div
            style={{
              marginTop: 10,
              fontSize: 112,
              fontWeight: 800,
              lineHeight: 1,
              transform: `scale(${0.9 + priceScale * 0.1})`,
              transformOrigin: "left center",
            }}
          >
            {price || "--"}
          </div>
          {originalPrice ? (
            <div
              style={{
                marginTop: 18,
                fontSize: 38,
                color: "rgba(255,255,255,0.65)",
                textDecoration: "line-through",
              }}
            >
              原价 {originalPrice}
            </div>
          ) : null}
        </div>
        <div
          style={{
            width: 380,
            height: 380,
            borderRadius: 40,
            overflow: "hidden",
            backgroundColor: "rgba(255,255,255,0.14)",
            transform: `translateY(${imageY}px)`,
            opacity: fadeIn(30, 20),
            flexShrink: 0,
          }}
        >
          <Img
            src={resolveImageSrc(imageUrl)}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        </div>
      </div>

      <div style={{ marginTop: 46, opacity: pointsProgress, display: "flex", flexDirection: "column", gap: 14 }}>
        {sellingPoints.slice(0, 3).map((point, i) => (
          <div key={`${point}-${i}`} style={{ fontSize: 34, display: "flex", gap: 18 }}>
            <span style={{ opacity: 0.8 }}>✦</span>
            <span>{point}</span>
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: "auto",
          alignSelf: "stretch",
          transform: `scale(${ctaScale})`,
          backgroundColor: "#ffffff",
          color: brandColor,
          fontSize: 44,
          fontWeight: 800,
          textAlign: "center",
          padding: "30px 0",
          borderRadius: 999,
        }}
      >
        {cta}
      </div>
    </AbsoluteFill>
  );
};
