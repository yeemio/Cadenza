#!/usr/bin/env bash
# Cadenza 备份恢复七步演练（T26，§3.1 合同附件级）——隔离环境实测编排。
#
# 纪律（P3-E 特别事项 3）：只动 cadenza_dops_* 临时库与临时目录，绝不碰 cadenza 主库与既有卷；
# 宿主无 psql/pg_dump，全部经 cadenza-dev-pg 容器执行；演练库用后即删，证据全部落 --evidence 目录。
#
# 七步：
#  1 取最近一次成功备份（演练=对演练源库先做真实备份；记录介质与版本指纹）
#  2 隔离环境干净安装目标版本（install.sh，DO-02）并停应用写入
#  3 按手册恢复 数据库→对象存储→配置（restore.sh）
#  4 迁移一致性检查（=备份版本）+ 升级兼容重入验证（DO-20）
#  5 启动应用与 worker，跑安装后重启自检（DO-04，含 /health）
#  6 三分对账（DO-18）：业务账/接口账/投影 三份具名输出
#  7 记录 RTO 实测与差异清单（DO-19），演练记录归档（DO-16/S4）
#
# 用法：./backup-restore-drill.sh [--repo-root DIR] [--evidence DIR] [--keep-dbs]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE=""
KEEP_DBS=no
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root) REPO_ROOT="${2:?}"; shift 2 ;;
    --evidence) EVIDENCE="${2:?}"; shift 2 ;;
    --keep-dbs) KEEP_DBS=yes; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "[失败] 未知参数 $1"; exit 2 ;;
  esac
done

STAMP="$(date '+%Y%m%d-%H%M%S')"
EVIDENCE="${EVIDENCE:-$REPO_ROOT/delivery/P3/delivery-ops/evidence/drill/$STAMP}"
SRC_DB="cadenza_dops_src"; RESTORE_DB="cadenza_dops_restore"
BASE_URL="postgres://postgres:cadenza_dev@127.0.0.1:55433"
SRC_URL="$BASE_URL/$SRC_DB"; RESTORE_URL="$BASE_URL/$RESTORE_DB"
ADMIN_URL="$BASE_URL/postgres"
PG_CONTAINER="cadenza-dev-pg"
API_PORT=3907

log() { printf '[drill %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf '[drill 失败] %s\n' "$*"; exit 1; }
ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

mkdir -p "$EVIDENCE"
STEP_LOG="$EVIDENCE/drill-steps.log"
exec > >(tee -a "$STEP_LOG") 2>&1

# ---- 预检：容器健康 + 临时库名护栏 + 端口 ----
log "预检：dev 容器健康与临时库护栏"
docker compose -f "$REPO_ROOT/docker-compose.yml" ps | grep -q healthy || die "cadenza-dev-pg 未运行（先 docker compose up -d）"
[[ "$SRC_DB" =~ ^cadenza_dops_[a-z0-9_]+$ && "$RESTORE_DB" =~ ^cadenza_dops_[a-z0-9_]+$ ]] || die "临时库名护栏不通过"
[[ "$SRC_DB" != "cadenza" && "$RESTORE_DB" != "cadenza" ]] || die "护栏：不得等于主库名"
lsof -nP -iTCP:$API_PORT -sTCP:LISTEN >/dev/null 2>&1 && die "端口 $API_PORT 已被占用"
node "$REPO_ROOT/scripts/delivery/backup/pg-ops.mjs" exists --admin-url "$ADMIN_URL" --database cadenza | grep -q yes \
  || die "护栏自检异常：cadenza 主库不可见于本容器（不应发生）"

drop_temp() {
  [[ "$KEEP_DBS" == yes ]] && { log "保留临时库（--keep-dbs）"; return; }
  case "$1" in cadenza_dops_src|cadenza_dops_restore) ;; *) die "清理护栏：非演练临时库名 $1" ;; esac
  docker exec "$PG_CONTAINER" psql -U postgres -d postgres -q -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$1' AND pid<>pg_backend_pid()" >/dev/null 2>&1 || true
  docker exec "$PG_CONTAINER" psql -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS \"$1\"" >/dev/null 2>&1 || true
}
# 演练源库：干净安装目标版本 + 种子 + 业务夹具（模拟一套在运系统）
log "准备演练源库 ${SRC_DB}（干净安装+种子+夹具）"
drop_temp "$SRC_DB"
node "$REPO_ROOT/scripts/delivery/backup/pg-ops.mjs" recreate --admin-url "$ADMIN_URL" --database "$SRC_DB" --target-confirm "$SRC_DB"
DATABASE_URL="$SRC_URL" node "$REPO_ROOT/packages/persistence/dist/cli.js" up
DATABASE_URL="$SRC_URL" node "$REPO_ROOT/packages/persistence/dist/cli.js" seed
docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$SRC_DB" < "$REPO_ROOT/deploy/drill/drill-fixtures.sql"

