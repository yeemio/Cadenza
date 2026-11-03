# P4 冻结合同 — 受控问数能力合同（能力注册表 + 首版三能力）

版本：P4 冻结合同候选 v1｜2026-10-28｜WorkItem：P4 文档合同冻结（AI 问数·DSH 路数）（PM assignment 待补绑，如实标注）
状态：**待 PM 签发**。除显式引用 P1 冻结条款与仓内既有实现外，本文件规则为 **[合同新造]**，签发前不视为已接受。

**溯源标记**：（方案 §x）= Cadence `ai-query-dsh-proposal.md`；（OA-xx/IT-xx/IF-xx）= `frozen/p1/` 合同；（S02/S14/A3-4/A5-3 等）= P1 底稿裁定号（沿用现有实现注释口径）；（GAP-Pxx）= `frozen/p4/GAP-P.md`；仓内映射证据一律写 **真实文件路径 + 符号/字段名 + 表名**（2026-10-28 本实施者实地复核，可抽查核对）。Cadence 参考方案与本仓实况冲突处以本仓实况为准（GAP-P7）。

**线归属标记**：A=P4-A（本合同主实施线）；B=P4-B；C=P4-C；UI=P4-UI；L0=整合。除标注外，本文件条款归 **A 线**实施；wire DTO 落 `packages/contracts/src/aiquery.ts`（A 线新增，L0 并桶）。

## 0. 机制总则：能力注册表

| 编号 | 规则（可判定） | 归属 |
| --- | --- | --- |
| AQ-REG-01 | 一切问数取数只能通过**已注册能力**（capabilityId + version）执行；未注册能力 → `not_supported`；登记为「未就绪问法族」（§8 清单）→ `source_not_ready`。两态都必须以可理解文案回用户，不得以空数据冒充。 | A |
| AQ-REG-02 | 注册表只登记**只读查询能力**（输入 schema、所需权限、允许对象与字段白名单、最大查询范围、口径参数）；任何含写语义或命令调用的定义一律非法（红线 AR-R1）。 | A |
| AQ-REG-03 | 注册行企业级隔离：`(enterprise_id, capability_id, version)` 唯一；同 `(enterprise_id, capability_id)` 至多一条 `enabled` 版本（partial unique，库层双保险，先例 0007 `schedule_slot_identity_unique`）。启停由服务端管理动作完成（许可 `aiquery.admin`），**不由 AI 会话触发**；首版三能力注册行由部署初始化 seed 写入。 | A |
| AQ-REG-04 | 版本语义：能力定义变更（输入 schema/字段白名单/口径参数）必须递增 version 并走新注册行；执行结果携带 `capabilityVersion`，审计按其归档；旧版本行停用后存量会话只可继续读取、不可新发起。 | A |
| AQ-REG-05 | 能力枚举接口（dsh-edge.md §4 `capabilities`）只返回当前用户**通过许可预检**的 enabled 能力 + 未就绪问法族清单；预检失败的能力对模型不可见（缩小可见面，AR-R3）。 | A |
| AQ-REG-06 | 执行入口唯一：`POST /internal/aiquery/execute`（接入层内部接口，形状见 dsh-edge.md §4）；参数中凡属执行上下文（tenant/user/scope/requestId/sessionId）一律以服务端绑定为准，**请求体携带的同名字段忽略并记审计**（不可由模型替换，方案 §5 第 1 条）。 | A/B |
| AQ-REG-07 | 结果信封（wire，`contracts/src/aiquery.ts`）固定六段承载：`status`（7 值：`ok_with_data`/`ok_no_records`/`no_permission`/`not_supported`/`source_not_ready`/`timeout`/`failed`，对应方案 §5「超时／失败」拆为两机器态）+ `data`（能力结果 DTO）+ `completeness`（truncated/fetchedRows/totalKnown/total/page）+ `freshness`（queriedAt + 各数据源 updatedAt 或 `unknown`）+ `contextEcho`（服务端实际生效的执行上下文与有效过滤条件）+ `auditRef`（requestId/toolCallSeq）。 | A |
| AQ-REG-08 | **零值＝有效查询产物**：查询成功且读面有对象时，数值为零（如五量全 `"0.0000"`）返回 `ok_with_data` 与零值；`ok_no_records` 仅用于「过滤条件有效但无匹配对象」。`source_not_ready` 仅用于 §8 已登记的未接读面问法，**不得把空集合算成零值经营事实**（方案 §5 D-18 边界）。 | A |
| AQ-REG-09 | 数量字段一律 `DecimalString`（`packages/contracts/src/decimal.ts`，≤4 位小数，禁 number）；分页复用 `PageRequest/PageResult`（`packages/contracts/src/pagination.ts`，pageSize 服务端上限 100，先例 `toPageRequest`）。 | A |
| AQ-REG-10 | `timeout`/`failed` 均须落审计（result_status），并携带阶段标识（query/model/orchestration）；失败不得降级伪装成 `ok_no_records`。 | A/B |

