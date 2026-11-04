# Cadenza 升级手册（T26，DO-20）

适用：数据库变化走可兼容的扩展/迁移/收缩；迁移在已有业务数据上可重入（幂等，失败续跑不重复应用）。

## 1. 升级三原则

1. **先备份后升级**：upgrade.sh 第 1 步强制执行备份——恢复方案必须考虑**已发生的业务写入**，不能只回滚容器（DO-20 明文）。
2. **路径受控**：起点版本集合→终点版本、不可跳转路径与数据后果登记在 `deploy/upgrade/COMPATIBILITY.json`（随发行版本更新）；漂移（库内版本非 registry 连续前缀）直接拒绝。
3. **失败可续跑**：本发行迁移执行器在一个事务中按版本应用并记入 `schema_migrations`；失败修复后重跑 `upgrade.sh` 自动跳过已应用版本续跑。

## 2. 执行

```bash
./deploy/upgrade/upgrade.sh --database-url URL [--env-file .env] \
  [--object-store-root 附件根] [--api-url http://…/health]
```

脚本依次：环境版本锚校验（DO-05）→ 只读兼容检查（漂移/路径，DO-20）→ 升级前备份（DO-15）→ 应用迁移 → 升级后自检（DO-04，提供 --api-url 时含健康端点）。

只读检查（不升级，可随时执行）：

```bash
node scripts/delivery/upgrade-compat-check.mjs --database-url URL
# 仅执行数据库 READ ONLY 事务中的 SELECT；无迁移、建表或自动重入验证
```

## 3. 不可跳转路径（COMPATIBILITY.json 摘要）

| 路径 | 判定 | 数据后果 |
| --- | --- | --- |
| 已应用 0004+ 的库降级到 0003- | **禁止** | 库存流水/分录 append-only 触发器与余额结构失去事实完整性（IT-S6）；如必须回退，整库恢复到旧备份，不得原地降级 |
| 旧备份直接恢复到更高发行版本应用 | **禁止** | restore.sh 迁移一致性检查拒绝；正确路径=恢复到备份版本 → 按 §2 升级 |
| 库内版本与 registry 不一致（drift） | **拒绝并人工处置** | migrateDown 同样显式拒绝（迁移执行器内置） |

## 4. 升级窗口纪律

- 升级窗口内停应用写入（与期初冻结点 DO-11 同纪律）；升级后先自检再放流量。
- 升级记录（变更单）必须包含：起点版本集合、终点版本、备份目录、自检结果、回退方案（=恢复到升级前备份 + 差异补录 DO-19，不是回滚容器）。


## PR12：只读预检与未验证路径

upgrade-compat-check.mjs 的默认及唯一模式是只读。它不用 migrateStatus（该方法会创建 schema_migrations），也不导入/调用 applyMigrations。检查事务使用 REPEATABLE READ READ ONLY 并最终 ROLLBACK；旧 --no-reentrancy 仅兼容读取，不提供任何会写目标的预检开关。缺 schema_migrations、未知版本、非连续前缀、未知目标、降级和未获证据的逐跳路径均明确失败。

注册表已包含到 0031，不等于已有业务数据可安全从 0030 升级到 0031。COMPATIBILITY.json 单独将这一跳保留为 UNVERIFIED/E02；没有获准、带旧 hash/回执/库存/未决 outbox/UNKNOWN 的隔离样本前，不能标 VERIFIED。更旧的未登记路径也不被默许。已经到顶且无待迁移路径的只读结构检查可通过，但不代表历史迁移测试或现场证据完成。

重入/升级测试应在另行获准的隔离克隆库执行，并记录 schema、数据摘要及关键业务链 before/after；原生产和旧业务库不在本交付授权内。本候选未执行任何升级、恢复、容器或数据库命令。
