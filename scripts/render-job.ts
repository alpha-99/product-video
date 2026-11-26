/**
 * 本地渲染 CLI：从 input.json 走完整正式渲染链路，便于 Worker 接入前联调。
 *
 *   npm run render:job -- path/to/input.json
 *   STORAGE_ROOT=/opt/product-video/data npm run render:job -- renders/job/input.json
 */
import { readFile } from "node:fs/promises";
import process from "node:process";
import "../src/lib/env";
import { renderVideo } from "../src/lib/renderer";
import { RenderJobInputSchema } from "../src/shared/render.schema";

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("用法: npm run render:job -- <input.json>");

  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  const result = await renderVideo(RenderJobInputSchema.parse(raw));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: unknown) => {
  console.error(`[render] ${(err as Error).message}`);
  process.exit(1);
});
