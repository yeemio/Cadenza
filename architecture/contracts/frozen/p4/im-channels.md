# P4 冻结合同 — 企业微信/飞书 IM 渠道（企微/飞书问数接入）

版本：P4 冻结合同候选 v1｜2026-10-28｜WorkItem：P4 文档合同冻结（AI 问数·DSH 路数）（PM assignment 待补绑，如实标注）
状态：**待 PM 签发**。除显式引用外为 **[合同新造]**。溯源标记同 `frozen/p4/architecture.md`。

**线归属标记**：本文件主实施线为 **C（packages/integrations/im + apps/api/src/aiquery/im）**；与 A 线接入层（会话/审计/execute）与 B 线运行服务的接缝按 architecture.md／dsh-edge.md。Cadence 参考方案称复用「现有 integration-im」——**本仓不存在该包**（`packages/integrations/` 仅有 README/package.json），按开工包全新新建（LP P4-C 行），差异登记 GAP-P7。

## 1. 包定位与三端口

| 编号 | 规则（可判定） | 归属 |
| --- | --- | --- |
| IM-01 | `packages/integrations/im` 为全新边缘包，承载且仅承载：渠道协议适配（企微/飞书消息形状 ↔ 统一消息）、**mock 双向通道**、身份绑定端口、发送端口；企微/飞书的验签、解密、票据等企业应用能力为待授权桩（§5）。不在 DSH/运行服务内再维护一套身份、权限或业务查询（方案 §4：协议实现归 integration-im）。 | C |
| IM-02 | 统一消息端口：`InboundChannelMessage { channelKind: 'wecom' | 'feishu' | 'mock', enterpriseAppRef: string, platformUserId: string, platformMessageId: string, conversationTarget: { kind: 'direct' | 'group', ref: string }, messageType, content, receivedAt }`；`OutboundChannelMessage { channelKind, conversationTarget, content }`。接入层只消费统一形状，不感知平台差异。 | C |
| IM-03 | 身份绑定端口：`ImIdentityBindingPort { resolve(binding): Promise<{ userId } | null>, bind(...), unbind(...) }`——平台身份（channel+platformUserId，企业应用维度）→ Cadence `user_account`；绑定必须由用户主动发起并经验证（首版 mock 绑定为显式登记动作）；**绑定关系不是权限**，权限仍按 AQ-AUTH-01 每次重算。未绑定/解析失败 → `no_permission` + 引导绑定文案（AQ-AUTH-05）。 | C |
| IM-04 | 发送端口：`send(message): Promise<SendResult>`，`SendResult = { status: 'sent' | 'unknown' | 'failed', detail? }`——**发送结果未知态不得冒称严格送达**（方案 §6 末段）；`unknown` 须记录并允许人工核对，不自动补发。 | C |
| IM-05 | 身份绑定与渠道事件处理记录的持久化承载未定（C 线无迁移号；首版 mock 以包内存储承载合同行为）——真实接入授权时由 L0 分配迁移并落库（GAP-P8）。 | C/L0 |

## 2. 渠道事件处理合同（去重／重试／处理记录）

| 编号 | 规则（可判定） | 归属 |
| --- | --- | --- |
| IM-06 | 去重键 = `(channelKind, enterpriseAppRef, platformMessageId)`（按企业/应用及平台消息标识）；重复回调命中同一处理记录 → 幂等丢弃（可观测计数），不重复进入问数流程、不重复消耗模型、不重复回复（方案 §6 末段；先例：IF-08 五元组幂等、IT-19 流水幂等键同构思想）。 | C |
| IM-07 | 处理记录：每条入站消息建立一条处理记录（messageKey、requestId、处理阶段、发送结果、时间戳），生命周期可观测；重试（平台重推/己方重放）**复用同一处理记录**推进，不新建（方案 §6）。首版承载于 IM-05 声明的包内存储。 | C |
| IM-08 | 问数轮结果发送前，接入层执行**目的地与访问权限再检**（发送目的地必须是提问者本人会话或获准目的地；用户此时撤权 → 不发送，`sent_result_status='not_sent'` 计审计，AQ-S2）（方案 §5 第 5 条）。 | C/A |
| IM-09 | 链接回传：AI 回答中的详情链接为既有业务页面路由；打开仍需 Cadence 身份校验（OA 鉴权），IM 内不内置免登旁路（方案 §6 末段）。 | C/UI |

