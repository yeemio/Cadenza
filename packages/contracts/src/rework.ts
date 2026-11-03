import type { DecimalString } from './decimal'
import type { PageResult } from './pagination'

/**
 * rework 域公开线合同（P2-A / T15 倒轴/分盘/分托解绑/轴号修正/轴码退役）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p2/rework-split.md
 * （RS-01～RS-37 业务规则 + RS-S1～RS-S6 表级约束）；
 * 数量字段一律 DecimalString（IT-07 口径随行：十进制定点、≤4 位小数，禁 number）。
 * 本文件为独立新文件（不并入 index.ts：L0 整合步统一注册导出）。
 */

// ---------------- 状态字典值 ----------------

/** 倒轴主单状态（RS-S1：append-only；reversed 由冲销事实行派生投影）。 */
export type ReelSplitStatusValue = 'executed' | 'reversed'

/** 分托/解绑任务类型（RS-14：同一人同一类型同时只能有一条进行中）。 */
export type PalletTaskTypeValue = 'split_pallet' | 'unbind_pallet'

/** 分托/解绑任务状态（RS-S3）。 */
export type PalletTaskStatusValue = 'in_progress' | 'completed' | 'abandoned'

/** 轴号修正记录状态（RS-S5：回撤写状态切换，不改历史值）。 */
export type AxisCorrectionStatusValue = 'completed' | 'withdrawn'

/** 新托/老托判定（RS-15）。 */
export type PalletKindValue = 'new' | 'old'

// ---------------- 倒轴（RS-01～12） ----------------

/** 倒入行载荷（RS-02：数量 > 0、≤4 位小数；倒入码互不重复且不得等于倒出码）。 */
export interface ReelSplitPourLineDto {
  unitNo: string
  quantity: DecimalString
  locationId?: string
  locationCode?: string
}

/** 倒轴执行命令载荷（RS-01/02/05/07/11）。 */
export interface ReelSplitExecuteCommand {
  sourceUnitNo: string
  pourLines: ReelSplitPourLineDto[]
  /** 损耗量（RS-11 [合同新造·建议]：默认 0、4 位小数、≥0；>0 时 lossReason 必填） */
  lossQty?: DecimalString
  lossReason?: string
  orderRef?: string
}

/** 倒轴冲销命令载荷（RS-12 [合同新造]：下游引用前置校验）。 */
export interface ReelSplitReverseCommand {
  sourceOrderId: string
  reason: string
}

/** 倒出轴扫码查询结果（RS-03/04/06：只读；同码合计数量作为倒出量基数）。 */
export interface ReelSplitSourceScanDto {
  unitNo: string
  balanceQty: DecimalString
  materialCode: string
  customerAxisNo: string | null
  segmentLength: string | null
  /** RS-05：带客户轴号/段长时必须全量倒出 */
  requireFullPour: boolean
  /** RS-05：带客户轴号/段长时倒入轴只能有一条 */
  requireSingleLine: boolean
}

/** 倒轴记录行（RS-08：主表＋明细展开只读；无新增/编辑/删除入口）。 */
export interface ReelSplitRecordDto {
  id: string
  orderNo: string
  sourceUnitNo: string
  originalQty: DecimalString
  retainedQty: DecimalString
  /** 剩余数量 = 原数量 − 该主单全部倒入合计（同主单多行数值相同） */
  remainQty: DecimalString
  lossQty: DecimalString
  materialCode: string
  orderRef: string | null
  splitBy: string
  splitAt: string
  reversed: boolean
  lines: Array<{ lineNo: number; targetUnitNo: string; quantity: DecimalString }>
}

// ---------------- 分托/解绑（RS-13～24） ----------------

/** 分入托码扫码载荷/结果（RS-15：新托/老托判定 + 老托位置自动带出不可改）。 */
export interface PalletScanTargetCommand {
  carrierCode: string
}

export interface PalletScanTargetResultDto {
  taskId: string
  taskNo: string
  carrierCode: string
  palletKind: PalletKindValue
  inheritedLocation: {
    warehouseId: string | null
    rackId: string | null
    locationId: string | null
    locationCode: string | null
  } | null
}

/** 料品码扫码载荷（RS-16/22：装入即锁定 RS-17/18）。 */
export interface PalletScanItemCommand {
  taskType: PalletTaskTypeValue
  unitNo: string
}

/** 非车间选库位载荷（RS-13②/RS-15/RS-19）。 */
export interface PalletSetLocationCommand {
  locationId: string
  locationCode?: string
  warehouseId?: string
  warehouseCode?: string
  rackId?: string
  rackCode?: string
}

