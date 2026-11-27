"use client";

/**
 * 模板管理页（原型 §模板管理）：全量列表 / 筛选 / 统计 / 启停 / 编辑 / 缩略图 / 同步 / 审计 / 排序。
 * 服务端 gate 在 admin/layout.tsx；本页只负责渲染与调用管理 API。
 */
import { useCallback, useRef, useState } from "react";
import { Account } from "../../../../components/AppShell";
import { useToast } from "../../../../components/Toaster";
import { Button, EmptyState, ErrorBanner, Modal, Skeleton } from "../../../../components/ui";
import { api, messageOf } from "../../../../lib/client/api";
import { invalidateAsyncCache, useAsync } from "../../../../lib/client/hooks";

interface AdminTemplate {
  id: string;
  name: string;
  compositionId: string;
  category: string;
  durationSec: number;
  sortOrder: number;
  enabled: boolean;
  registered: boolean;
  version: number;
  thumbnailPath: string | null;
  displayName: string | null;
  englishName: string | null;
  description: string | null;
  cta: string | null;
  tone: string | null;
  updatedAt: string;
}
interface ListData {
  items: AdminTemplate[];
  total: number;
  take: number;
  skip: number;
  stats: { total: number; enabled: number; renderableEnabled: number; registryMissing: number };
}
interface AuditItem {
  id: string;
  action: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: string;
}
interface SyncResult {
  created: Array<{ compositionId: string; name: string }>;
  skipped: string[];
  autoDisabled: Array<{ compositionId: string }>;
  errors: Array<{ compositionId: string; message: string }>;
}

const CAT_LABEL: Record<string, string> = {
  launch: "新品发布",
  highlight: "亮点展示",
  sale: "限时促销",
  showcase: "场景展示",
};

type ModalKey = "edit" | "disable" | "thumb" | "audit" | "sort" | "sync" | null;

