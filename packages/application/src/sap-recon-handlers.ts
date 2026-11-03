import { randomUUID } from 'node:crypto'
import { ERROR_CODES } from '@cadenza/contracts'
import {
  GROUP_PERMISSIONS,
  SapReconRuleViolation,
  assertSapReconCreatePayload,
  GroupRuleViolation,
} from '@cadenza/domain'
import type { CommandEnvelope } from '@cadenza/contracts'
import type { CommandHandler, CommandContext, HandlerOutcome } from './command-bus'
import type { SapReconCommandTools } from './sap-recon-repositories'

type Payload = Record<string, unknown>

function rejection(error: SapReconRuleViolation | GroupRuleViolation): HandlerOutcome {
  const errorCode =
    error instanceof GroupRuleViolation && error.rule === 'A-S1'
      ? ERROR_CODES.FORBIDDEN_SCOPE
      : ERROR_CODES.BUSINESS_RULE
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<Record<string, unknown>>): Promise<HandlerOutcome> {
  try {
    return { status: 'COMMITTED', data: await body() }
  } catch (error) {
    if (error instanceof SapReconRuleViolation || error instanceof GroupRuleViolation) return rejection(error)
    throw error
  }
}

export function createSapReconCommandHandlers(): CommandHandler[] {
  return [
    {
      commandType: 'sap.reconciliation.create',
      async handle(
        envelope: CommandEnvelope<unknown>,
        context: CommandContext,
        tools: SapReconCommandTools,
      ): Promise<HandlerOutcome> {
        return run(async () => {
          const perms = await tools.actorPermissions()
          if (!perms.includes(GROUP_PERMISSIONS.GROUP_POST)) {
            throw new GroupRuleViolation('A-S1', `缺少岗位许可 ${GROUP_PERMISSIONS.GROUP_POST}`)
          }
          const p = (envelope.payload ?? {}) as Payload
          const fields = assertSapReconCreatePayload(p)
          const node = await tools.org.findById(fields.plantId)
          if (node === null || node.status !== 'active' || node.enterpriseId !== context.enterpriseId) {
            throw new GroupRuleViolation('G-01', `工厂不存在或不属于当前企业（plantId=${fields.plantId}）`)
          }
          const scope = await tools.actorDataScope()
          if (!scope.enterpriseWide && !scope.plantIds.includes(fields.plantId)) {
            throw new GroupRuleViolation('A-S1', '目标工厂不在授权数据范围内')
          }
          const reconNo =
            fields.reconNo ??
            `SREC-${tools.now().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`
          const matchStatus = fields.matchStatus ?? 'OPEN'
          const row = await tools.sapReconciliation.insert({
            id: randomUUID(),
            reconNo,
            objectCode: fields.objectCode,
            objectName: fields.objectName ?? null,
            momQty: fields.momQty ?? null,
            sapQty: fields.sapQty ?? null,
            diffQty: fields.diffQty ?? null,
            currencyCode: fields.currencyCode ?? null,
            matchStatus,
            title: fields.title,
            reason: fields.reason,
            sapStockState: fields.sapStockState ?? null,
            momHold: fields.momHold ?? null,
            unknownSliceQty: fields.unknownSliceQty ?? null,
            payload: {
              ...p,
              actual_connection: false,
              notCostReconItems: true,
              notFixture: true,
              classification: matchStatus,
              gb02Aligned: true,
            },
            enterpriseId: context.enterpriseId,
            plantId: fields.plantId,
            createdBy: context.actorLoginName,
          })
          return {
            id: row.id,
            reconNo: row.reconNo,
            objectCode: row.objectCode,
            matchStatus: row.matchStatus,
            classification: row.matchStatus,
            plantId: row.plantId,
            title: row.title,
            sapStockState: row.sapStockState ?? null,
            momHold: row.momHold ?? null,
            unknownSliceQty: row.unknownSliceQty ?? null,
            actual_connection: false,
            boundary: 'full_recon_sim_classification;≠cost/recon-items;≠fixture;≠REAL-SAP',
          }
        })
      },
    },
  ]
}
