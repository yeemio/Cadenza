# 分类修复 PR 合同

本 PR 初始仅冻结整改范围，尚无产品修复，不代表 ACCEPT。代码作者由 Owner 指定：普通 ChatGPT Chat / Pro 最高档；唯一控制与接收方仍为 Cadenza 总控。只在本 PR head 分支写允许路径，不改 main，不合并、不部署、不访问旧业务库/生产或新增付费调用。

严格 TDD 尚未获 Owner 授权：以已知静态失败/日志诊断，稳定修复后做针对性回归，不自行启动 RED/GREEN 流程。真实 PG 必跑场景不能被替身/skip 冒充。一次实现加最多一次具名窄返工；再有新根因/范围冲突/无进展返回总控裁定，不无限循环。

## 05 AI轮次身份、缓存与结果隔离

基线 `cb25076d99cda0ac359151ff9eea65507de8cc4d`。归口条目：C5。

- C5: AI requestId 所有权与缓存串用

依赖组：无先行修复依赖。共享路径有重叠时必须先重新绑定累计基线，禁止直接覆盖其它 PR 修复。

## 允许写入

- `apps/api/src/aiquery/aiquery.turn-context.ts`
- `apps/api/src/aiquery/aiquery.turns.controller.ts`
- `packages/application/src/aiquery-service.ts`
- `packages/persistence/src/aiquery-repositories.ts`
- `apps/ai/src/orchestrator.ts`
- `tests/pr05/**`
- `docs/review/fixes/05-ai-turn-ownership.md`
- `docs/review/evidence/pr-05/**`

## 行为接受条件

1. 两用户/两企业/同用户两会话复用同requestId，禁止覆盖owner及读取/澄清/取消他人轮次
2. 零工具answer/refuse不回退他人旧信封；撤权后拒绝过期结果
3. 合法同轮澄清/取消/审计重放可用；需要已知ID和进程缓存的风险前提如实保留

## 交付与停止

提交准确 head SHA、changed paths、实际命令/环境/输出/退出码、执行/跳过/失败数、未解决项。代码补丁和必要证据须落本 PR，文字建议不算代码修复。没有 GitHub 写工具时返回完整可应用 patch/逐文件内容，由总控在同一 PR 发布，不让 Owner 搬运，不用新 Work 任务替代。

仅在本 PR 验收边界关闭后停止；未知业务例外、真实旧库/现场/独立 R6 仍留待相应证据。E01 是审查可见性差距，本地主控已有原件；E04 不能由内部模型补造。
