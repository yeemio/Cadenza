import { randomUUID } from 'node:crypto'
import { ERROR_CODES } from '@cadenza/contracts'
import {
  SCAN_BLOCK_PERMISSIONS,
  P1RuleViolation,
  assertScanBlockEventCreatePayload,
} from '@cadenza/domain'
import type { CommandEnvelope } from '@cadenza/contracts'
import type { CommandHandler, CommandContext, HandlerOutcome } from './command-bus'
import type { ScanBlockCommandTools } from './scan-block-repositories'

type Payload = Record<string, unknown>

function rejection(error: P1RuleViolation): HandlerOutcome {
  const errorCode =
    error.rule === 'A-S1' ? ERROR_CODES.FORBIDDEN_SCOPE : ERROR_CODES.BUSINESS_RULE
  return {
    status: 'BUSINESS_REJECTION',
    errorCode,
    errorMessage: `[${error.rule}] ${error.message}`,
  }
}

async function run(body: () => Promise<Record<string, unknown>>): Promise<HandlerOutcome> {
  try {
    const data = await body()
    return { status: 'COMMITTED', data }
  } catch (error) {
    if (error instanceof P1RuleViolation) return rejection(error)
    throw error
  }
}

async function assertPermission(tools: ScanBlockCommandTools, needed: string): Promise<void> {
  const perms = await tools.actorPermissions()
  if (!perms.includes(needed)) {
    throw new P1RuleViolation('A-S1', `缺少岗位许可 ${needed}`)
  }
}

async function assertPlantInScope(
  tools: ScanBlockCommandTools,
  plantId: string,
  enterpriseId: string,
): Promise<void> {
  const node = await tools.org.findById(plantId)
  if (node === null || node.status !== 'active' || node.enterpriseId !== enterpriseId) {
    throw new P1RuleViolation('E09-S1', `工厂不存在或不属于当前企业（plantId=${plantId}）`)
  }
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new P1RuleViolation('A-S1', '目标工厂不在授权数据范围内')
  }
}

/**
 * SCAN-BLOCK 域命令：
 * - scan-block.event.create
 */
export function createScanBlockCommandHandlers(): CommandHandler[] {
  return [
    {
      commandType: 'scan-block.event.create',
      async handle(
        envelope: CommandEnvelope<unknown>,
        context: CommandContext,
        tools: ScanBlockCommandTools,
      ): Promise<HandlerOutcome> {
        return run(async () => {
          await assertPermission(tools, SCAN_BLOCK_PERMISSIONS.SCAN_BLOCK_POST)
          const p = (envelope.payload ?? {}) as Payload
          const fields = assertScanBlockEventCreatePayload(p)
          await assertPlantInScope(tools, fields.plantId, context.enterpriseId)
          const eventNo =
            fields.eventNo ??
            `SBE-${tools.now().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`
          const id = randomUUID()
          const row = await tools.scanBlockEvents.insert({
            id,
            eventNo,
            policyCode: fields.policyCode,
            scanCode: fields.scanCode,
            blockReason: fields.blockReason,
            severity: fields.severity ?? 'block',
            status: 'open',
            payload: p,
            enterpriseId: context.enterpriseId,
            plantId: fields.plantId,
            createdBy: context.actorLoginName,
          })
          return {
            id: row.id,
            eventNo: row.eventNo,
            policyCode: row.policyCode,
            scanCode: row.scanCode,
            severity: row.severity,
            status: row.status,
            plantId: row.plantId,
          }
        })
      },
    },
  ]
}
