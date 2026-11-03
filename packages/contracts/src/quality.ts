import type { DecimalString } from './decimal'
import type { PageResult } from './pagination'

/**
 * quality 域公开线合同（L1-P1-SERVER / T12 质量放行：质量状态轴/参数化闸门/检验规范版本化/存疑）。
 *
 * 依据：规则底稿 architecture/contracts/prep/p1/04-supply-chain-rules-T08T12T13T14.md §A-T12；
 * 冻结合同 architecture/contracts/frozen/p1/inventory-trace-core.md（IT-14 质量闸门）。
 * - 数量字段一律 DecimalString（IT-07 口径随行：十进制定点、≤4 位小数，禁 number）；
 * - 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）。
 */

// ---------------- 状态字典值 ----------------

/** 质量状态轴六值（A-T12-1：待检/免检/合格/不合格/待复检/存疑）。 */
export type QualityAxisValue =
  | 'pending_inspection'
  | 'exempt'
  | 'qualified'
  | 'unqualified'
  | 're_inspection'
  | 'suspect'

/** 检验阶段（A-T12-5：过程/成品检验，S12 显式新增）。 */
export type InspectionStageValue = 'process' | 'finished'

/** 检验单状态。 */
export type InspectionOrderStatusValue = 'pending' | 'in_progress' | 'concluded' | 'cancelled'

/** 检验结论（版本化生效指针口径，S14）。 */
export type TestConclusionValue = 'pending' | 'qualified' | 'unqualified'

/** 处置种类（A-T12-1：放行/让步——让步保留原不合格事实）。 */
export type DispositionKindValue = 'release' | 'concession'

/** 隔离种类（A-T12-2：待检/不合格/存疑不可用；隔离与处置独立）。 */
export type HoldKindValue = 'pending_inspection' | 'unqualified' | 'suspect'

// ---------------- 查询侧 DTO ----------------

/** 检验项实测明细（quality_test_result.items 元素；实测值追加历史由版本行承载）。 */
export interface InspectionItemMeasurementDto {
  itemNo: string
  itemName: string | null
  measuredValue: string
  judgement: 'pass' | 'fail' | 'not_tested'
  note: string | null
}

/** 检验任务视图（A-T12-5：来源/阶段/规范引用版本化）。 */
export interface InspectionOrderDto {
  orderId: string
  orderNo: string
  sourceType: 'work_report' | 'putaway_receipt'
  sourceRef: string
  inspectionStage: InspectionStageValue
  specCode: string
  specVersion: number
  status: InspectionOrderStatusValue
  statusLabel: string
  inventoryUnitId: string | null
  unitNo: string | null
  materialId: string
  materialCode: string
  quantity: DecimalString
  uomCode: string
  effectiveConclusion: TestConclusionValue | null
  effectiveVersion: number | null
  disposition: { kind: DispositionKindValue; releasedBy: string; releasedAt: string; basedOnVersion: number } | null
  plantId: string
}

export type InspectionOrderPage = PageResult<InspectionOrderDto>

/** 实测/结论版本行（S14：追加历史+生效结论版本化）。 */
export interface TestResultVersionDto {
  resultId: string
  version: number
  resultKind: 'initial' | 'test' | 're_inspection'
  conclusion: TestConclusionValue
  items: InspectionItemMeasurementDto[]
  isEffective: boolean
  inspector: string | null
  inspectedAt: string | null
}

/** 存疑/隔离记录视图（A-T12-3：保留发起人/时间/生产部门；恢复留最小处置记录）。 */
export interface QualityHoldDto {
  holdId: string
  inventoryUnitId: string
  unitNo: string
  holdKind: HoldKindValue
  status: 'active' | 'released'
  raisedBy: string
  raisedAt: string
  productionDeptName: string | null
  releasedBy: string | null
  releasedAt: string | null
  dispositionNote: string | null
}

// ---------------- 命令载荷 ----------------

/** quality.inspection.generate：检验任务生成（消费执行块提交事件，经 ExecutionEventPort 注入）。 */
export interface InspectionGeneratePayload {
  operationId?: string
  plantId: string
  /** 拉取事件类型过滤（缺省 work_report_confirmed） */
  eventTypes?: string[]
  /** 检验规范引用（版本化；缺省以事件载荷携带） */
  defaultSpecCode?: string
  defaultSpecVersion?: number
  reason?: string
}

/** quality.test-result.submit：实测提交（追加版本行+翻生效指针，S14）。 */
export interface TestResultSubmitPayload {
  operationId?: string
  inspectionOrderId: string
  conclusion: 'qualified' | 'unqualified'
  items: InspectionItemMeasurementDto[]
  inspector?: string
  reason?: string
  businessTime?: string
}

/** quality.disposition.release：判定放行（生效结论=合格）。 */
export interface DispositionReleasePayload {
  operationId?: string
  inspectionOrderId: string
  reason?: string
  businessTime?: string
}

/** quality.disposition.concession：让步放行（保留原不合格事实，based_on_version 引用原结论）。 */
export interface DispositionConcessionPayload {
  operationId?: string
  inspectionOrderId: string
  basedOnVersion: number
  reason: string
  businessTime?: string
}

/** quality.suspect.register：存疑登记（在库+在库位+未存疑+托码拒）。 */
export interface SuspectRegisterPayload {
  operationId?: string
  plantId: string
  unitId?: string
  unitNo?: string
  barcodeValue?: string
  barcodeKind?: 'unit' | 'pallet' | 'unknown'
  productionDeptId?: string
  productionDeptName?: string
  reason?: string
  businessTime?: string
}

/** quality.suspect.restore：存疑恢复（最小处置记录：恢复人/时间/处置依据必填）。 */
export interface SuspectRestorePayload {
  operationId?: string
  holdId?: string
  unitId?: string
  dispositionNote: string
  reason?: string
  businessTime?: string
}
