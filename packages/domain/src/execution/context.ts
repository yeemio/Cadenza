import { ExecutionRuleViolation } from './errors'

/**
 * 三入口共享报工上下文（ReportContext）——[底稿 A6-1 + K13/DM §2 execution_session]。
 *
 * 三入口与来源（01/02/03 §1.1）：
 * - 实绩录入 → source='order'（订单列表→工作台→实绩录入）；
 * - 工作台 → source='workbench'（车间→工序宫格，工序固定）；
 * - 扫码报工 → source='scan'（扫设备码→按班次日期带任务单，设备默认=扫到的设备）。
 *
 * K13/DM §2：来源/工序/设备显式绑定 —— 来源三值、订单/工序/设备/班次/操作者都是
 * 服务端显式字段（不是 UI 隐含状态）；同工序规则不分叉（B12 收敛为单一服务端判定）。
 */

export const REPORT_SOURCES = ['order', 'workbench', 'scan'] as const
export type ReportSource = (typeof REPORT_SOURCES)[number]

export interface ReportContextInput {
  source: string
  orderId: string
  /** 订单工序绑定（order_operation.id）。workbench 必填（工序固定）；order/scan 可缺省后补。 */
  orderOperationId?: string | null
  /** 设备显式绑定。scan 必填（扫到的设备）；其余入口可空。 */
  equipmentId?: string | null
  equipmentCode?: string | null
  /** 班次日期（业务班次口径，A4：按白班起点计算，非自然日）。 */
  shiftDate?: string | null
  operatorUserId?: string | null
}

/**
 * [底稿 A6-1] ReportContext 校验：来源三值 + 显式绑定形态。
 * - source ∈ {order, workbench, scan}；
 * - workbench 必须绑定工序（工序宫格进入，工序固定）；
 * - scan 必须绑定设备（扫设备码进入，设备默认=扫到的设备）；
 * - orderId 必填（三入口都以订单为载体）；operatorUserId 必填（服务端从会话补齐，不信客户端自报）。
 */
export function assertReportContext(input: ReportContextInput): void {
  if (!REPORT_SOURCES.includes(input.source as ReportSource)) {
    throw new ExecutionRuleViolation(
      'A6-1',
      `报工来源必须为 order/workbench/scan 三值之一（收到 ${input.source}）`,
    )
  }
  if (!input.orderId) {
    throw new ExecutionRuleViolation('A6-1', 'ReportContext 缺少订单绑定（orderId 必填）')
  }
  if (!input.operatorUserId) {
    throw new ExecutionRuleViolation('A6-1', 'ReportContext 缺少操作者绑定（operatorUserId 必填，服务端补齐）')
  }
  if (input.source === 'workbench' && !input.orderOperationId) {
    throw new ExecutionRuleViolation('A6-1', '工作台报工必须显式绑定工序（工序宫格进入，工序固定）')
  }
  if (input.source === 'scan') {
    if (!input.equipmentId) {
      throw new ExecutionRuleViolation('A6-1', '扫码报工必须显式绑定设备（扫设备码进入，设备默认=扫到的设备）')
    }
    if (!input.shiftDate) {
      throw new ExecutionRuleViolation('A6-1', '扫码报工必须携带班次日期（按班次日期带任务单）')
    }
  }
}

/** [底稿 A6-1/K13] 一张报工单只存一道工序（K15）：报工载荷的产出/投料行不得携带异己工序。 */
export function assertSingleOperationBinding(input: {
  orderOperationId: string
  lineOperationIds: readonly (string | null | undefined)[]
}): void {
  for (const opId of input.lineOperationIds) {
    if (opId !== undefined && opId !== null && opId !== input.orderOperationId) {
      throw new ExecutionRuleViolation(
        'A6-1',
        '一张报工单只存一道工序（K15）：产出/投料行的工序绑定与报工单不一致',
      )
    }
  }
}
