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

## 作者代码候选 R0（PR14 ACCEPT 后续）

候选绑定本 PR 初始/本轮读回 head `2446347cbc83343ae0a40017552f22df2dbe7ec7`，产品前像仍为 `cb25076d99cda0ac359151ff9eea65507de8cc4d`。身份 `same_family_external_advisory`。状态：`CODE_CANDIDATE / PG_NOT_RUN / PUBLICATION_PENDING_CONTROLLER`，不是 ACCEPT。

必要兼容前置：缺组织映射的采购 QUARANTINED Inbox 是合法诊断事实；共同事务改为拒绝回滚后，原采购处理器须显式标识该诊断的重建。该一文件最小差异单独归 PR #2 允许路径 `packages/application/src/purchase-handlers.ts`，在原 PR #2 发布兼容提交后，仅将该提交带入本 PR。它兼容旧总线，不提前宣称 C2 完成；PR #2 的对象授权主体仍依赖本 PR。无需将 PR14 带入本链。

新增内部 `persistRejectionDiagnostics` 回调不进入 API/回执 JSON；仅在整体 BUSINESS_REJECTION 的业务写集回滚后执行。COMMITTED、DRAFT_SAVED 与整体成功的逐行登记保留；VERSION_CONFLICT 回滚且持久化冲突回执。成功时显式等待 shipping/rework Outbox 队列，事务绑定 SQL 观察器保留已被调用方 catch 的 SQL 错误，并拒绝已完成事务的后续查询。

新增 22 个待执行行为场景：真实 PG 总线夹具 13、真实采购/PL/DC 诊断及附件逐行登记 4、真实发运两轴 4、真实倒轴晚拒绝 1。另复用现有三个 integration 文件及 shipping API 全文件回归。当前只完成源码语法/补丁完整性检查，未执行这些 PG 场景；完整环境、命令、范围和停止条件见 [verification.md](../evidence/pr-01/verification.md)。
