/**
 * Worker 进程入口（方案 8.1 / 8.2）。
 * 独立进程、不监听公网端口：循环领取 pending 任务并渲染，同时定期扫描过期租约。
 * 单个任务由 pipeline 内部心跳续租；异常被 pipeline 转成状态，不打断主循环。
 */
import process from "node:process";
import "../lib/env";
import { processNextJob } from "../lib/pipeline";
import { reclaimExpiredJobs } from "../lib/queue";
import { writeWorkerHeartbeat } from "../lib/heartbeat";

const POLL_INTERVAL_MS = 2000;
const RECLAIM_INTERVAL_MS = 30 * 1000;
/** 方案 11：即使队列空闲也要写心跳，否则 Worker 静默卡死无法被发现。 */
const HEARTBEAT_INTERVAL_MS = 15 * 1000;
let running = true;
let unexpectedErrors = 0;

/**
 * Remotion 在 Windows / Node 24 上偶发「预启动 ffmpeg 的 stdin 提前关闭」：
 * 内部 onFrame 回调里未被 await 的 writeFrame Promise 以 EPIPE 抛出，
 * 它既不会被 loop 的 try/catch 捕获，又会触发 Node 默认的
 * --unhandled-rejections=throw，直接终止整个进程（表现为「启动后自己退出」）。
 *
 * Worker 是长驻进程，单条渲染的 I/O 异常不该带走整个进程：这里统一兜底并记录
 * 完整堆栈，任务本身由 pipeline 转 retry/failed，卡住的租约由 reclaim 超时回收。
 * 代价是极端情况下进程可能处于不健康状态，因此打印累计次数与 EPIPE 专项提示，
 * 便于运维从日志判断是否该重启，而不是静默吞掉错误。
 */
function reportUnexpected(kind: string, reason: unknown): void {
  unexpectedErrors += 1;
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const code = (err as NodeJS.ErrnoException).code;
  console.error(
    `[worker] ${kind} kept alive (count=${unexpectedErrors}${code ? ` code=${code}` : ""}): ${err.message}`
  );
  if (err.stack) console.error(err.stack);
  if (code === "EPIPE") {
    console.error(
      "[worker] ffmpeg 写帧通道提前关闭：请确认 Node 版本（建议 22 LTS）与磁盘/内存充足；" +
        "当前任务的租约会超时后由 reclaim 重新入队。"
    );
  }
}

process.on("unhandledRejection", (reason) => reportUnexpected("unhandled rejection", reason));
process.on("uncaughtException", (err) => reportUnexpected("uncaught exception", err));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const reclaimTimer = setInterval(() => {
  if (!running) return;
  void reclaimExpiredJobs()
    .then(({ requeued, failed }) => {
      if (requeued.length || failed.length) {
        console.log(`[worker] reclaim: requeued=${requeued.length} failed=${failed.length}`);
      }
    })
    .catch((err: unknown) => {
      console.error(`[worker] reclaim error: ${(err as Error).message}`);
    });
}, RECLAIM_INTERVAL_MS);
reclaimTimer.unref?.();

function beat(): void {
  void writeWorkerHeartbeat().catch((err: unknown) => {
    // 心跳失败不打断渲染：/api/health 会发现心跳停滞并触发告警。
    console.error(`[worker] heartbeat error: ${(err as Error).message}`);
  });
}

const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref?.();
beat();

async function loop(): Promise<void> {
  while (running) {
    try {
      const result = await processNextJob();
      if (!result) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      console.log(`[worker] job=${result.jobId} status=${result.status}${result.error ? ` error=${result.error}` : ""}`);
    } catch (err) {
      console.error(`[worker] loop error: ${(err as Error).message}`);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

// 不再强制结束进程：shutdown 里那次 "stopped" 心跳是异步写库，
// 强制退出会把它截断；让事件循环自然排空即可。
void loop().catch((err: unknown) => {
  reportUnexpected("loop terminated", err);
  process.exitCode = 1;
});

function shutdown(signal: string) {
  if (!running) return;
  running = false;
  clearInterval(reclaimTimer);
  clearInterval(heartbeatTimer);
  void writeWorkerHeartbeat("stopped").catch(() => undefined);
  console.log(`[worker] received ${signal}, waiting for current job to finish`);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(
  `[worker] ready (poll ${POLL_INTERVAL_MS}ms, reclaim ${RECLAIM_INTERVAL_MS}ms, no HTTP port)`
);
