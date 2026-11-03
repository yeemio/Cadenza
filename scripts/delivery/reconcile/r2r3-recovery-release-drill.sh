#!/usr/bin/env bash
# R2R3 合并演练（PM-FINAL-RECEPTION R2+R3，2026-10-29）——一次隔离库串起：
#   干净安装（0001–0021+seed）→ 期初样本落账（最小自备样本）→ 报表投影重建（产品命令面）
#   → 备份（既有 backup.sh）→ 破坏性变更（DROP 源库）→ 恢复（既有 restore.sh）
#   → 三分对账（R2 新能力，期望 PASS）→ 注入投影偏差（期望 FAIL 被检出）
#   → rebuild（产品命令面）→ 复对账 PASS → 恢复读回与发行锚一致。
#
# 纪律（同 backup-restore-drill.sh）：只动 cadenza_dops_* 临时库与临时目录，绝不碰 cadenza 主库；
# 宿主无 psql/pg_dump，全部经 cadenza-dev-pg 容器执行；临时库用后即删，证据落 --evidence 目录。
#
# 用法：./r2r3-recovery-release-drill.sh [--repo-root DIR] [--evidence DIR] [--keep-dbs]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EVIDENCE=""
KEEP_DBS=no
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root) REPO_ROOT="${2:?}"; shift 2 ;;
    --evidence) EVIDENCE="${2:?}"; shift 2 ;;
    --keep-dbs) KEEP_DBS=yes; shift ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "[失败] 未知参数 $1"; exit 2 ;;
  esac
done

STAMP="$(date '+%Y%m%d-%H%M%S')"
EVIDENCE="${EVIDENCE:-$REPO_ROOT/delivery/P3/delivery-ops/evidence/drill/r2r3-$STAMP}"
SRC_DB="cadenza_dops_r2r3_src"; RESTORE_DB="cadenza_dops_r2r3_restore"
BASE_URL="postgres://postgres:cadenza_dev@127.0.0.1:55433"
SRC_URL="$BASE_URL/$SRC_DB"; RESTORE_URL="$BASE_URL/$RESTORE_DB"
ADMIN_URL="$BASE_URL/postgres"
PG_CONTAINER="cadenza-dev-pg"
API_PORT=3907
ANCHOR="$REPO_ROOT/deploy/release/RELEASE-ANCHOR.json"

log() { printf '[r2r3 %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf '[r2r3 失败] %s\n' "$*"; exit 1; }
ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

mkdir -p "$EVIDENCE"
STEP_LOG="$EVIDENCE/drill-steps.log"
exec > >(tee -a "$STEP_LOG") 2>&1

# ---- 预检 ----
log "预检：容器健康/临时库护栏/端口/发行锚"
docker compose -f "$REPO_ROOT/docker-compose.yml" ps | grep -q healthy || die "cadenza-dev-pg 未运行"
[[ "$SRC_DB" =~ ^cadenza_dops_[a-z0-9_]+$ && "$RESTORE_DB" =~ ^cadenza_dops_[a-z0-9_]+$ ]] || die "临时库名护栏不通过"
[[ "$SRC_DB" != "cadenza" && "$RESTORE_DB" != "cadenza" ]] || die "护栏：不得等于主库名"
lsof -nP -iTCP:$API_PORT -sTCP:LISTEN >/dev/null 2>&1 && die "端口 $API_PORT 已被占用"
[[ -f "$ANCHOR" ]] || die "发行锚缺失：$ANCHOR"
[[ -f "$REPO_ROOT/deploy/release/APP-DELIVERABLE-DIGEST.json" ]] || die "应用交付物清单缺失（先跑 deploy/release/app-deliverable-digest.mjs）"
node "$REPO_ROOT/scripts/delivery/backup/pg-ops.mjs" exists --admin-url "$ADMIN_URL" --database cadenza | grep -q yes \
  || die "护栏自检异常：cadenza 主库不可见（不应发生）"

drop_temp() {
  [[ "$KEEP_DBS" == yes ]] && { log "保留临时库（--keep-dbs）"; return; }
  case "$1" in cadenza_dops_r2r3_src|cadenza_dops_r2r3_restore) ;; *) die "清理护栏：非演练临时库名 $1" ;; esac
  docker exec "$PG_CONTAINER" psql -U postgres -d postgres -q -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$1' AND pid<>pg_backend_pid()" >/dev/null 2>&1 || true
  docker exec "$PG_CONTAINER" psql -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS \"$1\"" >/dev/null 2>&1 || true
}

