/**
 * 运维健康探测（方案 11 / 阶段九）。
 *
 * 四个相互独立的探针：数据库、磁盘、队列、Worker 心跳。任一探针异常不会
 * 打断其余探针；evaluateHealth 是纯函数，便于单测覆盖阈值分支。
 *
 * 状态语义：
 *   ok       可正常对外服务（HTTP 200）
 *   degraded 仍可用但有隐患，交给告警脚本通知（HTTP 200，避免 Nginx 直接摘节点）
 *   down     核心依赖不可用（HTTP 503，Nginx/PM2 可据此判定故障）
 */
import { mkdir, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { listWorkerHeartbeats } from "./heartbeat";
import { DATA_ROOT } from "./storage";

export interface HealthThresholds {
  diskWarnPercent: number;
  diskCriticalPercent: number;
  queueWarn: number;
  queueCritical: number;
  workerStaleSec: number;
  failureRateWarn: number;
  dbTimeoutMs: number;
}

export interface DatabaseProbe {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

export interface DiskProbe {
  ok: boolean;
  writable: boolean;
  totalBytes: number | null;
  freeBytes: number | null;
  usedPercent: number | null;
  error?: string;
}

export interface QueueProbe {
  ok: boolean;
  pending: number;
  processing: number;
  backlog: number;
  stalled: number;
  failed1h: number;
  completed1h: number;
  failureRate: number;
  error?: string;
}

export interface WorkerProbe {
  ok: boolean;
  workerId: string | null;
  lastSeenAt: string | null;
  staleSec: number | null;
  status: string | null;
  error?: string;
}

export interface HealthChecks {
  database: DatabaseProbe;
  disk: DiskProbe;
  queue: QueueProbe;
  worker: WorkerProbe;
}

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthReport {
  status: HealthStatus;
  phase: 9;
  service: "product-video-ai";
  version: string;
  timestamp: string;
  uptimeSec: number;
  checks: HealthChecks;
  thresholds: HealthThresholds;
  issues: string[];
}

function numberFrom(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** 阈值全部可通过环境变量覆盖，脚本与接口共用同一份定义。 */
export function readThresholds(
  env: Record<string, string | undefined> = process.env
): HealthThresholds {
  return {
    diskWarnPercent: numberFrom(env.HEALTH_DISK_WARN_PERCENT, 80),
    diskCriticalPercent: numberFrom(env.HEALTH_DISK_CRITICAL_PERCENT, 92),
    queueWarn: numberFrom(env.HEALTH_QUEUE_WARN, 20),
    queueCritical: numberFrom(env.HEALTH_QUEUE_CRITICAL, 100),
    workerStaleSec: numberFrom(env.HEALTH_WORKER_STALE_SEC, 120),
    failureRateWarn: numberFrom(env.HEALTH_FAILURE_RATE_WARN, 0.3),
    // 跨区连接 Supabase 时 Prisma 首次握手可能 >3s，默认给 8s 避免冷启动误报。
    dbTimeoutMs: numberFrom(env.HEALTH_DB_TIMEOUT_MS, 8000),
  };
}

/** 纯函数：把四组探测结果折算成整体状态与中文问题清单。 */
export function evaluateHealth(checks: HealthChecks, thresholds: HealthThresholds) {
  const issues: string[] = [];
  let status: HealthStatus = "ok";

  const degrade = (message: string) => {
    issues.push(message);
    if (status === "ok") status = "degraded";
  };
  const down = (message: string) => {
    issues.push(message);
    status = "down";
  };

  if (!checks.database.ok) {
    if (checks.queue.ok) {
      // 同一个 Prisma 客户端的 SQL 已成功 → 数据库其实可达，多为冷启动/瞬时抖动。
      degrade(`数据库主探测超时，但队列查询成功（疑似连接冷启动）：${checks.database.error ?? ""}`);
    } else {
      down(`数据库不可用${checks.database.error ? `：${checks.database.error}` : ""}`);
    }
  }
  if (!checks.disk.ok) {
    down(`数据目录不可写${checks.disk.error ? `：${checks.disk.error}` : ""}`);
  } else if (checks.disk.usedPercent !== null) {
    if (checks.disk.usedPercent >= thresholds.diskCriticalPercent) {
      down(`磁盘使用率 ${checks.disk.usedPercent.toFixed(1)}% 已超临界值 ${thresholds.diskCriticalPercent}%`);
    } else if (checks.disk.usedPercent >= thresholds.diskWarnPercent) {
      degrade(`磁盘使用率 ${checks.disk.usedPercent.toFixed(1)}% 已超警戒值 ${thresholds.diskWarnPercent}%`);
    }
  }
  if (!checks.queue.ok) {
    degrade(`队列指标读取失败${checks.queue.error ? `：${checks.queue.error}` : ""}`);
  } else {
    if (checks.queue.backlog >= thresholds.queueCritical) {
      degrade(`队列积压 ${checks.queue.backlog} 个任务`);
    } else if (checks.queue.backlog >= thresholds.queueWarn) {
      degrade(`队列积压 ${checks.queue.backlog} 个任务，超过 ${thresholds.queueWarn}`);
    }
    if (checks.queue.stalled > 0) {
      degrade(`${checks.queue.stalled} 个任务租约已过期但未回收`);
    }
    const sample = checks.queue.failed1h + checks.queue.completed1h;
    if (sample >= 5 && checks.queue.failureRate >= thresholds.failureRateWarn) {
      degrade(`近 1 小时失败率 ${(checks.queue.failureRate * 100).toFixed(0)}%`);
    }
  }
  if (!checks.worker.ok) {
    degrade(
      checks.worker.lastSeenAt
        ? `Worker 心跳已停滞 ${checks.worker.staleSec ?? "?"} 秒`
        : `未收到 Worker 心跳${checks.worker.error ? `：${checks.worker.error}` : ""}`
    );
  }

  return { status, issues };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`探测超时 ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function probeDatabase(timeoutMs: number): Promise<DatabaseProbe> {
  const started = Date.now();
  try {
    await withTimeout(db.$queryRaw`SELECT 1 AS ok`, timeoutMs);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, latencyMs: null, error: message(error) };
  }
}

/** statfs 读分区余量 + 实际写一次临时文件，避免「目录存在但只读」的假健康。 */
export async function probeDisk(root = DATA_ROOT): Promise<DiskProbe> {
  let totalBytes: number | null = null;
  let freeBytes: number | null = null;
  let usedPercent: number | null = null;
  try {
    await mkdir(root, { recursive: true });
    const stats = await statfs(root);
    totalBytes = Number(stats.blocks) * Number(stats.bsize);
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (totalBytes > 0) {
      usedPercent = Number((((totalBytes - freeBytes) / totalBytes) * 100).toFixed(1));
    }
  } catch (error) {
    // 某些平台不支持 statfs（Windows 老版本 Node）：只影响容量指标，不影响可写判定。
    if ((error as NodeJS.ErrnoException).code !== "ENOSYS") {
      return { ok: false, writable: false, totalBytes, freeBytes, usedPercent, error: message(error) };
    }
  }

  const probeFile = path.join(root, `.health-${process.pid}-${randomUUID().slice(0, 8)}`);
  try {
    await writeFile(probeFile, "ok", { flag: "wx" });
    await unlink(probeFile);
    return { ok: true, writable: true, totalBytes, freeBytes, usedPercent };
  } catch (error) {
    await unlink(probeFile).catch(() => undefined);
    return { ok: false, writable: false, totalBytes, freeBytes, usedPercent, error: message(error) };
  }
}

export async function probeQueue(): Promise<QueueProbe> {
  const empty: QueueProbe = {
    ok: false,
    pending: 0,
    processing: 0,
    backlog: 0,
    stalled: 0,
    failed1h: 0,
    completed1h: 0,
    failureRate: 0,
  };
  try {
    const [statusRows, recentRows, stalledRows] = await Promise.all([
      db.$queryRaw<Array<{ status: string; count: number }>>`
        SELECT status, COUNT(*)::int AS count FROM video_jobs GROUP BY status
      `,
      db.$queryRaw<Array<{ failed: number; completed: number }>>`
        SELECT COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
               COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
        FROM video_jobs
        WHERE COALESCE(completed_at, created_at) > now() - interval '1 hour'
      `,
      db.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM video_jobs WHERE status = 'processing' AND lease_until < now()
      `,
    ]);
    const counts = new Map(statusRows.map((row) => [row.status, Number(row.count)]));
    const pending = counts.get("pending") ?? 0;
    const processing = counts.get("processing") ?? 0;
    const failed1h = Number(recentRows[0]?.failed ?? 0);
    const completed1h = Number(recentRows[0]?.completed ?? 0);
    const sample = failed1h + completed1h;
    return {
      ok: true,
      pending,
      processing,
      backlog: pending + processing,
      stalled: Number(stalledRows[0]?.count ?? 0),
      failed1h,
      completed1h,
      failureRate: sample > 0 ? Number((failed1h / sample).toFixed(3)) : 0,
    };
  } catch (error) {
    return { ...empty, error: message(error) };
  }
}

