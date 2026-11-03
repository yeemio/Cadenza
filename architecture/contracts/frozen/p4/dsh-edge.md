# P4 冻结合同 — apps/ai 独立运行服务与 DSH 边缘（DSH 路数）

版本：P4 冻结合同候选 v1｜2026-10-28｜WorkItem：P4 文档合同冻结（AI 问数·DSH 路数）（PM assignment 待补绑，如实标注）
状态：**待 PM 签发**。除显式引用外为 **[合同新造]**。溯源标记同 `frozen/p4/architecture.md`（方案 §x／LP／OA-xx／GAP-Pxx；仓内文件直接引用）。

**线归属标记**：本文件主实施线为 **B（apps/ai + packages/integrations/dsh）**；§4 内部接口形状同时约束 A 线实现（B 线按本合同先行 mock，L0 接通）。

## 1. 进程边界与职责

| 编号 | 规则（可判定） | 归属 |
| --- | --- | --- |
| DS-01 | apps/ai 承担且仅承担：会话编排、模型调用（首版 mock 适配器）、工具调用循环（唯一工具族=受控查询）、澄清交互、超时/限额/取消管理、运行与会话记录存储。业务查询权限、业务含义与可展示结果裁定归接入层/受控查询层（AR-01），apps/ai 不重复实现一套权限或业务查询（方案 §4 职责表）。 | B |
| DS-02 | apps/ai **无生产数据库账号、不执行 SQL、不挂载生产数据目录**（AR-R2）；其全部业务数据获取经 §4 内部受控查询接口；其自有持久化（会话存储、运行记录）写入独立数据目录（AR-08）。 | B |
| DS-03 | apps/ai 对外仅暴露两组 HTTP 面：**公开运行接口**（§5，仅接受接入层转发，内部服务凭据认证）与**健康接口**（§5 health，供探测与降级判定）。不暴露通用终端、任意文件访问、自由网络访问、动态插件安装（方案 §2 第 3 条/§4 插件边界）。 | B |
| DS-04 | 依赖方向：`packages/integrations/dsh` 只被 apps/ai 组合根与自身测试引用；**不得**被 packages/domain、packages/application、packages/contracts、packages/ui、apps/api 引用（厂商类型止于此包，方案 §2 第 2 条；先例：domain→contracts 允许、集成包不入业务核心）。apps/api 的 aiquery 接入层只消费 `contracts/src/aiquery.ts` 类型。 | B/A |
| DS-05 | 会话/工具成功只表示 AI 执行状态，不创建生产事实、不构成业务审批（AR-R4）；apps/ai 无任何生产写通道可调用。 | B |

## 2. 运行行为合同（会话／编排／澄清／超时／限额／取消）

| 编号 | 规则（可判定） | 归属 |
| --- | --- | --- |
| DS-06 | 会话生命周期：open → active（轮次进行）→ closed（用户结束/超时空闲）→ 过期清理；会话记录（消息、工具调用、模型应答）按 requestId 归档于 apps/ai 会话存储；会话身份锚点在接入层 `ai_session` 表（AR-19），两边以 sessionId 关联。 | B |
| DS-07 | 工具调用循环：每轮 turn 内 apps/ai 可多次调用受控查询（每次携带同一 requestId + 递增 toolCallSeq）；**单轮工具调用次数上限**（配置，缺省 8）触发即停止继续调工具，以「已达工具调用上限」状态收口作答（用已获结构化结果解释，不得虚构未取数据）。 | B |
| DS-08 | 澄清交互：模型返回澄清意图时，apps/ai 以结构化澄清消息（question + options[]）结束本轮等待用户输入；选项来自能力结果（如 AQ-AMB-01 候选清单/AQ-AMB-03 口径选项），不由模型自由编造对象；用户答复后延续同一 requestId 继续（AQ-AMB-04）。 | B |
| DS-09 | 超时合同：单次受控查询等待超时（对齐 A 线 execute 超时，§4）与单轮总预算超时（配置）分别可判；超时后**停止继续调工具**，返回可理解状态（`timeout` + 已完成阶段说明），已取部分数据须带完整性标注（未取全不得总结为完整总量）。 | B |
| DS-10 | 限额合同：按租户（enterprise）配置并发轮数、日调用次数、单轮预算；超限拒绝新轮并返回「已超限/暂不可用」可理解状态（不无限重试、不排队放大；失败重试上限与退避由配置声明）。限额触发不影响生产进程（AR-13）。 | B |
| DS-11 | 取消合同：用户或渠道可取消在途轮次（§5 cancel）；收到取消后 apps/ai **不再发起任何新的工具调用**，在途查询按底层能力取消语义处理（不可取消则等待其返回后丢弃），最终状态=`cancelled`（含已完成的阶段摘要）；取消后不得再产生发送动作（IM 目的地按 im-channels.md 处理）。 | B |
| DS-12 | 回答组织：数字与来源由结构化结果（信封 data/completeness/freshness）呈现，模型生成解释并区分事实与推测（AQ-C3 §4 事实列 vs 解释）；发送前的目的地与访问权限再检由接入层完成（AR-01；im-channels.md §3）。 | B/A |
| DS-13 | mock 模型适配器承载**全部合同行为**：澄清返回、结构化作答、拒绝越权问法（提示走业务页面）、超时/限额/取消的可复现场景；mock 响应可脚本化（按测试注入），不依赖外部服务（LP 红线：真实付费模型不接通）。 | B |

