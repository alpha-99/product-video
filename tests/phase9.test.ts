import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import "../src/lib/env";
import {
  collectHealth,
  evaluateHealth,
  readThresholds,
  type HealthChecks,
  type HealthReport,
} from "../src/lib/ops";
import {
  alertSignature,
  buildAlertMessage,
  buildWebhookPayload,
  parseWebhookKind,
  shouldNotify,
  toAlertSource,
  type AlertState,
} from "../src/lib/alert";
import { cookieSecure, isLocalAuthEnabled, signSession, verifySession } from "../src/lib/session";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { listWorkerHeartbeats, writeWorkerHeartbeat } from "../src/lib/heartbeat";
import { db } from "../src/lib/db";

const root = path.resolve(__dirname, "..");
const hasDb = Boolean(process.env.DATABASE_URL);
const thresholds = readThresholds({});

function healthyChecks(): HealthChecks {
  return {
    database: { ok: true, latencyMs: 5 },
    disk: { ok: true, writable: true, totalBytes: 1000, freeBytes: 500, usedPercent: 50 },
    queue: {
      ok: true,
      pending: 0,
      processing: 0,
      backlog: 0,
      stalled: 0,
      failed1h: 0,
      completed1h: 0,
      failureRate: 0,
    },
    worker: {
      ok: true,
      workerId: "w1",
      lastSeenAt: new Date().toISOString(),
      staleSec: 1,
      status: "running",
    },
  };
}

describe("阶段九：健康探测阈值判定（纯函数）", () => {
  it("全部正常 → ok，无问题清单", () => {
    const result = evaluateHealth(healthyChecks(), thresholds);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.issues, []);
  });

  it("数据库不可用 / 磁盘不可写 / 磁盘超临界 → down", () => {
    const dbDown = healthyChecks();
    dbDown.database = { ok: false, latencyMs: null, error: "connect ECONNREFUSED" };
    dbDown.queue = { ...dbDown.queue, ok: false, error: "connect ECONNREFUSED" };
    assert.equal(evaluateHealth(dbDown, thresholds).status, "down");

    const diskFail = healthyChecks();
    diskFail.disk = { ok: false, writable: false, totalBytes: null, freeBytes: null, usedPercent: null };
    const failed = evaluateHealth(diskFail, thresholds);
    assert.equal(failed.status, "down");
    assert.ok(failed.issues.some((i) => i.includes("数据目录不可写")));

    const diskCritical = healthyChecks();
    diskCritical.disk.usedPercent = 95;
    assert.equal(evaluateHealth(diskCritical, thresholds).status, "down");
  });

  it("DB 主探测超时但队列查询成功（冷启动）→ 仅 degraded，不误报 down", () => {
    const coldStart = healthyChecks();
    coldStart.database = { ok: false, latencyMs: null, error: "探测超时 8000ms" };
    const result = evaluateHealth(coldStart, thresholds);
    assert.equal(result.status, "degraded");
    assert.ok(result.issues[0].includes("冷启动"));
  });

  it("磁盘警戒 / 队列积压 / 租约停滞 / 心跳丢失 → degraded", () => {
    const cases: Array<[string, (c: HealthChecks) => void]> = [
      ["磁盘使用率", (c) => { c.disk.usedPercent = 85; }],
      ["队列积压", (c) => { c.queue.backlog = 25; }],
      ["租约", (c) => { c.queue.stalled = 2; }],
      ["失败率", (c) => { c.queue.failed1h = 5; c.queue.completed1h = 5; c.queue.failureRate = 0.5; }],
      ["心跳", (c) => { c.worker.ok = false; c.worker.staleSec = 300; }],
    ];
    for (const [label, mutate] of cases) {
      const checks = healthyChecks();
      mutate(checks);
      const result = evaluateHealth(checks, thresholds);
      assert.equal(result.status, "degraded", `${label} 应判为 degraded`);
      assert.ok(result.issues.length >= 1);
    }
  });

  it("样本不足时不因单个失败判失败率告警；阈值可由环境变量覆盖", () => {
    const checks = healthyChecks();
    checks.queue.failed1h = 1;
    checks.queue.completed1h = 1;
    checks.queue.failureRate = 1;
    assert.equal(evaluateHealth(checks, thresholds).status, "ok");

    const custom = readThresholds({
      HEALTH_DISK_WARN_PERCENT: "60",
      HEALTH_QUEUE_WARN: "3",
      HEALTH_WORKER_STALE_SEC: "45",
      HEALTH_DB_TIMEOUT_MS: "8888",
    });
    assert.equal(custom.diskWarnPercent, 60);
    assert.equal(custom.queueWarn, 3);
    assert.equal(custom.workerStaleSec, 45);
    assert.equal(custom.dbTimeoutMs, 8888);
    assert.equal(readThresholds({ HEALTH_QUEUE_WARN: "bad" }).queueWarn, 20);
  });
});

