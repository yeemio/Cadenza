import { ERROR_CODES } from '@cadenza/contracts'
import { CONCURRENCY_RETRY, InventoryRuleViolation } from '@cadenza/domain'
import type { CommandHandler, HandlerOutcome } from './command-bus'
import type { InventoryCommandTools } from './inventory-repositories'
import {
  NOT_FOUND_RULE,
  acquireReservation,
  establishBusinessHold,
  buildPostingContext,
  issueMaterial,
  moveStock,
  receiveGoods,
  releaseReservation,
  returnMaterial,
  splitStock,
  transferIn,
  transferOut,
  type PostingContext,
} from './inventory-posting'

/**
 * inventory 域命令处理器（全部在命令总线事务内运行；IT-18：库存域唯一维护方入口）。
 *
 * - 幂等/回执由 PgCommandBus 承担（IT-19/21：流水 (command_receipt_id, line_no) 唯一、
 *   同键同载荷回放原结果、同键异载荷拒）；
 * - 处理器只做：载荷校验（十进制字符串 IT-07）→ 记账服务编排 → 违例映射（IT-22 五态中的
 *   COMMITTED / BUSINESS_REJECTION；DRAFT_SAVED / VERSION_CONFLICT / UNKNOWN_PENDING_QUERY
 *   由总线与后续域命令使用）；
 * - IT-27：唯一约束冲突（如并发同键余额插入，pg 23505）由调用侧有界重试；
 *   行级余量竞争在行锁串行后以可解释业务拒绝收敛，不需要重试。
 */

/** InventoryRuleViolation → HandlerOutcome（错误码映射；信息中文可读）。 */
export function violationOutcome(error: InventoryRuleViolation): HandlerOutcome {
  let errorCode: string = ERROR_CODES.BUSINESS_RULE
  if (error.rule === 'IT-14' || error.rule === 'IT-30' || error.rule === 'IT-15') {
    errorCode = ERROR_CODES.INSUFFICIENT_STOCK
  } else if (error.rule === 'IT-S1') {
    errorCode = ERROR_CODES.FORBIDDEN_SCOPE
  } else if (error.rule === NOT_FOUND_RULE) {
    errorCode = ERROR_CODES.NOT_FOUND
  }
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<Record<string, unknown>>): Promise<HandlerOutcome> {
  try {
    const data = await body()
    return { status: 'COMMITTED', data }
  } catch (error) {
    if (error instanceof InventoryRuleViolation) return violationOutcome(error)
    throw error
  }
}

/** IT-27：pg 唯一约束冲突（23505）判定，供外层有界重试。 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505'
  )
}

export const INVENTORY_CONCURRENCY_RETRY = CONCURRENCY_RETRY

type InventoryHandlerFn = (pc: PostingContext, p: Record<string, unknown>) => Promise<Record<string, unknown>>

/** 命令处理器清单（组合根装配进 PgCommandBus）。 */
export function createInventoryCommandHandlers(): CommandHandler[] {
  const make = (commandType: string, fn: InventoryHandlerFn): CommandHandler => ({
    commandType,
    handle: (envelope, ctx, tools): Promise<HandlerOutcome> =>
      run(async () => {
        const inventoryTools = tools as InventoryCommandTools // 组合根构造的工具集窄化（见 inventory.composition）
        const payload = (envelope.payload ?? {}) as Record<string, unknown>
        const pc = await buildPostingContext(inventoryTools, ctx, commandType, envelope.operationId, payload)
        return fn(pc, payload)
      }),
  })

  return [
    make('inventory.business-hold.establish', establishBusinessHold),
    make('inventory.receive-goods', receiveGoods),
    make('inventory.issue-material', issueMaterial),
    make('inventory.return-material', returnMaterial),
    make('inventory.move-stock', moveStock),
    make('inventory.transfer.out', transferOut),
    make('inventory.transfer.in', transferIn),
    make('inventory.split', splitStock),
    make('inventory.reservation.acquire', acquireReservation),
    make('inventory.reservation.release', releaseReservation),
  ]
}
