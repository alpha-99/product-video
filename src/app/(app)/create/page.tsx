"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Account, useShell } from "../../../components/AppShell";
import { BrandColorPicker } from "../../../components/BrandColorPicker";
import { useToast } from "../../../components/Toaster";
import {
  BoundaryCard, Button, EmptyState, ErrorBanner, Field, SegmentedTabs, Skeleton,
} from "../../../components/ui";
import {
  api, ApiError, messageOf, newIdempotencyKey, QUOTA_EMPTY_MESSAGE,
} from "../../../lib/client/api";
import { normalizeColor, normalizeHex } from "../../../lib/client/color";
import { invalidateAsyncCache, useAsync } from "../../../lib/client/hooks";
import type {
  AiCopyResponse, CreateVideoResult, ProductDto, RenderCopy, TemplateDto,
} from "../../../lib/client/types";

/**
 * 验收 P2-05：原 6 步里的「预览确认」只有说明文字、「提交生成」只有按钮，
 * 合并为一个完整的「确认并提交」步骤，消除空步骤。
 * 品牌色控件仍在第 4 步（step=3），逻辑与交互按冻结要求保持不变。
 */
const STEPS = ["选商品", "选模板", "文案", "参数", "确认并提交"];
const LIMITS = { title: 60, subtitle: 80, point: 40, points: 5, cta: 20 } as const;

const EMPTY_COPY: RenderCopy = { title: "", subtitle: "", sellingPoints: [], cta: "" };

/** 服务端 fields 的 key → 面向用户的字段名（验收 P1-01）。 */
const FIELD_LABELS: Record<string, string> = {
  "copy.title": "视频标题",
  "copy.subtitle": "副标题",
  "copy.sellingPoints": "卖点",
  "copy.cta": "行动号召",
  "options.brandColor": "品牌色",
  body: "提交内容",
};

function charLen(value: string) {
  return Array.from(value).length;
}

function validate(copy: RenderCopy): string[] {
  const issues: string[] = [];
  if (!copy.title.trim()) issues.push("视频标题不能为空");
  else if (charLen(copy.title) > LIMITS.title) issues.push(`标题超过 ${LIMITS.title} 字`);
  if (!copy.subtitle.trim()) issues.push("副标题不能为空");
  else if (charLen(copy.subtitle) > LIMITS.subtitle) issues.push(`副标题超过 ${LIMITS.subtitle} 字`);
  if (copy.sellingPoints.length === 0) issues.push("至少填写 1 个卖点");
  if (copy.sellingPoints.length > LIMITS.points) issues.push("卖点最多 5 个");
  if (copy.sellingPoints.some((p) => !p.trim() || charLen(p) > LIMITS.point)) {
    issues.push(`每个卖点不超过 ${LIMITS.point} 字且不能为空`);
  }
  if (!copy.cta.trim()) issues.push("CTA 不能为空");
  else if (charLen(copy.cta) > LIMITS.cta) issues.push(`CTA 超过 ${LIMITS.cta} 字`);
  return issues;
}

