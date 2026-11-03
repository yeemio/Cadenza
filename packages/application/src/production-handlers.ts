import { randomUUID } from 'node:crypto'
import { ERROR_CODES } from '@cadenza/contracts'
import {
  PRODUCTION_PERMISSIONS,
  P1RuleViolation,
  assertFeedRacePlanCreatePayload,
} from '@cadenza/domain'
import type { CommandEnvelope } from '@cadenza/contracts'
import type { CommandHandler, CommandContext, HandlerOutcome } from './command-bus'
import type { ProductionCommandTools } from './production-repositories'

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

async function assertPermission(tools: ProductionCommandTools, needed: string): Promise<void> {
  const perms = await tools.actorPermissions()
  if (!perms.includes(needed)) {
    throw new P1RuleViolation('A-S1', `缺少岗位许可 ${needed}`)
  }
}

async function assertPlantInScope(
  tools: ProductionCommandTools,
  plantId: string,
  enterpriseId: string,
): Promise<void> {
  const node = await tools.org.findById(plantId)
  if (node === null || node.status !== 'active' || node.enterpriseId !== enterpriseId) {
    throw new P1RuleViolation('E09-F1', `工厂不存在或不属于当前企业（plantId=${plantId}）`)
  }
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new P1RuleViolation('A-S1', '目标工厂不在授权数据范围内')
  }
}

/**
 * production 域命令（E09 投料竞争专用面）：
 * - production.feed-race-plan.create
 */
export function createProductionCommandHandlers(): CommandHandler[] {
  return [
    {
      commandType: 'production.feed-race-plan.create',
      async handle(
        envelope: CommandEnvelope<unknown>,
        context: CommandContext,
        tools: ProductionCommandTools,
      ): Promise<HandlerOutcome> {
        return run(async () => {
          await assertPermission(tools, PRODUCTION_PERMISSIONS.PRODUCTION_POST)
          const p = (envelope.payload ?? {}) as Payload
          const fields = assertFeedRacePlanCreatePayload(p)
          await assertPlantInScope(tools, fields.plantId, context.enterpriseId)
          const planNo =
            fields.planNo ??
            `FRP-${tools.now().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`
          const id = randomUUID()
          const row = await tools.feedRacePlans.insert({
            id,
            planNo,
            planKind: fields.planKind,
            title: fields.title,
            reason: fields.reason,
            status: 'draft',
            payload: p,
            enterpriseId: context.enterpriseId,
            plantId: fields.plantId,
            createdBy: context.actorLoginName,
          })
          return {
            id: row.id,
            planNo: row.planNo,
            planKind: row.planKind,
            status: row.status,
            plantId: row.plantId,
            title: row.title,
          }
        })
      },
    },
  ]
}
