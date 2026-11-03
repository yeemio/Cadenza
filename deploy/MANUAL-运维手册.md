# Cadenza 运维手册（T25 / DO-24 第二类：安装/备份/监控/恢复/升级）

版本：2026-10-28｜本册为总纲，操作细节在各分册（互链不重复）。

## 1. 职责与边界

- 运维负责人：发行、安装、备份、监控、恢复、升级的执行与记录；**管理权限不等于任意删除已入账业务事实**。
- 值班岗位收到技术告警必须能看到**关联单据与恢复入口**（DO-21），不是裸日志。

## 2. 部署形态（DO-06）

- 正式形态：客户私有网络 `web/pda + api + worker + PostgreSQL + 对象存储`；数据库主备＋独立备份介质。
- 试点形态：可用单机容器；应用与数据库**独立备份**；单机试点不宣称高可用。
- 本仓库开发形态：docker-compose 单容器 PostgreSQL 17（cadenza-dev-pg@55433）+ Node 进程——正式部署按本册在现场资源上执行同一组脚本（install/backup/restore/upgrade 均参数化 DATABASE_URL）。

## 3. 安装与升级

- 干净安装（非开发者步骤）：`deploy/install/MANUAL-安装手册.md`（DO-02/04/05：版本锚/干净检查/重启自检）。
- 升级（先备份后升级、路径受控、失败续跑、不可跳转路径与数据后果）：`deploy/upgrade/MANUAL-升级手册.md`（DO-20）。

## 4. 备份与恢复（含 §3.1 七步演练）

- 备份对象与独立性、恢复目标 RPO≤15min/RTO≤2h（未实测不填通过）、恢复步骤、差异处置：`deploy/backup/MANUAL-备份恢复手册.md`（DO-15～19）。
- 演练频次：**至少每发行版本一次**；一键编排 `deploy/drill/backup-restore-drill.sh`（隔离环境，七步全留档：介质指纹/版本一致性/自检/三分对账三份输出/RTO 实测/差异清单）。
- 恢复后对外业务恢复条件：三分对账各自核对通过并留输出（DO-18），差异按 DO-19 保留并获准补录。

## 5. 监控（DO-21）

九项最低监项与接入方式见 `deploy/monitoring/MONITORING-CHECKLIST.md`；备份失败（backup-status.json result=failed）必告警。

## 6. 期初与增量导入（T25）

- 工具：`scripts/delivery/import/import-validate.mjs`（模板下载/列级校验/名称匹配/拒绝清单/分层门禁/冻结点/幂等重导）＋ `reconcile-inventory.mjs`（四维差异对账）。
- 纪律：分层导入逐层核对（DO-10）；期初库存须冻结点（DO-11）；坏行不静默修补、历史空值不默认有利语义（DO-08/09）。

## 7. 试点与切换值班（T27）

`deploy/pilot/PILOT-GUIDE.md`：试点记录不可删（哈希链账本）、五元组保留分母、双轨非双主账、退出标准五条、SITE_PENDING 边界。

## 8. 记录归档

| 记录 | 位置 | 合同 |
| --- | --- | --- |
| 发行清单（九项+四件指纹） | RELEASE-MANIFEST.json（release-manifest.mjs 生成） | DO-01/03/S1 |
| 备份清单/状态 | 各备份目录 BACKUP-MANIFEST.json、backups/backup-status.json | DO-15 |
| 恢复演练记录 | 演练证据目录 DRILL-RECORD.json | DO-16/S4 |
| 导入运行/拒绝清单 | 目标库 delivery_import_run/row + 工作区账本 | DO-08/S2 |
| 试点记录/退出标准 | deploy/pilot/records/（账本+报告） | DO-27/29/S5 |
| T28 检查单 | deploy/multi-plant/evidence/ | §6/MP-20 |
