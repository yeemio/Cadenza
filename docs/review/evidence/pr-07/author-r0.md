# PR07 R0 — 工厂认领与外部结果确认候选

状态：SOURCE_READY_PG_NOT_RUN_CONTROLLER_PENDING。不是主控 ACCEPT。

原 PR #7 / `codex/fix-07-outbox-confirmation`，精确父 head `fe1f8bb4acc253747e6e95ddfd55f421e62b49d6`。
源码/测试文件集合 SHA256 `2b867a6e60fa7d98bbe76b0f7152e736856254ee991d48114b3361e1e9d8eb9c`，不是 Git commit。

## 前置及应用

使用 `pr07-r0-from-recorded-head.patch`；或顺序应用 `pr07-pr01-pr02-prerequisite.patch` 与 `pr07-r0-increment.patch`。只选一条路线。累计前置精确复用 PR02 R0 的 31 个后像及其中已接受 PR01 必要源码；PR02 尚待主控接受。摘要与逐文件前/后像见清单。

## 实现

- I06：认领 SQL 在 FOR UPDATE 之前过滤实际工厂；已知聚合从持久化对象取工厂，未知任务类型可使用服务端存储的工厂快照，缺失/冲突范围保持原行。外厂任务不改状态、attempt、重试时间或 updated_at。处理器二次范围不符也不改行。
- worker 必须显式配置非空 WORKER_SCOPE_PLANTS；空范围不再默认为全企业。主程序和循环绑定同一范围。未解析任务没有被擅自隔离或重排；历史范围缺口需主控处理相应映射。
- noop 通道及旧自定义 noop DISPATCHED 结果落 NOOP_NEEDED，并明确 SITE_PENDING，清除外部回执字段；外发未知/异常/无效回执落 EXTERNAL_UNKNOWN，不盲重试。仅明确确认、非 noop 外部引用且匹配原始任务摘要才 DISPATCHED。
- I08：订单转换重试严格枚举 success/failure/unknown，缺省/非法拒绝。success 必须已有持久化 DISPATCHED 回执且匹配不可变任务快照摘要，客户端 success/引用/摘要不能替代。UNKNOWN 保留已完成本地转换，outbox=EXTERNAL_UNKNOWN，订单沿用既有 sync_failed 未解决投影（不改历史 schema）。没有再次执行本地分配或另建推送任务。
- 库存转换未知也隔离 outbox，本地 apply/resync 的非法/缺省 outcome 不默认为成功。触及结果写入按真实转换对象的 conversion.post 工厂授权复核。摘要序列化补齐 JSON 对象闭括号，应用层/worker 一致核对。

## 验证

20 个本地规则/通道替身用例 PASS，0 FAIL，0 SKIP；不是真实外发证明。worker、application、persistence 类型检查通过。测试初检 TS2322（randomUUID 模板字面量推断）已以显式 string 类型窄修复，原日志保留，最终测试类型检查 exit 0。

真实 PG 入口因缺 CADENZA_PR07_TEST_DB_URL exit 1：业务执行 **0 / NOT_RUN**。20 个 PG 场景源码包含两厂 worker 反序/并发且 NOWAIT 检查外厂行未锁、一厂离线保留到期重试、聚合范围与冲突、noop/UNKNOWN、实际本地完成的转换在重试中保持分配事实、缺省/非法/伪造回执拒绝及原键重放。成功外部回执是明确的本地夹具，不是真实 U9/SAP 样例。

```bash
CADENZA_PR07_TEST_DB_URL='<controller fresh exclusive cadenza_pr07_* database>' node node_modules/vitest/vitest.mjs run --config tests/pr07/vitest.config.ts tests/pr07/confirmation.pg.spec.ts --reporter=verbose
```

新库入口拒绝非空库，不 fallback 或 drop/create，不以 skip 通过。未跑旧共享库 worker suite；其旧“外厂 FAILED/NULL、noop DISPATCHED、payload-only success”断言已与本整改语义冲突，不混算 PASS。未执行冷构建、真实外部接口、生产或现场验证。

## 交付

7 个产品源码文件、4 个测试/配置文件均在原合同允许路径，无范围外扩。完整统一补丁、逐文件后像及其 SHA256、两条独立 git apply 验证在包内。主控仍负责原 PR7 应用、隔离 PG 证明、接受和发布；本 Chat 未发起 GitHub 写入、merge、部署或消息发送。