# 演练对象存储（附件层）：临时目录 + 样例文件
OBJ_ROOT="$EVIDENCE/object-store-src"
mkdir -p "$OBJ_ROOT/labels"
printf '演练附件-标签样例 %s\n' "$STAMP" > "$OBJ_ROOT/labels/label-001.txt"
printf '演练附件-装箱图样例 %s\n' "$STAMP" > "$OBJ_ROOT/labels/packing-001.txt"

RPO_NOTE="演练源库在备份后冻结（无新写入），实测 RPO≈0（口径：备份时间锚=最后业务写入时间）"

# ---- §3.1 第 1 步：取最近一次成功备份（介质+版本指纹） ----
T_BACKUP_START=$(ms)
log "§3.1-1 备份演练源库（backup.sh，真实 pg_dump）"
"$REPO_ROOT/deploy/backup/backup.sh" --database-url "$SRC_URL" \
  --object-store-root "$OBJ_ROOT" --env-file "$REPO_ROOT/.env.example" \
  --out "$EVIDENCE/backups" --repo-root "$REPO_ROOT" | tee "$EVIDENCE/step1-backup.log"
BACKUP_DIR="$(ls -dt "$EVIDENCE"/backups/*/ | head -1)"
[[ -f "$BACKUP_DIR/BACKUP-MANIFEST.json" ]] || die "备份清单未生成"
# 恢复截止点接口账快照（worker 认领前）
docker exec "$PG_CONTAINER" psql -U postgres -d "$SRC_DB" -Atc \
  "SELECT status||'='||count(*) FROM outbox GROUP BY status ORDER BY status" > "$EVIDENCE/step1-outbox-source-snapshot.txt"

# ---- §3.1 第 2 步：隔离环境干净安装目标版本，停应用写入 ----
T_RESTORE_START=$(ms)
log "§3.1-2 隔离环境干净安装目标版本（install.sh → ${RESTORE_DB}；安装后应用保持停止）"
node "$REPO_ROOT/scripts/delivery/backup/pg-ops.mjs" recreate --admin-url "$ADMIN_URL" \
  --database "$RESTORE_DB" --target-confirm "$RESTORE_DB"
"$REPO_ROOT/deploy/install/install.sh" --database-url "$RESTORE_URL" --skip-selfcheck --repo-root "$REPO_ROOT" \
  | tee "$EVIDENCE/step2-clean-install.log"

# ---- §3.1 第 3 步：恢复 数据库→对象存储→配置 ----
log "§3.1-3 恢复（restore.sh：库→对象存储→配置）"
"$REPO_ROOT/deploy/backup/restore.sh" --backup-dir "$BACKUP_DIR" --database-url "$RESTORE_URL" \
  --target-confirm "$RESTORE_DB" --object-store-root "$EVIDENCE/object-store-restored" \
  --repo-root "$REPO_ROOT" | tee "$EVIDENCE/step3-restore.log"
docker exec "$PG_CONTAINER" psql -U postgres -d "$RESTORE_DB" -Atc \
  "SELECT status||'='||count(*) FROM outbox GROUP BY status ORDER BY status" > "$EVIDENCE/step3-outbox-restored-snapshot.txt"

# ---- §3.1 第 4 步：迁移一致性检查 + 升级兼容（含重入验证） ----
log "§3.1-4 迁移一致性 + 升级兼容重入验证（DO-20）"
node "$REPO_ROOT/scripts/delivery/upgrade-compat-check.mjs" --database-url "$RESTORE_URL" \
  --repo-root "$REPO_ROOT" | tee "$EVIDENCE/step4-compat-check.log"
# 不可跳转路径反例：显式降级目标必须被拒
set +e
node "$REPO_ROOT/scripts/delivery/upgrade-compat-check.mjs" --database-url "$RESTORE_URL" \
  --repo-root "$REPO_ROOT" --to 0005 --no-reentrancy > "$EVIDENCE/step4-downgrade-refusal.log" 2>&1
DOWNGRADE_EXIT=$?
set -e
[[ "$DOWNGRADE_EXIT" -ne 0 ]] || die "降级拒绝反例未生效（应退出非零）"
grep -q "DO-20-不可跳转" "$EVIDENCE/step4-downgrade-refusal.log" || die "降级反例缺少规则码输出"

# ---- §3.1 第 5 步：启动应用与 worker + 安装后重启自检（DO-04） ----
log "§3.1-5 启动 api(worker) 与 worker，重启自检"
DATABASE_URL="$RESTORE_URL" PORT=$API_PORT node "$REPO_ROOT/apps/api/dist/main.js" > "$EVIDENCE/step5-api.log" 2>&1 &
API_PID=$!
DATABASE_URL="$RESTORE_URL" WORKER_INTERVAL_MS=1000 node "$REPO_ROOT/apps/worker/dist/main.js" > "$EVIDENCE/step5-worker.log" 2>&1 &
WORKER_PID=$!
cleanup_procs() { kill "$API_PID" "$WORKER_PID" 2>/dev/null || true; wait "$API_PID" "$WORKER_PID" 2>/dev/null || true; }
trap cleanup_procs EXIT
HEALTH_OK=no
for i in $(seq 1 40); do
  sleep 1
  if curl -sf "http://127.0.0.1:$API_PORT/health" > "$EVIDENCE/step5-health.json" 2>/dev/null; then HEALTH_OK=yes; break; fi
