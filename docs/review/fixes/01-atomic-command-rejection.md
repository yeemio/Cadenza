# 分类修复 PR 合同

本 PR 初始仅冻结整改范围，尚无产品修复，不代表 ACCEPT。代码作者由 Owner 指定：普通 ChatGPT Chat / Pro 最高档；唯一控制与接收方仍为 Cadenza 总控。只在本 PR head 分支写允许路径，不改 main，不合并、不部署、不访问旧业务库/生产或新增付费调用。

严格 TDD 尚未获 Owner 授权：以已知静态失败/日志诊断，稳定修复后做针对性回归，不自行启动 RED/GREEN 流程。真实 PG 必跑场景不能被替身/skip 冒充。一次实现加最多一次具名窄返工；再有新根因/范围冲突/无进展返回总控裁定，不无限循环。

## 01 业务拒绝原子性与幂等回执

基线 `cb25076d99cda0ac359151ff9eea65507de8cc4d`。归口条目：C1。

- C1: 业务拒绝仍提交此前写入

依赖组：无先行修复依赖。共享路径有重叠时必须先重新绑定累计基线，禁止直接覆盖其它 PR 修复。

## 允许写入

- `packages/persistence/src/pg-command-bus.ts`
- `packages/application/src/command-bus.ts`
- `packages/application/src/shipping-handlers.ts`
- `packages/application/src/rework-handlers.ts`
- `apps/api/src/shipping/shipping.composition.ts`
- `apps/api/src/rework/rework.composition.ts`
- `tests/integration/command-idempotency.spec.ts`
- `tests/integration/shipping-flow.spec.ts`
- `tests/integration/rework-flow.spec.ts`
- `tests/api/shipping-api.spec.ts`
- `tests/pr01/**`
- `docs/review/fixes/01-atomic-command-rejection.md`
- `docs/review/evidence/pr-01/**`

## 行为接受条件

1. 真实PG：第一轴合法、第二轴业务留置/活动预留时拒绝，全部业务写集不变而拒绝回执可重放
2. 倒轴冲销子轴扣回后源轴留存检查拒绝：无部分业务写入
3. 成功多轴发运、同键并发/不同载荷、提交前异常/提交后丢响应、现有质量异常回滚均正确
4. 合法采购缺组织映射QUARANTINED Inbox、草稿/逐行合同保留，不一刀切删除合法诊断事实；如需扩写purchase-handler先给最小原因
5. 审计/outbox异步写必须归事务完成，不能void吞错；不靠仅将校验前移代替共同事务保证

## 交付与停止

提交准确 head SHA、changed paths、实际命令/环境/输出/退出码、执行/跳过/失败数、未解决项。代码补丁和必要证据须落本 PR，文字建议不算代码修复。没有 GitHub 写工具时返回完整可应用 patch/逐文件内容，由总控在同一 PR 发布，不让 Owner 搬运，不用新 Work 任务替代。

仅在本 PR 验收边界关闭后停止；未知业务例外、真实旧库/现场/独立 R6 仍留待相应证据。E01 是审查可见性差距，本地主控已有原件；E04 不能由内部模型补造。
