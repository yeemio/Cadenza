/**
 * 轴查询纯规则（RP-08~RP-11；原件 生产管理/轴查询.md 字典与列集）。
 *
 * 只读跨域投影：列集内各状态列取自各自权威表当前值（RP-11：不跨表快照、不承诺行内
 * 多状态同一时点）；采购来源轴不走报工（RP-09：报工状态固定 `-`，按报工状态筛选时不包含）。
 */

// ---------------- 入库状态（6 值字典，原件 轴查询.md:17-24） ----------------

export type AxisInboundStatus =
  | 'not_in'
  | 'in_stock'
  | 'shipped'
  | 'returned'
  | 'receipt_unconfirmed'
  | 'issue_unconfirmed'

export const AXIS_INBOUND_STATUS_LABELS: Readonly<Record<AxisInboundStatus, string>> = {
  not_in: '未入库',
  in_stock: '在库中',
  shipped: '已出库',
  returned: '已退货',
  receipt_unconfirmed: '入库未确认',
  issue_unconfirmed: '出库未确认',
}

/**
 * 五状态轴（IT-13）→ 轴查询入库状态映射（[合同新造]框架内最小映射，GAP-A7 映射族邻接、待裁）：
 * - in_stock → 在库中；shipped/exhausted → 已出库（耗尽=已离开库存）；
 * - in_production/in_transit → 未入库（尚未入库或在途）；无余额行 → 未入库；
 * - 已退货/入库未确认/出库未确认：P1 权威通道尚未产生这些事实（退回冲销属 P2-C、
 *   外部 WMS 确认语义未建模），字典值保留、当前事实不映射（不冒充）。
 */
export function mapAxisInboundStatus(
  unitStatus: 'in_stock' | 'in_production' | 'in_transit' | 'shipped' | 'exhausted' | null,
): AxisInboundStatus {
  switch (unitStatus) {
    case 'in_stock':
      return 'in_stock'
    case 'shipped':
    case 'exhausted':
      return 'shipped'
    case 'in_production':
    case 'in_transit':
    case null:
      return 'not_in'
  }
}

// ---------------- 质检状态（4 值字典，原件 轴查询.md:26-33） ----------------

export type AxisQcStatus = 'pending' | 'qualified' | 'exempt' | 'unqualified'

export const AXIS_QC_STATUS_LABELS: Readonly<Record<AxisQcStatus, string>> = {
  pending: '待质检',
  qualified: '合格',
  exempt: '免检',
  unqualified: '不合格',
}

/**
 * 质检状态映射：料品免检（material.qc_flag=0）→ 免检；否则按库存质量投影
 * （stock_balance.quality_status，IT-18）：qualified→合格、unqualified→不合格、
 * pending_inspection/suspect→待质检（suspect 同时在存疑状态列独立展示，不混写）。
 */
export function mapAxisQcStatus(
  qcFlag: number | null | undefined,
  qualityStatus: 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect' | null,
): AxisQcStatus {
  if (qcFlag !== null && qcFlag !== undefined && qcFlag === 0) return 'exempt'
  switch (qualityStatus) {
    case 'qualified':
      return 'qualified'
    case 'unqualified':
      return 'unqualified'
    default:
      return 'pending'
  }
}

// ---------------- 销售状态（2 值字典） ----------------

export type AxisSaleStatus = 'unsold' | 'sold'

export const AXIS_SALE_STATUS_LABELS: Readonly<Record<AxisSaleStatus, string>> = {
  unsold: '未销售',
  sold: '已销售',
}

/** 销售状态映射：存在有效客户轴段分配（customer_segment status=allocated/reallocated）→ 已销售。 */
export function mapAxisSaleStatus(hasActiveCustomerSegment: boolean): AxisSaleStatus {
  return hasActiveCustomerSegment ? 'sold' : 'unsold'
}

// ---------------- 报工状态（RP-09：采购来源固定 `-`） ----------------

export type AxisReportStatus = 'not_reported' | 'reported' | 'not_applicable'

export const AXIS_REPORT_STATUS_LABELS: Readonly<Record<AxisReportStatus, string>> = {
  not_reported: '未报工',
  reported: '已报工',
  not_applicable: '-',
}

/**
 * 报工状态映射：采购来源轴（material_lot.kind=purchase）不走报工，固定 `-`（RP-09）；
 * 生产来源：关联报工全部已提交（无草稿）→ 已报工（关联报工已结束）；否则未报工。
 */
export function mapAxisReportStatus(
  lotKind: 'purchase' | 'production' | null,
  hasReport: boolean,
  allReportsSubmitted: boolean,
): AxisReportStatus {
  if (lotKind === 'purchase') return 'not_applicable'
  if (hasReport && allReportsSubmitted) return 'reported'
  return 'not_reported'
}

/** RP-09 后半：按报工状态筛选时不包含采购来源轴（任何报工状态筛选值下都排除）。 */
export function includedInReportStatusFilter(lotKind: 'purchase' | 'production' | null): boolean {
  return lotKind !== 'purchase'
}

// ---------------- 存疑 / 锁定 / 成品异常（2 值字典） ----------------

export type AxisSuspectStatus = 'normal' | 'suspect'

export const AXIS_SUSPECT_STATUS_LABELS: Readonly<Record<AxisSuspectStatus, string>> = {
  normal: '正常',
  suspect: '存疑',
}

/** 存疑状态：库存质量投影 suspect（IT-18 口径，quality 域唯一维护）。 */
export function mapAxisSuspectStatus(
  qualityStatus: 'qualified' | 'pending_inspection' | 'unqualified' | 'suspect' | null,
): AxisSuspectStatus {
  return qualityStatus === 'suspect' ? 'suspect' : 'normal'
}

export type AxisLockStatus = 'unlocked' | 'locked'

export const AXIS_LOCK_STATUS_LABELS: Readonly<Record<AxisLockStatus, string>> = {
  unlocked: '未锁定',
  locked: '锁定',
}

/** 是否锁定：存在活动作业预留（reservation status=active，IT-15）。 */
export function mapAxisLockStatus(hasActiveReservation: boolean): AxisLockStatus {
  return hasActiveReservation ? 'locked' : 'unlocked'
}

export type AxisFinishedAbnormalStatus = 'none' | 'pending_handle'

export const AXIS_FINISHED_ABNORMAL_LABELS: Readonly<Record<AxisFinishedAbnormalStatus, string>> = {
  none: '无异常',
  pending_handle: '异常未处理',
}

/**
 * 成品异常状态（[合同新造]框架内最小映射）：存在活动质量隔离
 * （quality_hold status=active，hold_kind=unqualified——不合格隔离未释放）→ 异常未处理；
 * 否则 无异常。独立"成品异常"通道（原件未定义权威来源）待 Owner 圈定（GAP-F25 邻接）。
 */
export function mapAxisFinishedAbnormalStatus(hasActiveUnqualifiedHold: boolean): AxisFinishedAbnormalStatus {
  return hasActiveUnqualifiedHold ? 'pending_handle' : 'none'
}
