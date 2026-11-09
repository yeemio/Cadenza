# PR05 R0 — AI 轮次身份、缓存与结果隔离

状态：SOURCE_READY_PG_NOT_RUN_CONTROLLER_PENDING。不是控制者 ACCEPT。

原 PR #5 / `codex/fix-05-ai-turn-ownership`；精确原 head `f5c286b10ff0ae43082ef1a4bf65e38ef1d0faef`。
源码/测试集合 SHA256：`b68b2c968844fe3a5153a902f3c6103fd19dd9a455ba9a88cda9bb52417092bf`（不是 Git SHA）。

## 前置及应用

PR05 无功能依赖，但两个 AI 源码文件与已交 PR03 重叠。按合同重新绑定累计来源，只带入 PR03 R0 的四个精确后像：application aiquery service/repositories、persistence aiquery repositories、domain inventory availability；各哈希在清单中。PR03 仍待控制者接受。没有带入无关库存写/质量/发运实现。

从本 PR 原 head 应用 `pr05-r0-from-recorded-head.patch`；或先 `pr05-pr03-shared-prerequisite.patch` 后 `pr05-r0-increment.patch`，两条路线不可混用。每份都完整含 hunk，另有按文件分段与完整后像。

## 已实现

- 接入缓存原子绑定 enterprise/user/AI session/OA login session；已有归属不可覆盖。在途重复问、他人澄清/取消均拒绝。缓存淘汰连同 owner、信封和选项整体移除，选择成功消费整组选项。
- 信封登记核对 echo 与 auditRef；返回副本。回答仅按当前 requestId 的明确引用取结果，移除 lastEnvelope 回退。零工具 answer/refuse 不带旧信封；跨轮或不可信能力引用拒绝。
- 接受轮次、澄清/取消前，以及返回模型输出/澄清结果前实时复核会话归属、用户状态、模块/业务读权限及审计数据范围。取消会清除缓存且压制迟到回答。
- 审计重放核对企业、用户、AI 会话、能力版本及规范化查询指纹；不允许同序号换查询。旧审计仅允许完整已留证过滤条件重放。序号不同仍归同一个不可变 owner。
- PG audit insert 在 requestId 事务 advisory lock 内核对全部既有 owner 再写；pool 取得独占连接事务；已有 UoW SqlClient 沿用调用者事务、不提交外层。并发相同请求保留一条审计，不覆盖旧事实。
- 运行服务在首次 await 之前占住在途轮次，拒绝不同会话接管；同轮延续的工具序号持续递增。

## 实际验证和失败记录

应用层、持久化层、最终 PR05 测试源码类型检查 exit 0。有效不重复用例 **36 个**：19 个新增缓存/控制器/本地运行时用例 PASS，加 17 个相同候选上原 runtime/limits/cancel 回归 PASS。服务与外部模型/查询端口的替身边界在测试标题中明确，不能算真实 PG 或模型服务 PASS。

首轮新套件因缺 @nestjs/common 无法收集、类型检查还缺参数装饰器开关；第一次环境修复仅补装饰器配置，依赖链接仍缺，两个失败原件均保留。最终从已有本地缓存链接 Nest 11.2.8、reflect-metadata 0.2.2、rxjs 7.8.2 后仅重跑新增 19 用例及测试类型检查，均通过。没有锁定安装/冷构建声明。

真实 PG 调用 exit 1：缺 CADENZA_PR05_TEST_DB_URL，**NOT_RUN，0 业务用例执行**。14 个 PG 源码用例覆盖两用户/两企业/同用户两会话、同序及新序号冲突、合法重放/澄清、撤权、会话关闭，以及不同序号的首次 owner 并发竞争。没有 fallback/drop/skip。

```bash
CADENZA_PR05_TEST_DB_URL='<controller fresh exclusive cadenza_pr05_* database>' node node_modules/vitest/vitest.mjs run --config tests/pr05/vitest.config.ts tests/pr05/turn-ownership.pg.spec.ts --reporter=verbose
```

## 保留边界

利用原漏洞需要获知/碰撞 requestId 及命中进程缓存，不表述为无条件泄露。零工具轮次 owner/澄清缓存仍为进程态；重启后未知选项拒绝，没有声称持久恢复或多实例运行时接受。PG 锁路径尚未实跑；裸 SqlClient 必须是既有 UoW 事务客户端，pool 路径自行开事务。内部 execute 控制器未改映射，归属错误会成为其通用服务器错误，仍无数据及外来审计写入。生产/付费模型/企业渠道/现场/R6 未执行。源码五文件及测试证据均在原允许范围。
