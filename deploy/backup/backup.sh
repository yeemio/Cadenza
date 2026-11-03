#!/usr/bin/env bash
# Cadenza 备份脚本（T26，DO-15）——应用与数据库独立备份；覆盖业务库、对象存储、配置与密钥清单。
#
# - 数据库：pg_dump -Fc（自定义格式，pg_restore 恢复）；
# - 对象存储（附件/标签根目录）：tar 归档；
# - 配置与密钥清单：环境文件脱敏副本（凭据不含明文密码）；
# - 备份执行结果写 backup-status.json（监控接入点：失败必告警，DO-15/DO-21），失败退出非零。
#
# 用法：
#   ./backup.sh --database-url URL [--object-store-root DIR] [--env-file FILE]
#               [--out DIR] [--pg-container NAME] [--repo-root DIR]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE_URL="${DATABASE_URL:-}"
OBJECT_STORE_ROOT=""
ENV_FILE="${ENV_FILE:-}"
OUT_ROOT=""
PG_CONTAINER="${PG_CONTAINER:-cadenza-dev-pg}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-url) DATABASE_URL="${2:?}"; shift 2 ;;
    --object-store-root) OBJECT_STORE_ROOT="${2:?}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?}"; shift 2 ;;
    --out) OUT_ROOT="${2:?}"; shift 2 ;;
    --pg-container) PG_CONTAINER="${2:?}"; shift 2 ;;
    --repo-root) REPO_ROOT="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "[失败] 未知参数 $1"; exit 2 ;;
  esac
done

log() { printf '[backup %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf '[失败] %s\n' "$*"; exit 1; }

[[ -n "$DATABASE_URL" ]] || die "必须提供 --database-url"
STAMP="$(date '+%Y%m%d-%H%M%S')"
OUT_DIR="${OUT_ROOT:-$REPO_ROOT/backups}/${STAMP}"
DB_NAME="$(basename "${DATABASE_URL%%\?*}")"
STATUS_FILE="${OUT_ROOT:-$REPO_ROOT/backups}/backup-status.json"
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
START_MS=$(( $(date +%s) * 1000 ))

mkdir -p "$OUT_DIR"

write_status() { # $1=ok|failed $2=detail
  local END_MS=$(( $(date +%s) * 1000 ))
  printf '{"result":"%s","detail":"%s","backup_dir":"%s","started_at":"%s","duration_ms":%s,"written_at":"%s"}\n' \
    "$1" "$2" "$OUT_DIR" "$STARTED_AT" "$((END_MS - START_MS))" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$STATUS_FILE"
}

log "备份开始：目标库 ${DB_NAME}（应用与数据库独立备份，DO-15）"

# 1) 数据库备份（pg_dump 经容器执行；宿主无 psql 工具时同样适用）
log "1/4 数据库 pg_dump（custom 格式）"
if ! docker exec "$PG_CONTAINER" pg_dump -U postgres -d "$DB_NAME" -Fc > "$OUT_DIR/database.dump" 2> "$OUT_DIR/database.dump.err"; then
  write_status failed "pg_dump 失败：$(head -c 300 "$OUT_DIR/database.dump.err" | tr '\n' ' ')"
  die "pg_dump 失败（备份失败已写监控状态文件 ${STATUS_FILE}，DO-15 失败必告警）"
fi
[[ -s "$OUT_DIR/database.dump" ]] || { write_status failed "pg_dump 输出为空"; die "数据库备份文件为空"; }

# 2) 对象存储备份（附件/标签）
log "2/4 对象存储归档"
if [[ -n "$OBJECT_STORE_ROOT" && -d "$OBJECT_STORE_ROOT" ]]; then
  tar -czf "$OUT_DIR/object-store.tar.gz" -C "$OBJECT_STORE_ROOT" .
  echo "对象存储根目录：${OBJECT_STORE_ROOT}（本机目录形态；现场对象存储按运维手册导出后替换本件）" > "$OUT_DIR/object-store.readme"
else
  echo "本次备份未提供 --object-store-root（对象存储层缺席，恢复时不覆盖附件根）" > "$OUT_DIR/object-store.readme"
fi

# 3) 配置与密钥清单（脱敏；凭据不含明文密码，DO-15）
log "3/4 配置与密钥清单（脱敏副本）"
if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
  sed -E 's#(://[^:/@]+:)[^@]+@#\1***@#g; s#^(.*PASSWORD|.*SECRET|.*KEY)=.*$#\1=***（值由密钥管理注入，不入备份）#' \
    "$ENV_FILE" > "$OUT_DIR/config.redacted.env"
else
  cp "$REPO_ROOT/.env.example" "$OUT_DIR/config.redacted.env" 2>/dev/null \
    || echo "无环境文件；按 deploy/config/CONFIG-CHECKLIST.md 第 2 节清单重建" > "$OUT_DIR/config.redacted.env"
fi

# 4) 备份清单（介质/版本指纹/文件哈希）＋监控状态
log "4/4 备份清单与指纹"
APPLIED="$(node "$REPO_ROOT/scripts/delivery/backup/pg-ops.mjs" applied --database-url "$DATABASE_URL")"
SERVER_NOW="$(node "$REPO_ROOT/scripts/delivery/backup/pg-ops.mjs" server-now --database-url "$DATABASE_URL")"
(
  cd "$OUT_DIR"
  printf 'database.dump\nobject-store.tar.gz\nobject-store.readme\nconfig.redacted.env\n' | while read -r f; do
    [[ -f "$f" ]] && printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"
  done > SHA256SUMS
)
MIG_JSON="$(printf '%s' "$APPLIED" | awk -F',' '{for(i=1;i<=NF;i++) printf "\"%s\"%s", $i, (i<NF?",":"")}')"
cat > "$OUT_DIR/BACKUP-MANIFEST.json" <<EOF
{
  "backup_id": "$STAMP",
  "media": "本机目录 ${OUT_DIR}（现场按介质登记：磁带/异地副本由运维执行并回填）",
  "source_database": "$DB_NAME",
  "source_url_redacted": "$(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:/@]+:)[^@]+@#\1***@#')",
  "schema_migrations": [$MIG_JSON],
  "server_now_at_backup": "$SERVER_NOW",
  "started_at": "$STARTED_AT",
  "finished_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "artifacts": {
    "database": "database.dump（pg_dump -Fc，独立可恢复）",
    "object_store": "object-store.tar.gz（应用附件层，独立可恢复；缺席见 object-store.readme）",
    "config": "config.redacted.env（配置与密钥清单，脱敏；密钥按 DO-04 保管方案在恢复时注入）"
  }
}
EOF
write_status ok "pg_dump + 对象存储 + 配置清单完成；迁移版本：$APPLIED"
log "备份完成：${OUT_DIR}（迁移版本 ${APPLIED}；数据库时间锚 ${SERVER_NOW}）"
log "监控接入：${STATUS_FILE}（DO-21：备份失败必告警——本文件 result=failed 即触发）"