export default function AdminTemplatesPage() {
  const toast = useToast();
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("");
  const [enabled, setEnabled] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const take = 10;
  const [reloadKey, setReloadKey] = useState(0);

  const query = new URLSearchParams({
    take: String(take),
    skip: String(page * take),
  });
  if (keyword) query.set("keyword", keyword);
  if (category) query.set("category", category);
  if (enabled) query.set("enabled", enabled);
  if (status) query.set("status", status);

  const { data, loading, error, reload } = useAsync<ListData>(
    () => api.get<ListData>(`/api/admin/templates?${query.toString()}`),
    { cacheKey: `admin-templates:${reloadKey}` }
  );

  const [modal, setModal] = useState<ModalKey>(null);
  const [target, setTarget] = useState<AdminTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [audits, setAudits] = useState<AuditItem[]>([]);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  // 编辑表单 state
  const [form, setForm] = useState({
    displayName: "",
    englishName: "",
    description: "",
    cta: "",
    tone: "energetic",
    sortOrder: 0,
    version: 1,
  });
  const [reason, setReason] = useState("");
  const [sortRows, setSortRows] = useState<
    Array<{ id: string; name: string; sortOrder: number; version: number }>
  >([]);

  const refresh = useCallback(() => {
    invalidateAsyncCache("templates"); // 主动失效前台缓存（M2）
    setReloadKey((n) => n + 1);
    reload();
  }, [reload]);

  function openEdit(t: AdminTemplate) {
    setTarget(t);
    setForm({
      displayName: t.displayName ?? "",
      englishName: t.englishName ?? "",
      description: t.description ?? "",
      cta: t.cta ?? "",
      tone: t.tone ?? "energetic",
      sortOrder: t.sortOrder,
      version: t.version,
    });
    setModal("edit");
  }
  function openDisable(t: AdminTemplate) {
    setTarget(t);
    setReason("");
    setModal("disable");
  }
  function openThumb(t: AdminTemplate) {
    setTarget(t);
    setModal("thumb");
  }
  async function openAudit(t: AdminTemplate) {
    setTarget(t);
    try {
      const r = await api.get<{ items: AuditItem[] }>(`/api/admin/templates/${t.id}/audits`);
      setAudits(r.items);
    } catch (e) {
      setAudits([]);
      toast.show(messageOf(e), true);
    }
    setModal("audit");
  }
  function openSort() {
    setSortRows(
      (data?.items ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        sortOrder: t.sortOrder,
        version: t.version,
      }))
    );
    setModal("sort");
  }
  async function doSync() {
    setBusy(true);
    try {
      const r = await api.post<SyncResult>("/api/admin/templates/sync");
      setSyncResult(r);
      setModal("sync");
      refresh();
    } catch (e) {
      toast.show(messageOf(e), true);
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!target) return;
    setBusy(true);
    try {
      await api.patch(`/api/admin/templates/${target.id}`, {
        version: form.version,
        displayName: form.displayName,
        englishName: form.englishName,
        description: form.description,
        cta: form.cta,
        tone: form.tone,
        sortOrder: Number(form.sortOrder),
      });
      toast.show("保存成功 · 前台 60s 内生效，已写入审计");
      setModal(null);
      refresh();
    } catch (e) {
      toast.show(messageOf(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function doEnableDisable(kind: "enable" | "disable") {
    if (!target) return;
    setBusy(true);
    try {
      await api.post(`/api/admin/templates/${target.id}/${kind}`, kind === "disable" ? { reason } : {});
      toast.show(kind === "disable" ? "模板已停用 · 已失效前台缓存；retry 不受影响" : "模板已启用");
      setModal(null);
      refresh();
    } catch (e) {
      toast.show(messageOf(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function doThumb(file: File | null) {
    if (!target || !file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      await api.upload(`/api/admin/templates/${target.id}/thumbnail`, fd);
      toast.show("缩略图上传成功 · 前台 60s 内生效");
      setModal(null);
      refresh();
    } catch (e) {
      toast.show(messageOf(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function saveSort() {
    setBusy(true);
    try {
      await api.post("/api/admin/templates/sort", {
        items: sortRows.map((r) => ({
          id: r.id,
          sortOrder: Number(r.sortOrder),
          version: r.version,
        })),
      });
      toast.show("排序已保存");
      setModal(null);
      refresh();
    } catch (e) {
      toast.show(messageOf(e), true);
    } finally {
      setBusy(false);
    }
  }

  const lastRenderable = (data?.stats.renderableEnabled ?? 2) <= 1;

  return (
    <>
      <div className="app-top">
        <div>
          <h1>模板管理</h1>
          <p className="muted">管理展示信息、启停与前台排序 · 渲染契约由代码发版维护，此处不可修改</p>
        </div>
        <Account />
      </div>

      <div className="stat-row">
        <div className="stat"><div className="k">模板总数</div><div className="v">{data?.stats.total ?? "—"} <small>条</small></div></div>
        <div className="stat"><div className="k">启用中</div><div className="v">{data?.stats.enabled ?? "—"} <small>条</small></div></div>
        <div className="stat accent"><div className="k">可渲染启用</div><div className="v">{data?.stats.renderableEnabled ?? "—"} <small>条 · 计入守卫</small></div></div>
        <div className="stat"><div className="k">注册缺失</div><div className="v">{data?.stats.registryMissing ?? "—"} <small>条 · 同步时自动停用</small></div></div>
      </div>

      <div className={`admin-boundary${lastRenderable ? " danger" : ""}`}>
        <div>
          <b>{lastRenderable ? "仅剩 1 套可渲染启用模板，停用操作将被拦截" : "模板元数据由 DB 下发，改文案无需发版"}</b>
          <span>
            {lastRenderable
              ? "服务器返回 409 TEMPLATE_LAST_ENABLED，需先启用其他模板。"
              : "同步不覆盖已编辑元数据；注册缺失且启用的行自动停用并写审计。"}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={doSync} disabled={busy}>↻ 从注册表同步</Button>
      </div>

      <div className="admin-filter">
        <input type="search" placeholder="搜索展示名称或内部 ID…" aria-label="搜索模板" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(0); }} />
        <select aria-label="按分类筛选" value={category} onChange={(e) => { setCategory(e.target.value); setPage(0); }}>
          <option value="">全部分类</option>
          {Object.entries(CAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v} {k}</option>)}
        </select>
        <select aria-label="按启用状态筛选" value={enabled} onChange={(e) => { setEnabled(e.target.value); setPage(0); }}>
          <option value="">全部状态</option>
          <option value="true">启用</option>
          <option value="false">停用</option>
        </select>
        <select aria-label="按注册状态筛选" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
          <option value="">全部注册状态</option>
          <option value="registered">已注册</option>
          <option value="missing">注册缺失</option>
        </select>
        <Button variant="ghost" size="sm" onClick={openSort}>↕ 批量排序</Button>
      </div>

      {loading && <Skeleton lines={6} />}
      {!loading && error && <ErrorBanner message={error} onRetry={refresh} />}
      {!loading && !error && (data?.items.length ?? 0) === 0 && (
        <EmptyState icon="▤" text="没有符合条件的模板。试试调整筛选条件，或从注册表同步新模板。" action={<Button onClick={doSync}>从注册表同步</Button>} />
      )}
      {!loading && !error && (data?.items.length ?? 0) > 0 && (
        <>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr>
                <th>模板</th><th>分类</th><th>时长</th><th>排序</th><th>启用状态</th><th>注册状态</th><th>操作</th>
              </tr></thead>
              <tbody>
                {data!.items.map((t) => {
                  const disableBlocked = lastRenderable && t.enabled;
                  return (
                    <tr key={t.id} className={t.registered ? "" : "reg-missing"}>
                      <td className="cell-main"><b>{t.name}</b><span className="cell-sub">{t.compositionId}</span></td>
                      <td><span className="admin-chip">{CAT_LABEL[t.category] ?? t.category}</span></td>
                      <td className="tabular">{t.durationSec}s <span className="muted">(只读镜像)</span></td>
                      <td className="tabular">{t.sortOrder}</td>
                      <td><span className={`badge ${t.enabled ? "ok" : "neutral"}`}>{t.enabled ? "启用" : "停用"}</span></td>
                      <td>{t.registered ? <span className="admin-reg-ok">✓ 已注册</span> : <span className="admin-reg-bad" title="禁止启用，同步时自动停用">⚠ 注册缺失</span>}</td>
                      <td>
                        <div className="admin-ops">
                          <button className="admin-link" onClick={() => openEdit(t)}>编辑</button>
                          <button
                            className="admin-link"
                            onClick={() => (t.enabled ? openDisable(t) : doEnableDirect(t))}
                            disabled={!t.registered || disableBlocked}
                            title={!t.registered ? "注册缺失，禁止启用" : disableBlocked ? "最后一套可渲染模板不可停用" : undefined}
                          >{t.enabled ? "停用" : "启用"}</button>
                          <button className="admin-icon" onClick={() => openThumb(t)} aria-label={`上传缩略图 ${t.name}`} title="上传缩略图">▧</button>
                          <button className="admin-icon" onClick={() => openAudit(t)} aria-label={`查看审计 ${t.name}`} title="查看审计">◷</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="table-foot" style={{ display: "flex", justifyContent: "space-between", padding: "12px 2px", fontSize: ".74rem", color: "var(--ink-3)" }}>
            <span>共 {data!.total} 条 · 每页 {take} 条</span>
            <span>
              <button className="admin-link" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹ 上一页</button>
              <button className="admin-link" disabled={(page + 1) * take >= data!.total} onClick={() => setPage((p) => p + 1)}>下一页 ›</button>
            </span>
          </div>
        </>
      )}

      {/* 编辑 */}
      {modal === "edit" && target && (
        <Modal title={`编辑模板 · ${target.name}`} onClose={() => setModal(null)}>
          <div className="admin-form-grid">
            <div className="field"><label>展示名称（中文）*</label><input maxLength={120} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></div>
            <div className="field"><label>展示名称（英文）</label><input maxLength={120} value={form.englishName} onChange={(e) => setForm({ ...form, englishName: e.target.value })} /></div>
            <div className="field full"><label>模板描述</label><textarea maxLength={300} rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div className="field"><label>行动按钮文案 CTA</label><input maxLength={60} value={form.cta} onChange={(e) => setForm({ ...form, cta: e.target.value })} /></div>
            <div className="field"><label>tone 枚举</label><select value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })}>
              {["energetic", "calm", "premium", "playful", "urgent"].map((v) => <option key={v}>{v}</option>)}
            </select></div>
            <div className="field"><label>排序值 sortOrder</label><input type="number" min={0} max={999} value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} /></div>
          </div>
          <div className="admin-ro" style={{ marginTop: "var(--sp-5)" }}>
            <div><span>compositionId（只读）</span><code>{target.compositionId}</code></div>
            <div><span>时长 durationSec（只读镜像）</span><code>{target.durationSec} 秒</code></div>
          </div>
          <p className="admin-note" style={{ marginTop: "var(--sp-4)" }}>version {form.version} · 乐观锁。若他人已修改，保存将返回 409 并提示刷新。修改渲染契约需改代码并发版，管理端不提供入口。</p>
          <div className="modal-actions"><Button variant="ghost" onClick={() => setModal(null)}>取消</Button><Button onClick={saveEdit} disabled={busy}>{busy ? "保存中…" : "保存更改"}</Button></div>
        </Modal>
      )}

      {/* 停用确认 */}
      {modal === "disable" && target && (
        <Modal title={`停用模板 · ${target.name}`} onClose={() => setModal(null)}>
          <div className="admin-warn"><b>停用后的行为</b><ul>
            <li>前台不再展示；新提交与 <b>regenerate</b> 会被服务端拒绝</li>
            <li>已提交任务不受影响；已付费失败任务的 <b>retry 仍可重试</b></li>
            <li>历史任务不回读模板元数据，不会「变脸」</li>
          </ul></div>
          <div className="field"><label>停用原因（选填）</label><textarea rows={3} placeholder="例如：活动结束，暂时下架" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="modal-actions"><Button variant="ghost" onClick={() => setModal(null)}>取消</Button><Button variant="danger" onClick={() => doEnableDisable("disable")} disabled={busy}>{busy ? "处理中…" : "确认停用"}</Button></div>
        </Modal>
      )}

      {/* 缩略图上传 */}
      {modal === "thumb" && target && (
        <Modal title={`上传缩略图 · ${target.name}`} onClose={() => setModal(null)}>
          <ThumbForm onFile={doThumb} busy={busy} />
          <p className="admin-note">卡片静帧封面；实时视频预览由注册表 Composition 提供，二者互不替代。PNG/JPG/WEBP · ≤10MB，SVG 一律拒绝。</p>
          <div className="modal-actions"><Button variant="ghost" onClick={() => setModal(null)}>取消</Button></div>
        </Modal>
      )}

      {/* 审计 */}
      {modal === "audit" && target && (
        <Modal title={`操作审计 · ${target.name}`} onClose={() => setModal(null)}>
          {audits.length === 0 ? <EmptyState icon="◷" text="暂无审计记录" /> : (
            <div>
              {audits.map((a) => (
                <div className="admin-audit-item" key={a.id}>
                  <div className="t">{new Date(a.createdAt).toLocaleString("zh-CN")} · {a.action}</div>
                  {a.reason && <div className="a">{a.reason}</div>}
                  <div className="d">− {JSON.stringify(a.before)}<br />+ {JSON.stringify(a.after)}</div>
                </div>
              ))}
            </div>
          )}
          <p className="admin-note" style={{ marginTop: "var(--sp-4)" }}>审计与主操作同一事务，写失败整笔回滚。</p>
          <div className="modal-actions"><Button variant="ghost" onClick={() => setModal(null)}>关闭</Button></div>
        </Modal>
      )}

      {/* 批量排序 */}
      {modal === "sort" && (
        <Modal title="批量调整排序" onClose={() => setModal(null)}>
          <p className="muted" style={{ marginBottom: 12 }}>分类为固定 4 类代码枚举；排序值 0~999，升序；相同值按 composition_id 兜底。整批同一事务。</p>
          <div className="admin-table-wrap"><table className="admin-table" style={{ minWidth: 480 }}>
            <thead><tr><th>模板</th><th>分类</th><th>排序值</th></tr></thead>
            <tbody>{sortRows.map((r, i) => (
              <tr key={r.id}><td>{r.name}</td><td><span className="admin-chip">{CAT_LABEL[data?.items.find((t) => t.id === r.id)?.category ?? ""] ?? ""}</span></td>
                <td><input type="number" min={0} max={999} value={r.sortOrder} onChange={(e) => setSortRows(sortRows.map((x, j) => j === i ? { ...x, sortOrder: Number(e.target.value) } : x))} style={{ width: 90, minHeight: 44, padding: "0 8px" }} /></td></tr>
            ))}</tbody>
          </table></div>
          <div className="modal-actions"><Button variant="ghost" onClick={() => setModal(null)}>取消</Button><Button onClick={saveSort} disabled={busy}>{busy ? "保存中…" : "保存排序"}</Button></div>
        </Modal>
      )}

      {/* 同步结果 */}
      {modal === "sync" && syncResult && (
        <Modal title="注册表同步完成" onClose={() => setModal(null)}>
          <div className="admin-result-grid">
            <div><b>{syncResult.created.length}</b><span>新增</span></div>
            <div><b>{syncResult.skipped.length}</b><span>跳过</span></div>
            <div><b>{syncResult.autoDisabled.length}</b><span>自动停用</span></div>
            <div><b>{syncResult.errors.length}</b><span>异常</span></div>
          </div>
          {syncResult.created.length > 0 && <p className="admin-note">新增（默认停用）：{syncResult.created.map((c) => c.compositionId).join(" / ")}</p>}
          {syncResult.autoDisabled.length > 0 && <p className="admin-note">自动停用 + 写审计：{syncResult.autoDisabled.map((c) => c.compositionId).join(" / ")}</p>}
          <div className="modal-actions"><Button onClick={() => setModal(null)}>知道了</Button></div>
        </Modal>
      )}
    </>
  );

  async function doEnableDirect(t: AdminTemplate) {
    setBusy(true);
    try {
      await api.post(`/api/admin/templates/${t.id}/enable`, {});
      toast.show("模板已启用");
      refresh();
    } catch (e) {
      toast.show(messageOf(e), true);
    } finally {
      setBusy(false);
    }
  }
}

function ThumbForm({ onFile, busy }: { onFile: (f: File | null) => void; busy: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  return (
    <div className={busy ? "admin-busy" : ""}>
      <div className="admin-dropzone" onClick={() => inputRef.current?.click()}>
        <div><b>{file ? file.name : "点击选择缩略图"}</b>支持 PNG / JPG / WEBP · ≤10MB<br />服务端校验扩展名 + MIME + 文件头 sniff；SVG 一律拒绝</div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <div className="modal-actions"><Button variant="ghost" onClick={() => inputRef.current?.click()}>选择文件</Button><Button onClick={() => onFile(file)} disabled={!file || busy}>{busy ? "上传中…" : "确认上传"}</Button></div>
    </div>
  );
}