## 1. 六段合同模板（每能力按此六段冻结；方案 §5 合同字段表逐项落位）

| 段 | 必备内容 | 承载位 |
| --- | --- | --- |
| ①能力定义 | capabilityId、版本、业务说明、输入 schema、所需权限、允许对象与字段、最大查询范围 | 注册表 definition + 本文件 §2～§4 |
| ②执行上下文 | 服务端绑定 tenant/user/scope、渠道与会话归属、requestId；不可由模型替换 | AQ-AUTH；信封 `contextEcho` |
| ③数据结果 | 行列、单位、有效过滤条件、统计口径及版本、时间基准与时区、来源记录引用 | 各能力结果 DTO（来源引用＝真实表名+业务键） |
| ④完整性与时效 | 查询时刻、各数据源更新时间或 unknown、完整/截断、已取行数、总量可知性、分页；**未取全不得总结为完整总量** | 信封 `completeness`/`freshness` + AQ-REG-07 |
| ⑤结果状态 | 7 值（AQ-REG-07）；零值＝有效查询产物 | 信封 `status` |
| ⑥审计关联 | 用户请求、工具调用、结果引用、模型/插件版本、发送结果、用量与耗时；用量未知如实标记 | `ai_query_audit`（AQ-S2）+ AR-15/16 |

时间基准总则（**[合同新造·部署约定]**）：服务端时间一律 ISO-8601（UTC，先例 `now().toISOString()`）；自然语言相对时间（"本周/最近 7 天"）由 B 线编排层换算为显式起止时刻后传参，**换算时区 Asia/Shanghai**，并在 `contextEcho` 回显实际起止；本仓无工厂级时区配置（登记 GAP-P11）。

## 2. AQ-C1 订单进度（capabilityId `aq.order-progress`，首版 v1）

**业务说明**：回答「这张工作令/生产订单目前做到哪一步，还有哪些任务没完成」。单订单只读视图：对象、当前状态、五量、排程完成度、未完成任务。

①能力定义：输入 schema `{ orderRef: { kind: 'orderId' | 'orderNo' | 'orderNoLike' | 'salesOrderNo', value: string } }`（orderRef 为空 → 语义非法，`failed` 带提示）；所需权限 `['aiquery.use','process.read','execution.read','scheduling.read']`；最大查询范围：单订单 + 当前设置版本工序全量（`order_operation` 单订单行数有限，无分页需求；五量/排程均为单订单投影）。

②执行上下文：enterpriseId 由会话绑定派生；订单可见性 = `dataScope`（OA-25：enterpriseWide 或 plantIds）；请求无 plantId 时按 dataScope 收敛（先例 `plantFilter`，`process-queries.ts`）。

③④⑤数据结果、完整性与时效、状态（字段级映射，全部为仓内真实读面）：

