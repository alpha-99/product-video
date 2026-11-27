"use client";

/**
 * 成员与角色页（原型 §成员与角色）：只读成员列表 / 待复核 / 角色变更记录。
 * 提权走双人复核、降权走独立接口；发起人不显示「批准」按钮，过期单不可批准。
 */
import { useCallback, useState } from "react";
import { Account } from "../../../../components/AppShell";
import { useToast } from "../../../../components/Toaster";
import { Button, EmptyState, ErrorBanner, Modal, Skeleton } from "../../../../components/ui";
import { api, messageOf } from "../../../../lib/client/api";
import { useAsync } from "../../../../lib/client/hooks";

interface Member {
  id: string;
  email: string;
  role: "user" | "admin";
  createdAt: string;
}
interface MemberData {
  items: Member[];
  total: number;
  adminCount: number;
}
interface RoleRequest {
  id: string;
  targetUserId: string;
  fromRole: string;
  toRole: string;
  requestedBy: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  reviewedBy: string | null;
  expiresAt: string;
  canApprove: boolean;
}
interface ReviewData { items: RoleRequest[]; adminCount: number }
interface AuditItem {
  id: string;
  targetUserId: string;
  actorUserId: string | null;
  actorLabel: string | null;
  source: string;
  fromRole: string;
  toRole: string;
  reason: string | null;
  createdAt: string;
}

type Tab = "list" | "review" | "audit";
type ModalKey =
  | { kind: "request"; member: Member }
  | { kind: "revoke"; member: Member }
  | { kind: "approve"; req: RoleRequest }
  | { kind: "reject"; req: RoleRequest }
  | null;

