"use client";

/** 设计稿组件库：按钮 / 表单 / 徽章 / 四态 / 弹窗，禁止各页重写。 */
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { STATUS_META, type VideoJobDto } from "../lib/client/types";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "gold" | "ghost" | "danger";
  size?: "sm" | "md";
  block?: boolean;
};

export function Button({
  variant = "primary",
  size = "md",
  block = false,
  className = "",
  ...props
}: ButtonProps) {
  const classes = [
    "btn",
    `btn-${variant}`,
    size === "sm" ? "btn-sm" : "",
    block ? "btn-block" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <button className={classes} {...props} />;
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Field({ label, hint, error, className = "", id, ...props }: FieldProps) {
  const fieldId = id ?? `f-${label.replace(/\s/g, "-")}`;
  const externalDescribedBy = props["aria-describedby"];
  const describedBy =
    [error ? `${fieldId}-err` : undefined, externalDescribedBy].filter(Boolean).join(" ") ||
    undefined;
  // 避免 spread 覆盖合并后的 aria-describedby。
  const { ["aria-describedby"]: _ignored, ...inputProps } = props;
  void _ignored;
  return (
    <div className={`field ${className}`}>
      <label htmlFor={fieldId}>{label}</label>
      <input
        id={fieldId}
        className={error ? "invalid" : ""}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        {...inputProps}
      />
      {error ? (
        <span className="hint err" id={`${fieldId}-err`} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function Badge({ status }: { status: VideoJobDto["status"] }) {
  const meta = STATUS_META[status] ?? STATUS_META.pending;
  return <span className={`badge ${meta.tone}`}>{meta.label}</span>;
}

export function EmptyState({
  icon = "▦",
  text,
  action,
}: {
  icon?: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="em-ico" aria-hidden="true">{icon}</div>
      <p>{text}</p>
      {action}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="加载中">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton-line" style={{ width: `${90 - i * 10}%` }} />
      ))}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {onRetry && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}

/** 边界态：额度耗尽等「不是错误但需引导」的场景。 */
export function BoundaryCard({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="boundary">
      <div>
        <b>{title}</b>
        <span>{description}</span>
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal —— WCAG 2.1 SC 2.1.2 / 2.4.3（审核报告 P0-4）
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * 可访问的模态框：portal 到 body → 背景 inert → 初始焦点入框 →
 * Tab / Shift+Tab 循环 → Escape 关闭 → 关闭后焦点还给触发元素。
 * 所有页面与 ConfirmDialog 共用这一份实现，禁止各页自己写弹窗。
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const maskRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const mask = maskRef.current;
    const dialog = dialogRef.current;
    if (!mask || !dialog) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    // 先把焦点移进弹窗，再让背景 inert，避免焦点被压在 inert 子树里。
    const items = focusableIn(dialog);
    (items[0] ?? dialog).focus();

    const background = Array.from(document.body.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== mask
    );
    background.forEach((el) => el.setAttribute("inert", ""));

    return () => {
      background.forEach((el) => el.removeAttribute("inert"));
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusableIn(dialogRef.current);
    if (items.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // Modal 只在客户端交互后挂载；此处兜底 SSR，避免 document 未定义时抛错。
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="modal-mask"
      ref={maskRef}
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} tabIndex={-1}>{title}</h2>
        {children}
      </div>
    </div>,
    document.body
  );
}

/** P1-5：危险操作统一确认框，替代各页的浏览器原生对话框。 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = "确认删除",
  cancelLabel = "取消",
  danger = true,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onClose,
}: {
  title: string;
  /** 允许放「前往视频管理」这类可点击引导（验收 P1-06）。 */
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** 前置条件未满足时禁用确认，只保留可点击引导。 */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="confirm-desc">{description}</p>
      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy || confirmDisabled}>
          {busy ? "处理中…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

/** A-05 / R-04：可访问的 segmented tabs，支持 ← → 键盘切换。 */
export function SegmentedTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  panelPrefix = "panel",
}: {
  label: string;
  tabs: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  panelPrefix?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.value === value);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = (index + delta + tabs.length) % tabs.length;
    onChange(tabs[next].value);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <div className="create-tabs" role="tablist" aria-label={label} ref={listRef} onKeyDown={handleKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          className="tab"
          id={`tab-${panelPrefix}-${tab.value}`}
          aria-selected={value === tab.value}
          aria-controls={`panel-${panelPrefix}-${tab.value}`}
          tabIndex={value === tab.value ? 0 : -1}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function SectionLine({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="section-line">
      <h2>{title}</h2>
      {action}
    </div>
  );
}