describe("阶段九：告警判定与消息模板", () => {
  const source = {
    status: "degraded" as const,
    issues: ["磁盘使用率 85%", "Worker 心跳停滞"],
    timestamp: "2026-11-26T04:00:00Z",
    version: "abc1234",
  };

  it("签名只由状态 + 排序后的问题清单决定", () => {
    assert.equal(
      alertSignature(source),
      alertSignature({ ...source, issues: [...source.issues].reverse() })
    );
    assert.notEqual(alertSignature(source), alertSignature({ ...source, status: "ok" }));
  });

  it("首次异常必报、恢复必报、静默期去重", () => {
    const now = 1_700_000_000_000;
    const signature = alertSignature(source);
    assert.equal(shouldNotify(null, signature, "degraded", now, 3_600_000), true);
    assert.equal(shouldNotify(null, signature, "ok", now, 3_600_000), false);
    const prev: AlertState = { signature, lastNotifiedAt: now, lastStatus: "degraded" };
    assert.equal(shouldNotify(prev, signature, "degraded", now + 60_000, 3_600_000), false);
    assert.equal(shouldNotify(prev, signature, "degraded", now + 3_600_001, 3_600_000), true);
    assert.equal(shouldNotify(prev, "ok|", "ok", now + 1_000, 3_600_000), true);
  });

  it("消息含状态/问题清单，恢复文案不同，Webhook 载荷按渠道区分", () => {
    const alert = buildAlertMessage(source, "vps-01");
    assert.match(alert, /DEGRADED/);
    assert.match(alert, /磁盘使用率 85%/);
    assert.match(alert, /vps-01/);
    assert.match(buildAlertMessage(source, "vps-01", true), /已恢复/);

    assert.deepEqual(buildWebhookPayload("wecom", alert, source), {
      msgtype: "text",
      text: { content: alert },
    });
    assert.deepEqual(buildWebhookPayload("slack", alert, source), { text: alert });
    assert.equal((buildWebhookPayload("generic", alert, source) as { status: string }).status, "degraded");
    assert.equal(parseWebhookKind("feishu"), "feishu");
    assert.equal(parseWebhookKind("unknown"), "generic");
  });

  it("toAlertSource 从健康报告抽出告警字段", () => {
    const report = {
      status: "ok",
      issues: [],
      timestamp: "t",
      version: "v1",
    } as unknown as HealthReport;
    assert.deepEqual(toAlertSource(report), {
      status: "ok",
      issues: [],
      timestamp: "t",
      version: "v1",
    });
  });
});

describe("阶段九：生产认证开关与密码哈希", () => {
  it("生产默认 fail-closed；local 模式必须显式开启且密钥 ≥32", () => {
    assert.equal(isLocalAuthEnabled({ NODE_ENV: "development" }), true);
    assert.equal(isLocalAuthEnabled({ NODE_ENV: "production" }), false);
    assert.equal(isLocalAuthEnabled({ NODE_ENV: "production", PV_AUTH_MODE: "local" }), false);
    assert.equal(
      isLocalAuthEnabled({ NODE_ENV: "production", PV_AUTH_MODE: "local", DEV_SESSION_SECRET: "short" }),
      false
    );
    assert.equal(
      isLocalAuthEnabled({
        NODE_ENV: "production",
        PV_AUTH_MODE: "local",
        DEV_SESSION_SECRET: "x".repeat(32),
      }),
      true
    );
  });

  it("Cookie Secure 默认随生产开启，可用 PV_COOKIE_SECURE=0 关闭", () => {
    assert.equal(cookieSecure({ NODE_ENV: "production" }), true);
    assert.equal(cookieSecure({ NODE_ENV: "production", PV_COOKIE_SECURE: "0" }), false);
    assert.equal(cookieSecure({ NODE_ENV: "development" }), false);
  });

  it("签名会话可校验且防篡改", () => {
    const token = signSession("00000000-0000-4000-8000-000000000001", "a@b.com");
    assert.equal(verifySession(token)?.sub, "00000000-0000-4000-8000-000000000001");
    assert.equal(verifySession(token.replace(/.$/, "z")), null);
  });

  it("scrypt 密码：正确通过、错误/空/格式非法被拒", async () => {
    const hash = await hashPassword("Sm0ke-Test!2026");
    assert.match(hash, /^scrypt\$/);
    assert.equal(await verifyPassword("Sm0ke-Test!2026", hash), true);
    assert.equal(await verifyPassword("wrong-password", hash), false);
    assert.equal(await verifyPassword("x", null), false);
    assert.equal(await verifyPassword("x", "plaintext"), false);
    assert.equal(await verifyPassword("x", "scrypt$bad$bad"), false);
  });
});

