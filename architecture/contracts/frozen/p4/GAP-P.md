# P4 缺口登记件（GAP-P）— AI 问数·DSH 路数

版本：P4 冻结合同候选 v1｜2026-10-28｜WorkItem：P4 文档合同冻结（PM assignment 待补绑，如实标注）
状态：**登记件，非实施依据**。本文件登记 P4 合同（`frozen/p4/` 另四份）实施前未闭合的缺口与外部输入依赖；裁定/授权前，各合同按「裁定前行为」列执行，不得以规划完成替代授权（Cadence 方案 §8 末段同则）。Cadence 参考方案与本仓实况冲突处一律以本仓实况为准，差异集中登记于 GAP-P7。

| 编号 | 缺口 | 影响的合同条款 | 裁定前行为（可判定） | 待谁输入 |
| --- | --- | --- | --- | --- |
| GAP-P1 | **真实 DSH 包与版本未定**：DSH 官方仓库处开发预览阶段（兼容性可能变化），OwlCodaE 本地声明（`0.2.1-rc.2.owlcoda.1`）只是参考仓声明，不构成本仓版本选择（方案 §10）。 | dsh-edge.md DS-14/DS-25 | 运行时声明保持 `{ kind:'mock', version:'mock-1', profileRef:null }`；不引入真实包依赖；mock 承载全部合同行为。 | Owner（选定版本+Profile 后出 accepted ADR） |
| GAP-P2 | **企微/飞书企业应用凭据未授权**：真实回调验签、消息解密、票据、企业身份未开通。 | im-channels.md IM-16/17 | 真实渠道实现为显式桩（SITE_PENDING）；mock 双向先行；不接通真实端点、不落真实凭据。 | Owner（企业应用开通与凭据交付） |
| GAP-P3 | **真实模型/付费调用未授权**：模型提供方、费用上限、租户并发预算未定。 | dsh-edge.md DS-13/25/26 | 只用 mock 模型适配器；不产生任何付费调用；限额配置以 mock 维度先行验证合同行为。 | Owner（模型与费用上限具名绑定） |
| GAP-P4 | **上游读面未接的问法与口径缺口**（对应问法必须显示「数据源未就绪」，不得把空集合算成零值经营事实）：① 采购/外协交货逾期及其对工作令的影响（`purchase_order_line.planned_receipt_date` 存在，「影响哪些工作令」无关联读面）；② 工时与经营统计（`labor_record`（0008）原始行无版本化统计口径；`engine-reporting` 不在本仓）；③ 报表口径类问法（良率/损耗/在制/交期，无版本化指标读面）；④ **BOM 行数量基数语义未冻结**（`manufacturing_bom_revision.lines` 的 quantity 单件用量 vs 订单总量，P1 无裁定、`requirements.ts` 仅覆盖工序下线量推导）→ AQ-C2 缺口数值列依赖注册参数 `requirementBase`；⑤ 跨源单位自动换算策略未定（BOM uom / stock uom / purchase uom 不一致时不折算）。 | capability-contract.md §3（AQ-C2）、§8 未就绪问法族、AQ-REG-08 | ①②③ 返回 `source_not_ready`（§8 固定清单）；④ 缺口数值列固定「口径未定」标注；⑤ 标注「单位不一致未折算」。 | Owner+PM（口径裁定）/后续读面建设 |
| GAP-P5 | **敏感域授权与字段策略待定**：薪酬、个人工时（`labor_record` 操作工维度、`production_report.operator_*`）、成本/价格（`purchase_receipt_batch.unit_price/avg_price/price_history/deviation_ppm/price_flag` 及复核列）不因拥有 `aiquery.use` 一并开放。 | capability-contract.md §2～§4 允许字段白名单 | 首版三能力字段白名单已物理排除价格复核列与操作工个人明细行；个人工时/薪酬/成本问法一律 `not_supported`（未注册能力）。 | Owner（分级授权与字段策略） |
| GAP-P6 | **受限内容首版不向 AI 暴露**：依赖自声明 clearance 的受限资料（如受控图纸，参考方案引 P2-3/O5 身份绑定待定）不进入任何问数能力或知识检索面。 | capability-contract.md §0（注册表只登记获准能力） | 首版不建图纸/文档检索能力；受限域对象不出现在字段白名单。 | Owner（clearance 机制裁定） |
| GAP-P7 | **Cadence 参考方案与本仓实况差异清单**（冲突处以本仓实况为准）：① 参考方案「现有 integration-im」——本仓无，`packages/integrations/im` 全新；② `packages/integration-dsh`——本仓无，全新；③ `apps/server`——本仓为 `apps/api`；④ `engine-reporting`/`business-store`——本仓无，AQ 能力直建 `packages/application`/`packages/persistence` 读面；⑤ OwlCodaE 的主壳选择不适用（本产品主界面仍是 MES 工作台，问数为模块）；⑥ LP 线路表前向引用的文件名 `ai-query-architecture.md` 实际落盘为 **本目录 `architecture.md`**（2026-10-28 Owner 派发任务指定名，LP 撰写于合同落盘前，不改 LP 原文）。 | architecture.md AR-05；各合同落位条款 | 按 architecture.md AR-05 与各合同「本仓落位」执行；各线读合同指针时按 ⑥ 对名。不按参考方案命名扩权或改共享结构。 | 已按本仓实况冻结，无需输入（留痕） |
| GAP-P8 | **渠道事件处理记录与身份绑定的持久化承载未定**：C 线无迁移号；0021 三表（capability/audit/session）不含渠道去重与绑定存储。 | im-channels.md IM-05/07 | 首版 mock 以 `packages/integrations/im` 包内存储承载（进程内）；真实接入授权时由 L0 分配迁移号落库，合同行为不变。 | L0（真实接入阶段分配） |
| GAP-P9 | **`order_operation.execution_status` 无置位路径**：0005 迁移注释称「由报工域置位」，0008 报工域落地后未见任何回写（全仓无 setter）；该列当前恒为 `pending`。 | capability-contract.md §2（AQ-C1 未完成任务判定） | AQ-C1 不以该列宣称工序已执行/未执行；未完成判定只依据五量与排程事实。若后续回写落地，需修订 AQ-C1 口径（合同修订而非实施线自定）。 | PM/后续域裁定 |
| GAP-P10 | **SaaS 多租户共享运行进程的隔离证明未做**：共享 apps/ai 进程须先证明上下文、插件状态、缓存与日志的租户隔离；仅会话携带 tenantId 不构成隔离证明（方案 §3 末段）。 | architecture.md AR-07～09 | 首版按私有化部署/单租户运行实例基线交付与验收；不宣称 SaaS 共享进程形态可用。 | Owner（SaaS 形态决策+隔离验收方案） |
| GAP-P11 | **时间基准/时区部署约定未成文**：本仓无工厂级时区配置；既有实现混用 UTC ISO 字符串与本地日期列（如 `scheduling-queries.ts` 的 `today()` 取 UTC 切日）。 | capability-contract.md §1 时间基准总则 | 自然语言相对时间统一按 Asia/Shanghai 换算并在 `contextEcho` 回显实际起止；绝对时间传参必须 ISO-8601 含偏移；不承诺工厂级时区配置。 | Owner（部署时区约定成文） |

## 使用规则

1. 各实施线开工时通读本件；遇本件登记边界内问法/字段，按「裁定前行为」执行并在交付记录引用对应 GAP-Pxx。
2. 裁定或授权落地后：由 PM/L0 更新本件状态与对应冻结合同条款，实施线不得据本件自行扩大范围。
3. 新增缺口按同一格式追加编号（GAP-P12 起），不得删改既有行（留痕）。