/** 删码载荷（RS-17：解除锁定并从本次调整移除；已确认完成的单不允许再删码）。 */
export interface PalletRemoveItemCommand {
  taskType: PalletTaskTypeValue
  unitNo: string
}

/** 确认载荷（RS-19/20/23）。 */
export interface PalletConfirmCommand {
  taskType: PalletTaskTypeValue
}

/** 放弃/返回载荷（RS-21/23）。 */
export interface PalletLeaveCommand {
  taskType: PalletTaskTypeValue
}

/** 进行中单据带出（RS-14：再次进入自动带出；Web 不展示进行中）。 */
export interface PalletCurrentTaskDto {
  taskId: string
  taskNo: string
  status: PalletTaskStatusValue
  targetCarrierCode: string | null
  warehouseCode: string | null
  rackCode: string | null
  locationCode: string | null
  lines: Array<{
    unitNo: string
    originalCarrierCode: string | null
    originalWarehouseCode: string | null
    originalLocationCode: string | null
    scannedAt: string
  }>
}

/** 已完成分托/解绑记录（RS-S3/RS-20）。 */
export interface PalletTaskRecordDto {
  id: string
  taskNo: string
  taskType: PalletTaskTypeValue
  operator: string
  targetCarrierCode: string | null
  warehouseOfRecord: string | null
  firstScanAt: string
  completedAt: string | null
}

/** 分托导出行（RS-24：导出那一刻绑定取数；同托码同产品轴号同料品合并、数量相加）。 */
export interface PalletExportRowDto {
  carrierCode: string
  productAxisNo: string | null
  materialCode: string
  quantity: DecimalString
  unitCount: number
}

// ---------------- 轴号修正（RS-25～33） ----------------

/** 修正提交载荷（RS-27 校验链；RS-30 占用核权时 reassignReason 必填）。 */
export interface AxisCorrectionSubmitCommand {
  unitNo: string
  cutQty: DecimalString
  newCustomerAxisNo?: string
  newSegmentLength?: string
  newVirtualAxisNo?: string
  /** RS-31：截取数量单位随物料主计量单位（不固定"米"） */
  uomCode?: string
  /** RS-30：选中已使用轴号时强制理由 */
  reassignReason?: string
}

/** 修正回撤载荷（RS-32/33）。 */
export interface AxisCorrectionWithdrawCommand {
  correctionId: string
  reason?: string
}

/** 可选新轴号项（RS-26：订单分段明细；已使用项仍可选中）。 */
export interface CorrectionOptionDto {
  customerAxisNo: string | null
  segmentLength: string | null
  virtualAxisNo: string | null
  used: boolean
  occupiedByUnitId: string | null
  occupiedByUnitNo: string | null
}

/** 修正扫码查询结果（RS-25：只查询不改数据）。 */
export interface CorrectionScanDto {
  unitNo: string
  currentQty: DecimalString
  maxSingleReportQty: DecimalString
  customerAxisNo: string | null
  segmentLength: string | null
  virtualAxisNo: string | null
  options: CorrectionOptionDto[]
  materialPrimaryUomCode: string | null
}

/** 修正记录行（RS-S5/RS-32）。 */
export interface AxisCorrectionRecordDto {
  id: string
  correctionNo: string
  targetUnitNo: string
  beforeCustomerAxisNo: string | null
  afterCustomerAxisNo: string | null
  originalQty: DecimalString
  cutQty: DecimalString
  newQty: DecimalString
  status: AxisCorrectionStatusValue
  correctedBy: string
  correctedAt: string
  withdrawnAt: string | null
}

// ---------------- 轴码退役（RS-34～37） ----------------

/** 轴码清空命令载荷（RS-34：至少勾选一条）。 */
export interface AxisRetireExecuteCommand {
  unitNos: string[]
  reason?: string
}

/** 清空记录行（RS-35：快照字段集；Web 清空记录可查）。 */
export interface AxisRetireRecordDto {
  id: string
  retireNo: string
  unitNo: string
  qtyBefore: DecimalString
  productionDept: string | null
  productionOrderNo: string | null
  salesOrderNo: string | null
  materialCode: string
  processName: string | null
  reportBy: string | null
  retiredBy: string
  retiredAt: string
}

// ---------------- 分页视图 ----------------

export type ReelSplitRecordsView = PageResult<ReelSplitRecordDto>
export type PalletCompletedRecordsView = PageResult<PalletTaskRecordDto>
export type AxisCorrectionRecordsView = PageResult<AxisCorrectionRecordDto>
export type AxisRetireRecordsView = PageResult<AxisRetireRecordDto>
