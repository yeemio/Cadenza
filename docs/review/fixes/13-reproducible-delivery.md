# 分类修复 PR 合同

本 PR 初始仅冻结整改范围，尚无产品修复，不代表 ACCEPT。代码作者由 Owner 指定：普通 ChatGPT Chat / Pro 最高档；唯一控制与接收方仍为 Cadenza 总控。只在本 PR head 分支写允许路径，不改 main，不合并、不部署、不访问旧业务库/生产或新增付费调用。

严格 TDD 尚未获 Owner 授权：以已知静态失败/日志诊断，稳定修复后做针对性回归，不自行启动 RED/GREEN 流程。真实 PG 必跑场景不能被替身/skip 冒充。一次实现加最多一次具名窄返工；再有新根因/范围冲突/无进展返回总控裁定，不无限循环。

## 13 完整冷构建、测试门禁与候选元数据

基线 `cb25076d99cda0ac359151ff9eea65507de8cc4d`。归口条目：I16, M02, E01, E03。

- I16: AI/IM不在完整冷构建图
- M02: 规划/发行元数据落后
- E01: 最新完整SIM证据在审查侧不可见（本地主控已保存原件）
- E03: 测试可移植性和必跑门禁不足

依赖组：无先行修复依赖。共享路径有重叠时必须先重新绑定累计基线，禁止直接覆盖其它 PR 修复。

## 允许写入

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `apps/ai/package.json`
- `apps/ai/build.sh`
- `apps/ai/tsconfig.build.json`
- `packages/integrations/im/package.json`
- `packages/integrations/im/tsconfig.build.json`
- `apps/api/src/aiquery/im/im.composition.ts`
- `tests/sol-sap-engine/**`
- `tests/sol-sap-recon/**`
- `tests/integration/command-idempotency.spec.ts`
- `scripts/sol-sap-recon/**`
- `architecture/ROADMAP.md`
- `deploy/release/RELEASE-ANCHOR.json`
- `docs/review/**`
- `docs/review/fixes/13-reproducible-delivery.md`
- `docs/review/evidence/pr-13/**`

## 行为接受条件

1. 无旧dist干净检出从锁文件构建API/worker/AI/Web/PDA/IM并验证产物入口
2. 夹具从仓库或显式路径取得；正式必跑PG缺失要失败，执行/跳过/失败数分明
3. 候选T/A实施/接受矩阵和发行锚绑定实际证据，保留历史规划，不整表改完成
4. E01是审查侧可见性缺口，本地主控有原件；只补必要索引/安全原文差集，不重跑旧65或上传全部本地日志

## 交付与停止

提交准确 head SHA、changed paths、实际命令/环境/输出/退出码、执行/跳过/失败数、未解决项。代码补丁和必要证据须落本 PR，文字建议不算代码修复。没有 GitHub 写工具时返回完整可应用 patch/逐文件内容，由总控在同一 PR 发布，不让 Owner 搬运，不用新 Work 任务替代。

仅在本 PR 验收边界关闭后停止；未知业务例外、真实旧库/现场/独立 R6 仍留待相应证据。E01 是审查可见性差距，本地主控已有原件；E04 不能由内部模型补造。
