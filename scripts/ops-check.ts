/**
 * 命令行健康巡检（阶段九）。
 *
 *   npm run ops:check                      本地直连探测（不依赖 Web 端口）
 *   npm run ops:check -- --url http://...  走 HTTP 探测线上 /api/health
 *   npm run ops:check -- --json --strict  机器可读；degraded 也返回非 0
 *
 * 退出码：0 正常 / 1 degraded(--strict) 或探测异常 / 2 down。
 * 部署脚本的发布后检查、cron 巡检、人工排障共用这一入口。
 */
import process from "node:process";
import "../src/lib/env";
import { collectHealth, type HealthReport } from "../src/lib/ops";

interface Options {
  url?: string;
  json: boolean;
  strict: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { json: false, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") options.url = argv[++i];
    else if (argv[i] === "--json") options.json = true;
    else if (argv[i] === "--strict") options.strict = true;
  }
  return options;
}

async function fetchReport(url: string): Promise<HealthReport> {
  const token = process.env.HEALTH_TOKEN;
  const response = await fetch(url, {
    headers: token ? { "x-health-token": token } : {},
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  const body = (await response.json()) as { ok?: boolean; data?: HealthReport; error?: { message?: string } };
  if (body.data) return body.data;
  throw new Error(`HTTP ${response.status}: ${body.error?.message ?? "响应缺少 data"}`);
}

function printHuman(report: HealthReport): void {
  const { database, disk, queue, worker } = report.checks;
  console.log(`状态: ${report.status.toUpperCase()}  版本: ${report.version}  运行: ${report.uptimeSec}s`);
  console.log(`  DB    : ${database.ok ? `OK (${database.latencyMs}ms)` : `FAIL (${database.error})`}`);
  console.log(
    `  磁盘  : ${disk.ok ? "可写" : "不可写"}  使用率 ${disk.usedPercent ?? "?"}%  ` +
      `剩余 ${disk.freeBytes === null ? "?" : `${(disk.freeBytes / 1024 ** 3).toFixed(1)}GiB`}`
  );
  console.log(
    `  队列  : pending=${queue.pending} processing=${queue.processing} ` +
      `stalled=${queue.stalled} 近1h失败率=${(queue.failureRate * 100).toFixed(0)}%`
  );
  console.log(
    `  Worker: ${worker.ok ? "OK" : "异常"}  ${worker.workerId ?? "无心跳"} ` +
      `${worker.staleSec === null ? "" : `(${worker.staleSec}s 前)`}`
  );
  if (report.issues.length) {
    console.log("问题：");
    for (const issue of report.issues) console.log(`  - ${issue}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  try {
    const report = options.url ? await fetchReport(options.url) : await collectHealth();
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);

    if (report.status === "down") process.exitCode = 2;
    else if (report.status === "degraded" && options.strict) process.exitCode = 1;
  } catch (error) {
    console.error(`[ops:check] 巡检失败：${(error as Error).message}`);
    process.exitCode = 1;
  }
}

void main();
