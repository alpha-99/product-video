/**
 * 巡检告警（方案 11「队列积压 / 失败率 / 磁盘 / Worker 心跳丢失 → 通知」）。
 *
 *   npm run ops:alert                     拉 /api/health，异常时通知（状态去重）
 *   npm run ops:alert -- --force         强制发一条测试告警，验证「告警可触发」
 *   npm run ops:alert -- --reset         清空去重状态
 *
 * 环境变量：
 *   HEALTH_URL            默认 http://127.0.0.1:${PORT:-3000}/api/health
 *   HEALTH_TOKEN          可选，随 x-health-token 发送
 *   ALERT_WEBHOOK_URL     未配置时只打印 dry-run 日志，不联网
 *   ALERT_WEBHOOK_KIND    wecom | feishu | slack | generic（默认）
 *   ALERT_REPEAT_MINUTES  同一异常重复通知间隔，默认 60
 *   ALERT_STATE_FILE      去重状态文件，默认 .ops/alert-state.json
 *
 * cron 每分钟跑一次（见 deploy/cron/product-video）。
 */
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import process from "node:process";
import "../src/lib/env";
import {
  alertSignature,
  buildAlertMessage,
  buildWebhookPayload,
  parseWebhookKind,
  shouldNotify,
  toAlertSource,
  type AlertSource,
  type AlertState,
} from "../src/lib/alert";
import type { HealthReport } from "../src/lib/ops";

const STATE_FILE = process.env.ALERT_STATE_FILE || ".ops/alert-state.json";
const REPEAT_MS = Math.max(1, Number(process.env.ALERT_REPEAT_MINUTES || 60)) * 60_000;
const HEALTH_URL =
  process.env.HEALTH_URL || `http://127.0.0.1:${process.env.PORT || 3000}/api/health`;

async function readState(): Promise<AlertState | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8")) as AlertState;
  } catch {
    return null;
  }
}

async function writeState(state: AlertState): Promise<void> {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state), "utf8");
}

async function probe(): Promise<AlertSource> {
  try {
    const token = process.env.HEALTH_TOKEN;
    const response = await fetch(HEALTH_URL, {
      headers: token ? { "x-health-token": token } : {},
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    const body = (await response.json()) as { data?: HealthReport; error?: { message?: string } };
    if (!body.data) {
      throw new Error(`HTTP ${response.status}: ${body.error?.message ?? "响应缺少 data"}`);
    }
    const source = toAlertSource(body.data);
    // down 接口返回 503，但 data 仍完整；这里额外标注 HTTP 状态便于排障。
    if (response.status >= 500) source.issues = [...source.issues, `健康检查返回 HTTP ${response.status}`];
    return source;
  } catch (error) {
    return {
      status: "down",
      issues: [`健康检查接口不可达：${(error as Error).message}`],
      timestamp: new Date().toISOString(),
      version: process.env.APP_VERSION,
    };
  }
}

async function send(text: string, source: AlertSource): Promise<"sent" | "dry-run"> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) {
    console.log("[alert][dry-run] 未配置 ALERT_WEBHOOK_URL，仅打印告警内容：");
    console.log(text);
    return "dry-run";
  }
  const payload = buildWebhookPayload(parseWebhookKind(process.env.ALERT_WEBHOOK_KIND), text, source);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Webhook HTTP ${response.status}: ${raw.slice(0, 200)}`);
  // 企业微信 / 飞书用 errcode 表达业务失败，HTTP 仍是 200。
  const errcode = /"errcode"\s*:\s*(-?\d+)/.exec(raw);
  if (errcode && errcode[1] !== "0") throw new Error(`Webhook 返回 errcode=${errcode[1]}: ${raw.slice(0, 200)}`);
  return "sent";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--reset")) {
    await rm(STATE_FILE, { force: true });
    console.log(`[alert] 已清空状态文件 ${STATE_FILE}`);
    return;
  }

  const force = args.includes("--force");
  const source: AlertSource = force
    ? {
        status: "degraded",
        issues: ["[测试告警] 由 --force 触发，用于验证通知链路已打通"],
        timestamp: new Date().toISOString(),
        version: process.env.APP_VERSION,
      }
    : await probe();

  const prev = await readState();
  const signature = force ? `force:${source.timestamp}` : alertSignature(source);
  const notify =
    force || shouldNotify(prev, signature, source.status, Date.now(), REPEAT_MS);
  const recovered =
    !force && Boolean(prev && prev.lastStatus !== "ok" && source.status === "ok");

  if (!notify) {
    console.log(`[alert] 状态未变化且在静默期内，跳过通知 (${source.status})`);
    return;
  }

  const text = buildAlertMessage(source, hostname(), recovered);
  const result = await send(text, source);
  await writeState({
    signature,
    lastNotifiedAt: Date.now(),
    lastStatus: source.status,
  });
  console.log(
    JSON.stringify({
      ts: source.timestamp,
      status: source.status,
      notified: true,
      channel: result,
      signature,
    })
  );
}

main().catch((error: unknown) => {
  console.error(`[alert] 告警失败：${(error as Error).message}`);
  process.exitCode = 1;
});
