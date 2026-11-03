# P1 只读准备底稿（prep/p1）

状态：**只读咨询底稿，未经裁定**。本目录是 RunKit WorkItem `L0-PREP-TRANSFER`（assignment `assign-l0-prep-20261027`，接收别名 `zcode-cadenza-main`）的一次性原文移交，内容为 2026-10-27 在 L0 线完成的四项只读咨询原文。不得据此宣称任何功能已实现或任何冲突已裁定；其中冲突裁定建议与缺口清单仅供 L2 合同冻结与 PM/Owner 判断使用。

| 文件 | 覆盖 | 原执行者（ZCode 子代理） |
| --- | --- | --- |
| [01-foundation-rules-T03T04T06.md](01-foundation-rules-T03T04T06.md) | 底座域：组织权限/主数据/库存追溯内核/公共页面 | agent_db61efdb-d238-4e07-b44a-992d9d361b7c |
| [02-external-interface-facts-T02.md](02-external-interface-facts-T02.md) | 外部接口事实底册（13 接口族） | agent_79e9ff5c-31e4-40e5-8d69-2f3f7de440f8 |
| [03-production-chain-rules-T05T09T10T11.md](03-production-chain-rules-T05T09T10T11.md) | 生产侧：工艺/订单排程/三入口报工/领投料 | agent_571f07d4-cfc0-4b05-94de-2756c9ae5649 |
| [04-supply-chain-rules-T08T12T13T14.md](04-supply-chain-rules-T08T12T13T14.md) | 供应链侧：采购/质量/入库物流/装箱发运 | agent_7058b784-3246-4528-9edb-cfd5efb7dcd1 |

## 原执行环境与身份标注

- 四项咨询均由 L0 线（ZCode，项目分支标签 "Cadenza · main"，线程标题 "Cadenza 三包并行推进与门槛核查"）以 code-reviewer 角色（判断咨询模式）派发，派发档位 GLM-5.3（Owner 指定；**实际 provider 平台未另行核验，明写未知**）。
- 咨询为纯只读：未写任何项目文件；未做产品实施或验收。
- 子代理会话归属 L0 线，L0 内部会话 ID **不可读取（未知）**；客户端可重定位引用为上述线程标题/分支标签。结果原文位于 L0 会话上下文，本目录即其逐字移交载体，**不是按摘要重建**。
- 输入来源：`architecture/DOMAIN_MODEL.md`、`architecture/SYSTEM_ARCHITECTURE.md`、`requirements/PRD_ISSUES.md`、`requirements/PRD_TRACEABILITY.md`、三包 README/COMMON-CONTRACT 及 `requirements/source/PRD文档/` 下各文内引用原件。

## 使用规则

1. L2（`L2-T01-T02-CONTRACTS`）在本底稿基础上产出 `architecture/contracts/frozen/**` 冻结合同；本目录文件保持原样，不修改不删除。
2. 底稿中的"裁定建议/冲突清单/缺口清单"是咨询输入，须经原件核对与 PM/Owner 判断；**不得自动当作已接受**。
3. L1 实施线可引用本底稿的 schema Must 与平台表硬影响，但在 L2 冻结前不提前落实未冻结业务规则（对应 `P1-S1-BOOTSTRAP` 边界）。
4. L4 线（P2/P3）成果不在本目录，归 `architecture/contracts/prep/l4/**`（WorkItem `L4-PREP-IMPORT`，另行签发）。
