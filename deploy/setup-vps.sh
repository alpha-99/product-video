#!/usr/bin/env bash
# VPS 从零准备（方案 12.1 / 阶段九）。在 Ubuntu 22.04/24.04 上以 root 执行：
#
#   sudo bash deploy/setup-vps.sh --domain video.example.com --email ops@example.com
#   sudo bash deploy/setup-vps.sh --app-dir /srv/pv --user pv --port 3000
#   sudo bash deploy/setup-vps.sh --skip-apt          # 已装好依赖时
#
# 做这些事：系统依赖 → 目录/用户 → .env.production（含随机密钥）→
#           Nginx 站点与限流 → cron 备份/告警/清理 → logrotate → 可选 Certbot。
# 不会自动 clone 代码、不会覆盖已有 .env.production、不会删 Nginx 默认站点。
set -euo pipefail

APP_DIR="/opt/product-video"
DEPLOY_USER="deploy"
DOMAIN="_"
CERT_EMAIL=""
PORT="3000"
WITH_CERTBOT=0
SKIP_APT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --user) DEPLOY_USER="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; WITH_CERTBOT=1; shift 2 ;;
    --email) CERT_EMAIL="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --with-certbot) WITH_CERTBOT=1; shift ;;
    --skip-apt) SKIP_APT=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[[ "$(id -u)" -eq 0 ]] || { echo "请以 root 运行（sudo bash deploy/setup-vps.sh ...）" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$APP_DIR/data"

echo "[setup] app=$APP_DIR user=$DEPLOY_USER domain=$DOMAIN port=$PORT"

# ---------- 1. 系统依赖 ----------
if [[ "$SKIP_APT" -eq 0 ]]; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    nginx ffmpeg fonts-noto-cjk postgresql-client curl git openssl ca-certificates
fi

command -v node >/dev/null || { echo "缺少 Node.js 20+，请先安装（NodeSource/nvm）" >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || { echo "Node.js 版本需 >= 20（当前 $(node -v)）" >&2; exit 1; }
if ! command -v pm2 >/dev/null; then
  npm i -g pm2
fi
PG_MAJOR="$(pg_dump --version | sed -E 's/.* ([0-9]+).*/\1/')"
if [[ "$PG_MAJOR" -lt 15 ]]; then
  echo "[setup][warn] pg_dump 版本 $PG_MAJOR 偏旧，连 PG15+ 可能失败；建议装 PGDG 的 postgresql-client-15+"
fi

# ---------- 2. 用户、目录、日志 ----------
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$DEPLOY_USER"
fi
mkdir -p "$DATA_DIR"/{uploads,renders,videos,thumbnails} "$APP_DIR"/{logs,backups,.ops}
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

# ---------- 3. 生产环境变量 ----------
ENV_FILE="$APP_DIR/.env.production"
if [[ ! -f "$ENV_FILE" ]]; then
  SESSION_SECRET="$(openssl rand -hex 32)"
  HEALTH_SECRET="$(openssl rand -hex 24)"
  sed \
    -e "s|^DEV_SESSION_SECRET=.*|DEV_SESSION_SECRET=\"$SESSION_SECRET\"|" \
    -e "s|^HEALTH_TOKEN=.*|HEALTH_TOKEN=\"$HEALTH_SECRET\"|" \
    -e "s|^STORAGE_ROOT=.*|STORAGE_ROOT=\"$DATA_DIR\"|" \
    -e "s|^PORT=.*|PORT=\"$PORT\"|" \
    "$SCRIPT_DIR/env.production.example" > "$ENV_FILE"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "[setup] 已生成 $ENV_FILE（含随机密钥）；请填写 DATABASE_URL / AI_API_KEY 等必填项"
else
  echo "[setup] 保留已有 $ENV_FILE"
fi

# ---------- 4. Nginx ----------
install -d /etc/nginx/conf.d /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled
cp "$SCRIPT_DIR/nginx/pv-http.conf" /etc/nginx/conf.d/pv-http.conf
cp "$SCRIPT_DIR/nginx/pv-proxy.conf" /etc/nginx/snippets/pv-proxy.conf
sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__PORT__|$PORT|g" \
  "$SCRIPT_DIR/nginx/product-video.conf" > /etc/nginx/sites-available/product-video
ln -sfn /etc/nginx/sites-available/product-video /etc/nginx/sites-enabled/product-video
nginx -t
systemctl reload nginx
echo "[setup] Nginx 已启用 product-video（如有默认站点占用 80 端口，请手动处理）"

# ---------- 5. HTTPS（可选） ----------
if [[ "$WITH_CERTBOT" -eq 1 && "$DOMAIN" != "_" ]]; then
  [[ -n "$CERT_EMAIL" ]] || { echo "--domain 需要同时给 --email" >&2; exit 2; }
  if ! command -v certbot >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx
  fi
  certbot --nginx -d "$DOMAIN" -m "$CERT_EMAIL" --non-interactive --agree-tos --redirect
  sed -i 's|^PV_COOKIE_SECURE=.*|PV_COOKIE_SECURE="1"|' "$ENV_FILE"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE"
  echo "[setup] HTTPS 已启用，PV_COOKIE_SECURE=1（Cookie 走 Secure）"
else
  echo "[setup] 未启用 HTTPS；HTTP 内测请保持 PV_COOKIE_SECURE=\"0\""
fi

# ---------- 6. 定时任务与日志轮转 ----------
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__USER__|$DEPLOY_USER|g" \
  "$SCRIPT_DIR/cron/product-video" > /etc/cron.d/product-video
chmod 644 /etc/cron.d/product-video
sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__USER__|$DEPLOY_USER|g" \
  "$SCRIPT_DIR/logrotate/product-video" > /etc/logrotate.d/product-video
systemctl reload cron 2>/dev/null || systemctl reload crond 2>/dev/null || true
echo "[setup] cron：每日 03:00 备份 / 每分钟告警 / 04:30 清理；logrotate 保留 14 天"

cat <<EOF

[setup] 完成。接下来（以 $DEPLOY_USER 身份）：

  1. 把代码放到 $APP_DIR（git clone 或 rsync）
  2. vi $APP_DIR/.env.production        # 填 DATABASE_URL（session pooler :5432）、AI_API_KEY 等
  3. cd $APP_DIR && npm ci && npx prisma generate && npm run migrate
  4. sudo pm2 startup systemd -u $DEPLOY_USER --hp /home/$DEPLOY_USER   # 按输出执行提示命令
  5. cd $APP_DIR && bash deploy/deploy.sh --init
  6. cd $APP_DIR && BASE_URL=https://$DOMAIN node_modules/.bin/tsx scripts/ops-smoke.ts
  7. cd $APP_DIR && npm run ops:alert -- --force                        # 验证告警链路

EOF
