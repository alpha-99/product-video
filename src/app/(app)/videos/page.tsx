"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Account, useShell } from "../../../components/AppShell";
import { useToast } from "../../../components/Toaster";
import {
  Badge, Button, ConfirmDialog, EmptyState, ErrorBanner, Modal, Skeleton,
} from "../../../components/ui";
import {
  api, fetchRaw, messageOf, newIdempotencyKey,
} from "../../../lib/client/api";
import { invalidateAsyncCache, useAsync, usePolling } from "../../../lib/client/hooks";
import {
  MAX_JOB_ATTEMPTS, type TemplateDto, type VideoJobDto,
} from "../../../lib/client/types";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

type ConfirmKind = "cancel" | "delete" | "retry" | "regenerate";
interface CancelResult {
  id: string;
  status: string;
  cancelled: boolean;
}

/** 验收 P2-06：消费已入库的 thumbnailPath，失败时回退到渐变占位。 */
function JobThumb({ job, index }: { job: VideoJobDto; index: number }) {
  const [broken, setBroken] = useState(false);
  const canShow = job.status === "completed" && Boolean(job.thumbnailPath) && !broken;
  return (
    <div className={`vt g${(index % 4) + 1}`}>
      {canShow && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/videos/${job.id}/thumbnail`}
          alt="视频缩略图"
          onError={() => setBroken(true)}
        />
      )}
    </div>
  );
}

export default function VideosPage() {
  const router = useRouter();
  const toast = useToast();
  const { me, refreshMe } = useShell();
  const jobsQuery = useAsync<VideoJobDto[]>(
    () => api.get<VideoJobDto[]>("/api/videos?take=100"),
    { cacheKey: "videos" }
  );
  const templatesQuery = useAsync<TemplateDto[]>(
    () => api.get<TemplateDto[]>("/api/templates"),
    { cacheKey: "templates", ttlMs: 60_000 }
  );
  const [playing, setPlaying] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // 验收 P1-04 / P1-05：四个动作统一走确认框，消耗额度的动作在触发前明示。
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; job: VideoJobDto } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const jobs = jobsQuery.data ?? [];
  const hasActive = jobs.some((j) => j.status === "pending" || j.status === "processing");
  // 只有存在未终态任务时才轮询；页面隐藏时 hook 自动暂停。
  usePolling(jobsQuery.reload, hasActive && !jobsQuery.loading, 5000);

  const templateName = (id: string) =>
    templatesQuery.data?.find((t) => t.id === id)?.label ?? "视频模板";

  /** 写操作后失效共享缓存并刷新，避免跨页面短暂看到旧列表（验收 P2-12）。 */
  function refreshAfterMutation() {
    invalidateAsyncCache("videos");
    invalidateAsyncCache("me");
    jobsQuery.reload();
    refreshMe();
  }

  /** 打开确认框时先拉一次最新列表，缩小 5s 轮询窗口造成的状态偏差。 */
  function openConfirm(kind: ConfirmKind, job: VideoJobDto) {
    void jobsQuery.reload();
    setConfirm({ kind, job });
  }

  /**
   * 失败 / 已取消任务「重新编辑」：把服务端快照带到创作页，用户改完参数后
   * 走标准 POST /api/videos 重新提交。不受 attempt 上限约束——重试同一份参数
   * 大概率再次失败，改参数再提交才是真正的出路。
   */
  function reedit(job: VideoJobDto) {
    router.push(`/create?from=${encodeURIComponent(job.id)}`);
  }

  async function download(job: VideoJobDto) {
    setBusy(job.id);
    try {
      const response = await fetchRaw(`/api/videos/${job.id}/download`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${job.id}.mp4`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) {
      toast.show(messageOf(error), true);
    } finally {
      setBusy(null);
    }
  }

  async function doConfirm() {
    if (!confirm) return;
    const { kind, job } = confirm;
    setConfirmBusy(true);
    setBusy(job.id);
    try {
      if (kind === "cancel") {
        // 验收 P1-05：以服务端最新状态为准，避免对已终态任务发出「取消成功」的误导。
        const latest = await api.get<VideoJobDto>(`/api/videos/${job.id}`);
        if (latest.status !== "pending" && latest.status !== "processing") {
          toast.show("任务状态已更新，无法取消；请刷新后重试", true);
          setConfirm(null);
          refreshAfterMutation();
          return;
        }
        const result = await api.delete<CancelResult>(`/api/videos/${job.id}`);
        if (result.cancelled === false) {
          toast.show("任务状态已变更，未能取消；请刷新后重试", true);
        } else {
          toast.show("任务已取消，额度已返还");
        }
      } else if (kind === "delete") {
        const result = await api.delete<{ id: string; deleted: boolean; cleanupPending?: boolean }>(
          `/api/videos/${job.id}?purge=1`
        );
        toast.show(
          result.cleanupPending
            ? "视频记录已删除，部分文件清理将稍后重试"
            : "视频记录与成片文件已删除"
        );
      } else if (kind === "retry") {
        await api.post(`/api/videos/${job.id}/retry`);
        toast.show("任务已重新入队，消耗 1 次额度");
      } else {
        await api.post(
          `/api/videos/${job.id}/regenerate`,
          {},
          { idempotencyKey: newIdempotencyKey() }
        );
        toast.show("已按原参数新建任务，消耗 1 次额度");
      }
      refreshAfterMutation();
      setConfirm(null);
    } catch (error) {
      toast.show(messageOf(error), true);
      refreshAfterMutation();
    } finally {
      setBusy(null);
      setConfirmBusy(false);
    }
  }

  const loading = jobsQuery.loading || templatesQuery.loading;
  const error = jobsQuery.error ?? templatesQuery.error;

  const confirmCopy = (kind: ConfirmKind, job: VideoJobDto) => {
    const quota = me?.quotaLeft ?? "—";
    switch (kind) {
      case "cancel":
        return {
          title: "取消任务",
          description: "确定取消该任务吗？取消后额度将返还，已产生的渲染进度会丢弃。",
          label: "确认取消",
          danger: false,
        };
      case "delete":
        return {
          title: "删除视频",
          description: `确定删除「${job.inputJson?.props?.title ?? "该视频"}」吗？将同时删除视频记录与成片文件，此操作不可撤销。额度流水会保留用于对账。`,
          label: "确认删除",
          danger: true,
        };
      case "retry":
        return {
          title: "重新生成视频",
          description: `将重新占用 1 次额度并从头渲染该任务（保留原参数）。当前剩余额度 ${quota} 次。`,
          label: "确认重试",
          danger: false,
        };
      case "regenerate":
        return {
          title: "按原参数新建视频",
          description: `将新建一条任务并消耗 1 次额度，原视频与记录保持不变。当前剩余额度 ${quota} 次。`,
          label: "确认新建",
          danger: false,
        };
    }
  };

  return (
    <>
      <div className="app-top">
        <h1>视频管理</h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {/* P2-4：加载中不再显示「共 0 条」，与模板页口径一致 */}
          <span className="muted">
            {loading && jobs.length === 0 ? "视频加载中…" : `共 ${jobs.length} 条`}
          </span>
          <Account />
        </div>
      </div>

      {hasActive && (
        <div className="boundary" style={{ marginBottom: 20 }}>
          <div>
            <b>有任务正在排队</b>
            {/* 验收 P2-12：面向用户文案不再泄露内部运维命令。 */}
            <span>状态每 5 秒自动刷新；若长时间停在「等待中」，请联系管理员确认渲染服务状态</span>
          </div>
          <Button variant="ghost" size="sm" onClick={jobsQuery.reload}>立即刷新</Button>
        </div>
      )}

      {/* 验收第 9 章：后台刷新失败时给出非致命提示，不再静默显示旧状态。 */}
      {jobsQuery.refreshError && !loading && (
        <div className="boundary" role="status" style={{ marginBottom: 16 }}>
          <div>
            <b>状态刷新失败</b>
            <span>仍显示上一次数据，系统会自动重试：{jobsQuery.refreshError}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={jobsQuery.reload}>立即刷新</Button>
        </div>
      )}

      {loading && <Skeleton lines={5} />}
      {!loading && error && <ErrorBanner message={error} onRetry={jobsQuery.reload} />}
      {!loading && !error && jobs.length === 0 && (
        <EmptyState
          icon="▶"
          text="还没有视频，去创作第一条吧"
          action={<Button onClick={() => (window.location.href = "/create")}>新建视频</Button>}
        />
      )}
      {!loading && !error && jobs.length > 0 && (
        <div className="vlist">
          {jobs.map((job, index) => {
            const completed = job.status === "completed";
            const active = job.status === "pending" || job.status === "processing";
            const failed = job.status === "failed";
            const cancelled = job.status === "cancelled";
            const finished = completed || failed || cancelled;
            // 验收 P1-02 / P1-03：cancelled 补重试入口；达到上限的任务不再展示必然被拒的按钮。
            const canRetry = (failed || cancelled) && job.attempt < MAX_JOB_ATTEMPTS;
            // 重新编辑走「改参数后新建任务」，不受 attempt 上限约束，失败/取消任务始终可用。
            const canReedit = failed || cancelled;
            const title = job.inputJson?.props?.title ?? "商品视频";
            return (
              <div className="vrow" key={job.id}>
                <JobThumb job={job} index={index} />
                <div className="info">
                  <b>{title}</b>
                  <span>{templateName(job.templateId)} · {timeAgo(job.createdAt)}</span>
                </div>
                <Badge status={job.status} />
                <div className="ops">
                  <button className="icon-btn" disabled={!completed || busy === job.id} onClick={() => setPlaying(job.id)} title="播放" aria-label="播放">▶</button>
                  <button className="icon-btn" disabled={!completed || busy === job.id} onClick={() => download(job)} title="下载" aria-label="下载">↓</button>
                  {canRetry && (
                    <button
                      className="icon-btn"
                      disabled={busy === job.id}
                      onClick={() => openConfirm("retry", job)}
                      title="重试该任务（消耗 1 次额度）"
                      aria-label="重试该任务（消耗 1 次额度）"
                    >
                      ↻
                    </button>
                  )}
                  {completed && (
                    <button
                      className="icon-btn"
                      disabled={busy === job.id}
                      onClick={() => openConfirm("regenerate", job)}
                      title="按原参数新建任务（消耗 1 次额度）"
                      aria-label="按原参数新建任务（消耗 1 次额度）"
                    >
                      ↻
                    </button>
                  )}
                  {canReedit && (
                    <button
                      className="icon-btn"
                      disabled={busy === job.id}
                      onClick={() => reedit(job)}
                      title="重新编辑参数后再提交（提交时消耗 1 次额度）"
                      aria-label="重新编辑参数后再提交"
                    >
                      ✎
                    </button>
                  )}
                  {active && (
                    <button className="icon-btn" disabled={busy === job.id} onClick={() => openConfirm("cancel", job)} title="取消" aria-label="取消">✕</button>
                  )}
                  {finished && (
                    <button className="icon-btn" disabled={busy === job.id} onClick={() => openConfirm("delete", job)} title="删除视频记录与文件" aria-label="删除视频记录与文件">⌫</button>
                  )}
                </div>
                {active && (
                  <div className="job-progress" role="status">
                    <span>{job.status === "processing" ? "正在生成 MP4…" : "等待渲染队列…"}</span>
                    <span className="track" aria-hidden="true"><i /></span>
                  </div>
                )}
                {failed && (
                  <div className="err-line">
                    {job.errorMessage ?? "渲染失败"}，额度已返还 ·{" "}
                    {canRetry
                      ? "点击 ↻ 原参数重试，或 ✎ 重新编辑（提交时消耗 1 次额度）"
                      : "已达最大尝试次数，请点击 ✎ 重新编辑参数后再提交（消耗 1 次额度）"}
                  </div>
                )}
                {cancelled && (
                  <div className="err-line">
                    已取消，额度已返还 ·{" "}
                    {canRetry
                      ? "可点击 ↻ 重新入队，或 ✎ 重新编辑（提交时消耗 1 次额度）"
                      : "已达最大尝试次数，请点击 ✎ 重新编辑参数后再提交（消耗 1 次额度）"}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {playing && (
        <Modal title="视频预览" onClose={() => setPlaying(null)}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            /* 验收第 9 章：inline=1 让下载接口返回 inline，避免浏览器触发下载而非播放 */
            src={`/api/videos/${playing}/download?inline=1`}
            controls
            autoPlay
            style={{ width: "100%", maxHeight: "65vh", background: "#000", borderRadius: 12 }}
          />
          <div className="modal-actions">
            <Button variant="ghost" onClick={() => setPlaying(null)}>关闭</Button>
          </div>
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirmCopy(confirm.kind, confirm.job).title}
          description={confirmCopy(confirm.kind, confirm.job).description}
          confirmLabel={confirmCopy(confirm.kind, confirm.job).label}
          danger={confirmCopy(confirm.kind, confirm.job).danger}
          busy={confirmBusy}
          confirmDisabled={
            (confirm.kind === "retry" || confirm.kind === "regenerate") && me?.quotaLeft === 0
          }
          onConfirm={doConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}
