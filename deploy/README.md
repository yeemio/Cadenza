# deploy/ — Cadenza 交付运维工具与手册（P3-E：T25–T27 交付工具 + T28 检查单）

版本：2026-10-28｜冻结合同：`architecture/contracts/frozen/p3/delivery-ops.md`（DO-01～DO-32）＋ `frozen/p3/multi-plant.md`

## 目录

| 目录 | 内容 | 合同 |
| --- | --- | --- |
| `install/` | install.sh（干净安装）/ selfcheck.sh（重启自检）/ 安装手册 | DO-02/03/04/05 |
| `upgrade/` | upgrade.sh / COMPATIBILITY.json / 升级手册 | DO-20 |
| `backup/` | backup.sh / restore.sh / 备份恢复手册（含 §3.1 七步） | DO-15～19 |
| `drill/` | backup-restore-drill.sh（七步演练编排）/ drill-fixtures.sql | §3.1、DO-16 |
| `release/` | RELEASE-ANCHOR.json（版本锚）/ 支持模块与设备 / 已知限制 | DO-01/05 |
| `demo/` | 匿名演示数据包 + ANON-RULES.md + demo-bootstrap.sql | DO-03/14 |
| `config/` | 配置清单与密钥管理 | DO-04 |
| `monitoring/` | 监控最低清单（九项） | DO-21 |
| `training/` | 剧本矩阵 + 10 个剧本 + 操作/管理员手册框架 | DO-22～25 |
| `pilot/` | 首厂影子试点与切换指南（记录格式/退出标准） | DO-26～32 |
| `multi-plant/` | T28 第二工厂落地检查单（十项） | §6/MP-20 |
| `MANUAL-运维手册.md` | 运维手册（三类手册之运维分册总纲） | DO-24 |

配套 node 工具在 `scripts/delivery/`（导入校验/三分对账/升级兼容/发行清单/剧本校验/试点检查/T28 检查单/匿名检查/版本锚/自检/PG 操作/哈希链账本）。

## 部署形态（DO-06）

客户私有网络 `web/pda + api + worker + PostgreSQL + 对象存储`。试点可用单机容器，但应用与数据库**独立备份**；单机试点不据此宣称满足高可用目标；正式环境数据库主备＋独立备份介质（现场执行，见运维手册第 2 节）。

## 快速入口

```bash
./deploy/install/install.sh --database-url URL            # 干净安装（默认无演示数据）
./deploy/backup/backup.sh --database-url URL …            # 备份（结果入 backup-status.json）
./deploy/drill/backup-restore-drill.sh                    # 备份恢复七步演练（隔离环境实测）
./deploy/upgrade/upgrade.sh --database-url URL …          # 先备份后升级
node scripts/delivery/import/import-validate.mjs --help   # 期初导入（模板/拒绝清单/分层/冻结点）
```