export default function AdminUsersPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("list");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<ModalKey>(null);

  const [reqReason, setReqReason] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const [revokeConfirm, setRevokeConfirm] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  const memberQuery = new URLSearchParams({ take: "100" });
  if (email) memberQuery.set("email", email);
  if (role) memberQuery.set("role", role);

  const members = useAsync<MemberData>(
    () => api.get<MemberData>(`/api/admin/users?${memberQuery.toString()}`),
    { cacheKey: `admin-users:${reloadKey}` }
  );
  const reviews = useAsync<ReviewData>(
    () => api.get<ReviewData>("/api/admin/users/role-requests"),
    { cacheKey: `admin-requests:${reloadKey}` }
  );
  const audits = useAsync<{ items: AuditItem[] }>(
    () => api.get<{ items: AuditItem[] }>("/api/admin/users/role-audits?take=100"),
    { cacheKey: `admin-role-audits:${reloadKey}` }
  );

  const refresh = useCallback(() => {
    setReloadKey((n) => n + 1);
    members.reload();
    reviews.reload();
    audits.reload();
  }, [members, reviews, audits]);

  async function submitRequest() {
    if (!modal || modal.kind !== "request") return;
    setBusy(true);
    try {
      await api.post("/api/admin/users/role-requests", {
        targetUserId: modal.member.id,
        role: "admin",
        reason: reqReason,
      });
      toast.show("提权申请已提交 · 等待另一名管理员复核");
      setModal(null);
      refresh();
    } catch (e) {
      toast.show(messageOf(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function submitRevoke() {
    if (!modal || modal.kind !== "revoke") return;
    setBusy(true);
    try {
      await api.patch(`/api/admin/users/${modal.member.id}/role`, {
        role: "user",
        reason: revokeReason,
        confirmEmail: revokeConfirm,
      });
      toast.show("已撤销管理员权限 · 角色审计已记录");
      setModal(null);
      refresh();
    } catch (e) {
      toast.show(messageOf(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function approve(req: RoleRequest) {
    setBusy(true);
    try {
      await api.post(`/api/admin/users/role-requests/${req.id}/approve`, {});
      toast.show("批准成功 · 目标已成为管理员，审计恰好 1 条");
      setModal(null);
      refresh();
    } catch (e) {
      toast.show(messageOf(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function reject(req: RoleRequest) {
    setBusy(true);
    try {
      await api.post(`/api/admin/users/role-requests/${req.id}/reject`, { reason: rejectReason });
      toast.show("已驳回申请");
      setModal(null);
      refresh();
    } catch (e) {
      toast.show(messageOf(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function cancel(req: RoleRequest) {
    try {
      await api.post(`/api/admin/users/role-requests/${req.id}/cancel`, {});
      toast.show("已撤回申请");
      refresh();
    } catch (e) {
      toast.show(messageOf(e), true);
    }
  }

  const adminCount = members.data?.adminCount ?? reviews.data?.adminCount ?? 2;
  const canRequest = adminCount >= 2;

  return (
    <>
      <div className="app-top">
        <div>
          <h1>成员与角色</h1>
          <p className="muted">只读列出最小字段，仅用于选择角色变更目标 · 不提供用户新建 / 删除 / 停用</p>
        </div>
        <Account />
      </div>

      <div className="admin-boundary">
        <div>
          <b>当前管理员 {adminCount} 名（主 / 备） · 提权需另一名管理员复核</b>
          <span>{canRequest ? "少于 2 名时提权入口冻结，需通过运维脚本 bootstrap 备用账号；撤销后下一次请求即失效。" : "管理员不足 2 名，提权入口已冻结，请通过运维脚本补齐备用账号。"}</span>
        </div>
      </div>

      <div className="admin-tabs" role="tablist" aria-label="成员与角色分区">
        <button className="admin-tab" role="tab" aria-selected={tab === "list"} onClick={() => setTab("list")}>成员列表</button>
        <button className="admin-tab" role="tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>
          待复核 <span className="cnt">{(reviews.data?.items ?? []).filter((r) => r.status === "pending").length}</span>
        </button>
        <button className="admin-tab" role="tab" aria-selected={tab === "audit"} onClick={() => setTab("audit")}>角色变更记录</button>
      </div>

      {tab === "list" && (
        <>
          <div className="admin-filter">
            <input type="search" placeholder="输入完整邮箱精确匹配…" aria-label="精确搜索成员邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
            <span className="muted">仅精确匹配 · 10 次/分限流 · 查询写结构化告警日志</span>
            <select aria-label="按角色筛选" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">全部角色</option>
              <option value="admin">管理员</option>
              <option value="user">普通用户</option>
            </select>
          </div>
          {members.loading && <Skeleton lines={5} />}
          {!members.loading && members.error && <ErrorBanner message={members.error} onRetry={refresh} />}
          {!members.loading && !members.error && (members.data?.items.length ?? 0) === 0 && (
            <EmptyState icon="♙" text="没有匹配的成员。请检查邮箱是否完整（精确匹配）。" />
          )}
          {!members.loading && !members.error && (members.data?.items.length ?? 0) > 0 && (
            <div className="admin-table-wrap">
              <table className="admin-table" style={{ minWidth: 720 }}>
                <thead><tr><th>账号邮箱</th><th>角色</th><th>注册时间</th><th>操作</th></tr></thead>
                <tbody>
                  {members.data!.items.map((m) => (
                    <tr key={m.id}>
                      <td><b>{m.email}</b></td>
                      <td><span className={`badge ${m.role === "admin" ? "ok" : "neutral"}`}>{m.role === "admin" ? "管理员" : "普通用户"}</span></td>
                      <td className="tabular muted">{new Date(m.createdAt).toLocaleString("zh-CN")}</td>
                      <td><div className="admin-ops">
                        {m.role === "user" ? (
                          <button className="admin-link" disabled={!canRequest} title={!canRequest ? "管理员不足 2 名" : undefined}
                            onClick={() => { setReqReason(""); setModal({ kind: "request", member: m }); }}>申请设为管理员</button>
                        ) : (
                          <button className="admin-link" style={{ color: "var(--error-fg)" }}
                            onClick={() => { setRevokeReason(""); setRevokeConfirm(""); setModal({ kind: "revoke", member: m }); }}>撤销管理员</button>
                        )}
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === "review" && (
        <>
          <div className="admin-boundary">
            <div>
              <b>{(reviews.data?.items ?? []).filter((r) => r.status === "pending").length} 条待复核申请 · 24 小时内有效</b>
              <span>发起人不可批准自己的申请；过期单在列表读取时置为 expired，不可批准。</span>
            </div>
          </div>
          {reviews.loading && <Skeleton lines={4} />}
          {!reviews.loading && reviews.error && <ErrorBanner message={reviews.error} onRetry={refresh} />}
          {!reviews.loading && !reviews.error && (reviews.data?.items.length ?? 0) === 0 && (
            <EmptyState icon="◷" text="暂无提权申请" />
          )}
          {(reviews.data?.items ?? []).map((r) => (
            <div key={r.id} className={`review-card${r.canApprove ? "" : " mine"}${r.status === "expired" ? " expired" : ""}`}>
              <div className="review-head">
                <div>
                  <b>目标账号 {r.targetUserId.slice(0, 8)}…</b>{" "}
                  <span className={`badge ${r.status === "pending" ? "wait" : "neutral"}`}>{
                    { pending: "待复核", approved: "已批准", rejected: "已驳回", expired: "已过期", cancelled: "已撤回" }[r.status]
                  }</span>
                </div>
                <span className="muted">剩余至 {new Date(r.expiresAt).toLocaleString("zh-CN")}</span>
              </div>
              <div className="review-meta">
                <div><span>目标角色</span>{r.fromRole} → <b>admin</b></div>
                <div><span>发起人</span>{r.requestedBy.slice(0, 8)}…</div>
                <div><span>申请原因</span>{r.reason}</div>
              </div>
              <div className="admin-ops" style={{ marginTop: 12 }}>
                {r.canApprove ? (
                  <>
                    <Button size="sm" onClick={() => { setModal({ kind: "approve", req: r }); }}>批准</Button>
                    <Button variant="ghost" size="sm" onClick={() => { setRejectReason(""); setModal({ kind: "reject", req: r }); }}>驳回</Button>
                  </>
                ) : r.status === "pending" ? (
                  <button className="admin-link" onClick={() => cancel(r)}>撤回申请</button>
                ) : (
                  <span className="muted">不可批准 · 状态为 {r.status}</span>
                )}
              </div>
            </div>
          ))}
        </>
      )}

      {tab === "audit" && (
        <>
          {audits.loading && <Skeleton lines={5} />}
          {!audits.loading && audits.error && <ErrorBanner message={audits.error} onRetry={refresh} />}
          {!audits.loading && !audits.error && (audits.data?.items.length ?? 0) === 0 && (
            <EmptyState icon="◷" text="暂无角色变更记录" />
          )}
          {(audits.data?.items.length ?? 0) > 0 && (
            <div className="admin-table-wrap">
              <table className="admin-table" style={{ minWidth: 760 }}>
                <thead><tr><th>时间</th><th>目标账号</th><th>角色变更</th><th>操作人 / 来源</th><th>原因</th></tr></thead>
                <tbody>
                  {audits.data!.items.map((a) => (
                    <tr key={a.id}>
                      <td className="tabular">{new Date(a.createdAt).toLocaleString("zh-CN")}</td>
                      <td className="cell-sub">{a.targetUserId.slice(0, 8)}…</td>
                      <td><span className="admin-chip">{a.fromRole}</span> → <span className="admin-chip">{a.toRole}</span></td>
                      <td>{(a.actorUserId ?? a.actorLabel ?? "—").slice(0, 12)} <span className="admin-chip">{a.source}</span></td>
                      <td>{a.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* 申请提权 */}
      {modal?.kind === "request" && (
        <Modal title="申请设为管理员" onClose={() => setModal(null)}>
          <div className="field"><label>目标账号（只读）</label><input value={modal.member.email} disabled /></div>
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <span className="badge neutral">user · 普通用户</span>→ <span className="badge ok">admin · 管理员</span>
          </div>
          <div className="field" style={{ marginTop: 16 }}><label>申请原因 *</label><textarea rows={4} placeholder="请说明为何需要管理后台权限" value={reqReason} onChange={(e) => setReqReason(e.target.value)} /><span className="hint">必填，写入审计与复核单；24 小时内有效</span></div>
          <p className="admin-note">提交后由另一名管理员在「待复核」中批准；你不能批准自己的申请。</p>
          <div className="modal-actions"><Button variant="ghost" onClick={() => setModal(null)}>取消</Button><Button onClick={submitRequest} disabled={busy || !reqReason.trim()}>{busy ? "提交中…" : "提交申请"}</Button></div>
        </Modal>
      )}

      {/* 撤销管理员 */}
      {modal?.kind === "revoke" && (
        <Modal title={`撤销管理员 · ${modal.member.email}`} onClose={() => setModal(null)}>
          <div className="admin-warn"><b>撤销后的影响</b><ul>
            <li>该账号下一次请求即失去管理端访问权限，无需重新登录</li>
            <li>不能撤销自己；撤销后管理员数必须 ≥ 1</li>
            <li>角色审计与角色更新同事务，写失败整笔回滚</li>
          </ul></div>
          <div className="field"><label>撤销原因 *</label><textarea rows={3} value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} /></div>
          <div className="field" style={{ marginTop: 12 }}><label>二次确认：输入目标邮箱</label><input placeholder={modal.member.email} value={revokeConfirm} onChange={(e) => setRevokeConfirm(e.target.value)} /><span className="hint">输入不一致时按钮保持禁用</span></div>
          <div className="modal-actions"><Button variant="ghost" onClick={() => setModal(null)}>取消</Button><Button variant="danger" onClick={submitRevoke} disabled={busy || !revokeReason.trim() || revokeConfirm.trim() !== modal.member.email}>{busy ? "处理中…" : "确认撤销"}</Button></div>
        </Modal>
      )}

      {/* 批准 */}
      {modal?.kind === "approve" && (
        <Modal title="复核提权申请" onClose={() => setModal(null)}>
          <div className="review-meta">
            <div><span>目标账号</span><b>{modal.req.targetUserId.slice(0, 8)}…</b></div>
            <div><span>发起人</span>{modal.req.requestedBy.slice(0, 8)}…</div>
            <div><span>申请原因</span>{modal.req.reason}</div>
          </div>
          <div className="admin-warn" style={{ marginTop: 14 }}><b>批准即生效</b><ul>
            <li>服务端重新校验：审批人 ≠ 发起人、目标仍为 user、申请未过期</li>
            <li>条件更新断言 count===1，防止并发双写</li>
            <li>角色变更 + 审计 + 关单在同一事务内完成</li>
          </ul></div>
          <div className="modal-actions"><Button variant="ghost" onClick={() => setModal(null)}>取消</Button><Button onClick={() => approve(modal.req)} disabled={busy}>{busy ? "处理中…" : "批准"}</Button></div>
        </Modal>
      )}

      {/* 驳回 */}
      {modal?.kind === "reject" && (
        <Modal title="驳回提权申请" onClose={() => setModal(null)}>
          <div className="field"><label>驳回理由 *</label><textarea rows={4} placeholder="请说明驳回原因" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} /><span className="hint">写入 review_reason，发起人可见</span></div>
          <div className="modal-actions"><Button variant="ghost" onClick={() => setModal(null)}>取消</Button><Button variant="danger" onClick={() => reject(modal.req)} disabled={busy || !rejectReason.trim()}>{busy ? "处理中…" : "确认驳回"}</Button></div>
        </Modal>
      )}
    </>
  );
}
