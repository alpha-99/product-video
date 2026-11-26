#!/usr/bin/env bash
# 备份恢复（方案 12.4 演练 / 回滚）。危险操作：会覆盖现有数据库与同名文件。
#
#   bash deploy/restore.sh backups/20261126-030000 --yes
#
# 不带 --yes 时只打印将要执行的内容（dry-run）。
# 恢复前建议先跑一次 backup.sh 留回滚点；pg_restore --clean 会重建表对象，
# 生产执行前务必确认目标库正确（Supabase 项目 / 环境别选错）。
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

SRC="${1:-}"
if [[ -z "$SRC" || ! -f "$SRC/database.dump" ]]; then
  echo "用法：bash deploy/restore.sh <备份目录> [--yes]" >&2
  exit 2
fi
: "${DATABASE_URL:?缺少 DATABASE_URL}"
DATA_DIR="${STORAGE_ROOT:-$APP_DIR/data}"
APPLY=0
[[ "${2:-}" == "--yes" ]] && APPLY=1

echo "[restore] 备份目录 : $SRC"
echo "[restore] 目标数据库: $(echo "$DATABASE_URL" | sed -E 's#://([^:]+):[^@]*@#://\1:***@#')"
echo "[restore] 数据目录  : $DATA_DIR"
cat "$SRC/manifest.json" 2>/dev/null || true

if [[ "$APPLY" -ne 1 ]]; then
  echo "[restore] dry-run：确认无误后追加 --yes 才会真正恢复"
  exit 0
fi

command -v pg_restore >/dev/null || { echo "缺少 pg_restore" >&2; exit 1; }
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname="$DATABASE_URL" "$SRC/database.dump"

if [[ -f "$SRC/files.tar.gz" ]]; then
  mkdir -p "$DATA_DIR"
  tar -C "$DATA_DIR" -xzf "$SRC/files.tar.gz"
fi

echo "[restore] 完成，请执行 npm run migrate:check 与 ops:check 验证"
