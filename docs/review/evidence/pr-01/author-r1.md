# PR01 R1：合法源轴消费与实际查询输出

- 精确增量父 head：`39f7d1212bbbcd7d3a1f1d3ebf4781b8f636380a`。
- 产品源码候选仍为 `6c611b5ea0b8bdb8016bf8064ac3555a94e1df9a`，本 R1 不改产品源码。
- 采购兼容原提交 `70fe34fa654e50ff9b8f41aacc5aef825118a9ed`，带入提交 `6a223bec6853f8b9c94b7191287f2de8924d3555`；不重复交付，不宣称 C2 完成。
- 身份：`same_family_external_advisory`。本轮作者状态：`R1_CODE_CANDIDATE / PG_NOT_RUN / PUBLICATION_PENDING_CONTROLLER`。没有新远端 head，未重试已确认 403 的写入。

## 实际读取与保留的证据

已实际读取父 head 上的 `controller-r0.json`、`controller-r0.md`、两份完整测试、rework-handler、inventory-posting、PgReworkFactsLookup 与域倒轴规则。文件字节已按 Git blob SHA1 校验。

控制者 R0 是 PG16.15 新独占实例/新卷下的 71 执行、71 通过、0 失败、0 跳过；application/persistence 类型检查通过。它们是 R0 的真实结果。本轮不会把语法检查说成 R1 PG 通过，也不把替换前的故障夹具结果当作合法消费证明。

既有 I16 首次 API 依赖构建失败、手动编译 IM 后 API 成功、冷构建未接受均原样保留，仍归 PR13。未修改任何 R0 日志、控制者记录或历史验证结论。PR14 仍 ACCEPT；本轮没有带入它。

## PR01-R1-LEGAL-SOURCE-CONSUMPTION

用实际 `inventory.issue-material` 命令消费源轴留存 1 米，替换原直接 UPDATE 余额夹具。测试查询并断言对应 COMMITTED 回执、issue 流水和分录：扣前 `500.0000`、变化 `-1.0000`、扣后 `499.0000`；子轴仍为 `500.0000`。实际 PgReworkFactsLookup 查询返回五类子轴下游事实均 false。

源码依据：`rework-repositories.ts` 的 `reelSplitReversalDownstream` 读取子轴下游，源 ID 当前不参与这一步；`rework-handlers.ts` 先对子轴调用 writeLine/closeUnitIfZero，再读取源余额并比较原倒轴留存。因此合法源轴消费在该候选上具备到达晚拒绝的代码路径。这是源码判断，实际运行仍待控制者 R1 验证。

为取得回滚前证据，测试用 Vitest spy 调用真实 `unitBalancesIncludingClosed` 原方法，并通过该实例绑定的同一个 PG 事务客户端额外 SELECT 子轴余额。原方法返回值原样返回；不替换 SQL 结果、不伪造 domain facts、不强制分支，也不增加业务写入。观测应看到源 `499.0000/active`、子 `0.0000/closed`，随后命中包含 `当前余额 499.0000 与倒轴后留存 500.0000` 的真实拒绝。spy 在 finally 恢复。

拒绝后的完整业务快照以及重放后的快照都须等于拒绝前快照；库存单元/余额、流水/分录、倒轴单/行/冲销记录、相关审计/Outbox 和全局关键计数均查询比较。拒绝回执仅一行，与返回值一致；同键重放后该实际方法总调用数仍为 1。

如果合法消费本身或冲销前置产生更早拒绝，实际结果会先输出，晚拒绝与事务内观测断言会失败。不得通过改规则、直接改余额、伪造查询返回值或弱化断言来让它通过。

## PR01-R1-QUERY-EVIDENCE

四种 shipping 模式和合法 rework 场景输出 `PR01_R1_EVIDENCE ` 前缀的 JSON 行。每行含场景、阶段、原 operationId 和关联测试对象 ID；阶段包括 before、after-first、after-replay，倒轴另有真实事务内观察与合法消费结果。

输出保留实际查询的标识、数量、状态、关键时间/计数与回执摘要；白名单排除 actor/owner/customer 名称、原始请求/Outbox payload、连接信息及凭据。断言仍使用未裁剪的完整业务行；脱敏只影响日志，不削弱比较。

shipping 新增流水/分录、关联审计/Outbox 的行查询，并保留原全部状态、数量、计数、回滚和重放断言。质量模式保持异常回滚，无持久回执；记录的第二次调用明确是 `same-key-retry-without-receipt`，不能称为回执重放。两次均须为真实 A-T12-3 质量异常，业务快照不变且回执为零。

## 作者实际验证

本环境 Linux x64 / Node v24.22.1，无项目 TypeScript/Vitest/pg/Nest 依赖，也无 psql/postgres/initdb/docker；未连接数据库。实际环境探测见 `author-r1-environment.json`。

实际命令：

```sh
node docs/review/evidence/pr-01/check-r1-syntax.mjs
```

结果为两份测试文件语法转换完成，退出 0，原始输出见 `author-r1-syntax.log`。这是语法检查，不是类型检查、项目构建或行为执行。增量补丁的前像/应用/后像比对记录随交付包提供。

R1 真实 PG / 项目 Vitest / 项目类型检查：`NOT_RUN`，业务测试执行 0；通过/失败/跳过数未生成。没有本地 PG 结果、查询快照或 PASS 可以预填。查询证据只会在控制者实际执行下面两个具名范围时产生。

## 控制者仅需增量验证

在父 head 上应用本补丁并提交，记录新 head 和测试文件 SHA256。继续使用控制者授权的新独占实例及白名单；原辅助文件重建固定测试库，因此 `PR01_R1_FRESH_LEGACY_URL` 必须是该新实例准确以 `/cadenza` 结尾、无查询串的连接，不得指向旧业务库。分开进程执行：

```sh
: "${PR01_R1_FRESH_LEGACY_URL:?必须绑定控制者新独占测试实例}"
DATABASE_URL="$PR01_R1_FRESH_LEGACY_URL" CADENZA_REQUIRE_PG=1 pnpm exec vitest run tests/integration/shipping-flow.spec.ts -t 'PR01 发运晚拒绝原子性' --reporter=verbose
DATABASE_URL="$PR01_R1_FRESH_LEGACY_URL" CADENZA_REQUIRE_PG=1 pnpm exec vitest run tests/integration/rework-flow.spec.ts -t 'PR01 倒轴冲销' --reporter=verbose
```

预期被选中的是 4+1 个场景；这不是已执行结果。`-t` 未选择的原用例在 Vitest 汇总中可能记为 skipped，必须与选中场景运行时跳过分开记录，不能把过滤数改写成零。五个选中场景缺 PG 均失败，不可 skip；stdout 必须保留实际 JSON 查询记录。其它 66 项 R0 有效用例及未变产品的类型检查证据复用，不重跑原 71 或旧 SIM。

接受仍由控制者裁定。R1 未通过时只处理真实具名根因；不改产品规则换绿，不修改历史迁移/冻结合同，不 merge/deploy，不触达真实外部渠道。独立 R6 原文与接收身份仍缺失，本 Chat 不替代它。
