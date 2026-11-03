#!/usr/bin/env bash
# Cadenza 恢复脚本（T26，§3.1 第 3 步）——按手册顺序恢复：数据库 → 对象存储 → 配置。
#
# 安全：
# - 恢复会重建目标库（DROP+CREATE）：--target-confirm 必须逐字输入目标库名；
# - dev 主库 cadenza 与并行线测试库（cadenza_*，除 cadenza_dops_* 演练临时库）一律拒绝；
# - 备份件指纹先校验（SHA256SUMS），不一致拒绝恢复。
#
# 用法：
#   ./restore.sh --backup-dir DIR --database-url URL --target-confirm DBNAME
#                [--object-store-root DIR] [--pg-container NAME] [--repo-root DIR]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_DIR=""
DATABASE_URL=""
TARGET_CONFIRM=""
OBJECT_STORE_ROOT=""
PG_CONTAINER="${PG_CONTAINER:-cadenza-dev-pg}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir) BACKUP_DIR="${2:?}"; shift 2 ;;
    --database-url) DATABASE_URL="${2:?}"; shift 2 ;;
    --target-confirm) TARGET_CONFIRM="${2:?}"; shift 2 ;;
    --object-store-root) OBJECT_STORE_ROOT="${2:?}"; shift 2 ;;
    --pg-container) PG_CONTAINER="${2:?}"; shift 2 ;;
    --repo-root) REPO_ROOT="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "[失败] 未知参数 $1"; exit 2 ;;
  esac
done

log() { printf '[restore %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf '[失败] %s\n' "$*"; exit 1; }

[[ -n "$BACKUP_DIR" && -n "$DATABASE_URL" ]] || die "必须提供 --backup-dir 与 --database-url"
[[ -f "$BACKUP_DIR/database.dump" ]] || die "备份目录缺 database.dump"
[[ -f "$BACKUP_DIR/BACKUP-MANIFEST.json" ]] || die "备份目录缺 BACKUP-MANIFEST.json"

DB_NAME="$(basename "${DATABASE_URL%%\?*}")"
ADMIN_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#')"

log "0/5 备份件指纹校验"
( cd "$BACKUP_DIR" && shasum -a 256 -c SHA256SUMS --quiet ) || die "备份件哈希与 SHA256SUMS 不一致——备份介质可疑，拒绝恢复"

log "1/5 重建目标库 ${DB_NAME}（输入目标库名确认：${TARGET_CONFIRM}）"
node "$REPO_ROOT/scripts/delivery/backup/pg-ops.mjs" recreate --admin-url "$ADMIN_URL" \
  --database "$DB_NAME" --target-confirm "$TARGET_CONFIRM"

log "2/5 恢复数据库（pg_restore，顺序第 1 位）"
docker exec -i "$PG_CONTAINER" pg_restore -U postgres -d "$DB_NAME" --no-owner --no-privileges \
  < "$BACKUP_DIR/database.dump" 2> "$BACKUP_DIR/restore.err" \
  || { head -20 "$BACKUP_DIR/restore.err"; die "pg_restore 失败"; }

log "3/5 恢复对象存储（顺序第 2 位）"
if [[ -f "$BACKUP_DIR/object-store.tar.gz" ]]; then
  DEST="${OBJECT_STORE_ROOT:-$REPO_ROOT/object-store-restored}"
  mkdir -p "$DEST"
  tar -xzf "$BACKUP_DIR/object-store.tar.gz" -C "$DEST"
  log "对象存储已恢复到 $DEST"
else
  log "备份无对象存储件（object-store.readme 有说明），附件根不覆盖"
fi

log "4/5 恢复配置与密钥清单（顺序第 3 位；密钥按 DO-04 保管方案另行注入，不随备份明文回放）"
cp "$BACKUP_DIR/config.redacted.env" "$BACKUP_DIR/config.restored.env"
log "脱敏配置已就位：$BACKUP_DIR/config.restored.env（值守人员按密钥管理注入真实值后重启应用）"

log "5/5 恢复后校验（迁移版本 = 备份版本）"
APPLIED="$(node "$REPO_ROOT/scripts/delivery/backup/pg-ops.mjs" applied --database-url "$DATABASE_URL")"
EXPECTED="$(node -e "const m=require(process.argv[1]);const s=m.schema_migrations;console.log(Array.isArray(s)?s.join(','):s)" "$BACKUP_DIR/BACKUP-MANIFEST.json")"
if [[ "$APPLIED" == "$EXPECTED" ]]; then
  log "迁移一致：${APPLIED}（= 备份指纹，§3.1 第 4 步通过）"
else
  die "迁移不一致：库 $APPLIED vs 备份 $EXPECTED——按 DO-20 升级路径处置或重选恢复源"
fi
log "恢复完成。后续按 §3.1：启动应用与 worker → 重启自检（DO-04）→ 三分对账（DO-18）→ 差异清单（DO-19）。"