| 结果要素 | 读面证据（文件 + 符号 + 表） | 口径 |
| --- | --- | --- |
| 对象与当前状态 | `production_order`（0005）：`order_no`（`UNIQUE (enterprise_id, order_no)`，企业内单号唯一——重名歧义仅出现在模糊/销售单号路径，见 AQ-AMB-01）、`order_status` 六值 `ProductionOrderStatusDtoValue`（`packages/contracts/src/process.ts`：approved/released/in_progress/pending_completion/closed/voided）、`suspended/suspended_reason`、`process_config_status`、`actual_start_at/planned_start_at/planned_finish_at/business_closed_at/erp_closed_at`；DTO `ProductionOrderDto`（process.ts）；查询 `listOrders/getOrderDetail`（`packages/application/src/process-queries.ts`） | 状态轴 0005 CHECK 原文 |
| 五量（总+分工序） | `FiveQuantitiesDto`（`packages/contracts/src/execution.ts`：draftQty/submittedQty/approvedQty/qualifiedQty/stockedQty）；`OrderQuantitiesView.total/operations[].quantities`（`packages/application/src/execution-queries.ts` `orderQuantities`）；纯函数 `computeFiveQuantities`（`packages/domain/src/execution/quantities.ts`）；事实表 `production_report` + `report_output`（0008：status/review_status/quantity/qualified_qty/stock_unit_id） | S02/A5-3：五量分立、禁混口径；submitted=已提交待审、approved=审核通过未撤审、stocked=审核通过且 `stock_unit_id` 非空 |
| 排程完成度 | `OrderSchedulingViewDto.schedulingStatus`（unplanned/partially_scheduled/fully_scheduled）与 `OrderViewOperationDto.scheduledQty/offlineQty/fullyScheduled`（`packages/contracts/src/scheduling.ts`）；`orderView`（`packages/application/src/scheduling-queries.ts`）；表 `schedule_slot`（0007，五元组唯一）；投影纯函数 `projectOperationScheduling/projectOrderSchedulingStatus`（domain scheduling） | A3-4：scheduledQty=该工序槽位计划合计；fullyScheduled=计划合计 ≥ 下线数量；订单级状态由各工序投影汇总 |
| 未完成任务 | `order_operation`（0005）当前 `settings_version` 行（先例 `listCurrentByOrder`，execution-queries.ts:176）：`seq/operation_name/offline_qty/uom`；就绪判定 `computeOperationReadiness` → `ready/readyReason`（execution-queries.ts:218-241，`packages/domain/src/execution/readiness.ts`）；**`execution_status` 列当前无置位路径（0005 注释称由报工域置位、0008 落地后未回写）——AQ-C1 不得以该列宣称"已执行/未执行"，未完成判定=五量与排程事实**（GAP-P9） | 未完成任务=（排程未排完 或 审核通过量为零）的当前版本工序行，逐行附五量与 readyReason |
| 料品描述 | `production_order.material_snapshot`（jsonb 快照：name/spec/color，先例 `materialDesc()` 拼接口径，scheduling-queries.ts:404-410） | 快照口径（组织变更不回写，IT-S2 同则） |
| 时效 | 各源行 `updated_at`（production_order/order_operation/schedule_slot/production_report）；`queriedAt`=服务端执行时刻 | freshness 信封 |

允许字段白名单：上表所列列名 + `order_type/sales_contract_no/sales_order_no/line_no/production_qty/uom/bom_revision_id/route_revision_id`。**不含**：操作工个人维度的报工明细行（报工单级明细、操作工姓名归 execution 页面，不进 AQ-C1 结果；个人工时属敏感域 GAP-P5）。

⑥审计关联：`ai_query_audit` 按 AQ-S2 落 `capability_id='aq.order-progress'`、参数、状态、行数、耗时。

歧义澄清（AQ-AMB-01/02）：`orderNoLike/salesOrderNo` 命中多订单 → 返回候选清单（orderNo、plantId、orderStatus、料品描述、`business_time` 最近者），AI 呈现选项待确认；精确 `orderNo/orderId` 唯一命中直接执行。

## 3. AQ-C2 物料缺口（capabilityId `aq.material-shortage`，首版 v1）

**业务说明**：回答「这张订单还缺哪些材料，哪些已有采购安排」。单订单只读视图：BOM 需求行 vs 当前可用量 vs 采购未交量，逐料品并排呈现，关联采购单行及状态。

