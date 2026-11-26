/**
 * 免费模板测试入口（不进生产模板注册表）。
 *
 * 来源：https://www.remotion.dev/templates/hello-world
 * 仓库：remotion-dev/remotion / packages/template-helloworld（源码已存 vendor/remotion-hello-world/）
 * 用途：验证本机 Remotion + Chrome Headless + FFmpeg 渲染链路是否可用，
 *       与生产 4 套模板解耦 —— TEMPLATES 注册表不含此 id，Worker 不会领取它。
 * 注意：Remotion 为 source-available 许可，商用前需按 RK-01 核对授权。
 */
import React from "react";
import { Composition } from "remotion";
import { HelloWorld } from "./vendor/HelloWorld";

export const VendorRoot: React.FC = () => (
  <Composition
    id="vendor-hello-world"
    component={HelloWorld}
    durationInFrames={90}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ titleText: "ProductVideo AI", titleColor: "#123b2e" }}
  />
);
