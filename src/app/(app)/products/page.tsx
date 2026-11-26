"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Account } from "../../../components/AppShell";
import { useToast } from "../../../components/Toaster";
import {
  Button, ConfirmDialog, EmptyState, ErrorBanner, Field, Modal, Skeleton,
} from "../../../components/ui";
import { api, ApiError, messageOf, uploadWithProgress } from "../../../lib/client/api";
import { useAsync } from "../../../lib/client/hooks";
import type { ProductDto, UploadResult, VideoJobDto } from "../../../lib/client/types";

const EMPTY_FORM = {
  name: "",
  price: "",
  description: "",
  sellingPoints: "",
  brandName: "",
  brandColor: "",
};

type FormState = typeof EMPTY_FORM;

/** 与后端 src/lib/upload.ts 的白名单/上限保持一致，前端只做即时反馈。 */
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function validateImageFile(file: File): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!(extension in ALLOWED_IMAGE_TYPES)) {
    return "不支持该格式，请上传 JPG / PNG / WebP（≤10MB）";
  }
  if (file.type && file.type !== ALLOWED_IMAGE_TYPES[extension]) {
    return "文件类型与扩展名不一致，请上传 JPG / PNG / WebP（≤10MB）";
  }
  if (file.size === 0) return "文件不能为空，请重新选择";
  if (file.size > MAX_UPLOAD_BYTES) return "图片不能超过 10MB";
  return null;
}

