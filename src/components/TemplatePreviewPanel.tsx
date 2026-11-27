"use client";

import React from "react";
import { VideoPreviewClient } from "./VideoPreviewClient";
import type { TemplateId } from "../shared/template.schema";
import type { ProductVideoProps } from "../shared/video-props.schema";

export interface TemplatePreviewPanelProps {
  /** 面向用户的模板名，如「卖点介绍」。 */
  title: string;
  /** 规格说明，如「20 秒 · 9:16」。 */
  meta: string;
  /** 卡片色调类名（g1–g4），用于播放器就绪前的占位底色。 */
  tone: string;
  compositionId: TemplateId | null;
  sampleProps: ProductVideoProps | null;
  /** 播放器代码可以开始加载后才挂载，避免拖慢首屏。 */
  ready: boolean;
  /** 面板底部的主操作（使用所选模板创作）。 */
  action: React.ReactNode;
}

/** 面板不接管空格键：方向键切换模板后，焦点必须留在卡片上，不能被播放按钮抢走。 */
const PANEL_PLAYER_PROPS = { width: "100%", spaceKeyToPlayOrPause: false } as const;

/**
 * 模板选择页右侧的常驻预览：跟随当前选中的模板，带播放控件，默认不自动播放。
 * 播放器以 key 重挂载来切换模板，避免沿用上一个模板的进度与播放状态。
 */
export function TemplatePreviewPanel({
  title,
  meta,
  tone,
  compositionId,
  sampleProps,
  ready,
  action,
}: TemplatePreviewPanelProps) {
  const playable = ready && compositionId !== null && sampleProps !== null;
  return (
    <aside className="tpl-panel" aria-label="模板预览">
      <div className="tpl-panel-head">
        <b>模板预览</b>
        <span>
          {title} · {meta}
        </span>
      </div>
      <div className="tpl-panel-frame">
        {playable ? (
          <VideoPreviewClient
            key={compositionId}
            compositionId={compositionId}
            props={sampleProps}
            {...PANEL_PLAYER_PROPS}
          />
        ) : (
          <div className={`tpl-panel-placeholder ${tone}`} role="status">
            预览加载中…
          </div>
        )}
      </div>
      <p className="preview-cap">实时预览 · 演示数据，成片以你的商品与文案为准</p>
      {action}
    </aside>
  );
}
