"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Account } from "../../../components/AppShell";
import { Button, EmptyState, ErrorBanner, Skeleton } from "../../../components/ui";
import { TemplatePreviewPanel } from "../../../components/TemplatePreviewPanel";
import { VideoPreviewClient } from "../../../components/VideoPreviewClient";
import { api } from "../../../lib/client/api";
import { displayFor } from "../../../lib/client/template-display";
import { useAsync, useIdleReady, usePrefersReducedMotion } from "../../../lib/client/hooks";
import { previewFor } from "../../../shared/template.schema";
import type { TemplateDto } from "../../../lib/client/types";

/** 指针停在卡片上超过这个时长才叠加预览：划过卡片时不触发加载与播放。 */
const HOVER_PREVIEW_DELAY_MS = 200;

export default function TemplatesPage() {
  const router = useRouter();
  const { data: templates, loading, error, reload } = useAsync<TemplateDto[]>(
    () => api.get<TemplateDto[]>("/api/templates"),
    { cacheKey: "templates", ttlMs: 5 * 60_000 }
  );
  const [selected, setSelected] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);

  /**
   * 悬停预览：同一时间最多叠加一个播放器；选中卡已在右侧面板播放，不再重复；
   * 系统「减少动效」时不自动播放。预览代码等首屏渲染完成（空闲）后再加载。
   */
  const [hovered, setHovered] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const previewReady = useIdleReady();

  const activeId = selected ?? templates?.[0]?.id ?? null;
  const count = templates?.length ?? 0;
  const activeTemplate = templates?.find((item) => item.id === activeId) ?? null;
  const activePreview = activeTemplate ? previewFor(activeTemplate.compositionId) : null;

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    []
  );

  function beginHover(template: TemplateDto) {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (reducedMotion || template.id === activeId || !previewFor(template.compositionId)) {
      setHovered(null);
      return;
    }
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setHovered(template.id);
    }, HOVER_PREVIEW_DELAY_MS);
  }

  function endHover() {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setHovered(null);
  }

  /**
   * 验收 P2-12：radiogroup 的方向键 + roving tabindex。
   * ←/↑ 上一个、→/↓ 下一个、Home/End 首尾；切换选中态同时移动焦点。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = templates ?? [];
    if (list.length === 0) return;
    const current = Math.max(0, list.findIndex((item) => item.id === activeId));
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (current + 1) % list.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (current - 1 + list.length) % list.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = list.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    setSelected(list[next].id);
    groupRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      [next]?.focus();
  }

  const createAction = (
    <Button onClick={() => router.push(`/create?templateId=${activeId}`)} block>
      使用所选模板创作 →
    </Button>
  );

  return (
    <>
      <div className="app-top">
        <h1>选择模板</h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span className="muted">
            {loading && count === 0 ? "模板加载中…" : `${count} 套 · 均已启用`}
          </span>
          <Account />
        </div>
      </div>

      {loading && <Skeleton lines={5} />}
      {!loading && error && <ErrorBanner message={error} onRetry={reload} />}
      {!loading && !error && count === 0 && (
        /* 验收 P2-12：面向用户文案不泄露内部运维命令。 */
        <EmptyState icon="▤" text="暂无可用模板，请联系管理员初始化模板数据" />
      )}
      {!loading && !error && count > 0 && (
        <div className="tpl-layout">
          <div
            className="tpl-grid"
            role="radiogroup"
            aria-label="视频模板"
            ref={groupRef}
            onKeyDown={handleKeyDown}
          >
            {templates!.map((template) => {
              const isActive = template.id === activeId;
              // P1-6：内部 compositionId 永不直接渲染，只展示面向用户的英文名与 CTA。
              const display = displayFor(template.compositionId);
              // 悬停中被点击选中的卡片立即撤掉叠加层，避免同一模板在卡面与面板各播一份。
              const hoverPreview =
                hovered === template.id && !isActive && previewReady
                  ? previewFor(template.compositionId)
                  : null;
              return (
                <div
                  key={template.id}
                  className="tpl-cell"
                  onMouseEnter={() => beginHover(template)}
                  onMouseLeave={endHover}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    tabIndex={isActive ? 0 : -1}
                    className={`tpl-card${isActive ? " selected" : ""}`}
                    onClick={() => setSelected(template.id)}
                  >
                    <div className={`tpl-visual ${template.tone}`}>
                      <span className="tv-tag">{template.durationSec} 秒</span>
                      <span className="tv-title">{display.englishName}</span>
                      <span className="tv-cta">{display.cta}</span>
                    </div>
                    <div className="tpl-body">
                      <b>{template.label}</b>
                      <span>{template.description}</span>
                    </div>
                  </button>
                  {/* 叠加层只负责画面，不接收指针事件，点击仍落在卡片按钮上。 */}
                  {hoverPreview && (
                    <div className="tpl-hover" aria-hidden="true">
                      <VideoPreviewClient
                        key={template.id}
                        compositionId={hoverPreview.compositionId}
                        props={hoverPreview.props}
                        autoPlay
                        controls={false}
                        width="100%"
                        radius={0}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <TemplatePreviewPanel
            title={activeTemplate?.label ?? ""}
            meta={`${activeTemplate?.durationSec ?? 0} 秒 · 9:16`}
            tone={activeTemplate?.tone ?? "g1"}
            compositionId={activePreview?.compositionId ?? null}
            sampleProps={activePreview?.props ?? null}
            ready={previewReady}
            action={createAction}
          />
        </div>
      )}
    </>
  );
}