## 3. packages/integrations/dsh 边缘包

| 编号 | 规则（可判定） | 归属 |
| --- | --- | --- |
| DS-14 | 包内固定**版本声明**（单一只读常量，如 `DSH_RUNTIME_DECLARATION = { kind: 'mock', version: 'mock-1', profileRef: null }`）；产品启动可读回实际组成（方案 §2 第 3 条）。真实 DSH 包/Profile/插件版本选定前，declaration 保持 mock 占位且 `profileRef=null`；版本选择 = SITE_PENDING（GAP-P1），未授权不得引入真实包依赖。 | B |
| DS-15 | 公开接口（包出口仅此四族，厂商类型不外泄）：`ModelClientPort`（对话/工具调用协议，输入消息与工具描述、输出文本+工具调用意图+用量或 unknown）；`ToolDescriptor/ToolResult`（对 §4 受控查询的抽象，字段与信封对齐）；`SessionStorePort`（会话记录读写，落独立数据目录）；`RuntimeProfile`（超时/限额/取消配置的装载）。 | B |
| DS-16 | mock 模型适配器实现 `ModelClientPort`：确定性、可注入脚本；其行为覆盖 DS-06～DS-13 的每条可观察状态（测试断言位）；不访问网络、不产生付费调用。 | B |
| DS-17 | 包自身零业务依赖（不 import domain/application/contracts 业务面；仅可复用通用工具类型）；apps/ai 组合根装配 ModelClientPort（mock）、ToolDescriptor→受控查询客户端（§4）、SessionStorePort（本地实现）、RuntimeProfile（env 配置）。 | B |

## 4. 内部受控查询 HTTP 接口形状（B→A；A 线实现、B 线先行 mock）

端点基址：`http://<apps/api>/internal/aiquery`（部署内部网络；认证=部署配置的内部服务令牌 `Authorization: Bearer <internal-token>`，非用户令牌；服务令牌**不构成权限来源**——权限仍按 AQ-AUTH-01 由 A 线对会话绑定用户实时重算）。

