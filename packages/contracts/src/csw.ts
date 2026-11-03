/**
 * csw 域公开线合同（P3-B / T22 受约束排程与外协）。
 *
 * 依据：冻结合同 architecture/contracts/frozen/p3/constrained-scheduling.md
 * （CS-01～CS-27 + CS-S1～CS-S5；承接基线 CS-01～03 属 T09 已冻结行为）。
 * - 数量字段一律 DecimalString（十进制定点、≤4 位小数，禁 number）；
 * - 日期字段 YYYY-MM-DD；停机窗口允许日期时间串（date-only＝整日）；
 * - 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）。
 */

// ---------------- 状态字典值 ----------------

/** [CS-11] 冻结对象粒度。 */
export type CswFreezeScopeValue = 'equipment_date_range' | 'slot'

/** [CS-27] 排程版本状态。 */
export type CswScheduleVersionStatusValue = 'proposed' | 'committed' | 'superseded'

/** [CS-12/14/15] 版本条目动作。 */
export type CswVersionItemActionValue =
  | 'keep'
  | 'move'
  | 'new'
  | 'remove'
  | 'conflict'
  | 'outside_horizon'

/** [CS-26] 人工覆盖类型。 */
export type CswOverrideTypeValue =
  | 'soft_constraint_confirm'
  | 'unfreeze'
  | 'weight_change'
  | 'manual_over_suggestion'

/** [CS-19] 外协任务状态机（草稿→待发送→已发送（在外加工）→回厂接收→检验→关闭；取消另记）。 */
export type CswOutsourcingStatusValue =
  | 'draft'
  | 'pending_send'
  | 'sent'
  | 'return_received'
  | 'inspecting'
  | 'closed'
  | 'recalled'
  | 'return_disposed'

/** [CS-22] 外协回厂检验结论（默认全部必检；结论与放行走质量合同）。 */
export type CswOutsourcingInspectionResultValue = 'pending' | 'passed' | 'rejected'

/** [CS-16] 换型矩阵维度。 */
export type CswChangeoverDimensionValue = 'operation' | 'product_attribute'

/** [CS-05③/CS-10] 校准状态投影结果（对齐 PE-15：合格/限用/失准）。 */
export type CswCalibrationResultValue = 'qualified' | 'limited' | 'invalid'

/** [CS-09] 停机种类。 */
export type CswDowntimeKindValue = 'planned_maintenance' | 'repair' | 'other'

// ---------------- 命令载荷（16 命令面） ----------------

export interface CswFreezeCreatePayload {
  plantId: string
  equipmentId: string
  scope: CswFreezeScopeValue
  productionDateFrom: string
  productionDateTo: string
  slotId?: string
  reason?: string
  operationId?: string
}

export interface CswFreezeReleasePayload {
  freezeId: string
  reason?: string
  operationId?: string
}

export interface CswChangeoverPublishPayload {
  plantId: string
  dimensionKind: CswChangeoverDimensionValue
  defaultMinutes: number
  entries: Array<{ fromValue: string; toValue: string; minutes: number }>
  note?: string
  operationId?: string
}

export interface CswCalibrationStatePayload {
  plantId: string
  equipmentId: string
  calibrationResult: CswCalibrationResultValue
  validUntil?: string | null
  certificateNo?: string
  operationId?: string
}

export interface CswDowntimeRegisterPayload {
  plantId: string
  equipmentId: string
  kind?: CswDowntimeKindValue
  fromAt: string
  toAt: string
  note?: string
  operationId?: string
}

export interface CswDowntimeClosePayload {
  downtimeId: string
  operationId?: string
}

export interface CswRescheduleProposePayload {
  plantId: string
  today?: string
  horizonDays?: number
  weights?: { dueDate?: string; changeover?: string; loadBalance?: string }
  reason?: string
  operationId?: string
}

export interface CswRescheduleCommitPayload {
  versionId: string
  confirm?: boolean
  reason?: string
  overrides?: Array<{
    itemNo: number
    equipmentId?: string
    productionDate?: string
    plannedQty?: string
  }>
  operationId?: string
}

export interface CswOutsourcingCreatePayload {
  orderOperationId: string
  supplierCode?: string
  supplierName: string
  qty: string
  transitLocationId: string
  transitLocationCode: string
  returnLocationId?: string
  returnLocationCode?: string
  operationId?: string
}

export interface CswOutsourcingTaskIdPayload {
  taskId: string
  operationId?: string
}

export interface CswOutsourcingSendPayload {
  taskId: string
  lines: Array<{ unitId: string; quantity: string }>
  businessTime?: string
  operationId?: string
}

export interface CswOutsourcingReceivePayload {
  taskId: string
  lines: Array<{ unitId: string; quantity: string; returnLotNo?: string }>
  returnLocationId?: string
  returnLocationCode?: string
  businessTime?: string
  operationId?: string
}

export interface CswOutsourcingInspectPayload extends CswOutsourcingTaskIdPayload {
  inspectionResult: 'passed' | 'rejected'
}

// ---------------- 查询侧 DTO ----------------

/** [CS-24] 外协加工数量事实（导出/回传供 ERP 结算核对；本系统不记应付/加工费/发票）。 */
export interface CswOutsourcingSettlementFactDto {
  taskNo: string
  supplierCode: string | null
  supplierName: string
  orderNo: string
  operationName: string
  sentQty: string
  returnedQty: string
  uom: string
  sentAt: string | null
  receivedAt: string | null
  closedAt: string | null
}

/** [CS-07/CS-08] 就绪评估视图（四条件 + 齐套口径）。 */
export interface CswReadinessDto {
  orderOperationId: string
  orderNo: string
  operationName: string
  ready: boolean
  blockers: Array<{ condition: string; rule: string; message: string }>
  materialBasis: 'default' | 'include_reserved'
  materialDemandQty: string
  materialAvailableQty: string
  materialShortfall: string | null
}

/** [CS-17] 建议排序权重（默认 交期优先 → 换型最少 → 负荷均衡；随排程版本留存，取值 → GAP-E11）。 */
export interface CswPriorityWeightsDto {
  dueDate: string
  changeover: string
  loadBalance: string
}
