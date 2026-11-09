# 分类修复 PR 合同

本 PR 初始仅冻结整改范围，尚无产品修复，不代表 ACCEPT。代码作者由 Owner 指定：普通 ChatGPT Chat / Pro 最高档；唯一控制与接收方仍为 Cadenza 总控。只在本 PR head 分支写允许路径，不改 main，不合并、不部署、不访问旧业务库/生产或新增付费调用。

严格 TDD 尚未获 Owner 授权：以已知静态失败/日志诊断，稳定修复后做针对性回归，不自行启动 RED/GREEN 流程。真实 PG 必跑场景不能被替身/skip 冒充。一次实现加最多一次具名窄返工；再有新根因/范围冲突/无进展返回总控裁定，不无限循环。

## 04 发运实物与商业行匹配

基线 `cb25076d99cda0ac359151ff9eea65507de8cc4d`。归口条目：C4。

- C4: 发运实物/商业行对应缺失

依赖组：01, 02, 03。共享路径有重叠时必须先重新绑定累计基线，禁止直接覆盖其它 PR 修复。

## 允许写入

- `packages/application/src/shipping-handlers.ts`
- `packages/application/src/shipping-repositories.ts`
- `packages/persistence/src/shipping-repositories.ts`
- `packages/domain/src/shipping/**`
- `apps/api/src/shipping/**`
- `tests/pr04/**`
- `docs/review/fixes/04-shipping-fulfilment.md`
- `docs/review/evidence/pr-04/**`

## 行为接受条件

1. 补码作业可登记，但未解析库存身份不得以postedUnits=0完成出库
2. 显式lineId与自动匹配同样校验料品、销售归属、段长与数量
3. 合法轴/单品发运保持，未知历史特殊映射另记Owner待裁而不伪造库存

## 交付与停止

提交准确 head SHA、changed paths、实际命令/环境/输出/退出码、执行/跳过/失败数、未解决项。代码补丁和必要证据须落本 PR，文字建议不算代码修复。没有 GitHub 写工具时返回完整可应用 patch/逐文件内容，由总控在同一 PR 发布，不让 Owner 搬运，不用新 Work 任务替代。

仅在本 PR 验收边界关闭后停止；未知业务例外、真实旧库/现场/独立 R6 仍留待相应证据。E01 是审查可见性差距，本地主控已有原件；E04 不能由内部模型补造。
