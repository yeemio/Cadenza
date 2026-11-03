import { MaintenanceRuleViolation } from './errors'

/**
 * 维修工单闭环规则（MT-07/MT-08/MT-10/MT-13/MT-14——[合同新造]，S12 显式新增，原件无工单概念）。
 *
 * 状态机合法迁移集封闭（MT-07）；设备状态是投影（MT-08：建单置维修、复机关闭置正常）；
 * 复机仅"待复机"可执行且一次事务完成（MT-10）；取消语义（MT-14：停机事实保留、
 * 关闭后结果不可再改）；报修入口与分派（MT-13：分派角色与通知方式 → GAP-F20 待裁）。
 */

// ---------------- MT-07：维修工单状态机 ----------------

export const MAINTENANCE_ORDER_STATUSES = [
  'reported',
  'dispatched',
  'in_progress',
  'pending_restart',
  'closed',
  'cancelled',
] as const

export type MaintenanceOrderStatus = (typeof MAINTENANCE_ORDER_STATUSES)[number]

export const MAINTENANCE_ORDER_STATUS_LABELS: Readonly<Record<MaintenanceOrderStatus, string>> = {
  reported: '已报修',
  dispatched: '已分派',
  in_progress: '处理中',
  pending_restart: '待复机',
  closed: '已关闭',
  cancelled: '已取消',
}

/**
 * MT-07：合法迁移集封闭——已报修→分派→处理中→待复机→关闭；取消另记（独立状态，
 * 仅已报修/已分派/处理中可进入，见 canCancel）。越级/逆向迁移拒绝。
 */
export const MAINTENANCE_ORDER_TRANSITIONS: Readonly<
  Record<MaintenanceOrderStatus, readonly MaintenanceOrderStatus[]>
> = {
  reported: ['dispatched', 'cancelled'],
  dispatched: ['in_progress', 'cancelled'],
  in_progress: ['pending_restart', 'cancelled'],
  pending_restart: ['closed'],
  closed: [],
  cancelled: [],
}

/** MT-07：状态迁移守卫（非法迁移集中含越级/逆向/终态迁出，全部拒绝）。 */
export function assertOrderTransition(from: MaintenanceOrderStatus, to: MaintenanceOrderStatus): void {
  const allowed = MAINTENANCE_ORDER_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw new MaintenanceRuleViolation(
      'MT-07',
      `工单状态非法迁移：${MAINTENANCE_ORDER_STATUS_LABELS[from]}（${from}）→ ${MAINTENANCE_ORDER_STATUS_LABELS[to]}（${to}）；合法迁移集封闭（已报修→分派→处理中→待复机→关闭，取消另记）`,
    )
  }
}

/** MT-07：关闭必须记录结果与责任人（任一为空不可关闭）。 */
export function assertCloseFields(result: unknown, responsible: unknown): void {
  if (typeof result !== 'string' || result.trim() === '') {
    throw new MaintenanceRuleViolation('MT-07', '关闭工单必须记录结果（结果为空不可关闭）')
  }
  if (typeof responsible !== 'string' || responsible.trim() === '') {
    throw new MaintenanceRuleViolation('MT-07', '关闭工单必须记录责任人（责任人为空不可关闭）')
  }
}

// ---------------- MT-08：设备状态是投影（工单事件驱动） ----------------

/** 驱动设备状态投影的工单事件（MT-08：受理报修建单置"维修"、复机关闭置"正常"）。 */
export type OrderProjectionEvent = 'order_created' | 'order_restarted'

/**
 * MT-08：工单事件 → 设备状态投影值（1=正常、2=维修）。
 * 直接改状态命令（Web 行内/异常上报）保留原文行为，每次变更记流水（见 equipment-rules）；
 * 置"维修"建议关联在单工单，是否强制关联 → GAP-F23 待裁（当前不强制）。
 */
export function equipmentStatusProjectionFor(event: OrderProjectionEvent): 1 | 2 {
  return event === 'order_created' ? 2 : 1
}

// ---------------- MT-10：复机执行 ----------------

/** MT-10：复机关闭的固定结果口径（复机执行 = 工单关闭（结果=复机正常＋责任人））。 */
export const RESTART_ORDER_RESULT = '复机正常'

/** MT-10：仅"待复机"状态可执行复机（其余状态拒绝，复机失败不改变工单状态——事务回滚承载）。 */
export function assertRestartExecutable(status: MaintenanceOrderStatus): void {
  if (status !== 'pending_restart') {
    throw new MaintenanceRuleViolation(
      'MT-10',
      `仅"待复机"状态可执行复机，当前状态=${MAINTENANCE_ORDER_STATUS_LABELS[status]}（${status}）`,
    )
  }
}

// ---------------- MT-13：报修入口与分派 ----------------

/** MT-13：工单创建入口首期 = Web 手工报修 ＋ 异常上报（置"维修"时可关联建单）。 */
export const MAINTENANCE_ORDER_SOURCES = ['web_manual', 'anomaly_report'] as const

export type MaintenanceOrderSource = (typeof MAINTENANCE_ORDER_SOURCES)[number]

export const MAINTENANCE_ORDER_SOURCE_LABELS: Readonly<Record<MaintenanceOrderSource, string>> = {
  web_manual: 'Web 手工报修',
  anomaly_report: '异常上报关联建单',
}

/** MT-13：分派守卫——已报修→分派，记录分派人与被派人（被派人必填；分派角色与通知方式 → GAP-F20）。 */
export function assertDispatchFields(assignee: unknown): void {
  if (typeof assignee !== 'string' || assignee.trim() === '') {
    throw new MaintenanceRuleViolation('MT-13', '分派必须记录被派人（被派人为空不可分派）')
  }
}

// ---------------- MT-14：取消语义与结果不可再改 ----------------

/** MT-14：可取消状态 = 已报修/已分派/处理中（待复机/已关闭不可取消）。 */
export function canCancelOrder(status: MaintenanceOrderStatus): boolean {
  return status === 'reported' || status === 'dispatched' || status === 'in_progress'
}

/** MT-14：取消守卫（不可取消状态拒绝＋取消原因必填）。 */
export function assertCancellable(status: MaintenanceOrderStatus, cancelReason: unknown): void {
  if (!canCancelOrder(status)) {
    throw new MaintenanceRuleViolation(
      'MT-14',
      `工单当前状态=${MAINTENANCE_ORDER_STATUS_LABELS[status]}（${status}），待复机/已关闭不可取消`,
    )
  }
  if (typeof cancelReason !== 'string' || cancelReason.trim() === '') {
    throw new MaintenanceRuleViolation('MT-14', '取消工单必须填写取消原因（原因为空不可取消）')
  }
}

/** MT-14：关闭后工单结果不可再改（任何对已关闭/已取消工单的业务改写拒绝）。 */
export function assertOrderNotConcluded(status: MaintenanceOrderStatus): void {
  if (status === 'closed' || status === 'cancelled') {
    throw new MaintenanceRuleViolation(
      'MT-14',
      `工单已终态（${MAINTENANCE_ORDER_STATUS_LABELS[status]}），关闭后结果不可再改`,
    )
  }
}