①能力定义：输入 schema `{ orderRef: { kind: 'orderId' | 'orderNo' | 'orderNoLike' | 'salesOrderNo', value: string }, includePurchaseLines?: boolean（缺省 true）}`；所需权限 `['aiquery.use','process.read','inventory.read','purchase.read']`；最大查询范围：单订单 BOM 行 ≤ 500、每料品关联采购行 ≤ 200（超限截断并标 truncated）。

②执行上下文：同 AQ-C1；库存与采购行均按 `plant_id` ∈ dataScope 收敛（先例 `plantScope`，inventory/purchase-queries.ts）。

③④⑤字段级映射：

| 结果要素 | 读面证据（文件 + 符号 + 表） | 口径 |
| --- | --- | --- |
| BOM 需求行 | `production_order.bom_revision_id` → `manufacturing_bom_revision`（0005）`lines` jsonb（`BomLineDto`：materialId/materialCode/quantity/uom，`packages/contracts/src/process.ts`）；查询先例 `listBoms`（process-queries.ts）；订单未冻结 BOM（`bom_revision_id` 为 null）→ `ok_no_records` + 附注「该订单未冻结 BOM 版本」，不视为缺料为零 | 行数量按 BOM 原文呈现；**基数语义（单件用量 vs 订单总量）P1 未冻结**（`requirements.ts` 仅覆盖工序下线量推导，无料品消耗推导）→ 缺口数值列首版固定返回「口径未定」标注，除非注册行口径参数 `requirementBase` 已显式配置（'per_unit'×production_qty 或 'total'）（GAP-P4） |
| 可用量 | `stock_balance`（0004：quantity/quality_status/status，`UNIQUE (unit_id, location_id, owner_id)`）经 `inventory_unit`（material_code 关联，plant 内）汇总；`computeAvailability`（`packages/domain/src/inventory/availability.ts`，毛量/预留/可用三段）；DTO `InventoryBalanceDto`（`packages/contracts/src/inventory.ts`）；查询先例 `listBalances`（inventory-queries.ts，`reservation` 表有效期内活动预留） | IT-14：可用=质量合格 ∧ 减有效预留；非 qualified 余额只计毛量不进可用；同料品跨余额行汇总 |
| 采购在途 | `purchase_order_line`（0006：`planned_qty/received_qty/status(0–5)/erp_closed/planned_receipt_date/first_arrival_date/last_arrival_date`，`PurchaseOrderLineStatusValue` 标签 `ORDER_LINE_STATUS_LABELS`）；DTO `PurchaseOrderLineDto`（`packages/contracts/src/purchase.ts`）；查询先例 `listOrderLines`（purchase-queries.ts）；行内质检状态 `purchase_receipt_batch.inspection_status` 六值（关联展示，`BATCH_INSPECTION_STATUS_LABELS`） | 在途量 = `planned_qty − received_qty`，仅取 `status ∈ {0,1,2}` 且 `erp_closed=false` 的行（IF-08 行状态轴：0 已开立/1 待收货/2 部分收货）；匹配键=plant 内 `material_code` 对齐 BOM 行 materialCode |
| 单位一致性 | BOM 行 `uom` vs `stock_balance.uom_code` vs `purchase_order_line.uom_code` | 三源 uom 不一致的行**不折算、不汇总结论**，逐行标注「单位不一致未折算」（首版无跨源自动换算，换算策略 GAP-P4；换算版本化机制存在于 `conversion_revision`（IT-08）但无跨源消费先例） |
| 允许字段 | 上表列 + material_name/spec/model/color（`purchase_order_line` 快照列） | **价格类字段（unit_price/avg_price/price_history/deviation_ppm/price_flag）与价格复核列一律不入结果**（成本敏感域，GAP-P5） |
| 时效 | 各源 `updated_at`；`queriedAt` | freshness 信封 |

⑥审计关联：同 AQ-S2，`capability_id='aq.material-shortage'`。

