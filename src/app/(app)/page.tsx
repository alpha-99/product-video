"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Account, useShell } from "../../components/AppShell";
import { BoundaryCard, Button, EmptyState, ErrorBanner, SectionLine, Skeleton } from "../../components/ui";
import { api, QUOTA_EMPTY_MESSAGE } from "../../lib/client/api";
import { useAsync } from "../../lib/client/hooks";
import type { VideoJobDto } from "../../lib/client/types";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 验收 P2-06：消费已入库的 thumbnailPath，加载失败回退渐变占位。 */
function JobThumb({ job }: { job: VideoJobDto }) {
  const [broken, setBroken] = useState(false);
  if (job.status !== "completed" || !job.thumbnailPath || broken) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/videos/${job.id}/thumbnail`} alt="" onError={() => setBroken(true)} />
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { me } = useShell();
  const { data: jobs, loading, error, reload } = useAsync<VideoJobDto[]>(
    () => api.get<VideoJobDto[]>("/api/videos?take=100"),
    { cacheKey: "videos" }
  );

  const total = jobs?.length ?? 0;
  const completed = jobs?.filter((j) => j.status === "completed").length ?? 0;
  const failed = jobs?.filter((j) => j.status === "failed").length ?? 0;
  // P2-3：分母只取已终结任务（completed + failed），无样本时显示「—」而不是 100%。
  const terminal = completed + failed;
  const successRate = terminal > 0 ? Math.round((completed / terminal) * 100) : null;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  const displayName = me?.email?.split("@")[0] ?? "创作者";

  return (
    <>
      <div className="app-top">
        <h1>{greeting}，{displayName}</h1>
        <Account />
      </div>

      {me && me.quotaLeft === 0 && (
        <div style={{ marginBottom: 24 }}>
          {/* 验收 P2-01：额度耗尽文案与 API 客户端保持统一口径。 */}
          <BoundaryCard title="额度已用完" description={QUOTA_EMPTY_MESSAGE} />
        </div>
      )}

      <div className="stat-row">
        <div className="stat accent">
          <div className="k">剩余额度</div>
          <div className="v tabular">{me?.quotaLeft ?? "—"} <small>次可生成</small></div>
        </div>
        <div className="stat">
          <div className="k">已生成视频</div>
          <div className="v tabular">{completed} <small>条</small></div>
        </div>
        <div className="stat">
          <div className="k">成功率</div>
          <div className="v tabular">
            {successRate === null ? "—" : <>{successRate}<small>%</small></>}
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            按已终结任务统计（已完成 ÷ 已完成＋失败）
          </div>
        </div>
      </div>

      <SectionLine title="快捷开始" />
      <Button onClick={() => router.push("/create")} disabled={me?.quotaLeft === 0}>✦ 新建视频</Button>

      <SectionLine title="最近生成" action={<Link href="/videos">查看全部 →</Link>} />

      {loading && <Skeleton lines={4} />}
      {!loading && error && <ErrorBanner message={error} onRetry={reload} />}
      {!loading && !error && total === 0 && (
        <EmptyState
          icon="▦"
          text="还没有视频，去创作第一条吧"
          action={<Button onClick={() => router.push("/create")}>新建视频</Button>}
        />
      )}
      {!loading && !error && total > 0 && (
        <div className="video-grid">
          {jobs!.slice(0, 3).map((job, index) => (
            <Link href="/videos" key={job.id} className="vid-card">
              <div className={`vid-thumb g${(index % 4) + 1}`}>
                <JobThumb job={job} />
                <span className="t">{job.inputJson?.props?.title ?? "商品视频"}</span>
              </div>
              <div className="vid-meta">
                <b>{job.inputJson?.props?.title ?? "商品视频"}</b>
                <span>{timeAgo(job.createdAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
