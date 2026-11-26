/**
 * 存储一致性核对（方案 9.3 / 阶段九）。
 *
 *   npx tsx scripts/ops-storage-audit.ts            只报告（cron 每周跑）
 *   npx tsx scripts/ops-storage-audit.ts --strict   发现异常返回退出码 1
 *   npx tsx scripts/ops-storage-audit.ts --fix      额外删除磁盘上的孤儿文件
 *
 * 比对 video_jobs.output_path / thumbnail_path 与 DATA_ROOT 下的实际文件，
 * 找出「记录存在但文件缺失」和「文件存在但无记录」两类漂移。
 * 不修改数据库；删除文件默认关闭，避免误伤正在渲染的产物。
 */
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import "../src/lib/env";
import { db } from "../src/lib/db";
import { DATA_ROOT, fileStorage } from "../src/lib/storage";

const STRICT = process.argv.includes("--strict");
const FIX = process.argv.includes("--fix");

async function walk(dir: string, relative = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walk(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const jobs = await db.videoJob.findMany({
    where: { status: "completed" },
    select: { id: true, outputPath: true, thumbnailPath: true },
  });

  const referenced = new Set<string>();
  const missingOutputs: string[] = [];
  const missingThumbnails: string[] = [];
  for (const job of jobs) {
    for (const [field, relative, bucket] of [
      ["video", job.outputPath, missingOutputs],
      ["thumbnail", job.thumbnailPath, missingThumbnails],
    ] as const) {
      if (!relative) continue;
      referenced.add(relative);
      const exists = await fileStorage.exists(relative).catch(() => false);
      if (!exists) bucket.push(`${job.id}:${field}:${relative}`);
    }
  }

  const [videos, thumbnails] = await Promise.all([
    walk(path.join(DATA_ROOT, "videos"), "videos"),
    walk(path.join(DATA_ROOT, "thumbnails"), "thumbnails"),
  ]);
  const onDisk = [...videos, ...thumbnails];
  const orphanFiles = onDisk.filter((relative) => !referenced.has(relative));

  if (FIX) {
    for (const relative of orphanFiles) {
      await fileStorage.delete(relative).catch(() => undefined);
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    storageRoot: DATA_ROOT,
    checkedJobs: jobs.length,
    filesOnDisk: onDisk.length,
    missingOutputs,
    missingThumbnails,
    orphanFiles,
    deletedOrphans: FIX ? orphanFiles.length : 0,
    mode: FIX ? "fix" : "report",
  };
  console.log(JSON.stringify(report, null, 2));

  const hasIssues =
    missingOutputs.length + missingThumbnails.length + (FIX ? 0 : orphanFiles.length) > 0;
  if (hasIssues && STRICT) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`[storage-audit] 失败：${(error as Error).message}`);
  process.exitCode = 1;
});