describe("阶段九：004 迁移幂等 + Worker 心跳", () => {
  it("001 + 004 连跑两遍，心跳表/索引/密码列均存在", async () => {
    const init = await readFile(path.join(root, "db/migrations/001_init.sql"), "utf8");
    const ops = await readFile(path.join(root, "db/migrations/004_ops.sql"), "utf8");
    const pg = new PGlite();
    try {
      await pg.exec(init);
      await pg.exec(ops);
      await pg.exec(ops);

      const tables = await pg.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()"
      );
      assert.ok(tables.rows.some((r) => r.tablename === "worker_heartbeats"));
      const columns = await pg.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'users'"
      );
      assert.ok(columns.rows.some((r) => r.column_name === "password_hash"));
      const indexes = await pg.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()"
      );
      assert.ok(indexes.rows.some((r) => r.indexname === "idx_worker_heartbeats_seen"));
      await pg.exec(
        "INSERT INTO worker_heartbeats (worker_id) VALUES ('a'), ('a') ON CONFLICT (worker_id) DO NOTHING"
      );
    } finally {
      await pg.close();
    }
  });

  it("心跳写入可读取、停机状态可更新", async (t) => {
    if (!hasDb) return t.skip("数据库不可达");
    const workerId = `phase9-${randomUUID()}`.slice(0, 120);
    try {
      await writeWorkerHeartbeat("running", workerId);
      const rows = await listWorkerHeartbeats(20);
      const found = rows.find((row) => row.workerId === workerId);
      assert.equal(found?.status, "running");
      assert.ok(found?.lastSeenAt instanceof Date);

      await writeWorkerHeartbeat("stopped", workerId);
      const stopped = (await listWorkerHeartbeats(20)).find((row) => row.workerId === workerId);
      assert.equal(stopped?.status, "stopped");
    } finally {
      await db.workerHeartbeat.deleteMany({ where: { workerId } });
    }
  });
});

describe("阶段九：/api/health 真实探测", () => {
  it("返回 phase=9 的四组探针，状态由 evaluateHealth 决定", async (t) => {
    if (!hasDb) return t.skip("数据库不可达");
    const report = await collectHealth();
    assert.equal(report.phase, 9);
    assert.equal(report.service, "product-video-ai");
    assert.ok(["ok", "degraded", "down"].includes(report.status));
    assert.equal(report.checks.database.ok, true);
    assert.equal(report.checks.disk.ok, true);
    assert.ok(report.checks.disk.freeBytes !== null);
    assert.ok(report.checks.queue.backlog >= 0);
    const evaluated = evaluateHealth(report.checks, report.thresholds);
    assert.equal(report.status, evaluated.status);
    assert.deepEqual(report.issues, evaluated.issues);
  });

  it("HEALTH_TOKEN 生效：无 token 401、带 token 返回报告", async (t) => {
    if (!hasDb) return t.skip("数据库不可达");
    const { GET } = await import("../src/app/api/health/route");
    const previous = process.env.HEALTH_TOKEN;
    process.env.HEALTH_TOKEN = "phase9-secret";
    try {
      const denied = await GET(new NextRequest("http://localhost/api/health"));
      assert.equal(denied.status, 401);

      const allowed = await GET(
        new NextRequest("http://localhost/api/health", {
          headers: { "x-health-token": "phase9-secret" },
        })
      );
      assert.ok(allowed.status === 200 || allowed.status === 503);
      const body = (await allowed.json()) as { ok: boolean; data: HealthReport };
      assert.equal(body.ok, true);
      assert.equal(body.data.phase, 9);
      assert.equal(allowed.headers.get("cache-control"), "no-store");
    } finally {
      if (previous === undefined) delete process.env.HEALTH_TOKEN;
      else process.env.HEALTH_TOKEN = previous;
    }
  });
});

