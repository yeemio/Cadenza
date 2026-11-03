# Cadenza 备份与恢复手册（含 §3.1 七步演练）

适用：T26（DO-15～DO-19，冻结合同 frozen/p3/delivery-ops.md §3 与 §3.1）｜随运维手册执行

## 1. 备份对象与独立性（DO-15）

| 对象 | 内容 | 件 | 独立性 |
| --- | --- | --- | --- |
| 业务数据库 | pg_dump `-Fc` | `database.dump` | 独立可恢复（pg_restore） |
| 对象存储 | 附件/标签根目录 tar | `object-store.tar.gz` | 独立可解包；缺席时恢复不覆盖附件根（有 readme 说明） |
| 配置与密钥清单 | 环境文件**脱敏**副本 | `config.redacted.env` | 凭据不含明文密码（DO-15）；真实密钥按 CONFIG-CHECKLIST 第 3 节保管，恢复时注入 |

备份执行结果写 `backups/backup-status.json`（`result=failed` 即告警触发条件，DO-21 监控最低清单第 9 项）。

```bash
./deploy/backup/backup.sh --database-url URL \
  [--object-store-root 附件根目录] [--env-file .env] [--out 备份根目录]
```

备份频率与保留：现场按 RPO≤15min 目标定（连续归档/WAL 或提频定时任务）；本仓库形态至少每次变更窗口前一次。

## 2. 恢复目标（DO-17，规划值）

- **RPO ≤ 15 分钟、RTO ≤ 2 小时**为规划值（现场 SLA 可更严）；**目标未实测不填"通过"**——实测环境与分母随演练记录登记（§4 第 7 步）。
- 恢复不是"数据库能启动"就结束：三分对账通过并留输出，才可恢复对外业务（发货/回传，DO-18）。

## 3. 恢复步骤（DO-18/19；完整演练编排见 §4）

```bash
# 恢复会 DROP+CREATE 目标库：--target-confirm 必须逐字输入目标库名；
# dev 主库 cadenza 与并行线测试库受保护，脚本直接拒绝。
./deploy/backup/restore.sh --backup-dir backups/<时间戳> \
  --database-url postgres://…/目标库 --target-confirm 目标库名 \
  [--object-store-root 附件根目录]
```

顺序固定：数据库 → 对象存储 → 配置（§3.1 第 3 步）；恢复后自动校验迁移版本=备份指纹。

**恢复后差异处置（DO-19）**：恢复点之后已发生的现场作业与外部单据差异**保留并获准补录**（差异清单＋批准记录）；不得用旧库存余额直接恢复发运。

## 4. 备份恢复演练七步（§3.1，合同附件级；编排脚本 `deploy/drill/backup-restore-drill.sh`）

| 步 | 内容 | 脚本承载 |
| --- | --- | --- |
| 1 | 取最近一次成功备份，记录介质与版本指纹 | backup.sh → BACKUP-MANIFEST.json（含 SHA256SUMS） |
| 2 | 隔离环境按 DO-02 干净安装目标版本，停应用写入 | install.sh --skip-selfcheck（隔离库）；演练源库同样干净安装+种子+模拟业务数据 |
| 3 | 按手册恢复 数据库→对象存储→配置 | restore.sh |
| 4 | 迁移一致性检查（=备份版本或按 DO-20 升级路径） | restore.sh 第 5 步 + upgrade-compat-check.mjs（重入验证） |
| 5 | 启动应用与 worker，跑安装后重启自检（DO-04） | api/worker 启动 + selfcheck（含 /health） |
| 6 | 三分对账（DO-18）：①业务账 ②接口账 ③投影 | scripts/delivery/reconcile-three-way.mjs（三份具名输出） |
| 7 | 记录 RTO 实测与差异清单（DO-19），演练记录归档（DO-16） | drill 记录 JSON（DO-S4：介质/版本/耗时/对账输出引用） |

频次：**至少每发行版本一次**（DO-16）；"备份成功"不等于可恢复。

演练纪律（本仓库）：只动 `cadenza_dops_*` 临时库与临时目录，**绝不碰 cadenza 主库与既有卷**；演练库用后即删。

```bash
./deploy/drill/backup-restore-drill.sh            # 一键七步（隔离环境实测）
```

## 5. 监控接入（DO-21）

备份失败必告警：`backup-status.json` 的 `result=failed` 为触发条件；告警须附恢复入口（本手册 §3）与关联介质（备份目录）。完整最低监项见 `deploy/monitoring/MONITORING-CHECKLIST.md`。