歧义澄清：订单解析同 AQ-C1；`requirementBase` 未配置时若用户追问「到底缺多少」→ AQ-AMB-03（列出口径未定事实，不给猜测数值）。

## 4. AQ-C3 质量查询（capabilityId `aq.quality`，首版 v1）

**业务说明**：回答「某时间段哪些检验未通过、后续处置是什么」。两类真实读面对象族并查：过程/成品检验单（quality 域）与来料检验批次（purchase 域）；**事实与原因推测分开**——结果只含判定/状态/处置事实，解释性文字由 AI 生成并标注为推测。

①能力定义：输入 schema `{ objectScope: 'inspection_order' | 'purchase_batch' | 'all'（缺省 all）, timeRange: { from: string, to: string }（ISO-8601，必填；自然语言时间由 B 线换算，AQ-AMB-02）, conclusions?: ('qualified'｜'unqualified')[]（过滤生效结论）, inspectionStages?: ('process'｜'finished')[], orderNoLike?: string, page?: PageRequest }`；所需权限 `['aiquery.use','quality.read','purchase.read']`；最大查询范围：时间跨度 ≤ 92 天、pageSize ≤ 100（超限拒绝或截断并标注）。

②执行上下文：同前；两族均按 plant ∈ dataScope 收敛（先例 `plantScope`，quality-queries.ts / purchase-queries.ts）。

③④⑤字段级映射：

| 结果要素 | 读面证据（文件 + 符号 + 表） | 口径 |
| --- | --- | --- |
| 检验单族（过程/成品） | `quality_inspection_order`（0009：order_no/source_type('work_report'｜'putaway_receipt')/inspection_stage('process'｜'finished')/spec_code/spec_version/status 四值 pending/in_progress/concluded/cancelled/material_code/unit_no/quantity/uom_code/production_order_no/production_dept_name/business_time）；DTO `InspectionOrderDto`（`packages/contracts/src/quality.ts`）；查询先例 `listInspectionOrders/inspectionDetail`（`packages/application/src/quality-queries.ts`）。**注意：现有查询无时间范围过滤参数——A 线 aiquery 仓储须新增 timeRange 条件（列=`business_time`），不改既有 quality-queries.ts** | 时间过滤列 `business_time`（业务时间，IT-37 双轨之业务侧） |
| 生效判定 | `quality_test_result`（0009：`is_effective` 生效指针 partial unique + `conclusion` 三值 pending/qualified/unqualified + `version/result_kind('initial'/'test'/'re_inspection')/inspector/inspected_at`）；DTO `TestResultVersionDto`（quality.ts） | S14：追加历史+生效指针；**生效结论=当前 `is_effective` 行**，历史版本行只作版本链展示，不得混作当前判定 |
| 处置状态 | `quality_disposition`（0009：disposition_kind 'release'/'concession'/based_on_version/released_by/released_at/reason，append-only）；`DispositionKindValue`（quality.ts） | 让步放行保留原不合格事实（based_on_version 链接）；处置与检验事实分列 |
| 隔离/存疑状态 | `quality_hold`（0009：hold_kind 'pending_inspection'/'unqualified'/'suspect'、status active/released、raised_at/released_at、`quality_hold_active_uidx` 同码至多一条活动隔离）；DTO `QualityHoldDto`（quality.ts）；查询先例 `listHolds`（quality-queries.ts；**同样无时间过滤参数，A 线新增条件列 `raised_at`**） | 处置状态=生效结论 + 最新处置记录 + 活动隔离 三者并排，不互相覆盖 |
| 来料批次族 | `purchase_receipt_batch`（0006：batch_no/order_no/line_no/material_code/material_name/inspection_status 六值 `BatchInspectionStatusValue`/storage_status('stored'/'returned')/received_qty/uom_code/arrival_time/confirm_time）；明细 `receipt_detail.quality_status` 五值 `DetailQualityStatusValue`；DTO `PurchaseBatchDto/ReceiptDetailDto`（purchase.ts）；查询先例 `listBatches`（purchase-queries.ts） | 时间过滤列 `confirm_time`（收货确认业务时间）；**价格复核列（review_status/reviewed_by/unit_price/avg_price/price_history/deviation_ppm/price_flag）与外发同步状态列不入结果**（GAP-P5） |
| 允许字段 | 上表所列 + `quality_inspection_order.plant_id`（作来源定位） | 白名单之外字段（含人员敏感之外的复核价格）一律不返回 |
| 时效 | 各源 `updated_at`；`queriedAt` | freshness 信封 |