export default function CreatePage() {
  const router = useRouter();
  const toast = useToast();
  const { me, refreshMe } = useShell();
  const productsQuery = useAsync<ProductDto[]>(
    () => api.get<ProductDto[]>("/api/products?take=100"),
    { cacheKey: "products" }
  );
  const templatesQuery = useAsync<TemplateDto[]>(
    () => api.get<TemplateDto[]>("/api/templates"),
    { cacheKey: "templates", ttlMs: 60_000 }
  );

  const [step, setStep] = useState(0);
  const [productId, setProductId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [copy, setCopy] = useState<RenderCopy>(EMPTY_COPY);
  const [pointsText, setPointsText] = useState("");
  // brandColor 恒为规范化 #rrggbb 或空串（= 模板默认），是提交与预览的唯一数据源。
  const [brandColor, setBrandColor] = useState("");
  // 高级手输的草稿与校验错误独立存放，非法值绝不写入 brandColor。
  const [brandColorDraft, setBrandColorDraft] = useState("");
  const [brandColorError, setBrandColorError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDegraded, setAiDegraded] = useState(false);
  const [aiMessage, setAiMessage] = useState("");
  // 验收 P2-03：AI 输出被截断的字段说明，必须让用户看到。
  const [copyNotes, setCopyNotes] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 验收 P1-01：ApiError.fields 回填到对应表单字段，并在确认页汇总。
  const [submitFields, setSubmitFields] = useState<Record<string, string>>({});
  // R-04：≤639px 用「表单 / 预览」双标签，预览默认收起；切换不卸载表单，状态保持。
  const [mobileTab, setMobileTab] = useState<"form" | "preview">("form");
  // 验收 P2-12：桌面隐藏的 tab 不应再被 tabpanel 的 aria-labelledby 引用。
  const [narrow, setNarrow] = useState(false);

  // 不用 useSearchParams，避免静态预渲染要求 Suspense 边界。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const p = params.get("productId");
    const t = params.get("templateId");
    if (p) setProductId(p);
    if (t) setTemplateId(t);
    if (p && t) goTo(2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  const product = productsQuery.data?.find((p) => p.id === productId) ?? null;
  const template = templatesQuery.data?.find((t) => t.id === templateId) ?? null;
  const issues = useMemo(() => validate(copy), [copy]);
  const canSubmit =
    Boolean(productId && templateId) && issues.length === 0 && !brandColorError && !submitting;

  /** 切换步骤时清理上一次提交的错误，避免旧提示跨步骤残留（验收 P2-12）。 */
  function goTo(next: number) {
    setSubmitError(null);
    setSubmitFields({});
    setStep(next);
  }

  function setPoints(value: string) {
    setPointsText(value);
    setCopy((prev) => ({
      ...prev,
      sellingPoints: value.split(/[·,，\n]/).map((s) => s.trim()).filter(Boolean),
    }));
  }

  /** 色板 / 系统取色器：写入规范化 HEX，并同步高级输入框。 */
  function applyBrandColor(raw: string) {
    const hex = normalizeHex(raw) ?? "";
    setBrandColor(hex);
    setBrandColorDraft(hex);
    setBrandColorError(null);
  }

  /** 高级手输：实时解析，合法立刻生效，非法只提示且保留上一次合法色。 */
  function changeBrandColorDraft(raw: string) {
    setBrandColorDraft(raw);
    const parsed = normalizeColor(raw);
    if (!parsed.ok) {
      setBrandColorError(parsed.error);
      return;
    }
    setBrandColorError(null);
    setBrandColor(parsed.hex ?? "");
  }

  /** 放弃未生效的草稿，回到当前已生效色值。 */
  function revertBrandColorDraft() {
    setBrandColorDraft(brandColor);
    setBrandColorError(null);
  }

  /** 清空色值 = 使用模板默认配色。 */
  function clearBrandColor() {
    setBrandColor("");
    setBrandColorDraft("");
    setBrandColorError(null);
  }

  async function generateCopy() {
    if (!productId) return;
    setAiLoading(true);
    setAiDegraded(false);
    setAiMessage("");
    setCopyNotes([]);
    try {
      const result = await api.post<AiCopyResponse>("/api/ai/copy", { productId });
      setCopy({
        title: result.copy.videoTitle,
        subtitle: result.copy.subtitle,
        sellingPoints: result.copy.sellingPoints,
        cta: result.copy.cta,
      });
      setPointsText(result.copy.sellingPoints.join(" · "));
      setCopyNotes(result.truncated ?? []);
      toast.show(result.cached ? "已复用缓存文案" : "AI 文案已生成");
    } catch (error) {
      // 验收 P2-02：保留服务端的具体原因与 Retry-After，不再一律「AI 不可用请手填」。
      setAiDegraded(true);
      const wait = error instanceof ApiError && error.retryAfterMs
        ? `请 ${Math.ceil(error.retryAfterMs / 1000)} 秒后重试`
        : "可稍后重试";
      setAiMessage(`${messageOf(error)}；${wait}，也可直接手工填写。`);
      toast.show("AI 文案暂不可用，已切换为手工填写", true);
    } finally {
      setAiLoading(false);
    }
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitFields({});
    try {
      await api.post<CreateVideoResult>(
        "/api/videos",
        {
          productId,
          templateId,
          copy,
          ...(brandColor ? { options: { brandColor } } : {}),
        },
        { idempotencyKey: newIdempotencyKey() }
      );
      // 验收 P2-12：提交成功后失效共享缓存，避免「视频管理」短暂显示旧列表。
      invalidateAsyncCache("videos");
      invalidateAsyncCache("me");
      refreshMe();
      toast.show("任务已提交，正在排队渲染");
      router.push("/videos");
    } catch (error) {
      if (error instanceof ApiError && error.fields) setSubmitFields(error.fields);
      setSubmitError(messageOf(error));
      refreshMe();
    } finally {
      setSubmitting(false);
    }
  }

  const loading = productsQuery.loading || templatesQuery.loading;
  const loadError = productsQuery.error ?? templatesQuery.error;

  // 防御性兜底：即使状态被外部污染，也只把合法 6 位 HEX 拼进 CSS。
  const previewColor = normalizeHex(brandColor) ?? "";

  const preview = (
    <div className="preview-wrap">
      <div
        className={`preview-phone ${template?.tone ?? "g1"}`}
        style={previewColor ? { background: `linear-gradient(160deg, ${previewColor}, oklch(31% 0.052 155))` } : undefined}
      >
        <div className="ph-top">
          <span>{product?.brandName ?? "ProductVideo"}</span>
          <span>{template?.durationSec ?? 15}s</span>
        </div>
        <div>
          <div className="ph-title">{copy.title || "视频标题"}</div>
          <div className="ph-bp">{copy.sellingPoints.join(" · ") || "卖点将在这里展示"}</div>
          <span className="ph-cta">{copy.cta || "Discover More"}</span>
        </div>
      </div>
      {/* P2-6：这是 CSS 静态版面示意图，不是 Remotion 同源渲染，不能宣称「同源」。 */}
      <p className="preview-cap">示意预览 · 9:16 / 1080×1920（静态示意图，最终以成片为准）</p>
    </div>
  );

  const panelAria = (name: string, tab: string) =>
    narrow
      ? { role: "tabpanel" as const, "aria-labelledby": `tab-create-${tab}` }
      : { "aria-label": name };

  return (
    <>
      <div className="app-top">
        <h1>视频创作</h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span className="badge wait">消耗 1 次额度</span>
          <Account />
        </div>
      </div>

      {me && me.quotaLeft === 0 && (
        <div style={{ marginBottom: 24 }}>
          {/* 验收 P2-01：额度文案与 API 客户端统一口径。 */}
          <BoundaryCard title="额度已用完" description={QUOTA_EMPTY_MESSAGE} />
        </div>
      )}

      {/* 验收 P2-05：带 productId / templateId 进入时给出常驻预选反馈与修改入口。 */}
      {(productId || templateId) && (
        <div className="boundary" role="status" style={{ marginBottom: 16 }}>
          <div>
            <b>已预选</b>
            <span>
              {product ? `商品：${product.name}` : productId ? "商品：已从链接带入" : "商品：未选择"} ·{" "}
              {template ? `模板：${template.label}` : templateId ? "模板：已从链接带入" : "模板：未选择"}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => goTo(0)}>重新选择</Button>
        </div>
      )}

      {/* 验收 P2-03：AI 文案被截断时明确告知用户，不再静默缩短。 */}
      {copyNotes.length > 0 && (
        <div className="boundary" role="status" style={{ marginBottom: 16 }}>
          <div>
            <b>文案已按模板限制调整</b>
            <span>{copyNotes.join("；")}</span>
          </div>
        </div>
      )}

      <div className="wizard-steps" role="list" aria-label="创作步骤">
        {STEPS.map((label, index) => (
          <div
            key={label}
            role="listitem"
            className={`wstep${index < step ? " done" : ""}${index === step ? " cur" : ""}`}
            /* 验收 P2-12：当前步骤的读屏语义。 */
            aria-current={index === step ? "step" : undefined}
          >
            <i>{index < step ? "✓" : index + 1}</i>{label}
          </div>
        ))}
      </div>

      {loading && <Skeleton lines={5} />}
      {!loading && loadError && (
        <ErrorBanner message={loadError} onRetry={() => { productsQuery.reload(); templatesQuery.reload(); }} />
      )}

      {!loading && !loadError && (
        <>
          <SegmentedTabs
            label="创作区域切换"
            panelPrefix="create"
            value={mobileTab}
            onChange={setMobileTab}
            tabs={[
              { value: "form", label: "表单" },
              { value: "preview", label: "预览" },
            ]}
          />
          <div className="create-grid">
            <div
              className="create-form"
              id="panel-create-form"
              {...panelAria("创作表单", "form")}
              data-hidden={mobileTab !== "form"}
            >
            {step === 0 && (
              <>
                <h2 className="muted" style={{ marginBottom: 16 }}>第一步 · 选择商品</h2>
                {(productsQuery.data?.length ?? 0) === 0 ? (
                  <EmptyState
                    text="还没有商品，先去新建一个吧"
                    action={<Link href="/products"><Button>+ 新增商品</Button></Link>}
                  />
                ) : (
                  <div className="pick-grid">
                    {productsQuery.data!.map((item) => (
                      <button
                        key={item.id}
                        className={`pick-card${productId === item.id ? " selected" : ""}`}
                        onClick={() => setProductId(item.id)}
                      >
                        <b>{item.name}</b>
                        <span>{item.sellingPoints.length} 个卖点{item.price ? ` · ¥${item.price}` : ""}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {step === 1 && (
              <>
                <h2 className="muted" style={{ marginBottom: 16 }}>第二步 · 选择模板</h2>
                {/* 验收 P2-04：模板为空时给出引导，不再是无出口的死路。 */}
                {(templatesQuery.data?.length ?? 0) === 0 ? (
                  <EmptyState
                    icon="▤"
                    text="暂无可用模板，请联系管理员初始化模板数据"
                    action={<Link href="/templates"><Button>前往模板页查看</Button></Link>}
                  />
                ) : (
                  <div className="pick-grid">
                    {templatesQuery.data?.map((item) => (
                      <button
                        key={item.id}
                        className={`pick-card${templateId === item.id ? " selected" : ""}`}
                        onClick={() => setTemplateId(item.id)}
                      >
                        <b>{item.label}</b>
                        <span>{item.durationSec}s · {item.description}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {step === 2 && (
              <>
                <div className="copy-actions">
                  <h2 className="muted">第三步 · 营销文案</h2>
                  <button className="regen" onClick={generateCopy} disabled={aiLoading || !productId}>
                    ↻ {aiLoading ? "生成中…" : "AI 生成文案"}
                  </button>
                </div>
                {aiDegraded && (
                  <div className="error-banner" role="alert" style={{ marginBottom: 16 }}>
                    {aiMessage}
                  </div>
                )}
                <div className="field-mb">
                  <Field
                    label={`视频标题（${charLen(copy.title)}/${LIMITS.title}）`}
                    value={copy.title}
                    onChange={(e) => setCopy({ ...copy, title: e.target.value })}
                    placeholder="如：Your Daily Hydration Essential"
                    error={submitFields["copy.title"]}
                  />
                  {charLen(copy.title) > LIMITS.title && (
                    <div className="limit-warn">标题超过模板限制 60 字，请精简后再提交</div>
                  )}
                </div>
                <div className="field-mb">
                  <Field
                    label="副标题"
                    value={copy.subtitle}
                    onChange={(e) => setCopy({ ...copy, subtitle: e.target.value })}
                    placeholder="一句补充说明"
                    error={submitFields["copy.subtitle"]}
                  />
                </div>
                <div className="field-mb">
                  <Field
                    label="卖点（最多 5 个，用 · 分隔）"
                    value={pointsText}
                    onChange={(e) => setPoints(e.target.value)}
                    placeholder="轻盈质地 · 日常保湿 · 温和亲肤"
                    error={submitFields["copy.sellingPoints"]}
                  />
                </div>
                <div className="field-mb">
                  <Field
                    label="行动号召 CTA"
                    value={copy.cta}
                    onChange={(e) => setCopy({ ...copy, cta: e.target.value })}
                    placeholder="立即选购"
                    error={submitFields["copy.cta"]}
                  />
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <h2 className="muted" style={{ marginBottom: 16 }}>第四步 · 渲染参数</h2>
                <div className="field-mb">
                  <BrandColorPicker
                    value={brandColor}
                    draft={brandColorDraft}
                    error={brandColorError}
                    onPick={applyBrandColor}
                    onDraftChange={changeBrandColorDraft}
                    onClear={clearBrandColor}
                  />
                </div>
                <p className="muted">视频规格固定为 1080×1920 / 30fps / H.264 MP4，由模板注册表控制。</p>
                {/* 验收 P2-07：诚实说明本期开放范围，不暴露未实现的输入入口。 */}
                <p className="muted">本期仅开放品牌色自定义；Logo、背景音乐与促销文案暂未开放，将在后续版本提供。</p>
              </>
            )}

            {step === 4 && (
              <>
                <h2 className="muted" style={{ marginBottom: 16 }}>第五步 · 确认并提交</h2>
                {/* 验收 P2-05：移动端不再写「右侧」，改为中性的预览区表述。 */}
                <p>预览区展示 9:16 版面示意图（窄屏请切换到「预览」标签），用于确认文案与配色；正式成片由渲染服务通过 Remotion 生成，效果以最终 MP4 为准。</p>
                <ul className="muted" style={{ marginTop: 16, paddingLeft: 18, lineHeight: 2 }}>
                  <li>商品：{product?.name ?? "未选择"}</li>
                  <li>模板：{template?.label ?? "未选择"}（{template?.durationSec ?? 15}s）</li>
                  <li>标题：{copy.title || "未填写"}</li>
                  <li>卖点：{copy.sellingPoints.length} 个</li>
                  <li>品牌色：{brandColor ? `${brandColor.toUpperCase()}（自定义）` : "模板默认"}</li>
                </ul>
                <p style={{ marginTop: 16 }}>提交后将消耗 1 次额度并进入渲染队列，任务状态可在「视频管理」查看。</p>
                {issues.length > 0 && (
                  <div className="error-banner" role="alert" style={{ marginTop: 16 }}>
                    {issues.join("；")}
                  </div>
                )}
                {submitError && (
                  <div className="error-banner" role="alert" style={{ marginTop: 16 }}>
                    {submitError}
                  </div>
                )}
                {/* 验收 P1-01：服务端字段级错误不再被吞，逐项列出并给返回修改入口。 */}
                {Object.keys(submitFields).length > 0 && (
                  <>
                    <ul className="muted" role="list" style={{ marginTop: 12, paddingLeft: 18, lineHeight: 1.8 }}>
                      {Object.entries(submitFields).map(([key, msg]) => (
                        <li key={key}>{FIELD_LABELS[key] ?? "提交参数"}：{msg}</li>
                      ))}
                    </ul>
                    <Button variant="ghost" size="sm" onClick={() => goTo(2)}>返回修改文案</Button>
                  </>
                )}
                <div className="wizard-actions">
                  <Button onClick={submit} disabled={!canSubmit || me?.quotaLeft === 0}>
                    {submitting ? "提交中…" : "提交生成（消耗 1 次额度）"}
                  </Button>
                  <span className="muted">已选：{product?.name ?? "—"} · {template?.label ?? "—"}模板</span>
                </div>
              </>
            )}

            {/* 高级区可能处于折叠状态，错误必须有一条始终可见的解释与恢复路径。 */}
            {step === 3 && brandColorError && (
              <div className="error-banner" role="alert" style={{ marginTop: 16 }}>
                <span>品牌色输入未生效，当前仍使用上次选中的颜色。请展开「高级」修正，或撤销本次输入。</span>
                <Button variant="ghost" size="sm" onClick={revertBrandColorDraft}>撤销输入</Button>
              </div>
            )}

            {step !== STEPS.length - 1 && (
              <div className="wizard-actions">
                {step > 0 && <Button variant="ghost" onClick={() => goTo(step - 1)}>上一步</Button>}
                <Button
                  onClick={() => goTo(step + 1)}
                  disabled={
                    (step === 0 && !productId) ||
                    (step === 1 && !templateId) ||
                    (step === 2 && issues.length > 0) ||
                    (step === 3 && Boolean(brandColorError))
                  }
                >
                  下一步 →
                </Button>
              </div>
            )}
            </div>

            <div
              className="create-preview"
              id="panel-create-preview"
              {...panelAria("版面预览", "preview")}
              data-hidden={mobileTab !== "preview"}
            >
              {step >= 2 ? preview : <div />}
            </div>
          </div>
        </>
      )}
    </>
  );
}
