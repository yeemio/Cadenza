# PR03 R2 — 有界产品引用修复

状态：**源码/本地入口与类型验证完成；真实 PG NOT_RUN；主控验收待定。**

## 准确绑定

- 原 PR3 / `codex/fix-03-quality-availability`。
- 唯一父 head：`b054adfaeeacb6f4f0afebded172357f302a9dec`。
- 父候选受测源/测：`c57980c53e0bd5003a1367f0d16c46d8861aca37`；原 fingerprint：`13326aea32477a1f100eff2180f541879e3fc3bee0ae757076736b080d035848`。
- 已接受 PR2 `0df991eac99a61132e50c10d8931d3532945dab2` 已在父候选中；本补丁不重复带入、不更改其测试夹具或重开其自身接受。
- R2 源/测 fingerprint：`7648c3cd9ec5c549e74544ecc9d330bb232f0b4d04295df65f1efcac2400a5df`。集合为原 16 路径加新增入口单测，共 **17 路径（12 产品源码 + 5 测试/测试配置）**；不是 Git commit。
- 主控裁定：`AUTHOR_R2_BOUNDED_PRODUCT_REPAIR`。此次未请求其它产品路径。

## 真实失败与修正

父候选 PR3 在新独占 PG 执行 **31 passed / 1 failed / 0 skip**。失败为合法自有预留消费；`holder_ref='PR03-task'` 是合法 text，却被应用默认写入 UUID 类型的 `stock_transaction.ref_id`，导致 SQLSTATE `22P02`。原错误、原32场景、原有效非 UUID holder 与竞争预留断言全部保留。

产品改动仅在 `packages/application/src/inventory-posting.ts` 的 `issueMaterial` 内：

1. 已验证预留没有显式 UUID 流水引用时，写入 `refType='reservation'` 与该真实预留的 `id`。即使 holder 文本长得像 UUID，也不自动推断成任务 UUID。
2. 显式、与原 holder 关联一致的非 UUID 文本别名仍可消费；改用同一真实预留 UUID 关联，同时保留原文本。只传 `refType` 不会形成 `task + reservation.id` 的错配。
3. 显式匹配的合法 UUID 引用保留原字段语义和原输入形式。识别 PostgreSQL 接受的大小写、花括号、无/部分连字符与四位分组格式；并完整匹配输入，避免把带尾换行的文本误判为 UUID。这不改变 holder 文本政策。
4. 对预留发料，现有审计 `after` 追加 `reservation: {id, holderType, holderRef}` 和 `ledgerReference`；文本不截断、不改写。原数量快照保留。无预留发料的引用与数量审计保持原行为。

所有者、企业/工厂、业务关联、有效期、库位/计量、质量留置、业务留置、竞争分配与负库存判断仍在原位置执行。机械核对确认写入前校验和 `issueMaterial` 之外的产品字节未变；预留消费、谱系和 outbox 代码未改。未改 schema、历史迁移、冻结合同、持久化实现或权限政策。

## 测试与保护

原 PG 文件 **24,154 字节 / SHA256 `a725cf13f9bae612a7a3cee2ba618b5ad4ce9cd637550eb1824ba1dc5b2e5184`** 完整成为新文件前缀，原32场景、所有正文与断言逐字节未变。仅在末尾追加8个 PG 场景，验证：文本默认/显式文本/仅类型、UUID holder 不隐式引用、显式 UUID 类型与ID/仅ID/替代拼写，以及无预留显式引用。

新增 PG 检查使用原真实命令总线、原空库初始化、相同键重放与实际 SQL 查询；检查唯一 issue 流水、余额15、剩余预留5、holder 原文和唯一审计。计划总数变为 **40 = 原32 + 新8**。这些新检查没有在本环境执行；不可据其源码称 PG PASS。

新增 `tests/pr03/issue-reference.unit.spec.ts` 调用实际 `issueMaterial`，以仓储端口替身检查上述应用输入/输出，以及他人预留和错业务引用在写入前被拒绝。**最终16/16 PASS，0 fail，0 skip**。此结果仅是本地应用边界证据，不证明 PG cast、事务、锁或总线重放。

首轮新增单测为14通过/2断言失败：错误已按预期拒绝，但测试错误地在 `Error.message` 内找 `IT-23`，实际属性是 `InventoryRuleViolation.rule`。仅修正这两处共用断言为检查 `name` 和 `rule`，保留首轮完整失败日志 `author-r2-issue-reference-unit-attempt1.log`，最终原始日志另存。没有为通过测试改动产品拒绝逻辑。

## 实际验证边界

| 项目 | 本轮结果 |
|---|---|
| application 源码类型 | 新执行 PASS，退出0 |
| tests/pr03 源码类型 | 最终测试版本新执行 PASS，退出0 |
| 新增应用入口单测 | 新执行16 PASS / 0 fail / 0 skip |
| 原22规则+24域回归 | 46条未变证据复用，不计新执行 |
| persistence 类型 | 未变证据复用，不计新执行 |
| PR3真实PG | NOT_RUN，计划40；未调用runner，业务执行0，实际skip0 |
| R2累计C2真实PG | NOT_RUN，计划129；需另一个新空库 |
| 安装/冷构建/现场/生产 | 未执行，无外推 |

本环境无专属 PG URL，也无 postgres/psql/docker；没有猜连接或访问保留失败库。R1累计C2的129 PASS与123实际查询仍属于 R1；共享产品路径本次已变，不能作为 R2 的真实回归结论。

原 R0/R1 作者和主控证据均不在补丁改动路径内。原R1 PG日志已实际读取并复算 **895,478字节 / SHA256 `2ad9948b9d4b1a4b6af9b71e7cb111e6fa8056c0aad50cdee10ab8041d462d2e`**，与父树 Git blob 和 receipt 一致；未修改或替换原件。

详细文件身份、运行命令、退出码、日志SHA、保护记录和证据边界见同目录 `author-r2.json`。交付包的 `DELIVERY-MANIFEST.json` 另行绑定完整增量patch SHA与实际隔离应用结果，`POSTIMAGES.sha256`列全部9个后像。

## 主控应用与验收

只在准确父 `b054adfaeeacb6f4f0afebded172357f302a9dec` 上应用这一个增量；父已含 R0、R1及接受的PR2，无需重放前置补丁。主控在新的 `cadenza_pr03_*` 空库运行40项真实PG，并在另一新的 `cadenza_pr02_*` 空库运行129项受影响C2。保留R1失败库/日志，不重跑非空库入口。

本作者没有 GitHub 写入、发布、合并或现场操作。本次仅交冻结增量；PR3尚未工程接受，全批仍3/15接受（#1、#2、#14）。