export async function probeWorker(staleSec: number, now = Date.now()): Promise<WorkerProbe> {
  try {
    const [latest] = await listWorkerHeartbeats(1);
    if (!latest) return { ok: false, workerId: null, lastSeenAt: null, staleSec: null, status: null };
    const seconds = Math.max(0, Math.round((now - latest.lastSeenAt.getTime()) / 1000));
    return {
      ok: latest.status === "running" && seconds <= staleSec,
      workerId: latest.workerId,
      lastSeenAt: latest.lastSeenAt.toISOString(),
      staleSec: seconds,
      status: latest.status,
    };
  } catch (error) {
    return {
      ok: false,
      workerId: null,
      lastSeenAt: null,
      staleSec: null,
      status: null,
      error: message(error),
    };
  }
}

/** 汇总四组探针，供 /api/health 与命令行巡检脚本共用。 */
export async function collectHealth(
  env: Record<string, string | undefined> = process.env
): Promise<HealthReport> {
  const thresholds = readThresholds(env);
  const [database, disk, queue, worker] = await Promise.all([
    probeDatabase(thresholds.dbTimeoutMs),
    probeDisk(),
    probeQueue(),
    probeWorker(thresholds.workerStaleSec),
  ]);
  const checks: HealthChecks = { database, disk, queue, worker };
  const { status, issues } = evaluateHealth(checks, thresholds);
  return {
    status,
    phase: 9,
    service: "product-video-ai",
    version: env.APP_VERSION || "dev",
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    checks,
    thresholds,
    issues,
  };
}
