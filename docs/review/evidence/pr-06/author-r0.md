# PR06 R0 — 采购退货与逆向接收候选

状态：SOURCE_READY_PG_NOT_RUN_CONTROLLER_PENDING。未获主控 ACCEPT。

原 PR #6 / `codex/fix-06-reverse-stock-lifecycle`，精确父 head `e48b2e78f27785f49016f2c0f0e86847267e6ff5`。
源码/测试集合 SHA256 `a8dce41bb20dcb880516cce6e6c275287562c8c019e17cacf39065cfc2d63c93`（文件集合摘要，不是 Git commit）。

## 前置与应用

完整补丁 `pr06-r0-from-recorded-head.patch` 从原 head 应用；或先 `pr06-pr01-pr02-prerequisite.patch` 再 `pr06-r0-increment.patch`。只选一条路线。前置是已交 PR02 R0 的 31 个完整后像，含其精确 PR01 已接受源码前置；不得拼接不同候选的结论。PR02 仍待主控接受。

## 修复行为

- I01：保留 PR02 对真实批次行的事务锁，等待者在任何冲销前重读退货状态；不改变既有批次→订单行锁顺序。状态更新增加 stored 条件，失败时拒绝并交命令 UoW 回滚，避免重复扣减与回传。
- I04：接收方依据真实调入厂 reverse.post 授权，与已完成调出单、逐码清单、源厂在途单元/余额/流水、实际目标库位核对。接收预留通过该交接创建，不授予接收方源厂写权。
- 完成接收按稳定次序锁全部实物；源厂在途减项与目标厂增项分别记录正确工厂，库存单元转到目标厂。原货权独立保留，包括客供货权；没有借接收修改 owner。预留必须仍有效，晚拒绝按既有事务机制整体回滚。
- I05：各料品未收数量必须为零，清单不得缺码、重码；一轴已收不能抵消另一轴未收。重复扫码拒绝，完成单不可删码重开，未完成单合法删码/重扫保留。

## 实际验证及局限

11 个新增纯规则用例 PASS，0 FAIL，0 SKIP。最终应用层、持久化层及 PR06 测试类型检查 exit 0；持久化层和纯规则未变证据复用。首次类型检查也通过，日志保留。PG 测试源码核对时修正 outbox 的 event_id 字段及 text/uuid 比较，并加入过期预留场景；最终测试源码重新通过类型检查。

真实 PG 入口 exit 1，缺 `CADENZA_PR06_TEST_DB_URL`，业务用例执行 **0 / NOT_RUN**。最终 15 个真实 PG 用例包含两批同订单并发退同一批、原键重放、另一批库存/回传不变、合法跨厂/客供货权、多料品、半收拒绝、重复/删码、错清单/库位/预留/数量晚拒绝和全业务表 before/after 查询。没有以 pure/type/skip 代替这些结果。

```bash
CADENZA_PR06_TEST_DB_URL='<controller fresh exclusive cadenza_pr06_* database>' node node_modules/vitest/vitest.mjs run --config tests/pr06/vitest.config.ts tests/pr06/lifecycle.pg.spec.ts --reporter=verbose
```

测试只接受新的空专属库，不 fallback、drop/create 或 skip；使用 INSERT-only 主数据和明确全不合格夹具，实际库存/调拨/退货走真实命令总线。不得推断检验全流程、冷构建、生产/ERP/现场已通过。

## 交接

本次 4 个产品源码文件和 4 个测试配置/源码文件均在合同允许路径内，无范围外扩。逐文件完整后像、SHA256、全量/前置/增量补丁及两条独立 git apply 校验见交付清单。主控在原 PR6 应用，补独占 PG 验证并发布验收；本 Chat 未执行 GitHub 写入、merge 或部署。
