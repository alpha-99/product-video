#!/usr/bin/env bash
# 容量治理（方案 9.3）：清理临时渲染目录、按留存期归档成片。
#
#   bash deploy/cleanup.sh             只清理 renders/，成片只报告（dry-run）
#   bash deploy/cleanup.sh --apply     额外删除超过 RETENTION_DAYS 的成片/缩略图
#
# 环境变量：STORAGE_ROOT、CLEANUP_RENDER_HOURS（默认 24）、RETENTION_DAYS（默认 30）。
# 一致性核对（数据库 output_path ↔ 磁盘文件）由 scripts/ops-storage-audit.ts 负责。
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

DATA_DIR="${STORAGE_ROOT:-$APP_DIR/data}"
RENDER_HOURS="${CLEANUP_RENDER_HOURS:-24}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1
mkdir -p "$DATA_DIR"

echo "[cleanup] $(date -u +%FT%TZ) root=$DATA_DIR renders>${RENDER_HOURS}h retention=${RETENTION_DAYS}d apply=$APPLY"

RENDERS="$DATA_DIR/renders"
if [[ -d "$RENDERS" ]]; then
  FOUND="$(find "$RENDERS" -mindepth 1 -maxdepth 1 -type d -mmin "+$((RENDER_HOURS * 60))" | wc -l)"
  find "$RENDERS" -mindepth 1 -maxdepth 1 -type d -mmin "+$((RENDER_HOURS * 60))" \
    -print -exec rm -r -- {} +
  echo "[cleanup] 已清理 $FOUND 个临时渲染目录"
fi

for d in videos thumbnails; do
  DIR="$DATA_DIR/$d"
  [[ -d "$DIR" ]] || continue
  COUNT="$(find "$DIR" -type f -mtime "+$RETENTION_DAYS" | wc -l)"
  if [[ "$APPLY" -eq 1 ]]; then
    find "$DIR" -type f -mtime "+$RETENTION_DAYS" -print -delete
    echo "[cleanup] $d 已删除 $COUNT 个过期文件"
  else
    echo "[cleanup] $d 有 $COUNT 个超过 ${RETENTION_DAYS} 天的文件（dry-run，加 --apply 才删）"
  fi
done
