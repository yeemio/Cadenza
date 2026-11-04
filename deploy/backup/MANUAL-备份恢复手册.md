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
| 4 | 迁移一致性检查（=备份版本或按 DO-20 升级路径） | restore.sh 第 5 步 + upgrade-compat-check.mjs（只读路径检查；重入另在获准克隆库验证） |
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


## PR12：实例绑定和配置导出边界

备份/恢复现在要求同一执行环境中的 `psql`、`pg_dump`、`pg_restore` 原生客户端。只有显式 `DATABASE_URL` 定位；旧 `PG_CONTAINER` 环境变量或 `--pg-container` 参数在 dump/重建前拒绝。需要容器运行时，应在该运行环境内执行整个脚本并提供可达的唯一 URL；不得再把容器内同名库与宿主 URL 混用。客户端缺失或无法读取 `pg_control_system()` 实例标识时只阻塞该操作，不自动授予额外权限。

Node 驱动与原生 psql 在操作前核对 system_identifier、实例启动时间、当前库名和数据库 OID。dump 和迁移指纹共享只读重复读事务导出的 snapshot；恢复在介质校验和原生 pg_restore 列表预检后，使用同一规范目标连接重建并导入。主库和并行测试库仍被拒绝，目标必须是 cadenza_dops_* 且 --target-confirm 与目标库名完全一致。身份错误、旧格式清单或未校验介质不会触发重建。

format=2 清单不保存连接 URL/用户名/密码；配置使用小型非秘密值白名单（NODE_ENV、LOG_LEVEL、合法端口、WORKER_ENABLED），其余变量只输出待从获准配置/密钥存储恢复的标记。TOKEN、PASSWORD、SECRET、KEY 及多行/注释值均不原样导出，错误日志不保存数据库驱动/原生工具原始 stderr。对象根若包含本次环境文件、.env 文件、符号链接或特殊文件则拒绝；对象归档与数据库 snapshot 是分开的捕获，不宣称跨资源原子一致。

含对象归档的恢复必须显式给出 --object-store-root。恢复配置仅生成参考文件，不执行或自动注入密钥。介质 SHA256 是完整性校验，不是独立真实性认证；仅恢复获准可信介质。完成迁移指纹校验也不等于三分对账、现场恢复/RPO/RTO 已通过。

升级兼容预检永远只读。旧 hash/0031 的真实历史样本证据 E02 仍未取得，禁止将新建夹具的通过当成旧库已验证。

## PR12 R1：原生客户端与目标版本预检

本自动重建恢复入口支持 PostgreSQL 10 及以上稳定发行版的同主版本组合：归档中记录的源服务器主版本、生成归档的 pg_dump 主版本、执行恢复的 pg_restore 主版本、目标服务器主版本必须一致。小版本可以不同。例如本次 PG16.15 源/目标应使用 pg_dump16.x 生成归档并由 pg_restore16.x 恢复；在同一执行环境中配置该套客户端，保留原有唯一 DATABASE_URL、目标库确认与 Node/psql 实例核对。

`pg_restore --list` 成功仅表示归档可读取。恢复现在从其原生归档头读取源库/pg_dump 版本，另读取实际 pg_restore 版本；随后在已经完成实例绑定的同一管理连接读取 `server_version_num`。未知/缺失/重复/非稳定版本元数据以 `RESTORE_VERSION_METADATA_UNVERIFIED` 拒绝，跨主版本组合以 `RESTORE_NATIVE_VERSION_MISMATCH` 拒绝；这些检查位于终止目标连接、DROP 和 CREATE 之前。缺少客户端或不可读归档仍在重建前拒绝。不会从可手改的 manifest 版本字段推断兼容，也不会过滤归档 SQL 来伪造兼容。

pg_dump18 可以读取 PG16，但这不保证其归档能安全恢复到 PG16；pg_restore18 可能输出该目标不支持的 SET。本入口不承诺任意跨主版本恢复。若归档由18生成且目标是16，保留原介质与失败证据，在获准的源/目标和兼容16客户端环境重新生成并验证所需备份；不能把已保留的18归档改名成16或仅更改manifest。版本预检通过也不代替真实恢复、迁移指纹、三分对账或现场验证。

版本兼容边界参考 PostgreSQL 官方 [pg_dump 文档](https://www.postgresql.org/docs/16/app-pgdump.html)；`--list` 语义参考 [pg_restore 文档](https://www.postgresql.org/docs/18/app-pgrestore.html)。本入口采用上述更窄的同主版本自动恢复政策，不将文档中的一般兼容描述当作本候选已完成的真实恢复证明。

PR12原10个真实场景/断言保留。新增拒绝证明使用当前任务的新源库和已恢复的新目标：通过 `CADENZA_PR12_INCOMPATIBLE_CLIENT_BIN` 指定一套比目标新的原生 pg_dump/pg_restore 目录（本次为18.x对16.x），仅给子进程设置 PATH，生成真实新版本归档，再确认实际restore拒绝且目标数据库OID、哨兵、迁移记录及A/B源均不变。正常成功恢复仍使用同主版本客户端；缺少第二套工具时新增证明为NOT_RUN，不用替身或skip充数。不得在原失败非空库重复初始化。
