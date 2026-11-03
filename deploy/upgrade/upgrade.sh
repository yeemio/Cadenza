#!/usr/bin/env bash
# Cadenza 升级脚本（T26，DO-20）——先备份后升级；恢复方案考虑已发生业务写入，不能只回滚容器。
#
# 步骤：0 环境版本锚（DO-05）→ 1 升级前备份（DO-15）→ 2 兼容检查（DO-20：漂移/路径/重入）
#       → 3 应用迁移（幂等，失败可续跑）→ 4 安装后自检（DO-04，可选 --api-url 时含健康端点）
#
# 用法：
#   ./upgrade.sh --database-url URL [--env-file FILE] [--object-store-root DIR]
#                [--api-url URL] [--repo-root DIR]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE_URL=""
ENV_FILE=""
OBJECT_STORE_ROOT=""
API_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-url) DATABASE_URL="${2:?}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?}"; shift 2 ;;
    --object-store-root) OBJECT_STORE_ROOT="${2:?}"; shift 2 ;;
    --api-url) API_URL="${2:?}"; shift 2 ;;
    --repo-root) REPO_ROOT="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "[失败] 未知参数 $1"; exit 2 ;;
  esac
done

log() { printf '[upgrade %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf '[失败] %s\n' "$*"; exit 1; }
[[ -n "$DATABASE_URL" ]] || die "必须提供 --database-url"

EXTRA_BACKUP=()
[[ -n "$ENV_FILE" ]] && EXTRA_BACKUP+=(--env-file "$ENV_FILE")
[[ -n "$OBJECT_STORE_ROOT" ]] && EXTRA_BACKUP+=(--object-store-root "$OBJECT_STORE_ROOT")

log "0/4 环境版本锚校验（DO-05）"
node "$REPO_ROOT/scripts/delivery/install/verify-anchor.mjs" \
  --anchor "$REPO_ROOT/deploy/release/RELEASE-ANCHOR.json" --database-url "$DATABASE_URL" \
  || die "环境版本锚校验未通过——升级拒绝执行（DO-05）"

log "1/4 升级前备份（DO-20：恢复方案必须考虑已发生的业务写入，不能只回滚容器）"
BACKUP_ARGS=(--database-url "$DATABASE_URL" --repo-root "$REPO_ROOT" "${EXTRA_BACKUP[@]+"${EXTRA_BACKUP[@]}"}")
"$REPO_ROOT/deploy/backup/backup.sh" "${BACKUP_ARGS[@]}" || die "升级前备份失败——不升级（备份失败必告警，DO-15）"

log "2/4 升级兼容检查（DO-20）"
node "$REPO_ROOT/scripts/delivery/upgrade-compat-check.mjs" --database-url "$DATABASE_URL" \
  --repo-root "$REPO_ROOT" --no-reentrancy \
  || die "升级兼容检查未通过（漂移/不可跳转路径见上方输出）"

log "3/4 应用数据库迁移（幂等；失败修复后重跑本脚本续跑，不重复应用）"
DATABASE_URL="$DATABASE_URL" node "$REPO_ROOT/packages/persistence/dist/cli.js" up

log "4/4 升级后自检（DO-04）"
if [[ -n "$API_URL" ]]; then
  node "$REPO_ROOT/scripts/delivery/install/selfcheck.mjs" --database-url "$DATABASE_URL" --api-url "$API_URL"
else
  node "$REPO_ROOT/scripts/delivery/install/selfcheck.mjs" --database-url "$DATABASE_URL"
fi
log "升级完成。升级记录要点（登记入变更单）：起点版本集合→终点版本、备份目录、自检结果。"