# ---- 阶段 A：干净安装源库（0001–0021 + seed）+ 期初样本落账 ----
T0=$(ms)
log "A 干净安装源库 ${SRC_DB}（迁移到 0021 + seed，install.sh 承载）"
drop_temp "$SRC_DB"
node "$REPO_ROOT/scripts/delivery/backup/pg-ops.mjs" recreate --admin-url "$ADMIN_URL" --database "$SRC_DB" --target-confirm "$SRC_DB"
"$REPO_ROOT/deploy/install/install.sh" --database-url "$SRC_URL" --skip-selfcheck --repo-root "$REPO_ROOT" \
  | tee "$EVIDENCE/a-clean-install.log"
node "$REPO_ROOT/scripts/delivery/backup/pg-ops.mjs" applied --database-url "$SRC_URL" > "$EVIDENCE/a-applied-migrations.txt"
log "A 期初样本落账（drill-fixtures + r2r3-fixtures：库存事实链/接口账/报工/投料/在制）"
docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$SRC_DB" < "$REPO_ROOT/deploy/drill/drill-fixtures.sql" > "$EVIDENCE/a-fixtures-base.log"
docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$SRC_DB" < "$REPO_ROOT/scripts/delivery/reconcile/r2r3-fixtures.sql" > "$EVIDENCE/a-fixtures-r2r3.log"

# ---- 阶段 B：报表投影重建（产品命令面：注册定义 + 两类 rebuild） ----
log "B 启动 api（${API_PORT}）并经命令面重建投影"
DATABASE_URL="$SRC_URL" PORT=$API_PORT node "$REPO_ROOT/apps/api/dist/main.js" > "$EVIDENCE/b-api-src.log" 2>&1 &
API_PID=$!
cleanup_api() { kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; }
trap cleanup_api EXIT
HEALTH_OK=no
for i in $(seq 1 40); do
  sleep 1
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && { HEALTH_OK=yes; break; }
done
[[ "$HEALTH_OK" == yes ]] || { cat "$EVIDENCE/b-api-src.log"; die "api 未就绪（源库）"; }
node "$REPO_ROOT/scripts/delivery/reconcile/reporting-rebuild.mjs" \
  --api-url "http://127.0.0.1:$API_PORT" --database-url "$SRC_URL" --plant-code PLNT-SZ \
  | tee "$EVIDENCE/b-reporting-rebuild.log"
cleanup_api; trap - EXIT
docker exec "$PG_CONTAINER" psql -U postgres -d "$SRC_DB" -Atc \
  "SELECT 'shift_snapshot='||count(*) FROM shift_snapshot UNION ALL SELECT 'stock_stat_projection='||count(*) FROM stock_stat_projection UNION ALL SELECT 'metric_definition_revision='||count(*) FROM metric_definition_revision" \
  > "$EVIDENCE/b-projection-counts.txt"
cat "$EVIDENCE/b-projection-counts.txt"

# ---- 阶段 C：备份（既有 backup.sh） ----
log "C 备份源库（pg_dump + 对象存储 + 脱敏配置）"
OBJ_ROOT="$EVIDENCE/object-store-src"
mkdir -p "$OBJ_ROOT/labels"
printf 'R2R3 演练附件样例 %s\n' "$STAMP" > "$OBJ_ROOT/labels/label-001.txt"
"$REPO_ROOT/deploy/backup/backup.sh" --database-url "$SRC_URL" \
  --object-store-root "$OBJ_ROOT" --env-file "$REPO_ROOT/.env.example" \
  --out "$EVIDENCE/backups" --repo-root "$REPO_ROOT" | tee "$EVIDENCE/c-backup.log"
