/**
 * 能力变化事件（MT-10/MT-15——[合同新造]）。
 *
 * 复机与能力恢复：复机执行在关闭工单、置设备正常、闭停机事件的同一事务中，
 * 向排程（T09 schedule_slot/capacity_calendar）发布能力变化事件（Outbox，
 * 含停机起止与原因）触发计划评估。维护与排产解耦（MT-15）：停机/复机只发布
 * 能力变化事件，不直接改排程结果；排程重评估由调度域（T09）消费事件执行；
 * 事件与停机事件可对齐（工单→停机→能力事件链可追溯）。
 */

/** Outbox 任务种类（0001 outbox.task_kind；T09 消费方按此认领能力变化事件）。 */
export const CAPACITY_EVENT_TASK_KIND = 'maintenance.capacity-change'

/** 聚合种类（outbox.aggregate_type，链路：工单→停机→能力事件可追溯）。 */
export const CAPACITY_EVENT_AGGREGATE_TYPE = 'maintenance_order'

/** 能力变化方向：down=停机（受理报修建单）/ restored=复机恢复。 */
export type CapacityChangeKind = 'down' | 'restored'

/** 能力变化事件载荷（MT-10/MT-15：含停机起止与原因；载荷为业务时点快照，重试不改推当前值）。 */
export interface CapacityChangeEventPayload {
  changeKind: CapacityChangeKind
  orderId: string
  orderNo: string
  equipmentId: string
  equipmentCode: string
  plantId: string
  /** 停机起止（复机恢复事件含闭口区间；停机事件 endAt 为 null=在停机中） */
  downtimeStartAt: string
  downtimeEndAt: string | null
  downtimeReason: string
  occurredAt: string
}

/** MT-10/MT-15：构造能力变化事件（Outbox 行：aggregate=工单，task_kind 固定）。 */
export function buildCapacityChangeEvent(input: {
  changeKind: CapacityChangeKind
  orderId: string
  orderNo: string
  equipmentId: string
  equipmentCode: string
  plantId: string
  downtimeStartAt: string
  downtimeEndAt: string | null
  downtimeReason: string
  occurredAt: string
}): {
  aggregateType: string
  aggregateId: string
  taskKind: string
  payload: CapacityChangeEventPayload
} {
  return {
    aggregateType: CAPACITY_EVENT_AGGREGATE_TYPE,
    aggregateId: input.orderId,
    taskKind: CAPACITY_EVENT_TASK_KIND,
    payload: {
      changeKind: input.changeKind,
      orderId: input.orderId,
      orderNo: input.orderNo,
      equipmentId: input.equipmentId,
      equipmentCode: input.equipmentCode,
      plantId: input.plantId,
      downtimeStartAt: input.downtimeStartAt,
      downtimeEndAt: input.downtimeEndAt,
      downtimeReason: input.downtimeReason,
      occurredAt: input.occurredAt,
    },
  }
}
