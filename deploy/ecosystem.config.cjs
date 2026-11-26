/**
 * PM2 进程守护（方案 12.2 / 阶段九）。
 *
 *   pm2 start   deploy/ecosystem.config.cjs
 *   pm2 reload  deploy/ecosystem.config.cjs --update-env
 *   pm2 startOrReload deploy/ecosystem.config.cjs   # deploy.sh 用这个
 *   pm2 save && pm2 startup                        # 开机自启（setup-vps.sh 会提示）
 *
 * Web 与 Worker 是两个独立进程：日志、重启、内存上限互不影响（方案 2.2）。
 * 环境变量统一从项目根 .env.production 读取（可用 PV_ENV_FILE 覆盖），
 * 与 src/lib/env.ts 的加载顺序一致；不要把密钥写进本文件。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const dotenv = require("dotenv");

const APP_DIR = path.resolve(__dirname, "..");
const ENV_FILE = process.env.PV_ENV_FILE || path.join(APP_DIR, ".env.production");

if (!fs.existsSync(ENV_FILE)) {
  throw new Error(`缺少环境文件 ${ENV_FILE}，请先运行 bash deploy/setup-vps.sh 或手动创建`);
}

const parsed = dotenv.parse(fs.readFileSync(ENV_FILE));
if (!parsed.DATABASE_URL) {
  throw new Error(`${ENV_FILE} 未配置 DATABASE_URL`);
}

let version = process.env.APP_VERSION || parsed.APP_VERSION || "unknown";
if (version === "unknown") {
  try {
    version = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: APP_DIR,
      encoding: "utf8",
    }).trim();
  } catch {
    // 非 git 部署（rsync/scp 拷贝）时保留 unknown，不影响启动。
  }
}

const PORT = parsed.PORT || "3000";
const LOG_DIR = path.join(APP_DIR, "logs");
const commonEnv = {
  ...parsed,
  NODE_ENV: "production",
  PORT,
  APP_VERSION: version,
  // 数据目录默认落在 /opt/product-video/data，与方案 9.1 一致。
  STORAGE_ROOT: parsed.STORAGE_ROOT || path.join(APP_DIR, "data"),
};

module.exports = {
  apps: [
    {
      name: "pv-web",
      cwd: APP_DIR,
      script: path.join(APP_DIR, "node_modules", "next", "dist", "bin", "next"),
      args: `start -p ${PORT}`,
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 3000,
      kill_timeout: 15000,
      max_memory_restart: "600M",
      env: commonEnv,
      out_file: path.join(LOG_DIR, "web-out.log"),
      error_file: path.join(LOG_DIR, "web-error.log"),
      merge_logs: true,
      time: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
    {
      name: "pv-worker",
      cwd: APP_DIR,
      // tsx 在 dependencies（生产也需要跑 worker / migrate / ops 脚本）。
      script: path.join(APP_DIR, "node_modules", "tsx", "dist", "cli.mjs"),
      args: "src/worker/index.ts",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1, // SKIP LOCKED 支持多实例，但单 VPS 渲染并发 MUST = 1
      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 3000,
      kill_timeout: 30000, // 尽量等当前渲染任务收尾，避免半途杀进程
      max_memory_restart: "1200M",
      env: {
        ...commonEnv,
        MAX_CONCURRENT_RENDER: parsed.MAX_CONCURRENT_RENDER || "1",
        RENDER_TIMEOUT_MS: parsed.RENDER_TIMEOUT_MS || "600000",
        PV_WORKER_ID: parsed.PV_WORKER_ID || "worker-1",
      },
      out_file: path.join(LOG_DIR, "worker-out.log"),
      error_file: path.join(LOG_DIR, "worker-error.log"),
      merge_logs: true,
      time: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
