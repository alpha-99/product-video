import React from "react";
import { Composition } from "remotion";
import { COMPONENTS } from "./component-map";
import { TEMPLATES } from "../src/shared/template.schema";

/** 模板注册表：compositionId → React Component + 时长 + 默认配置（方案 7.1） */
export const RemotionRoot: React.FC = () => (
  <>
    {TEMPLATES.map((template) => (
      <Composition
        key={template.id}
        id={template.compositionId}
        component={COMPONENTS[template.id]}
        durationInFrames={template.durationSec * template.fps}
        fps={template.fps}
        width={template.width}
        height={template.height}
        defaultProps={template.defaultProps}
      />
    ))}
  </>
);