describe("阶段九：部署配置静态检查", () => {
  it("PM2 ecosystem 可被加载，Web/Worker 两进程配置完整", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pv-phase9-"));
    const envFile = path.join(dir, ".env.production");
    const previous = process.env.PV_ENV_FILE;
    try {
      await writeFile(envFile, "DATABASE_URL=postgresql://u:p@localhost:5432/db\nPORT=3100\n", "utf8");
      process.env.PV_ENV_FILE = envFile;
      const require = createRequire(__filename);
      const config = require(path.join(root, "deploy/ecosystem.config.cjs")) as {
        apps: Array<{
          name: string;
          script: string;
          args: string;
          env: Record<string, string>;
          instances: number;
          autorestart: boolean;
        }>;
      };
      assert.equal(config.apps.length, 2);
      assert.deepEqual(config.apps.map((a) => a.name), ["pv-web", "pv-worker"]);
      for (const app of config.apps) {
        assert.equal(app.env.NODE_ENV, "production");
        assert.equal(app.instances, 1);
        assert.equal(app.autorestart, true);
      }
      assert.match(config.apps[0].args, /start -p 3100/);
      assert.match(config.apps[1].args, /src\/worker\/index\.ts/);
      assert.ok(config.apps[1].script.endsWith(path.join("tsx", "dist", "cli.mjs")));
    } finally {
      if (previous === undefined) delete process.env.PV_ENV_FILE;
      else process.env.PV_ENV_FILE = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("Nginx：限流区在 http 层、server 层含 11m 上传与鉴权下载保护", async () => {
    const httpConf = await readFile(path.join(root, "deploy/nginx/pv-http.conf"), "utf8");
    const site = await readFile(path.join(root, "deploy/nginx/product-video.conf"), "utf8");
    assert.match(httpConf, /limit_req_zone .* zone=pv_write/);
    assert.doesNotMatch(site, /limit_req_zone/);
    assert.match(site, /client_max_body_size 11m/);
    assert.match(site, /location = \/api\/health/);
    assert.match(site, /location \^~ \/data\/ \{[\s\S]{0,80}deny all/);
    assert.match(site, /proxy_pass http:\/\/127\.0\.0\.1:__PORT__/);
  });

  it("部署脚本 bash -n 语法通过，cron / 环境模板关键项齐全", async () => {
    const shells = ["backup.sh", "restore.sh", "deploy.sh", "setup-vps.sh", "cleanup.sh"];
    for (const file of shells) {
      const target = path.join(root, "deploy", file);
      try {
        execFileSync("bash", ["-n", target], { stdio: "pipe" });
      } catch (error) {
        // 无 bash 的环境跳过语法检查；有 bash 时必须通过。
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const cron = await readFile(path.join(root, "deploy/cron/product-video"), "utf8");
    assert.match(cron, /deploy\/backup\.sh/);
    assert.match(cron, /ops-alert\.ts/);
    assert.match(cron, /ops-storage-audit\.ts/);

    const env = await readFile(path.join(root, "deploy/env.production.example"), "utf8");
    for (const key of [
      "DATABASE_URL=",
      "DEV_SESSION_SECRET=",
      "HEALTH_TOKEN=",
      "PV_AUTH_MODE=",
      "ALERT_WEBHOOK_URL=",
      "BACKUP_KEEP_DAYS=",
    ]) {
      assert.ok(env.includes(key), `模板缺少 ${key}`);
    }
  });

  it("ops:alert --force 能触发一条测试告警（dry-run 不联网）", () => {
    const stateFile = path.join(tmpdir(), `pv-alert-${randomUUID()}.json`);
    const output = execFileSync(
      process.execPath,
      [path.join(root, "node_modules/tsx/dist/cli.mjs"), "scripts/ops-alert.ts", "--force"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          ALERT_WEBHOOK_URL: "",
          ALERT_STATE_FILE: stateFile,
          NODE_ENV: "development",
        },
      }
    );
    assert.match(output, /测试告警/);
    assert.match(output, /dry-run/);
    assert.match(output, /"notified":true/);
    void rm(stateFile, { force: true });
  });
});
