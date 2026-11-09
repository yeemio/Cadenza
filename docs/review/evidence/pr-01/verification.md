# PR #1 R0 — 作者代码候选与验证边界

身份：`same_family_external_advisory`。产品基线 `cb25076d99cda0ac359151ff9eea65507de8cc4d`；本轮实际读回 PR #1 head `2446347cbc83343ae0a40017552f22df2dbe7ec7`、PR #2 head `f174cafc8506b5f67f9928edb29145c680c56134`，均仍为初始合同提交。没有提交到远端、没有新的 Git head。已确认的 GitHub 写入 403 本轮不重试；交付完整补丁，由控制者在原 PR 发布并回填真实提交 SHA。

状态：`CODE_CANDIDATE / PG_NOT_RUN / PUBLICATION_PENDING_CONTROLLER`。C1 未标 ACCEPT，C2 未宣称完成；PR14 已由控制者 ACCEPT，本候选不带入 PR14。

## 范围与必要兼容前置

PR #1 仅写其允许路径。另附一文件 PR #2 兼容前置：`packages/application/src/purchase-handlers.ts`。原因是原采购缺组织映射分支先写 QUARANTINED Inbox，再返回整体 BUSINESS_REJECTION；共同事务修复后该诊断也会被回滚，必须显式重建。

该前置先在原 PR #2 发布为独立提交，再将该必要提交带入 PR #1，最后应用 PR #1 补丁。前置通过内部异常携带诊断回调；原总线仍保留原有一次写入，新总线先回滚原写入再重建一次。`Object.assign` 保持与原 HandlerOutcome 的结构兼容，不先要求 PR #1 新类型；回调不进入任何对外 JSON。它不是 C2 授权修复，也不改变 PR #2 授权主体依赖 PR #1 的关系。不得只发布共同事务而遗漏前置。

PR #1 的五个产品文件：共同总线实现、应用总线内部类型、shipping-handler 诊断分支、shipping/rework 两个组合根。未更改 rework 的业务规则、冻结业务合同、迁移或外部渠道。

## 状态语义与实际源码审计

| 处理结果 | 事务行为 |
|---|---|
| COMMITTED | 业务事实、审计、Outbox、成功回执同事务提交 |
| DRAFT_SAVED | 保留草稿事实及回执；没有被错误归为失败 |
| 整体成功、逐行有失败清单 | 保留成功行和逐行结果，按 COMMITTED 提交 |
| BUSINESS_REJECTION | 回滚整个处理器业务写集，然后在仍持有幂等键的事务内记录拒绝回执 |
| VERSION_CONFLICT | 回滚业务写集并记录可重放的冲突回执 |
| 显式 QUARANTINED 诊断 | 先回滚所有处理器写入，再执行仅重建 Inbox 的内部回调；随后与拒绝回执一起提交 |
| 异常、SQL 错误、诊断或 Outbox 写失败 | 整个事务回滚，不能留下成功回执或半套业务事实 |

已沿源码核实：`execution.session.save` 返回 DRAFT_SAVED；`shipping.photo.attach` 对有效附件落库、无效附件加入 failed 清单，整体仍为 COMMITTED；采购 order-sync、发运 PL/DC 入站的缺组织映射分支明确写 QUARANTINED。没有把结果数据内的逐行失败解释为整体拒绝。

幂等键占用在业务 SAVEPOINT 之前；业务拒绝回滚不释放该回执行的唯一键占用。相同键并发由真实 PG 唯一约束串行，异载荷不覆盖原回执；拒绝重放不重跑处理器。shipping/rework 收集器只登记不可变 Outbox 意图，成功分支在提交前显式 await flushEffects。事务绑定 SQL 观察器等待已发起查询，保留被旧调用方 catch 的 SQL 错误，并拒绝完成后继续使用的仓储连接。

## 提供的行为验证

新增场景共 22 个，均为待执行，不能计作通过：

- `tests/pr01/transaction.pg.spec.ts`：13 个真实 PG 场景，使用实际 PgCommandBus 与独立事务夹具表。覆盖两类拒绝回滚、COMMITTED/DRAFT_SAVED、明确诊断重建、同载荷并发、异载荷并发、诊断失败、未等待 SQL 排空、提交前异常、Outbox 失败、被吞 SQL 错误和完成后连接隔离。成功用例丢弃首次返回的使用机会后同键重放；这不是实际网络断连实验。
- `tests/pr01/diagnostics.pg.spec.ts`：4 个真实应用处理器场景，应用实际迁移、仓储及组合根；采购/PL/DC 各自缺映射时只保留 Inbox 与拒绝回执，以及真实附件逐行登记。
- `tests/integration/shipping-flow.spec.ts` 新增：4 个两轴场景。第二轴业务留置、活动预留、原质量异常路径分别验证无部分业务写入；两轴全部合法验证库存、流水、分录、审计及两条 Outbox 共同提交和重放不增量。
- `tests/integration/rework-flow.spec.ts` 新增：1 个真实倒轴冲销晚拒绝场景，子轴扣回后源轴留存校验失败，全部业务写集保持不变且拒绝可重放。