BACKUP_DIR="$(ls -dt "$EVIDENCE"/backups/*/ | head -1)"
[[ -f "$BACKUP_DIR/BACKUP-MANIFEST.json" ]] || die "备份清单未生成"

# ---- 阶段 D：破坏性变更（DROP 源库，模拟介质丢失） ----
T_RESTORE_START=$(ms)
log "D 破坏性变更：DROP 源库 ${SRC_DB}（演练源数据就此丢失，只能靠备份恢复）"
drop_temp "$SRC_DB"

# ---- 阶段 E：干净安装目标库 + 恢复（既有 restore.sh） ----
log "E 隔离环境干净安装目标版本（${RESTORE_DB}）后按手册恢复"
node "$REPO_ROOT/scripts/delivery/backup/pg-ops.mjs" recreate --admin-url "$ADMIN_URL" \
  --database "$RESTORE_DB" --target-confirm "$RESTORE_DB"
"$REPO_ROOT/deploy/install/install.sh" --database-url "$RESTORE_URL" --skip-selfcheck --repo-root "$REPO_ROOT" \
  | tee "$EVIDENCE/e-clean-install.log"
"$REPO_ROOT/deploy/backup/restore.sh" --backup-dir "$BACKUP_DIR" --database-url "$RESTORE_URL" \
  --target-confirm "$RESTORE_DB" --object-store-root "$EVIDENCE/object-store-restored" \
  --repo-root "$REPO_ROOT" | tee "$EVIDENCE/e-restore.log"

# ---- 阶段 F：恢复读回与发行锚一致（R3） ----
log "F 恢复读回与发行锚一致：环境规格校验 + 迁移集合比对"
node "$REPO_ROOT/scripts/delivery/install/verify-anchor.mjs" --anchor "$ANCHOR" --database-url "$RESTORE_URL" \
  | tee "$EVIDENCE/f-verify-anchor.log"
node - "$ANCHOR" "$RESTORE_URL" "$REPO_ROOT" > "$EVIDENCE/f-anchor-migration-compare.txt" <<'NODE'
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const [anchorPath, dbUrl, repoRoot] = process.argv.slice(2)
const anchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'))
const expected = [...anchor.migration_versions].sort().join(',')
const applied = execFileSync('node', [`${repoRoot}/scripts/delivery/backup/pg-ops.mjs`, 'applied', '--database-url', dbUrl], { encoding: 'utf8' }).trim()
const digest = anchor.app_deliverable?.aggregate_digest ?? '(missing)'
console.log(`发行锚迁移集合：${expected}`)
console.log(`恢复库已应用　：${applied}`)
console.log(`应用交付物 digest：${digest.slice(0, 24)}…（清单 deploy/release/APP-DELIVERABLE-DIGEST.json）`)
if (applied !== expected) { console.error('迁移集合与发行锚不一致'); process.exit(1) }
console.log('迁移集合与发行锚一致（R3 恢复读回通过）')
NODE

# ---- 阶段 G：三分对账（R2 新能力，期望 PASS） ----
log "G 三分对账 #1（恢复后，期望三分 PASS）"
set +e
node "$REPO_ROOT/scripts/delivery/reconcile-three-way.mjs" --database-url "$RESTORE_URL" \
  --out "$EVIDENCE/three-way-1" > "$EVIDENCE/g-three-way-1.log" 2>&1
