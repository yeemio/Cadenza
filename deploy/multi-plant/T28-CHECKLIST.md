# T28 第二工厂落地检查单（multi-plant 合同验收入口）

版本：2026-10-28｜冻结合同：`architecture/contracts/frozen/p3/delivery-ops.md` §6（DO-32/MP-20）＋ `frozen/p3/multi-plant.md`
工具：`node scripts/delivery/t28-checklist.mjs --evidence deploy/multi-plant/evidence --check`

> 逐项通过并留证方可宣称落地（MP-20）；第 10 项在真实第二厂读回之前恒为 SITE_PENDING，不得勾选。

| # | 检查项 | 合同引用 | 通过判据 | 证据要求（evidence/items.json） |
| --- | --- | --- | --- | --- |
| 1 | 组织与权限隔离（第二厂命名空间、工厂范围、集团只读无写通道） | MP-04/05/08 | A14 场景在第二厂配置下通过；越权写为拒绝 | A14 双厂演练记录（403 证据 + 集团只读证明） |
| 2 | 主数据版本下发与主权划分 | MP-13/14 | 下发应用、stale 不覆盖、非主权侧只读各留证 | 下发/拒绝/只读三段证据 |
| 3 | 外部接口网关路由到归属工厂 | MP-15/16 | 同一外部单据仅归属厂应用；路由失败入隔离 | 路由命中 + 隔离队列证据 |
| 4 | 跨厂调拨三段事实演练 | MP-09～12 | 出库/在途/接收三段留证，在途不双计，接收为独立事实 | 三段流水 + 在途余额单方证据 |
| 5 | 集团汇总与延迟标注 | MP-06/07 | 断连补传去重、旧版本不覆盖新版本、延迟标注可见 | 断连重放记录 + 看板延迟标注截图/输出 |
| 6 | 配置包差异登记完整 | MP-17/18 | MP-18 清单逐项有差异值与模板引用；无核心代码分叉 | 配置包差异表（MP-18 十项） |
| 7 | 双实例模拟环境验收 | MP-19 | 标明环境的双本地实例证据齐套 | 环境标识 + 四类行为（隔离/下发/调拨/延迟）证据 |
| 8 | 监控接入 | DO-21 | 第二厂实例接入最低监项并告警演练 | 告警演练记录（含恢复入口） |
| 9 | 第二厂岗位剧本与培训 | DO-22～25 | 剧本矩阵覆盖第二厂差异岗位 | 矩阵扩展记录 + 执行事件 |
| 10 | 真实第二厂接入 | MP-19/20 | SITE_PENDING：未见真实工厂读回**不勾选** | 须真实工厂读回记录（real_factory_readback，绑定授权链）；当前不存在 |

## 使用

1. 逐项执行并留证，证据文件放 `deploy/multi-plant/evidence/`，在 `evidence/items.json` 登记 `{item, result:"PASS", evidence:[文件], note}`。
2. `node scripts/delivery/t28-checklist.mjs --evidence deploy/multi-plant/evidence --check`：十项逐项判定 + 报告归档；第 10 项恒 SITE_PENDING（工具内建，防伪造）。
3. 任一项未通过不得宣称第二厂落地（MP-20）。
