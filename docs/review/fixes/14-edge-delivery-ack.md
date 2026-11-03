# 分类修复 PR 合同

本 PR 初始仅冻结整改范围，尚无产品修复，不代表 ACCEPT。代码作者由 Owner 指定：普通 ChatGPT Chat / Pro 最高档；唯一控制与接收方仍为 Cadenza 总控。只在本 PR head 分支写允许路径，不改 main，不合并、不部署、不访问旧业务库/生产或新增付费调用。

严格 TDD 尚未获 Owner 授权：以已知静态失败/日志诊断，稳定修复后做针对性回归，不自行启动 RED/GREEN 流程。真实 PG 必跑场景不能被替身/skip 冒充。一次实现加最多一次具名窄返工；再有新根因/范围冲突/无进展返回总控裁定，不无限循环。

## 14 模拟网关确认后清积压

基线 `cb25076d99cda0ac359151ff9eea65507de8cc4d`。归口条目：I17。

- I17: 模拟网关未送达仍清积压

依赖组：无先行修复依赖。共享路径有重叠时必须先重新绑定累计基线，禁止直接覆盖其它 PR 修复。

## 允许写入

- `packages/edge/src/gateway.ts`
- `packages/edge/src/buffer.ts`
- `packages/edge/test/edge-gateway.spec.ts`（2026-11-03 R1 最小范围扩展，仅同步旧回归）
- `tests/pr14/**`
- `docs/review/fixes/14-edge-delivery-ack.md`
- `docs/review/evidence/pr-14/**`

## 行为接受条件

1. 无transport/发送失败保留样本与overflow统计
2. 发送中新样本不被确认旧批次时一并drain
3. 按已确认事件ID移除；重启与重复送达不丢数；不外推真实设备接受

## 交付与停止

提交准确 head SHA、changed paths、实际命令/环境/输出/退出码、执行/跳过/失败数、未解决项。代码补丁和必要证据须落本 PR，文字建议不算代码修复。没有 GitHub 写工具时返回完整可应用 patch/逐文件内容，由总控在同一 PR 发布，不让 Owner 搬运，不用新 Work 任务替代。

仅在本 PR 验收边界关闭后停止；未知业务例外、真实旧库/现场/独立 R6 仍留待相应证据。E01 是审查可见性差距，本地主控已有原件；E04 不能由内部模型补造。


## 本次代码候选交付

- 作者与咨询身份：`same_family_external_advisory`；产品基线与初始 head 不变。
- 候选为完整 unified patch；GitHub 写入返回 403，状态 `BLOCKED_DELIVERY_PUBLICATION`，无新远端 SHA。
- 实现与真实执行边界见 `../evidence/pr-14/verification.md`，最终本地门禁 7 通过／0 失败／0 跳过。
- 旧包测试 `packages/edge/test/edge-gateway.spec.ts` 的无通道清空断言与 I17 冲突，属于未授权路径；
  需要最小一文件测试同步扩展。该缺口和未运行的完整构建／真实 API／PG／设备验收均保留，未标 ACCEPT。

## R1 窄返工（2026-11-03）

- 本轮准确父提交为 `624067da1a5340a107db4c7786fc7755a572e1ed`，取代初始合同 head；
  上节为首次交付历史。总控已原样发布原九文件，记录见 `../evidence/pr-14/controller-r0.md`。
- Owner／总控已核准上列单一测试文件扩展：显式保留无 transport／离线不清空断言，
  成功补传明确使用 `MemoryTransport` 并恢复 online；不改产品算法、冻结合同或既有原始日志。
- 本轮只交测试修正与本节及 `../evidence/pr-14/author-r1.md`。旧 7/7 为既有证据，
  不重复计为新增覆盖；本环境 R1 Vitest／构建／类型检查均 `NOT_RUN`，由总控执行接收。
- 返工候选待发布和验证，PR 仍为 Draft／REWORK，未标 ACCEPT；整批 15 PR 授权继续。

## 控制者最终接收（2026-11-03）

ACCEPT：仅 I17 模拟网关源码与本地行为范围。R1 旧回归 6 执行／6 通过／0 失败／0 跳过，edge 类型检查通过；产品及原测试字节未变，复用 R0 的 7 项源码测试和针对性构建。准确来源、原始输出及未验证边界见 `../evidence/pr-14/controller-r1.md`、`controller-r1.json`。上节 Draft／REWORK 为历史交付状态；此接收不代表 main 合并、部署、真实 API／PG／设备／现场或独立 R6 接受。