G1_EXIT=$?
set -e
tail -12 "$EVIDENCE/g-three-way-1.log"
[[ "$G1_EXIT" -eq 0 ]] || { cat "$EVIDENCE/g-three-way-1.log"; die "恢复后三分对账未通过（exit=${G1_EXIT}，应在偏差注入前 PASS）"; }
log "G 三分对账 #1 PASS"

# ---- 阶段 H：注入投影偏差（期望被检出 FAIL） ----
log "H 注入三处投影偏差（库存统计数量 / 快照分子 / 快照值）"
docker exec "$PG_CONTAINER" psql -U postgres -d "$RESTORE_DB" -v ON_ERROR_STOP=1 -c \
  "UPDATE stock_stat_projection SET quantity = quantity + 25 WHERE unit_no='UNIT-DRILL-P0001'" \
  > "$EVIDENCE/h-drift-inject.log"
docker exec "$PG_CONTAINER" psql -U postgres -d "$RESTORE_DB" -v ON_ERROR_STOP=1 -c \
  "UPDATE shift_snapshot SET numerator_value = numerator_value + 10 WHERE metric_key='yield.qualified-rate'" \
  >> "$EVIDENCE/h-drift-inject.log"
docker exec "$PG_CONTAINER" psql -U postgres -d "$RESTORE_DB" -v ON_ERROR_STOP=1 -c \
  "UPDATE shift_snapshot SET value = value + 7 WHERE metric_key='wip.quantity'" \
  >> "$EVIDENCE/h-drift-inject.log"
cat "$EVIDENCE/h-drift-inject.log"
set +e
node "$REPO_ROOT/scripts/delivery/reconcile-three-way.mjs" --database-url "$RESTORE_URL" \
  --out "$EVIDENCE/three-way-2" > "$EVIDENCE/h-three-way-2.log" 2>&1
H_EXIT=$?
set -e
tail -12 "$EVIDENCE/h-three-way-2.log"
[[ "$H_EXIT" -ne 0 ]] || die "偏差未被检出（应 FAIL 退出非零）"
grep -q "投影：FAIL" "$EVIDENCE/three-way-2"/three-way-summary-*.md || die "③投影未按 FAIL 汇总"
grep -q "数值差异" "$EVIDENCE/three-way-2"/03-投影-*.md || die "③明细未具名列出数值差异"
log "H 偏差被检出：③投影 FAIL（exit=${H_EXIT}），差异具名列出"

# ---- 阶段 I：rebuild（产品命令面）后复对账（期望 PASS） ----
log "I 启动 api（恢复库）经命令面 rebuild 后复对账"
DATABASE_URL="$RESTORE_URL" PORT=$API_PORT node "$REPO_ROOT/apps/api/dist/main.js" > "$EVIDENCE/i-api-restore.log" 2>&1 &
API_PID=$!
trap cleanup_api EXIT
HEALTH_OK=no
for i in $(seq 1 40); do
  sleep 1
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && { HEALTH_OK=yes; break; }
done
[[ "$HEALTH_OK" == yes ]] || { cat "$EVIDENCE/i-api-restore.log"; die "api 未就绪（恢复库）"; }
node "$REPO_ROOT/scripts/delivery/reconcile/reporting-rebuild.mjs" \
  --api-url "http://127.0.0.1:$API_PORT" --database-url "$RESTORE_URL" --plant-code PLNT-SZ \
  --commands stock-stat,shift-snapshot | tee "$EVIDENCE/i-reporting-rebuild.log"
cleanup_api; trap - EXIT
set +e
node "$REPO_ROOT/scripts/delivery/reconcile-three-way.mjs" --database-url "$RESTORE_URL" \
  --out "$EVIDENCE/three-way-3" > "$EVIDENCE/i-three-way-3.log" 2>&1
I_EXIT=$?
set -e
tail -12 "$EVIDENCE/i-three-way-3.log"
[[ "$I_EXIT" -eq 0 ]] || { cat "$EVIDENCE/i-three-way-3.log"; die "rebuild 后复对账未通过（exit=${I_EXIT}）"; }
log "I rebuild 后复对账 PASS"