| 编号 | 合同 | 归属 |
| --- | --- | --- |
| DS-18 | `POST /internal/aiquery/capabilities`，体 `{ sessionId: string }` → `200 { capabilities: Array<{ capabilityId, version, displayName, description, inputSchema }>, unreadyTopics: Array<{ topic, message }> }`。A 线按会话绑定用户做许可预检（AQ-REG-05）；会话不存在/失效 → `404 { code: 'ERR_AI_SESSION_NOT_FOUND' }`。 | A 实现/B 消费 |
| DS-19 | `POST /internal/aiquery/execute`，体 `{ requestId: string, toolCallSeq: number, sessionId: string, capabilityId: string, capabilityVersion: number, params: object }` → `200` 结果信封（AQ-REG-07：status/data/completeness/freshness/contextEcho/auditRef，wire 类型落 `contracts/src/aiquery.ts`）；非 2xx 统一错误形状（先例 `AllExceptionsFilter`，`ERR_` 前缀）。请求体中任何 tenant/user/scope 字段被忽略并记审计（AQ-REG-06）。 | A 实现/B 消费 |
| DS-20 | execute 语义状态映射：能力未注册→`not_supported`；未就绪问法族→`source_not_ready`（§capabilities 清单命中）；许可/范围不过→`no_permission`；A 侧查询超时→`timeout`（A 线单次 execute 服务端耗时上限配置，缺省 15s）；其余异常→`failed`（带阶段码）。**A 线不得把错误伪装成 ok_no_records**（AQ-REG-10）。 | A |
| DS-21 | B 线受控查询客户端（`apps/ai` 内）按本合同形状实现 HTTP 客户端 + **合同级 mock**（测试不经网络即回放信封）；L0 整合前 A/B 两线各自以本节形状为共同冻结面，字段漂移视为合同违约（双方 supertest 断言同一信封样例）。 | B（客户端）/A（端点） |
| DS-22 | 传输与重试：内部调用失败（网络/5xx）B 侧有限重试（同一 requestId+toolCallSeq 幂等——A 线以 `UNIQUE (request_id, tool_call_seq)` 识别重复执行并返回既有审计结果，AQ-S2）；重试耗尽 → `failed` 可理解状态。 | A/B |

## 5. apps/ai 公开运行接口（接入层→apps/ai；B 线实现）

| 编号 | 合同 | 归属 |
| --- | --- | --- |
| DS-23 | `POST /ai-runtime/sessions` 体 `{ sessionId, enterpriseId, userId, channel, conversationRef }`（由接入层在建 ai_session 后同步登记；此处仅作运行时会话索引，不赋权）→ `201`。`POST /ai-runtime/turns` 体 `{ requestId, sessionId, userMessage, timeBasis: { timeZone: 'Asia/Shanghai' } }` → `200 { outcome: 'answer' | 'clarify' | 'unavailable' | 'cancelled', message?, options?, answerRefs?, statusDetail }`（同步请求/应答；流式留待真实 DSH 版本选定时再裁定，首版不承诺）。`POST /ai-runtime/turns/:requestId/cancel` → `200 { status: 'cancelled' }`。`GET /ai-runtime/health` → `200 { status:'ok', runtime: DSH_RUNTIME_DECLARATION }`（探测与 UI「暂不可用」判定源，AR-11）。 | B 实现/A 消费 |
| DS-24 | 接入层对 apps/ai 的转发设超时上限（AR-12）；unreachable/over_limit/starting 三类不可用原因透传给 UI 降级态与 IM 引导文案。 | A/B |

## 6. SITE_PENDING（不自动接通）

| 编号 | 规则 | 归属 |
| --- | --- | --- |
| DS-25 | 真实 DSH 版本选择、真实模型调用、付费凭据均为 SITE_PENDING（GAP-P1/P3）：未经 Owner 授权不得引入真实包、不得配置真实模型端点、不得产生付费调用；mock 承载全部合同行为（LP 红线；方案 §8「先合成数据证明技术接缝」）。 | B |
| DS-26 | 模型密钥/凭据只存于服务端凭据配置，不进提示词、页面、聊天或普通日志；外发模型的数据须在查询授权之后按模型使用策略裁剪；客户数据能否离开部署环境是独立配置与授权条件（方案 §6 末段）。首版 mock 无外发，该条为真实接入前置约束。 | B |

## 7. 分线验收门（架构级增量；六门按 LP 共同协议）

- B：停 apps/ai 进程 → 生产命令路径与 `GET /health` 行为不变的故障隔离证明（LP P4-B 行）；DS-09/10/11 超时/限额/取消各一组可复现证据（mock 脚本驱动）；DS-21 信封断言与 A 线样例一致。
- A：`/internal/aiquery/capabilities|execute` 的 supertest 证据覆盖 AQ-REG-07 七状态与 AQ-AUTH 重验（撤权后 execute 立即 no_permission）。
- L0：B↔A 真实接线替换双方 mock（AR-22）。

## 8. 开放项引用

- GAP-P1（真实 DSH 包与版本）、GAP-P3（真实模型/付费）、GAP-P10（SaaS 共享进程隔离证明：首版按私有化/单租户基线，共享运行进程须先证明上下文/插件状态/缓存/日志的租户隔离——方案 §3 末段）。

— 规则统计：DS-01～DS-26 共 26 条规则（含红线成文 DS-02/05/13/25）。