function ProductImage({ path }: { path: string }) {
  const [broken, setBroken] = useState(false);
  if (broken || !path) return <div className="mini-bottle" aria-hidden="true" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/uploads/products?path=${encodeURIComponent(path)}`}
      alt="商品图片"
      onError={() => setBroken(true)}
    />
  );
}

export default function ProductsPage() {
  const toast = useToast();
  const { data: products, loading, error, reload } = useAsync<ProductDto[]>(
    () => api.get<ProductDto[]>("/api/products?take=100"),
    { cacheKey: "products" }
  );
  // 验收 P1-06：删除前预判关联任务数，给出可点击引导，避免点了删除才被拒绝。
  // 与视频管理页共用同一份缓存，AppShell 空闲预热已填好数据。
  const relatedJobs = useAsync<VideoJobDto[]>(
    () => api.get<VideoJobDto[]>("/api/videos?take=100"),
    { cacheKey: "videos" }
  );
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProductDto | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // P1-4：字段级上传状态
  const [imageError, setImageError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [existingImage, setExistingImage] = useState<string | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  // P1-5：统一确认框状态
  const [confirmRemove, setConfirmRemove] = useState<ProductDto | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const update = (key: keyof FormState, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  function clearPreview() {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setImagePreview(null);
  }

  function resetImageState() {
    clearPreview();
    setFile(null);
    setImageError(null);
    setUploadPercent(null);
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    resetImageState();
    setExistingImage(null);
    setFormError(null);
    setFieldErrors({});
    setOpen(true);
  }

  function openEdit(product: ProductDto) {
    setEditing(product);
    setForm({
      name: product.name,
      price: product.price ?? "",
      description: product.description ?? "",
      sellingPoints: product.sellingPoints.join(" · "),
      brandName: product.brandName ?? "",
      brandColor: product.brandColor ?? "",
    });
    resetImageState();
    setExistingImage(product.imagePath || null);
    setFormError(null);
    setFieldErrors({});
    setOpen(true);
  }

  // P1-4：选择文件即刻校验（扩展名 / MIME / 大小），并生成缩略图预览。
  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0] ?? null;
    resetImageState();
    if (!picked) return;
    const problem = validateImageFile(picked);
    if (problem) {
      setImageError(problem);
      event.target.value = "";
      return;
    }
    setFile(picked);
    const url = URL.createObjectURL(picked);
    previewUrlRef.current = url;
    setImagePreview(url);
  }

  async function save() {
    setFormError(null);
    setFieldErrors({});
    setImageError(null);
    if (!file && !editing?.imagePath) {
      setImageError("请先上传商品图片");
      return;
    }
    setSaving(true);
    try {
      let imagePath = editing?.imagePath ?? "";
      if (file) {
        const data = new FormData();
        data.append("file", file);
        setUploadPercent(0);
        const uploaded = await uploadWithProgress<UploadResult>(
          "/api/uploads/products",
          data,
          setUploadPercent
        );
        imagePath = uploaded.path;
      }

      const points = form.sellingPoints
        .split(/[·,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5);

      const payload = {
        name: form.name.trim(),
        imagePath,
        ...(form.price.trim() ? { price: form.price.trim() } : {}),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        sellingPoints: points,
        ...(form.brandName.trim() ? { brandName: form.brandName.trim() } : {}),
        ...(form.brandColor.trim() ? { brandColor: form.brandColor.trim() } : {}),
      };

      if (editing) await api.patch(`/api/products/${editing.id}`, payload);
      else await api.post("/api/products", payload);

      toast.show(editing ? "商品已更新" : "商品已新增");
      resetImageState();
      setOpen(false);
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setFieldErrors(err.fields);
        // 服务端仍是最终校验方；把文件类错误就近显示在上传字段旁。
        const uploadMessage = err.fields.file ?? err.fields.imagePath;
        if (uploadMessage) setImageError(uploadMessage);
      }
      setFormError(messageOf(err));
    } finally {
      setSaving(false);
      setUploadPercent(null);
    }
  }

  async function doRemove() {
    if (!confirmRemove) return;
    setRemoving(true);
    try {
      await api.delete(`/api/products/${confirmRemove.id}`);
      toast.show("商品已删除");
      setConfirmRemove(null);
      reload();
    } catch (err) {
      toast.show(messageOf(err), true);
    } finally {
      setRemoving(false);
    }
  }

  const shownPreview = imagePreview ??
    (existingImage && !file
      ? `/api/uploads/products?path=${encodeURIComponent(existingImage)}`
      : null);

  const relatedCount = confirmRemove
    ? (relatedJobs.data ?? []).filter((job) => job.productId === confirmRemove.id).length
    : 0;

  return (
    <>
      <div className="app-top">
        <h1>商品管理</h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Button onClick={openCreate}>+ 新增商品</Button>
          <Account />
        </div>
      </div>

      {loading && <Skeleton lines={4} />}
      {!loading && error && <ErrorBanner message={error} onRetry={reload} />}
      {!loading && !error && (products?.length ?? 0) === 0 && (
        <EmptyState
          icon="▦"
          text="还没有商品，新增一个开始创作吧"
          action={<Button variant="ghost" onClick={openCreate}>+ 新增商品</Button>}
        />
      )}
      {!loading && !error && (products?.length ?? 0) > 0 && (
        <div className="card-grid">
          {products!.map((product, index) => (
            <div className="prod-card" key={product.id}>
              <div className={`prod-img g${(index % 4) + 1}`}>
                <ProductImage path={product.imagePath} />
              </div>
              <div className="prod-body">
                <b title={product.name}>{product.name}</b>
                <div className="row">
                  <span>
                    {product.sellingPoints.length} 个卖点
                    {product.price ? ` · ¥${product.price}` : ""}
                  </span>
                  <span style={{ display: "flex", gap: 8 }}>
                    <button className="icon-btn" onClick={() => openEdit(product)} title="编辑" aria-label="编辑">✎</button>
                    <button className="icon-btn" onClick={() => setConfirmRemove(product)} title="删除" aria-label="删除">✕</button>
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <Modal title={editing ? "编辑商品" : "新增商品"} onClose={() => setOpen(false)}>
          <div className="form-grid">
            <div className="field-mb">
              <Field
                label="商品名称 *"
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder="如：水润精华面霜"
                error={fieldErrors.name}
              />
            </div>
            <div className="field-mb">
              <Field
                label="价格"
                value={form.price}
                onChange={(e) => update("price", e.target.value)}
                placeholder="如 129.00"
                hint="最多两位小数，可不填"
                error={fieldErrors.price}
              />
            </div>
          </div>
          <div className="field-mb">
            <div className="field">
              <label htmlFor="p-img">商品图片 {editing ? "（不上传则保留原图）" : "*"}</label>
              <input
                id="p-img"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={onFileChange}
                className={imageError ? "invalid" : ""}
                aria-invalid={Boolean(imageError)}
                aria-describedby={imageError ? "p-img-hint p-img-err" : "p-img-hint"}
              />
              <span className="hint" id="p-img-hint">JPG / PNG / WebP，≤10MB</span>
              {imageError && (
                <span className="hint err" id="p-img-err" role="alert">{imageError}</span>
              )}
              {!imageError && fieldErrors.imagePath && (
                <span className="hint err" role="alert">{fieldErrors.imagePath}</span>
              )}
              {shownPreview && (
                <div className="upload-preview">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={shownPreview} alt="商品图片预览" />
                  <span>{imagePreview ? "待上传图片的本地预览" : "当前已保存的商品图片"}</span>
                </div>
              )}
              {uploadPercent !== null && (
                <>
                  <div
                    className="upload-progress"
                    role="progressbar"
                    aria-valuenow={uploadPercent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="图片上传进度"
                  >
                    <i style={{ width: `${uploadPercent}%` }} />
                  </div>
                  <div className="upload-progress-text">正在上传图片… {uploadPercent}%</div>
                </>
              )}
            </div>
          </div>
          <div className="field-mb">
            <div className="field">
              <label htmlFor="p-desc">商品描述</label>
              <textarea
                id="p-desc"
                rows={3}
                value={form.description}
                onChange={(e) => update("description", e.target.value)}
                placeholder="质地、适用人群等，AI 会据此生成文案"
              />
            </div>
          </div>
          <div className="field-mb">
            <Field
              label="卖点（最多 5 个）"
              value={form.sellingPoints}
              onChange={(e) => update("sellingPoints", e.target.value)}
              placeholder="轻盈质地 · 日常保湿 · 温和亲肤"
              hint="用 · 或逗号分隔"
              error={fieldErrors.sellingPoints}
            />
          </div>
          <div className="form-grid">
            <Field
              label="品牌名"
              value={form.brandName}
              onChange={(e) => update("brandName", e.target.value)}
              placeholder="LUMIÈRE"
            />
            <Field
              label="品牌色"
              value={form.brandColor}
              onChange={(e) => update("brandColor", e.target.value)}
              placeholder="#1f4d3d"
              hint="#RRGGBB 格式"
              error={fieldErrors.brandColor}
            />
          </div>

          {formError && (
            <div className="error-banner" role="alert" style={{ marginTop: 16 }}>{formError}</div>
          )}

          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>取消</Button>
            <Button onClick={save} disabled={saving}>
              {uploadPercent !== null ? "上传中…" : saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </Modal>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={relatedCount > 0 ? "商品暂不能删除" : "删除商品"}
          description={
            relatedCount > 0 ? (
              <>
                「{confirmRemove.name}」已关联 {relatedCount} 个视频任务，需先删除这些任务的记录才能删除商品。
                <div style={{ marginTop: 12 }}>
                  <Link href="/videos">前往「视频管理」处理 →</Link>
                </div>
              </>
            ) : (
              `确定删除「${confirmRemove.name}」吗？此操作不可撤销。`
            )
          }
          onConfirm={doRemove}
          onClose={() => setConfirmRemove(null)}
          busy={removing}
          confirmDisabled={relatedCount > 0}
        />
      )}
    </>
  );
}