# ---- 阶段 J：演练记录归档 ----
T_END=$(ms)
log "J 归档演练记录"
node - "$EVIDENCE" "$STAMP" "$BACKUP_DIR" "$T0" "$T_RESTORE_START" "$T_END" "$SRC_DB" "$RESTORE_DB" "$G1_EXIT" "$H_EXIT" "$I_EXIT" "$REPO_ROOT" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [ev, stamp, backupDir, t0, tRestore, tEnd, srcDb, restoreDb, g1, h, i, repoRoot] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'BACKUP-MANIFEST.json'), 'utf8'))
const anchor = JSON.parse(fs.readFileSync(path.join(repoRoot, 'deploy/release/RELEASE-ANCHOR.json'), 'utf8'))
const tw = (dir) => fs.readdirSync(path.join(ev, dir)).map((f) => `${dir}/${f}`)
const record = {
  drill_id: `r2r3-${stamp}`,
  recorded_at: new Date().toISOString(),
  rule_refs: ['PM-FINAL-RECEPTION R2/R3', 'DO-15', 'DO-16', 'DO-18', 'DO-19', 'A11', 'RP-01~RP-22', '§3.1'],
  environment: `隔离演练（dev 容器 cadenza-dev-pg；源库 ${srcDb} / 恢复库 ${restoreDb}，均为 cadenza_dops_* 临时库，未触碰 cadenza 主库）`,
  anchor: {
    release_id: anchor.release_id,
    migration_versions: anchor.migration_versions,
    migration_groups: anchor.migration_groups,
    app_deliverable_aggregate_digest: anchor.app_deliverable.aggregate_digest,
  },
  media: manifest.media,
  version_fingerprint: { schema_migrations: manifest.schema_migrations, sha256sums: '备份目录 SHA256SUMS' },
  steps: [
    'A 干净安装源库（install.sh：迁移 0001–0021 + seed）+ 期初样本落账（drill+r2r3 fixtures）',
    'B 报表投影重建（产品命令面：metric-definition.register + stock-stat.rebuild + shift-snapshot.rebuild）',
    'C 备份（backup.sh：pg_dump + 对象存储 + 脱敏配置）',
    'D 破坏性变更（DROP 源库）',
    'E 干净安装目标库 + 恢复（restore.sh：库→对象存储→配置，迁移一致性通过）',
    'F 恢复读回与发行锚一致（verify-anchor + 迁移集合比对）',
    `G 三分对账 #1 PASS（exit=${g1}；业务账/接口账/投影三分真实结果）`,
    `H 注入 3 处投影偏差 → 三分对账 #2 检出 FAIL（exit=${h}；③差异具名、汇总阻断）`,
    `I rebuild（产品命令面）→ 三分对账 #3 PASS（exit=${i}）`,
    'J 本记录归档',
  ],
  duration_ms: { total: Number(tEnd) - Number(t0), backup_to_reconcile_pass: Number(tEnd) - Number(tRestore) },
  three_way_outputs: [...tw('three-way-1'), ...tw('three-way-2'), ...tw('three-way-3')],
  drift_injected: [
    "stock_stat_projection.quantity +25（unit_no=UNIT-DRILL-P0001，采购收货码键）",
    "shift_snapshot.numerator_value +10（metric_key=yield.qualified-rate）",
    "shift_snapshot.value +7（metric_key=wip.quantity）",
  ],
  result: 'PASS',
}
fs.writeFileSync(path.join(ev, 'DRILL-RECORD.json'), JSON.stringify(record, null, 2) + '\n')
console.log(`演练记录：${path.join(ev, 'DRILL-RECORD.json')}`)
NODE

drop_temp "$SRC_DB"; drop_temp "$RESTORE_DB"
log "R2R3 合并演练完成：证据目录 ${EVIDENCE}；临时库已清理；cadenza 主库与既有卷未触碰。"
