#!/usr/bin/env bash
# 发布与回滚（方案 12.5）：备份 → 依赖 → 迁移 → 构建 → PM2 重启 → 健康检查。
#
#   bash deploy/deploy.sh                 常规发布（自动前置备份）
#   bash deploy/deploy.sh --init          首次发布（不要求 PM2 已有进程）
#   bash deploy/deploy.sh --skip-backup  紧急修复，跳过备份
#   bash deploy/deploy.sh --rollback     回滚上一版构建产物（数据库迁移不回滚）
#
# 环境变量：PV_ENV_FILE（默认 .env.production）、DEPLOY_SMOKE=1（发布后跑冒烟）、
#          HEALTH_TOKEN、BASE_URL、DEPLOY_WAIT（健康检查重试次数，默认 30）。
# 失败时自动恢复 .next.previous 并 reload（DEPLOY_AUTO_ROLLBACK=0 可关闭）。
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
ENV_FILE="${PV_ENV_FILE:-$APP_DIR/.env.production}"
CONFIG="$APP_DIR/deploy/ecosystem.config.cjs"
RELEASE_LOG="$APP_DIR/logs/RELEASES.log"
mkdir -p "$APP_DIR/logs"

SKIP_BACKUP=0
INIT=0
ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --skip-backup) SKIP_BACKUP=1 ;;
    --init) INIT=1 ;;
    --rollback) ROLLBACK=1 ;;
  esac
done

log() { echo "[deploy] $*" | tee -a "$RELEASE_LOG"; }

reload_apps() {
  if pm2 describe pv-web >/dev/null 2>&1; then
    pm2 reload "$CONFIG" --update-env
  else
    pm2 start "$CONFIG"
  fi
  pm2 save >/dev/null 2>&1 || true
}

rollback() {
  log "开始回滚构建产物"
  if [[ -d "$APP_DIR/.next.previous" ]]; then
    rm -rf "$APP_DIR/.next"
    mv "$APP_DIR/.next.previous" "$APP_DIR/.next"
    reload_apps
    log "已恢复上一版 .next（数据库迁移未回滚，请人工评估）"
  else
    log "未找到 .next.previous，无法自动回滚；请用 git 回退后重新部署"
  fi
}

if [[ "$ROLLBACK" -eq 1 ]]; then
  rollback
  exit 0
fi

# ---------- 前置检查 ----------
[[ -f "$ENV_FILE" ]] || { log "缺少 $ENV_FILE"; exit 1; }
command -v node >/dev/null || { log "缺少 Node.js"; exit 1; }
command -v npm >/dev/null || { log "缺少 npm"; exit 1; }
command -v pm2 >/dev/null || { log "缺少 pm2，请先运行 setup-vps.sh 或 npm i -g pm2"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || { log "Node.js 版本需 >= 20"; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${DATABASE_URL:?缺少 DATABASE_URL}"
if [[ "${PV_AUTH_MODE:-supabase}" == "local" && ${#DEV_SESSION_SECRET:-} -lt 32 ]]; then
  log "PV_AUTH_MODE=local 要求 DEV_SESSION_SECRET 长度 >= 32"
  exit 1
fi

COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "开始发布 commit=$COMMIT node=$(node -v)"

# ---------- 1. 前置备份 ----------
if [[ "$SKIP_BACKUP" -eq 0 ]]; then
  bash "$APP_DIR/deploy/backup.sh" pre-deploy || { log "前置备份失败，已中止发布"; exit 1; }
fi

# ---------- 2. 保留上一版构建产物 ----------
rm -rf "$APP_DIR/.next.previous"
if [[ -d "$APP_DIR/.next" ]]; then
  mv "$APP_DIR/.next" "$APP_DIR/.next.previous"
fi

# ---------- 3. 依赖 / 迁移 / 构建 ----------
if ! {
  npm ci --no-audit --no-fund &&
  npx prisma generate &&
  npm run migrate &&
  npm run build
}; then
  log "依赖/迁移/构建失败"
  [[ "${DEPLOY_AUTO_ROLLBACK:-1}" == "1" ]] && rollback
  exit 1
fi

# ---------- 4. 重启进程 ----------
if ! reload_apps; then
  log "PM2 启动失败"
  [[ "${DEPLOY_AUTO_ROLLBACK:-1}" == "1" ]] && rollback
  exit 1
fi
if [[ "$INIT" -eq 1 ]]; then
  log "首次部署：执行 'sudo pm2 startup && sudo pm2 save' 配置开机自启"
fi

# ---------- 5. 健康检查 ----------
PORT="${PORT:-3000}"
URL="${BASE_URL:-http://127.0.0.1:$PORT}"
WAIT="${DEPLOY_WAIT:-30}"
HEALTH_TMP="$(mktemp)"
PASSED=0
fetch_health() {
  if [[ -n "${HEALTH_TOKEN:-}" ]]; then
    curl -fsS -m 5 -H "x-health-token: $HEALTH_TOKEN" "$URL/api/health" > "$HEALTH_TMP" 2>/dev/null
  else
    curl -fsS -m 5 "$URL/api/health" > "$HEALTH_TMP" 2>/dev/null
  fi
}
for _ in $(seq 1 "$WAIT"); do
  if fetch_health; then
    if node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit(r?.data?.status === "down" ? 1 : 0);
    ' "$HEALTH_TMP"; then
      PASSED=1
      break
    fi
  fi
  sleep 2
done
rm -f "$HEALTH_TMP"

if [[ "$PASSED" -ne 1 ]]; then
  log "发布后健康检查未通过"
  [[ "${DEPLOY_AUTO_ROLLBACK:-1}" == "1" ]] && rollback
  exit 1
fi
log "健康检查通过（$URL/api/health）"

# ---------- 6. 可选线上冒烟 ----------
if [[ "${DEPLOY_SMOKE:-0}" == "1" ]]; then
  if ! BASE_URL="$URL" node_modules/.bin/tsx scripts/ops-smoke.ts; then
    log "线上冒烟失败"
    exit 1
  fi
fi

log "发布成功 commit=$COMMIT"
