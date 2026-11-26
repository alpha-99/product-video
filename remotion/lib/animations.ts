import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

/** 模板共用的时间函数：所有动画只依赖帧号，保证预览与正式渲染一致。 */

export function fadeIn(start = 0, duration = 15): number {
  const frame = useCurrentFrame();
  return interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

export function slideUp(start = 0, duration = 20, distance = 60): number {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (1 - progress) * distance;
}

export function popIn(start = 0, damping = 14): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({
    frame: Math.max(0, frame - start),
    fps,
    config: { damping, mass: 0.6, stiffness: 120 },
    durationInFrames: 30,
  });
}

/** 缓慢呼吸感缩放，用于促销 CTA 与品牌展示。 */
export function breathe(frame: number, period = 45, amount = 0.02): number {
  return 1 + amount * Math.sin((frame / period) * Math.PI * 2);
}

/** 分段线性进度：用于卖点逐个出现、章节转场。 */
export function segmentProgress(
  frame: number,
  start: number,
  duration: number
): number {
  return interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}