⑥审计关联：同 AQ-S2，`capability_id='aq.quality'`。

事实与推测分开的机器承载：结果 DTO 只有事实列；AI 生成解释时，信封 `contextEcho` 提供 `factColumns` 提示（哪些列是判定事实），B 线提示词合同要求解释文字标注「解释非事实」。首版不建「原因」数据列（无原文读面）。

## 5. 歧义澄清合同

| 编号 | 规则（可判定） | 归属 |
| --- | --- | --- |
| AQ-AMB-01 | 对象多候选：模糊单号/销售单号命中 >1 订单时返回候选清单（见 §2），AI 呈现选项待用户确认后带精确 `orderId/orderNo` 重新执行；不得自行择一作答（方案 §5 第 2 条）。 | A（解析）/B（呈现）/UI（选项渲染） |
| AQ-AMB-02 | 时间范围不明：无显式起止时 AQ-C3 默认「最近 7 个自然日（Asia/Shanghai）」，`contextEcho` 回显实际起止并提示可修改；用户显式给定则从之（方案 §5 第 2 条）。 | A/B |
| AQ-AMB-03 | 口径多版本：存在多个有效口径版本时列出可选项待确认；AQ-C2 的 `requirementBase` 未配置＝口径未定，缺口数值列固定「口径未定」标注（§3），不得按猜测口径给数（方案 §5 第 2 条；GAP-P4）。 | A/B |
| AQ-AMB-04 | 澄清轮计入同一 requestId 的会话与审计（不落新 ai_query_audit 执行行，但会话记录留澄清事件）。 | B |

## 6. 权限与执行上下文合同（AQ-AUTH）

| 编号 | 规则（可判定） | 归属 |
| --- | --- | --- |
| AQ-AUTH-01 | **每次执行重验**：接入层对每次 execute 按会话绑定的 userId 实时重算授权上下文（user_account 状态/角色/scope_grant/org_node，同 `SessionVerifier` 口径，`packages/application/src/session-verifier.ts`）；不信任 ai_session 建立时的快照；用户禁用/撤权/角色变更后下一次 execute 即 `no_permission`。 | A |
| AQ-AUTH-02 | 许可两层：模块许可 `aiquery.use`（新增权限键，落 scope_grant，OA-23 岗位许可机制）+ 能力所需域读权限（首版仅引用既有键：`process.read/execution.read/scheduling.read/inventory.read/purchase.read/quality.read`，定义于 `packages/domain/src/*/permissions.ts`）全部满足方可执行；许可不足的能力在枚举接口即不可见（AQ-REG-05）。 | A |
| AQ-AUTH-03 | 数据范围：OA-25 `dataScope`（enterpriseWide 或 plantIds）贯穿存储读取；请求参数中的 plantId 越范围 → `no_permission`；未指定 → 按 dataScope 收敛（先例 `plantFilter/plantScope`）。**AI 只能缩小授权范围**：模型可给的参数（更窄时间窗、更少行数、单厂）只做交集，任何扩大请求按 dataScope 截回并在 `contextEcho` 标注。 | A |
| AQ-AUTH-04 | enterpriseId/tenantId 一律由会话绑定派生；请求体同名参数忽略并记审计（AQ-REG-06；方案 §5 第 1 条：模型参数、聊天文本、显示姓名、调用方自填 tenantId 均不赋权）。 | A |
| AQ-AUTH-05 | IM 渠道身份：渠道身份绑定解析失败或未绑定 → `no_permission` + 引导文案（绑定合同见 im-channels.md）；群会话的目的地规则见 im-channels.md §3。 | C |

