/**
 * 链路处理 CLI：按 jobId 走完整渲染处理（领取 → 渲染 → 回写/返还）。
 *
 *   npm run process:job -- <jobId>
 *
 * 阶段六会把同样的 processJob 接入 Worker 的 SKIP LOCKED 轮询循环。
 */
import process from "node:process";
import "../src/lib/env";
import { processJob } from "../src/lib/pipeline";

async function main() {
  const jobId = process.argv[2];
  if (!jobId) throw new Error("用法: npm run process:job -- <jobId>");
  const result = await processJob(jobId);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: unknown) => {
  console.error(`[pipeline] ${(err as Error).message}`);
  process.exit(1);
});
