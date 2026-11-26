"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type KeyboardEvent } from "react";
import { Account } from "../../../components/AppShell";
import { Button, EmptyState, ErrorBanner, Skeleton } from "../../../components/ui";
import { api } from "../../../lib/client/api";
import { displayFor } from "../../../lib/client/template-display";
import { useAsync } from "../../../lib/client/hooks";
import type { TemplateDto } from "../../../lib/client/types";

export default function TemplatesPage() {
  const router = useRouter();
  const { data: templates, loading, error, reload } = useAsync<TemplateDto[]>(
    () => api.get<TemplateDto[]>("/api/templates"),
    { cacheKey: "templates", ttlMs: 5 * 60_000 }
  );
  const [selected, setSelected] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);

  const activeId = selected ?? templates?.[0]?.id ?? null;
  const count = templates?.length ?? 0;

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
        <>
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
              return (
                <button
                  key={template.id}
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
              );
            })}
          </div>
          <div style={{ marginTop: 24 }}>
            <Button onClick={() => router.push(`/create?templateId=${activeId}`)}>
              使用所选模板创作 →
            </Button>
          </div>
        </>
      )}
    </>
  );
}
