# 期初数据导入工具（T25 DO-07～13/S2/S3 ＋ R1 合并通道）

期初数据从源系统 CSV 走到**业务事实**的完整通道，全部落在 `scripts/delivery/import/`：

| 工具 | 职责 |
| --- | --- |
| `import-validate.mjs` | 模板下载/列级校验/名称匹配/拒绝清单/幂等重导/分层门禁/冻结点/导入运行表；第 1 层主数据合并（`--merge-master-data`） |
| `merge-staged.mjs` | **R1 合并通道**：第 2/3/4 层暂存行经产品命令面落业务事实（`--merge-inventory` / `--merge-open-orders` / `--merge-history`） |
| `reconcile-inventory.mjs` | DO-13 四维对账（数量/单位/质量状态/库位），只读比对、绝不直接改账 |
| `e2e-import-merge-proof.mjs` | 隔离库端到端证明（匿名样本→暂存→确认→落账→幂等→三方对账数字），临时库 `cadenza_dops_r1imp_*` 用后即删 |

## 全链路（分层迁移 DO-10，逐层核对，不一次全量混导）

```
模板下载 → check 预检 → apply 落暂存（delivery_stg_*）+ 拒绝清单哈希链账本
        → 业务核对 → --confirm-layer N
        → 合并通道（第 1 层 --merge-master-data；第 2/3/4 层 merge-staged.mjs）
        → 业务事实（material / inventory_unit+stock_balance+stock_transaction /
          purchase_order / production_order …）或具名拒绝/待确认清单
```

期初库存层另有冻结点纪律（DO-11/DO-30）：`--set-freeze`（操作人）→ 导入核对
`--confirm-layer 2` → **合并落账/增量补齐（在冻结窗口内）** → `--release-freeze`（批准人）。

## 合并通道（merge-staged.mjs，R1）

- **门禁**：合并第 N 层须该层已核对通过（`delivery_layer_check[N]='verified'`）；
  `--merge-inventory` 另须存在 active 冻结点（期初/增量落账发生在冻结窗口内）。
- **产品命令面（不走 SQL 直插业务表）**：
  - 期初库存 → `inventory.receive-goods`（新批次/单元/余额/receive 流水，businessTime=冻结点时刻）；
  - 增量正变动 → `inventory.receive-goods`（businessTime=发生日期，refId=来源单据号）；
  - 增量负变动 → `inventory.issue-material`（工厂+批次+库位+货主+质量状态唯一命中才扣；多义/缺失→具名待确认）；
  - `purchase_open` → `purchase.order-sync`；`process_wip` → `process.order.receive`（released，生产部门唯一命中）；
  - `sales_open` → 当前无销售订单命令面 → **具名待确认**（不 SQL 直插、不冒充）；
  - 历史单据 → 期初库存已含冻结点余额，重放历史收发将双计当前库存 → 全部**具名待确认**交业务确认处置（DO-09/K21）。
- **幂等（operationId 语义）**：每暂存行派生确定性 `dimp/<通道>/<自然键哈串>[/尝试号]`；
  已落账行置 `merged_at` 跳过；命令总线同键同载荷回放原结果（不重复入账）；业务拒绝后重试
  以尝试号 +1 换新 operationId（原拒绝未产生业务事实，重试不多记）。
- **行级 trace**：`stg 行 → operationId/命令回执 → 业务事实 id 或具名待确认/拒绝`，逐行落
  `delivery_merge_run` / `delivery_merge_row` 与 `workspace/merges/<run>/trace.csv`、`merge-report.md`。

```bash
node scripts/delivery/import/merge-staged.mjs --merge-inventory \
  --database-url postgres://…/cadenza_dops_目标库 --actor admin --workspace delivery-import-workspace
```

## 隔离库端到端证明

```bash
node scripts/delivery/import/e2e-import-merge-proof.mjs            # 临时库用后即删
node scripts/delivery/import/e2e-import-merge-proof.mjs --keep-db  # 保留现场复查
```

证明链与断言见证据目录（默认 `delivery/P3/delivery-ops/evidence/import-r1/<时间戳>/`）：
分步日志、workspace 报告、`THREE-WAY-RECON.md`（导入汇总 vs 业务落账 vs 拒绝/待确认三方
数字恒等式）、`PROOF-SUMMARY.md`（断言清单）。任一断言失败脚本退出非 0。

## 安全护栏

- 除模板下载外所有模式必须显式 `--database-url`；
- 建库/删库仅允许 `cadenza_dops_*` 白名单前缀（`scripts/delivery/lib/db.mjs`），dev 主库 `cadenza` 永不可写；
- 合并命令面复用 `apps/api/dist` 组合根（构建产物），不改产品代码；构建需先 `pnpm build`。