## 3. 群披露与目的地规则

| 编号 | 规则（可判定） | 归属 |
| --- | --- | --- |
| IM-10 | 首版以**个人会话（direct）为默认**问数与回复目的地；群会话收到提问时只允许两类应答：a) 获准的公共摘要（无具体业务数据）；b) 固定引导语（引导发起人进入个人会话提问）。**群内提问≠全群成员有权**看到提问者可见的数据（方案 §6；LP P4-C 行）。 | C/B |
| IM-11 | 群内业务数据披露需单独的目的地规则（披露范围/摘要口径/审批），首版未开放：群目标一律走 IM-10 b) 引导，能力执行不针对群目标放行（接入层对 `conversationTarget.kind='group'` 不创建问数轮，审计留拦截记录）。 | C |
| IM-12 | 会话按 租户(enterprise)/用户/渠道/会话目标 四元划分（ai_session.channel + conversation_ref 承载）；**不同渠道之间不自动拼接私密历史**（web 会话与 IM 会话、企微与飞书互不共享上下文）（方案 §6）。 | C/A |

## 4. 会话历史与权限撤销

| 编号 | 规则（可判定） | 归属 |
| --- | --- | --- |
| IM-13 | 权限撤销后：后续工具调用（AQ-AUTH-01 重验失败 → `no_permission`）、历史引用（回答中引用历史结论前重新执行能力查询取当前读面，AR-18）与回答交付（IM-08 发送前再检）**均执行新的权限检查**；已发出的历史消息不做追回（无此能力，如实声明）（方案 §6）。 | C/A/B |
| IM-14 | 渠道会话内的 AI 历史不是业务账本（AR-R5）；渠道消息内容不写生产库正文列（ai_session 无消息正文，AQ-S3）。 | C/A |

## 5. 真实验签解密与企业身份 = SITE_PENDING

| 编号 | 规则（可判定） | 归属 |
| --- | --- | --- |
| IM-15 | 首版 mock 双向通道承载全部合同行为：mock 入站（脚本化消息）→ 统一消息 → 接入层问数轮 → mock 出站；去重/重试/未知态/群拦截/撤权各一组可复现证据（LP P4-C 行）。 | C |
| IM-16 | 企微/飞书**真实**回调验签、消息解密、access_token/ticket 管理、企业应用凭据均为待授权桩（SITE_PENDING，GAP-P2）：接口与适配器存在不代表企业应用已开通或真实双向已验收（方案 §6 首段）；未经 Owner 授权不接通真实端点、不落真实凭据（LP 红线）。 | C |
| IM-17 | 企业应用凭据只存服务端凭据配置，不进提示词、页面、聊天或普通日志（方案 §6 末段；DS-26 同则）。 | C |

## 6. 分线验收门（架构级增量；六门按 LP 共同协议）

- C：mock 双向消息闭环（提问→澄清→回答）证据；IM-06 同一 platformMessageId 重推仅一次处理/一次回复；IM-04 发送 `unknown` 态不被改写为 `sent`；IM-10/11 群目标拦截与引导语；IM-13 撤权后不发送（`not_sent` 审计）。
- 与 A/B 接缝：im 入站经统一消息进入接入层会话流（AR-01）；出站经发送端口，发送结果回写 ai_query_audit（AQ-S2）。

## 7. 开放项引用

- GAP-P2（企微/飞书企业应用凭据未授权）、GAP-P7（参考方案 integration-im 差异）、GAP-P8（渠道持久化承载未定）。

— 规则统计：IM-01～IM-17 共 17 条规则（含红线成文 IM-04/10/11/13/16）。
