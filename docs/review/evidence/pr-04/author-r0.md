# PR04 R0 — 实物与商业行绑定候选

状态：SOURCE_READY_PG_NOT_RUN_CONTROLLER_PENDING。不是控制者 ACCEPT。

原 PR #4 / `codex/fix-04-shipping-fulfilment`；精确原 head `df864060609f24b89b84d5a453757ffbe555f971`。
源码及测试集合 SHA256：`2c194fec1592e430bb56b856370b2f752e091afd8eb57a6be498258aa21e5dff`（本地集合摘要，不是 Git commit）。

## 前置和应用

完整补丁 `pr04-r0-from-recorded-head.patch` 从原 head 应用；或依次应用 `pr04-pr01-pr02-pr03-prerequisite.patch` 与 `pr04-r0-increment.patch`。只选一条路线。前置明确绑定已接受 PR01 head 956d9e1bd4192943e1095e03884d4c58435de710、PR02 R0、PR03 R0 的逐文件后像，详情见 author-r0.json / DELIVERY-MANIFEST.json。PR02/03 仍待控制者接受。

## 产品行为

- 普通装入与补码中的已知实物读取实际库存企业、工厂、料品、现存量、单位，以及已审核报工产出/验证拆分谱系的销售订单和行归属。显式 lineId 和自动选择都受同一校验约束，自动匹配多候选拒绝。
- 真实段长必须为正，与当前唯一活动余额和商业行冻结段长一致。客户端实际段长只是待核对声明。轴号差异继续走既有 IF06 机制。
- 无库存身份的补码继续登记并计入登记进度；确认出库时每条记录必须解析成唯一实物，实物数、登记数、应扫数必须相等。无实体不能以零库存记账完成出库。
- 确认出库按稳定次序锁全部实物，复核归属、实物状态、质量隔离、业务留置和预留，任何晚拒绝交既有事务总线完整回滚。不可变扫码原件不修改，最终绑定保存在出库快照 physicalBindings。
- 无法证明历史销售归属时 UNKNOWN 并拒绝出库；没有用发货单或客户端自行补造归属。多段单元须先完成受验证拆分，未定义单位换算不推断。

## 实际验证

应用层、持久化层、PR04 测试源码类型检查均 exit 0。27 个新增纯规则用例及 31 个原 shipping domain 回归共 58 PASS，0 FAIL，0 SKIP；这些不是数据库业务证明。

真实 PG 调用 exit 1，缺 CADENZA_PR04_TEST_DB_URL：**NOT_RUN，0 数据库用例执行**。32 个源码用例要求新空 cadenza_pr04_* 库；不会 fallback、drop/create 或 skip。覆盖合法轴/普通出库、显式/自动错料品/销售单行/段长/数量/单位/UNKNOWN、补码晚解析、声明伪造、计数伪造、来源变化，以及第二件实物晚质量/留置/预留拒绝时全业务表不变和原键重放。所有原始日志在 evidence。

```bash
CADENZA_PR04_TEST_DB_URL='<controller fresh exclusive cadenza_pr04_* database>' node node_modules/vitest/vitest.mjs run --config tests/pr04/vitest.config.ts tests/pr04/fulfilment.pg.spec.ts --reporter=verbose
```

测试以明确 SQL 夹具建立已审核产出来源，库存/发运操作和断言走真实 PG 仓储及命令总线。没有声称这证明执行报工全流程。PR01/PR03 旧 shipping PG 夹具未含本次要求的商业来源，不能原样当作本候选回归 PASS；其历史证据不被重写或混算。

## 范围与交接

PR04 新改路径全部在原合同允许范围，0 范围外扩；累计前置包含 PR03 已具名的 inventory persistence 只读接口外扩，仍待控制者范围复核。完整逐文件后像、文件 SHA256、三条补丁 SHA256、两条 git apply 独立验证在交付包内。主控在原 PR 原样应用、补独占 PG 证明并验收发布。本 Chat 是唯一源码/测试作者；未调用 GitHub 写入、merge、部署或外部渠道。