## 7. 0021 迁移表合同（迁移号 0021，A 线实施；不注册共享 registry，L0 整合，P2 包 §2）

| 编号 | 约束 | 归属 |
| --- | --- | --- |
| AQ-S1 | `ai_capability_registry`：id uuid PK；enterprise_id uuid NOT NULL REFERENCES org_node；capability_id text NOT NULL；version integer ≥1；status text CHECK IN ('enabled','disabled') DEFAULT 'disabled'；definition jsonb NOT NULL（§0 字段：inputSchema/requiredPermissions/allowedObjects[{table,fields}]/maxQueryRange/口径参数）；remark/审计四列。`UNIQUE (enterprise_id, capability_id, version)`；partial unique `(enterprise_id, capability_id) WHERE status='enabled'`；索引 (enterprise_id)。 | A |
| AQ-S2 | `ai_query_audit`：id uuid PK；request_id uuid NOT NULL；tool_call_seq integer ≥1 NOT NULL；session_id uuid NOT NULL REFERENCES ai_session；capability_id/capability_version；user_id/enterprise_id NOT NULL；channel text CHECK IN ('web','pda','wecom','feishu','mock')；params jsonb（**脱敏载荷**：只存过滤参数与对象引用，不存聊天正文）；result_status text CHECK IN（AQ-REG-07 七值）；row_count/truncated/duration_ms；model_info jsonb（模型/插件版本 + usage 或字面 `"unknown"`）；sent_result_status text NULL CHECK IN ('sent','send_unknown','failed','not_sent')；created_at。`UNIQUE (request_id, tool_call_seq)`；索引 (enterprise_id, created_at)/(session_id)/(user_id)。**审计表不是业务账本**（AR-18/19）。 | A |
| AQ-S3 | `ai_session`：id uuid PK；enterprise_id/user_id NOT NULL（FK user_account/org_node）；channel text 同 AQ-S2 值域；conversation_ref text（IM 会话目标标识或 web 会话标识，可空）；status text CHECK IN ('open','closed','expired') DEFAULT 'open'；created_at/last_active_at/closed_at。索引 (user_id)/(enterprise_id, channel)。**只存身份绑定与审计锚点，不存消息正文**（AR-19）。 | A |
| AQ-S4 | 三表均含 enterprise_id 隔离列（IT-S1 同则）；不携带任何生产业务写路径；表注释须标注「AI 问数审计/注册面，非业务账本」。 | A |

## 8. 未就绪问法族（首版固定清单，source_not_ready；扩充走注册表/合同修订）

对应问法必须显示「数据源未就绪」，不得把空集合算成零值经营事实（方案 §1/§5 D-18 边界；明细登记 GAP-P4）：

1. 采购/外协交货逾期及其对工作令的影响（`planned_receipt_date` 存在，但「影响哪些工作令」无关联读面——`sales_order_no` 对齐不构成工作令级影响结论）。
2. 工时与经营统计（车间有效工时/汇总工时：`labor_record`（0008）为原始行，无版本化统计口径与数据源绑定；`engine-reporting` 不存在于本仓）。
3. 报表口径类问法（良率/损耗/在制/交期指标：无版本化指标读面）。
4. BOM 消耗推导类问法（需求总量折算：基数语义未冻结，见 §3）。

## 9. 开放项引用（不生效，待裁定/输入）

- GAP-P4（上游读面未接问法与口径缺口：BOM 基数、跨源单位换算、逾期影响、工时统计）、GAP-P5（敏感域授权与字段策略）、GAP-P9（`order_operation.execution_status` 无置位路径）、GAP-P11（时间基准/时区部署约定）。
- 三能力注册行 seed 的 definition 具体 JSON 由 A 线按 §0～§4 落地，DEV/交付环境验收时回读注册表与结果信封逐段对照。

— 规则统计：AQ-REG-01～10 ＋ AQ-AMB-01～04 ＋ AQ-AUTH-01～05 ＋ AQ-S1～S4 共 23 条机制规则；三能力字段级映射表 3 张（引用 12 个真实文件、13 张既有表 + 0021 三新表）。
