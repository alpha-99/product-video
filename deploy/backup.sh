#!/usr/bin/env bash
# 每日备份（方案 12.4）：数据库 pg_dump(custom) + 上传件/成片/缩略图 tar.gz。
#
#   bash deploy/backup.sh [tag]         tag 默认 manual；deploy.sh 传 pre-deploy
#   BACKUP_DIR=/mnt/backup bash deploy/backup.sh
#
# 环境变量（.env.production）：DATABASE_URL、STORAGE_ROOT、BACKUP_DIR、
#   BACKUP_KEEP_DAYS（默认 14）、RCLONE_REMOTE（可选，异地同步）、BACKUP_TAG。
# 备份产物：backups/<时间戳>/{database.dump,files.tar.gz,manifest.json}
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
ENV_FILE="${PV_ENV_FILE:-$APP_DIR/.env.production}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${DATABASE_URL:?缺少 DATABASE_URL，请在 .env.production 配置后重试}"
command -v pg_dump >/dev/null || { echo "缺少 pg_dump，请先 apt install postgresql-client" >&2; exit 1; }

TAG="${1:-${BACKUP_TAG:-manual}}"
BACKUP_ROOT="${BACKUP_DIR:-$APP_DIR/backups}"
DATA_DIR="${STORAGE_ROOT:-$APP_DIR/data}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
TS="$(date -u +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$TS"
mkdir -p "$DEST" "$DATA_DIR"

echo "[backup] $(date -u +%FT%TZ) tag=$TAG dest=$DEST"

# 1) 数据库：session pooler(5432) 可用；transaction pooler(6543) 不支持 pg_dump。
pg_dump --no-owner --no-privileges --format=custom \
  --file="$DEST/database.dump" "$DATABASE_URL"
[[ -s "$DEST/database.dump" ]] || { echo "pg_dump 产物为空" >&2; exit 1; }

# 2) 文件：只备份长期资产；renders/ 是临时目录，由 cleanup.sh 清理。
DIRS=()
for d in uploads videos thumbnails; do
  [[ -d "$DATA_DIR/$d" ]] && DIRS+=("$d")
done
if ((${#DIRS[@]})); then
  tar -C "$DATA_DIR" -czf "$DEST/files.tar.gz" "${DIRS[@]}"
else
  tar -czf "$DEST/files.tar.gz" --files-from /dev/null
fi

COMMIT="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DB_BYTES="$(stat -c%s "$DEST/database.dump")"
FILE_BYTES="$(stat -c%s "$DEST/files.tar.gz")"
cat > "$DEST/manifest.json" <<EOF
{
  "timestamp": "$(date -u +%FT%TZ)",
  "tag": "$TAG",
  "commit": "$COMMIT",
  "databaseBytes": $DB_BYTES,
  "filesBytes": $FILE_BYTES,
  "pgDumpVersion": "$(pg_dump --version)",
  "storageRoot": "$DATA_DIR",
  "keepDays": $KEEP_DAYS
}
EOF

# 3) 异地备份（可选）：rclone remote 需提前 rclone config 好。
if [[ -n "${RCLONE_REMOTE:-}" ]] && command -v rclone >/dev/null; then
  rclone copy "$DEST" "$RCLONE_REMOTE/$TS"
  echo "[backup] 已同步到 $RCLONE_REMOTE/$TS"
fi

# 4) 留存：仅清理本目录内符合时间戳命名的备份目录。
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??????-??????' \
  -mtime "+$KEEP_DAYS" -print -exec rm -r -- {} + 2>/dev/null || true

echo "[backup] 完成：db=${DB_BYTES}B files=${FILE_BYTES}B 保留 ${KEEP_DAYS} 天"
