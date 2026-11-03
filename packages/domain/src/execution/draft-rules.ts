import { ExecutionRuleViolation } from './errors'
import type { ReportSource } from './context'

/**
 * 草稿隔离与跨来源互斥 —— [底稿 A6-2]。
 *
 * - 草稿隔离键：同操作工+同订单+同来源至多一张未提交报工单；工作台报工再细分到工序（01 §1.2）；
 * - 跨来源互斥：同操作工同订单存在其它来源未提交单时不允许进入（01 §3.1、03 §3.1）；
 * - 草稿续作：再次进入带出产出/托码/库位/备注并锁工序（01 §3.3）——本机暂存仅体验层，
 *   服务端草稿是唯一权威（DM §6）。
 */

/** 已存在的未提交（open/draft）会话事实。 */
export interface OpenDraftFact {
  sessionId: string
  source: ReportSource
  orderOperationId: string | null
  operatorUserId: string
  orderId: string
}

/**
 * [底稿 A6-2] 草稿隔离键校验：新建/续作草稿前置。
 * 违反形态：
 * - 同操作工+同订单+同来源已存在未提交单（工作台来源按 工序 细分键判定）；
 * - 工作台草稿的工序键未提供时按粗键判定（拒绝，防止绕过细分键）。
 */
export function assertDraftIsolationAllowed(input: {
  operatorUserId: string
  orderId: string
  source: ReportSource
  /** 工作台来源必填（细分键）；其它来源忽略。 */
  orderOperationId?: string | null
  excludeSessionId?: string | null
  openDrafts: readonly OpenDraftFact[]
}): void {
  const sameOperatorOrder = input.openDrafts.filter(
    (d) =>
      d.operatorUserId === input.operatorUserId &&
      d.orderId === input.orderId &&
      d.sessionId !== input.excludeSessionId,
  )
  const clash = sameOperatorOrder.find((d) => {
    if (d.source !== input.source) return false
    if (input.source === 'workbench') {
      if (!input.orderOperationId) return true // 工作台进入必须带细分键，缺键按冲突拒绝
      return d.orderOperationId === input.orderOperationId
    }
    return true
  })
  if (clash !== undefined) {
    throw new ExecutionRuleViolation(
      'A6-2',
      input.source === 'workbench'
        ? '草稿隔离键：同操作工+同订单+同来源（工作台细分到工序）至多一张未提交报工单'
        : '草稿隔离键：同操作工+同订单+同来源至多一张未提交报工单',
    )
  }
}

/**
 * [底稿 A6-2] 跨来源互斥：有其它来源未提交单时不允许进入（新草稿/新入口会话创建前置）。
 */
export function assertNoCrossSourceOpenDraft(input: {
  operatorUserId: string
  orderId: string
  source: ReportSource
  excludeSessionId?: string | null
  openDrafts: readonly OpenDraftFact[]
}): void {
  const other = input.openDrafts.find(
    (d) =>
      d.operatorUserId === input.operatorUserId &&
      d.orderId === input.orderId &&
      d.source !== input.source &&
      d.sessionId !== input.excludeSessionId,
  )
  if (other !== undefined) {
    throw new ExecutionRuleViolation(
      'A6-2',
      `跨来源互斥：该操作工在此订单已有来源 ${other.source} 的未提交报工单，不允许从 ${input.source} 进入`,
    )
  }
}

/**
 * [底稿 A6-2] 草稿续作锁工序：草稿已有产出时工序不可改（01 §3.3 带出产出/托码/库位/备注并锁工序）。
 */
export function assertDraftOperationLocked(input: {
  currentOperationId: string | null
  requestedOperationId: string | null
  hasOutputs: boolean
}): void {
  if (
    input.hasOutputs &&
    input.currentOperationId !== null &&
    input.requestedOperationId !== input.currentOperationId
  ) {
    throw new ExecutionRuleViolation(
      'A6-2',
      '草稿续作带出产出/托码/库位/备注并锁工序：已有产出的草稿不可更换工序',
    )
  }
}

/** [底稿 A6-2] 主页「N条报工待提交」直达最早草稿（01 §3.3）：排序键 = 创建时间最早。 */
export function earliestDraft(openDrafts: readonly { sessionId: string; createdAt: string }[]): string | null {
  if (openDrafts.length === 0) return null
  return [...openDrafts].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]!.sessionId
}
