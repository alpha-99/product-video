/**
 * Worker 心跳（方案 11「Worker 心跳写数据库」/ 阶段九）。
 *
 * 与任务级租约（queue.ts 的 lease_until）互补：租约只在有任务时存在，
 * 队列空闲时 Worker 静默卡死无法被发现；本表记录进程存活，供 /api/health
 * 与告警脚本判断「进程还活着但队列没动」这类静默故障。
 */
import { hostname } from "node:os";
import process from "node:process";
import { db } from "./db";

export type WorkerStatus = "running" | "stopped";

export function currentWorkerId(): string {
  return (process.env.PV_WORKER_ID || `${hostname()}:${process.pid}`).slice(0, 120);
}

function host(): string {
  return hostname().slice(0, 255);
}

export async function writeWorkerHeartbeat(
  status: WorkerStatus = "running",
  workerId = currentWorkerId()
): Promise<void> {
  const now = new Date();
  const meta = { pid: process.pid, node: process.version };
  await db.workerHeartbeat.upsert({
    where: { workerId },
    create: { workerId, hostname: host(), status, lastSeenAt: now, meta },
    update: { hostname: host(), status, lastSeenAt: now, meta },
  });
}

export async function listWorkerHeartbeats(take = 5) {
  return db.workerHeartbeat.findMany({
    orderBy: { lastSeenAt: "desc" },
    take,
    select: { workerId: true, hostname: true, status: true, lastSeenAt: true },
  });
}
