/**
 * 幂等文件清理（验收 P2-09）。
 *
 * purge 时数据库记录已经提交，文件清理只能放在事务外；此前失败仅 warn，
 * 会留下永远没人再管的孤儿文件。这里做有限次幂等重试（delete 本身 force，
 * 重复执行安全），仍失败则写结构化「死信」日志，供巡检脚本 / 人工兜底，
 * 并把失败路径回传给 API，让响应不再假装全部清理完成。
 */
import { fileStorage } from "./storage";

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface CleanupReport {
  cleaned: string[];
  failed: string[];
}

export async function cleanupFilesWithRetry(
  paths: Array<string | null | undefined>,
  context: { jobId: string }
): Promise<CleanupReport> {
  const cleaned: string[] = [];
  const failed: string[] = [];

  for (const relative of paths) {
    if (!relative) continue;
    let ok = false;
    let lastError = "";

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(100 * 2 ** (attempt - 1));
      try {
        await fileStorage.delete(relative);
        ok = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (ok) {
      cleaned.push(relative);
    } else {
      failed.push(relative);
      console.error(
        JSON.stringify({
          level: "error",
          event: "file_cleanup_dead_letter",
          jobId: context.jobId,
          relativePath: relative,
          attempts: MAX_ATTEMPTS,
          error: lastError,
        })
      );
    }
  }

  return { cleaned, failed };
}