另运行原 command-idempotency、shipping-flow、rework-flow 和 shipping-api 全文件回归。四个入口在 `CADENZA_REQUIRE_PG=1` 时连接/初始化失败直接失败，不静默跳过；新增原子性案例也不得跳过。原质量异常仍抛异常并整体回滚，不改为另一业务规则。

## 作者实际执行与原始输出

环境：Linux x64，Node v24.22.1。`author-environment.json` 是实际依赖/二进制探测结果：无项目 TypeScript、Vitest、pg、Nest 依赖，无 psql/postgres/initdb/docker。没有连接任何 PostgreSQL。

实际执行 `node docs/review/evidence/pr-01/check-syntax.mjs`：12 个 TS 文件语法转换完成，退出 0，原始输出见 `author-syntax.log`。这仅检查语法，不是类型检查或构建，不执行导入和业务代码。两个补丁的精确前像 Git blob SHA、完整补丁 SHA256、git apply 检查及应用后逐文件比对记录随交付包 CANDIDATE.json/application-check.log 提供。检查工作区是精确前像文件构成的隔离目录，不声称克隆或构建了完整仓库。

业务测试执行 0；通过数、失败数、跳过数为未运行，不用 0/0 表示验收通过。全部真实 PG 场景、项目 Vitest、TypeScript 类型检查与构建均 `NOT_RUN`。既有 PR14 结果不用于本候选。

## 控制者可执行命令

先将前置与 PR #1 补丁应用到同一候选，安装锁定依赖。由控制者使用已授权的新独占 PG 环境与白名单库，不提供开发库或旧业务库连接。两个新测试入口要求显式命名，不会回退到默认连接：

```sh
: "${CADENZA_PR01_DB_URL:?必须是新的 cadenza_pr01_* 测试库}"
pnpm exec vitest run tests/pr01/transaction.pg.spec.ts

: "${CADENZA_PR01_DIAGNOSTICS_DB_URL:?必须是空的 cadenza_pr01_diag_* 测试库}"
pnpm exec vitest run tests/pr01/diagnostics.pg.spec.ts
```

第二个入口发现 public 内已有业务表即拒绝迁移；完成后保留该库供控制者检查，下次重跑换新空库。第一个入口使用随机专属 schema，清理也仅限它创建的 schema。

原回归的辅助文件使用固定 `cadenza_shp`/`cadenza_rework` 库名并重建；它们未在本 PR 扩权修改。下面的 `PR01_FRESH_LEGACY_URL` 必须绑定控制者专门创建的新独占实例，准确以 `/cadenza` 结尾且无查询串，白名单仅包括该新实例上的 cadenza、cadenza_shp、cadenza_rework。四个文件分开进程运行，避免 API 用例更改 DATABASE_URL 影响下一文件：

```sh
: "${PR01_FRESH_LEGACY_URL:?必须是控制者新独占实例的 /cadenza 连接}"
DATABASE_URL="$PR01_FRESH_LEGACY_URL" CADENZA_REQUIRE_PG=1 pnpm exec vitest run tests/integration/command-idempotency.spec.ts
DATABASE_URL="$PR01_FRESH_LEGACY_URL" CADENZA_REQUIRE_PG=1 pnpm exec vitest run tests/integration/shipping-flow.spec.ts
DATABASE_URL="$PR01_FRESH_LEGACY_URL" CADENZA_REQUIRE_PG=1 pnpm exec vitest run tests/integration/rework-flow.spec.ts
DATABASE_URL="$PR01_FRESH_LEGACY_URL" CADENZA_REQUIRE_PG=1 pnpm exec vitest run tests/api/shipping-api.spec.ts

pnpm --filter @cadenza/api... build
pnpm --filter @cadenza/application typecheck
pnpm --filter @cadenza/persistence typecheck
```

记录各命令退出码、实际执行/通过/失败/跳过数及当时 head 与前置 SHA；任一场景跳过、连接/初始化失败均不能关闭接受门禁。不得将语法检查、事务替身或部分构建替代真实 PG。

## 未解决与停止条件

- 等待控制者发布本候选并绑定真实 commit SHA、在同候选运行上述真实 PG 与项目验证。当前不能把 C1 关闭为 ACCEPT。
- 如果采购兼容前置未带入、出现其它合法持久拒绝语义、修复必须写非本批已允许路径，停止相关依赖并具名返回；不通过丢弃诊断、删除/skip 用例或放宽业务规则换绿。
- 失败仅围绕实际根因作窄修复；不因此重跑旧 65 次 SIM、不扩大现场或旧库权限。源码语法证据、PG 结果与现场接受分别记录。
- 独立 R6 原文/接收身份、真实 SAP/模型/企业渠道、设备/现场与旧库升级仍未证明；本 Chat 不提供独立验收身份。