done
[[ "$HEALTH_OK" == yes ]] || { cat "$EVIDENCE/step5-api.log"; die "api 健康端点未就绪"; }
sleep 3   # 让 worker 完成至少一轮认领
node "$REPO_ROOT/scripts/delivery/install/selfcheck.mjs" --database-url "$RESTORE_URL" \
  --api-url "http://127.0.0.1:$API_PORT/health" | tee "$EVIDENCE/step5-selfcheck.log"
T_SERVICE_RESTORED=$(ms)
docker exec "$PG_CONTAINER" psql -U postgres -d "$RESTORE_DB" -Atc \
  "SELECT status||'='||count(*) FROM outbox GROUP BY status ORDER BY status" > "$EVIDENCE/step5-outbox-after-worker.txt"
cleanup_procs; trap - EXIT

# ---- §3.1 第 6 步：三分对账（DO-18） ----
log "§3.1-6 三分对账（业务账/接口账/投影）"
node "$REPO_ROOT/scripts/delivery/reconcile-three-way.mjs" --database-url "$RESTORE_URL" \
  --out "$EVIDENCE/three-way" | tee "$EVIDENCE/step6-three-way.log"

# ---- §3.1 第 7 步：RTO 实测 + 差异清单 + 演练记录归档（DO-16/S4） ----
log "§3.1-7 RTO 记录与归档"
RTO_MS=$((T_SERVICE_RESTORED - T_RESTORE_START))
BACKUP_MS=$(($(ms) - T_BACKUP_START))
node - "$EVIDENCE" "$STAMP" "$BACKUP_DIR" "$RTO_MS" "$BACKUP_MS" "$RPO_NOTE" "$SRC_DB" "$RESTORE_DB" <<'NODE'
const [ev, stamp, backupDir, rtoMs, backupMs, rpoNote, srcDb, restoreDb] = process.argv.slice(2)
const fs = require('node:fs')
const path = require('node:path')
const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'BACKUP-MANIFEST.json'), 'utf8'))
const record = {
  drill_id: `drill-${stamp}`,
  recorded_at: new Date().toISOString(),
  rule_refs: ['DO-16', 'DO-17', 'DO-18', 'DO-19', 'DO-S4', '§3.1'],
  environment: `隔离演练（dev 容器 cadenza-dev-pg；源库 ${srcDb} / 恢复库 ${restoreDb}，均为 cadenza_dops_* 临时库，未触碰 cadenza 主库与既有卷）`,
  media: manifest.media,
  version_fingerprint: { schema_migrations: manifest.schema_migrations, sha256sums: '备份目录 SHA256SUMS' },
  steps: ['1 备份(真实 pg_dump)', '2 干净安装目标版本(install.sh)', '3 恢复 库→对象存储→配置(restore.sh)',
          '4 迁移一致性+升级兼容重入+降级拒绝反例', '5 api/worker 启动+重启自检(/health 200)', '6 三分对账三份输出', '7 本记录归档'],
  duration: { backup_ms: Number(backupMs), rto_ms: Number(rtoMs), rto_note: 'RTO=恢复开始(§3.1-2)→健康端点通过(§3.1-5)' },
  rpo: { observed: '≈0', note: rpoNote },
  differences_after_restore_point: '无（演练源库备份后冻结，无恢复点后现场作业；现场演练按 DO-19 保留差异清单＋批准记录）',
  three_way_outputs: fs.readdirSync(path.join(ev, 'three-way')).map((f) => `three-way/${f}`),
  outbox_recovery: {
    source: fs.readFileSync(path.join(ev, 'step1-outbox-source-snapshot.txt'), 'utf8').trim().split('\n'),
    restored: fs.readFileSync(path.join(ev, 'step3-outbox-restored-snapshot.txt'), 'utf8').trim().split('\n'),
    after_worker: fs.readFileSync(path.join(ev, 'step5-outbox-after-worker.txt'), 'utf8').trim().split('\n'),
  },
  result: 'PASS',
}
fs.writeFileSync(path.join(ev, 'DRILL-RECORD.json'), JSON.stringify(record, null, 2) + '\n')
console.log(`演练记录：${path.join(ev, 'DRILL-RECORD.json')}（RTO=${rtoMs}ms 备份=${backupMs}ms）`)
NODE

# 清理：演练库用后即删（证据保留）
drop_temp "$SRC_DB"; drop_temp "$RESTORE_DB"
log "七步演练完成：证据目录 ${EVIDENCE}；临时库已清理；cadenza 主库与既有卷未触碰。"
