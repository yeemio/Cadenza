# 分类修复 PR 合同

本 PR 初始仅冻结整改范围，尚无产品修复，不代表 ACCEPT。代码作者由 Owner 指定：普通 ChatGPT Chat / Pro 最高档；唯一控制与接收方仍为 Cadenza 总控。只在本 PR head 分支写允许路径，不改 main，不合并、不部署、不访问旧业务库/生产或新增付费调用。

严格 TDD 尚未获 Owner 授权：以已知静态失败/日志诊断，稳定修复后做针对性回归，不自行启动 RED/GREEN 流程。真实 PG 必跑场景不能被替身/skip 冒充。一次实现加最多一次具名窄返工；再有新根因/范围冲突/无进展返回总控裁定，不无限循环。

## 08 PDA/Web作业意图、归属与工厂业务日

基线 `cb25076d99cda0ac359151ff9eea65507de8cc4d`。归口条目：I02, I03, I07。

- I02: PDA未知结果重试换业务键
- I03: PDA/Web演示归属进入真实业务
- I07: CN/KR业务日口径分叉

依赖组：01, 02, 03。共享路径有重叠时必须先重新绑定累计基线，禁止直接覆盖其它 PR 修复。

## 允许写入

- `apps/pda/src/pages/FeedScanPage.tsx`
- `apps/pda/src/pages/PutawayScanPage.tsx`
- `apps/web/src/pages/FeedingPage.tsx`
- `packages/ui/src/api/client.ts`
- `packages/ui/src/i18n/time.tsx`
- `packages/application/src/execution-handlers.ts`
- `packages/application/src/inventory-posting.ts`
- `packages/domain/src/inventory/time.ts`
- `tests/pr08/**`
- `docs/review/fixes/08-operator-intent-calendar.md`
- `docs/review/evidence/pr-08/**`

## 行为接受条件

1. 服务端提交后丢响应，以原operationId/载荷查询或重试，只有明确新意图才换键
2. 两个非演示订单/第二工序/两个工厂的归属均由受信任务解析并后端复核
3. CN/KR跨午夜的UI/记账/报表用同一服务端日历；真实班表未提供不宣称现场接受

## 交付与停止

提交准确 head SHA、changed paths、实际命令/环境/输出/退出码、执行/跳过/失败数、未解决项。代码补丁和必要证据须落本 PR，文字建议不算代码修复。没有 GitHub 写工具时返回完整可应用 patch/逐文件内容，由总控在同一 PR 发布，不让 Owner 搬运，不用新 Work 任务替代。

仅在本 PR 验收边界关闭后停止；未知业务例外、真实旧库/现场/独立 R6 仍留待相应证据。E01 是审查可见性差距，本地主控已有原件；E04 不能由内部模型补造。
