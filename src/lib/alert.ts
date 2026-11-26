/**
 * 告警判定纯逻辑（方案 11 / 阶段九）。
 * 与 IO 分离：状态去重、消息模板、Webhook 载荷都可单测，脚本只负责收发。
 */
import type { HealthReport, HealthStatus } from "./ops";

export interface AlertSource {
  status: HealthStatus;
  issues: string[];
  timestamp: string;
  version?: string;
}

export interface AlertState {
  signature: string;
  lastNotifiedAt: number;
  lastStatus: HealthStatus;
}

export type WebhookKind = "wecom" | "feishu" | "slack" | "generic";

/** 状态签名：状态或问题清单变化才算一次新事件。 */
export function alertSignature(source: AlertSource): string {
  return `${source.status}|${[...source.issues].sort().join("|")}`;
}

/**
 * 去重：首次异常必报；状态恢复必报；同一异常默认 60 分钟内不重复轰炸。
 * --force 的测试告警由调用方跳过本函数。
 */
export function shouldNotify(
  prev: AlertState | null,
  signature: string,
  status: HealthStatus,
  now: number,
  repeatMs: number
): boolean {
  if (!prev) return status !== "ok";
  if (prev.signature !== signature) return true;
  return now - prev.lastNotifiedAt >= repeatMs;
}

/** 纯文本消息：异常列出问题清单，恢复单独措辞。 */
export function buildAlertMessage(
  source: AlertSource,
  host: string,
  recovered = false
): string {
  const lines = [
    recovered
      ? `✅ [ProductVideo AI] 服务已恢复 (${host})`
      : `[ProductVideo AI] 巡检异常：${source.status.toUpperCase()} (${host})`,
    `时间：${source.timestamp}`,
    `状态：${source.status}`,
    `版本：${source.version ?? "dev"}`,
  ];
  if (source.issues.length) {
    lines.push("问题：", ...source.issues.map((issue) => `  - ${issue}`));
  }
  if (recovered) lines.push("此前告警已消除，无需处理。");
  return lines.join("\n");
}

/** 企业微信 / 飞书 / Slack 载荷；未知渠道按通用 JSON 发。 */
export function buildWebhookPayload(kind: WebhookKind, text: string, source: AlertSource) {
  switch (kind) {
    case "wecom":
      return { msgtype: "text", text: { content: text } };
    case "feishu":
      return { msg_type: "text", content: { text } };
    case "slack":
      return { text };
    default:
      return {
        text,
        status: source.status,
        issues: source.issues,
        timestamp: source.timestamp,
      };
  }
}

export function parseWebhookKind(value: string | undefined): WebhookKind {
  return value === "wecom" || value === "feishu" || value === "slack" ? value : "generic";
}

/** 从 /api/health 包络里抽出告警所需字段，容忍字段缺失。 */
export function toAlertSource(report: HealthReport): AlertSource {
  return {
    status: report.status,
    issues: report.issues ?? [],
    timestamp: report.timestamp,
    version: report.version,
  };
}
