#!/usr/bin/env bash
# Cadenza 安装脚本（T26，DO-02/03/04/05）——干净安装：非开发者按《安装手册》执行。
#
# 规则落点：
# - DO-05 环境版本锚：目标环境规格（容器运行时/DB 主版本/Node）与发行锚不匹配即拒绝；
# - DO-02 干净安装：目标库已有任何表（含 schema_migrations）即拒绝——非干净环境必须先清理或换库；
# - DO-03 四件分离：默认不装演示数据；--with-demo 才装载（demo-bootstrap.sql + demo-dataset 分层装载）；
# - DO-04 安装后重启自检：安装完成即调 selfcheck.sh（历史坑：空模块配置/密钥失效重启后才暴露）。
#
# 用法：
#   ./install.sh --database-url URL [--anchor FILE] [--with-demo] [--skip-selfcheck] [--repo-root DIR]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE_URL=""
ANCHOR="${REPO_ROOT}/deploy/release/RELEASE-ANCHOR.json"
WITH_DEMO=no
SKIP_SELFCHECK=no

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-url) DATABASE_URL="${2:?--database-url 须带值}"; shift 2 ;;
    --anchor) ANCHOR="${2:?--anchor 须带值}"; shift 2 ;;
    --with-demo) WITH_DEMO=yes; shift ;;
    --skip-selfcheck) SKIP_SELFCHECK=yes; shift ;;
    --repo-root) REPO_ROOT="${2:?--repo-root 须带值}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "[失败] 未知参数 $1（--help 查看用法）"; exit 2 ;;
  esac
done

log() { printf '[install %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf '[失败] %s\n' "$*"; exit 1; }

[[ -n "$DATABASE_URL" ]] || die "必须提供 --database-url（目标库须为干净空库；cadenza dev 主库会被干净检查拒绝）"

log "步骤 0/6 前置检查：工具与构建产物"
command -v node >/dev/null || die "未找到 node（要求 Node ≥ 24，见安装手册第 2 节）"
[[ -f "$REPO_ROOT/packages/persistence/dist/cli.js" ]] || die "packages/persistence/dist/cli.js 不存在——先在发行包根执行 pnpm install && pnpm build（安装手册第 3 节）"

log "步骤 1/6 环境版本锚校验（DO-05）：$ANCHOR"
node "$REPO_ROOT/scripts/delivery/install/verify-anchor.mjs" --anchor "$ANCHOR" --database-url "$DATABASE_URL" || die "环境版本锚校验未通过：目标环境规格与发行锚不匹配，安装脚本拒绝执行（DO-05）"

log "步骤 2/6 干净环境检查（DO-02）"
node "$REPO_ROOT/scripts/delivery/install/verify-anchor.mjs" --assert-clean --database-url "$DATABASE_URL" || die "目标库非干净环境（已有表/schema_migrations）——干净安装拒绝执行；换空库或按手册清理（DO-02）"

log "步骤 3/6 应用数据库迁移（registry 全量，幂等）"
DATABASE_URL="$DATABASE_URL" node "$REPO_ROOT/packages/persistence/dist/cli.js" up

log "步骤 4/6 组织/角色/用户种子（幂等；演示/测试凭据仅 dev 占值，生产另行签发）"
DATABASE_URL="$DATABASE_URL" node "$REPO_ROOT/packages/persistence/dist/cli.js" seed

if [[ "$WITH_DEMO" == "yes" ]]; then
  log "步骤 5/6 装载匿名演示数据（DO-03：仅显式 --with-demo；演示库与真实业务库分开）"
  docker exec -i cadenza-dev-pg psql -v ON_ERROR_STOP=1 -U postgres -d "$(basename "${DATABASE_URL%%\?*}")" < "$REPO_ROOT/deploy/demo/demo-bootstrap.sql"
  (cd "$REPO_ROOT" && node scripts/delivery/import/import-validate.mjs --database-url "$DATABASE_URL" \
    --workspace "$REPO_ROOT/delivery-import-workspace" --apply --template initial-01-master-data --file deploy/demo/demo-dataset/demo-materials.csv) \
    || die "演示主数据装载失败（拒绝清单见 delivery-import-workspace）"
  (cd "$REPO_ROOT" && node scripts/delivery/import/import-validate.mjs --database-url "$DATABASE_URL" \
    --workspace "$REPO_ROOT/delivery-import-workspace" --merge-master-data)
  (cd "$REPO_ROOT" && node scripts/delivery/import/import-validate.mjs --database-url "$DATABASE_URL" \
    --workspace "$REPO_ROOT/delivery-import-workspace" --set-freeze --operator "演示装载") \
    || die "演示冻结点设置失败"
  (cd "$REPO_ROOT" && node scripts/delivery/import/import-validate.mjs --database-url "$DATABASE_URL" \
    --workspace "$REPO_ROOT/delivery-import-workspace" --apply --template initial-02-inventory --file deploy/demo/demo-dataset/demo-inventory.csv) \
    || die "演示库存装载失败"
  (cd "$REPO_ROOT" && node scripts/delivery/import/import-validate.mjs --database-url "$DATABASE_URL" \
    --workspace "$REPO_ROOT/delivery-import-workspace" --confirm-layer 1 --confirmer "演示装载" \
    && node scripts/delivery/import/import-validate.mjs --database-url "$DATABASE_URL" \
      --workspace "$REPO_ROOT/delivery-import-workspace" --confirm-layer 2 --confirmer "演示装载" \
    && node scripts/delivery/import/import-validate.mjs --database-url "$DATABASE_URL" \
      --workspace "$REPO_ROOT/delivery-import-workspace" --release-freeze --approver "演示装载")
else
  log "步骤 5/6 跳过演示数据（生产默认不含演示数据，DO-03）"
fi

log "步骤 6/6 安装后自检（DO-04）"
if [[ "$SKIP_SELFCHECK" == "yes" ]]; then
  log "已按参数跳过 selfcheck（仅限演练/隔离环境使用）"
else
  "$REPO_ROOT/deploy/install/selfcheck.sh" --database-url "$DATABASE_URL" --repo-root "$REPO_ROOT"
fi

log "安装完成。后续：启动 api/worker（手册第 5 节），并执行一次重启自检。"
