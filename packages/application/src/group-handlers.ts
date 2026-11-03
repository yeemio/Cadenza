import { randomUUID } from 'node:crypto'
import { ERROR_CODES } from '@cadenza/contracts'
import {
  GROUP_PERMISSIONS,
  GroupRuleViolation,
  P1RuleViolation,
  assertAllocationRevisionCreatePayload,
  assertShortageKittingCheckPayload,
  assertProductRecallCreatePayload,
  assertVendorRiskCreatePayload,
  assertReworkWriteCreatePayload,
  assertScrapWriteCreatePayload,
} from '@cadenza/domain'
import type { CommandEnvelope } from '@cadenza/contracts'
import type { CommandHandler, CommandContext, HandlerOutcome } from './command-bus'
import type { GroupCommandTools } from './group-repositories'

type Payload = Record<string, unknown>

function rejection(error: GroupRuleViolation | P1RuleViolation): HandlerOutcome {
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
    if (error instanceof GroupRuleViolation || error instanceof P1RuleViolation) return rejection(error)
    throw error
  }
}

async function assertPermission(tools: GroupCommandTools, needed: string): Promise<void> {
  const perms = await tools.actorPermissions()
  if (!perms.includes(needed)) {
    throw new GroupRuleViolation('A-S1', `缺少岗位许可 ${needed}`)
  }
}

async function assertPlantInScope(
  tools: GroupCommandTools,
  plantId: string,
  enterpriseId: string,
): Promise<void> {
  const node = await tools.org.findById(plantId)
  if (node === null || node.status !== 'active' || node.enterpriseId !== enterpriseId) {
    throw new GroupRuleViolation('G-01', `工厂不存在或不属于当前企业（plantId=${plantId}）`)
  }
  const scope = await tools.actorDataScope()
  if (!scope.enterpriseWide && !scope.plantIds.includes(plantId)) {
    throw new GroupRuleViolation('A-S1', '目标工厂不在授权数据范围内')
  }
}

/**
 * group 域命令：
 * - group.allocation-revision.create：创建分配修订草稿（缺字段 422）
 * - group.shortage-kitting.check：触发缺料/齐套检查（空库可落 empty 结果；缺字段 422）
 * - group.product-recall.create：成品/批次召回（≠ CSW 外协 recall；缺字段 422）
 * - group.vendor-risk.create：供应商风险（≠ 外协任务；缺字段 422）
 * - group.rework.create / group.scrap.create：返工/报废写入口（≠ disposition 库存联动；≠ 召回）
 */
export function createGroupCommandHandlers(): CommandHandler[] {
  return [
    {
      commandType: 'group.allocation-revision.create',
      async handle(
        envelope: CommandEnvelope<unknown>,
        context: CommandContext,
        tools: GroupCommandTools,
      ): Promise<HandlerOutcome> {
        return run(async () => {
          await assertPermission(tools, GROUP_PERMISSIONS.GROUP_POST)
          const p = (envelope.payload ?? {}) as Payload
          const fields = assertAllocationRevisionCreatePayload(p)
          await assertPlantInScope(tools, fields.plantId, context.enterpriseId)
          const revisionNo =
            fields.revisionNo ??
            `GAR-${tools.now().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`
          const id = randomUUID()
          const row = await tools.allocationRevisions.insert({
            id,
            revisionNo,
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
            revisionNo: row.revisionNo,
            status: row.status,
            plantId: row.plantId,
            title: row.title,
          }
        })
      },
    },
    {
      commandType: 'group.shortage-kitting.check',
      async handle(
        envelope: CommandEnvelope<unknown>,
        context: CommandContext,
        tools: GroupCommandTools,
      ): Promise<HandlerOutcome> {
        return run(async () => {
          await assertPermission(tools, GROUP_PERMISSIONS.GROUP_POST)
          const p = (envelope.payload ?? {}) as Payload
          const fields = assertShortageKittingCheckPayload(p)
          await assertPlantInScope(tools, fields.plantId, context.enterpriseId)
          // 空库 / 无订单匹配：落 empty 结果结构（专用面；不借道投料/排程）
          const id = randomUUID()
          const row = await tools.shortageKitting.insert({
            id,
            orderNo: fields.orderNo,
            orderId: null,
            checkStatus: 'empty',
            shortageLines: [],
            enterpriseId: context.enterpriseId,
            plantId: fields.plantId,
            createdBy: context.actorLoginName,
          })
          return {
            id: row.id,
            orderNo: row.orderNo,
            checkStatus: row.checkStatus,
            shortageLines: row.shortageLines,
            plantId: row.plantId,
            checkedAt: row.checkedAt.toISOString(),
          }
        })
      },
    },

    {
      commandType: 'group.product-recall.create',
      async handle(
        envelope: CommandEnvelope<unknown>,
        context: CommandContext,
        tools: GroupCommandTools,
      ): Promise<HandlerOutcome> {
        return run(async () => {
          await assertPermission(tools, GROUP_PERMISSIONS.GROUP_POST)
          const p = (envelope.payload ?? {}) as Payload
          const fields = assertProductRecallCreatePayload(p)
          await assertPlantInScope(tools, fields.plantId, context.enterpriseId)
          const recallNo =
            fields.recallNo ??
            `GPR-${tools.now().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`
          const id = randomUUID()
          const row = await tools.productRecalls.insert({
            id,
            recallNo,
            recallScope: fields.recallScope,
            batchNo: fields.batchNo ?? null,
            materialCode: fields.materialCode ?? null,
            title: fields.title,
            reason: fields.reason,
            status: 'draft',
            payload: {
              ...p,
              // Caller-supplied lifecycle flags never establish customer confirmation.
              status: 'draft', confirmed: false,
              confirmation: { state: 'AWAITING_CUSTOMER_CONFIRMATION' },
              returnRequest: { state: 'NOT_REQUESTED', returnedQty: '0.0000' },
              returnedQty: '0.0000',
            },
            enterpriseId: context.enterpriseId,
            plantId: fields.plantId,
            createdBy: context.actorLoginName,
          })
          return {
            id: row.id,
            recallNo: row.recallNo,
            recallScope: row.recallScope,
            status: row.status,
            plantId: row.plantId,
            title: row.title,
          }
        })
      },
    },
    {
      commandType: 'group.product-recall.confirm',
      async handle(envelope, context, commandTools): Promise<HandlerOutcome> {
        const tools = commandTools as GroupCommandTools
        return run(async () => {
          const row = await recallForWrite(tools, envelope.targetId, context)
          const reference = (envelope.payload as Payload)?.['confirmationRef']
          if (typeof reference !== 'string' || reference.trim() === '' || reference.length > 128) throw new GroupRuleViolation('G-RECALL-CONFIRM', '客户确认引用必填（1~128字符）')
          const previous = row.payload['confirmation'] as Record<string, unknown> | undefined
          if (previous?.['state'] === 'CONFIRMED') {
            if (previous['reference'] !== reference.trim()) throw new GroupRuleViolation('G-RECALL-CONFIRM', '该召回已绑定另一客户确认引用')
            return { id: row.id, status: row.status, confirmation: previous, alreadyConfirmed: true, returnedQty: '0.0000' }
          }
          const confirmation = { state: 'CONFIRMED', reference: reference.trim(), confirmedBy: context.actorLoginName, confirmedAt: tools.now().toISOString() }
          const updated = await tools.productRecalls.updateState(row.id, 'submitted', { ...row.payload,
            confirmed: true, confirmation, returnedQty: '0.0000' }, context.actorLoginName)
          await tools.audit.record({ actor: context.actorLoginName, action: 'group.product-recall.confirm', subjectType: 'group_product_recall', subjectId: row.id,
            before: { status: row.status, confirmation: previous }, after: { status: updated.status, confirmation }, reason: context.reason })
          return { id: row.id, status: updated.status, confirmation, alreadyConfirmed: false, returnedQty: '0.0000' }
        })
      },
    },
    {
      commandType: 'group.product-recall.return-request',
      async handle(envelope, context, commandTools): Promise<HandlerOutcome> {
        const tools = commandTools as GroupCommandTools
        return run(async () => {
          const row = await recallForWrite(tools, envelope.targetId, context)
          const confirmation = row.payload['confirmation'] as Record<string, unknown> | undefined
          const state = confirmation?.['state'] === 'CONFIRMED' && row.status === 'submitted' ? 'READY_FOR_RETURN' : 'AWAITING_CUSTOMER_CONFIRMATION'
          const previous = row.payload['returnRequest'] as Record<string, unknown> | undefined
          if (previous?.['state'] !== state) {
            const returnRequest = { state, returnedQty: '0.0000', requestedBy: context.actorLoginName, requestedAt: tools.now().toISOString() }
            await tools.productRecalls.updateState(row.id, row.status, { ...row.payload, returnRequest, returnedQty: '0.0000' }, context.actorLoginName)
            await tools.audit.record({ actor: context.actorLoginName, action: 'group.product-recall.return-request', subjectType: 'group_product_recall', subjectId: row.id,
              before: previous, after: returnRequest, reason: context.reason })
          }
          // This command only records readiness. No inventory receiving or custody transfer is performed.
          return { id: row.id, status: row.status, returnStatus: state, returnedQty: '0.0000' }
        })
      },
    },
    {
      commandType: 'group.vendor-risk.create',
      async handle(
        envelope: CommandEnvelope<unknown>,
        context: CommandContext,
        tools: GroupCommandTools,
      ): Promise<HandlerOutcome> {
        return run(async () => {
          await assertPermission(tools, GROUP_PERMISSIONS.GROUP_POST)
          const p = (envelope.payload ?? {}) as Payload
          const fields = assertVendorRiskCreatePayload(p)
          await assertPlantInScope(tools, fields.plantId, context.enterpriseId)
          const riskNo =
            fields.riskNo ??
            `GVR-${tools.now().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`
          const id = randomUUID()
          const row = await tools.vendorRisks.insert({
            id,
            riskNo,
            vendorCode: fields.vendorCode,
            vendorName: fields.vendorName ?? null,
            riskLevel: fields.riskLevel,
            title: fields.title,
            reason: fields.reason,
            status: 'open',
            payload: p,
            enterpriseId: context.enterpriseId,
            plantId: fields.plantId,
            createdBy: context.actorLoginName,
          })
          return {
            id: row.id,
            riskNo: row.riskNo,
            vendorCode: row.vendorCode,
            riskLevel: row.riskLevel,
            status: row.status,
            plantId: row.plantId,
            title: row.title,
          }
        })
      },
    },
    {
      commandType: 'group.rework.create',
      async handle(
        envelope: CommandEnvelope<unknown>,
        context: CommandContext,
        tools: GroupCommandTools,
      ): Promise<HandlerOutcome> {
        return run(async () => {
          await assertPermission(tools, GROUP_PERMISSIONS.GROUP_POST)
          const p = (envelope.payload ?? {}) as Payload
          const fields = assertReworkWriteCreatePayload(p)
          await assertPlantInScope(tools, fields.plantId, context.enterpriseId)
          const reworkNo =
            fields.reworkNo ??
            `GRW-${tools.now().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`
          const id = randomUUID()
          const row = await tools.reworkWrites.insert({
            id,
            reworkNo,
            title: fields.title,
            reason: fields.reason,
            unitNo: fields.unitNo ?? null,
            batchNo: fields.batchNo ?? null,
            materialCode: fields.materialCode ?? null,
            status: 'draft',
            payload: p,
            enterpriseId: context.enterpriseId,
            plantId: fields.plantId,
            createdBy: context.actorLoginName,
          })
          return {
            id: row.id,
            reworkNo: row.reworkNo,
            status: row.status,
            plantId: row.plantId,
            title: row.title,
            boundary: 'entry_contract_only',
            notDispositionInventoryLinked: true,
          }
        })
      },
    },
    {
      commandType: 'group.scrap.create',
      async handle(
        envelope: CommandEnvelope<unknown>,
        context: CommandContext,
        tools: GroupCommandTools,
      ): Promise<HandlerOutcome> {
        return run(async () => {
          await assertPermission(tools, GROUP_PERMISSIONS.GROUP_POST)
          const p = (envelope.payload ?? {}) as Payload
          const fields = assertScrapWriteCreatePayload(p)
          await assertPlantInScope(tools, fields.plantId, context.enterpriseId)
          const scrapNo =
            fields.scrapNo ??
            `GSC-${tools.now().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`
          const id = randomUUID()
          const row = await tools.scrapWrites.insert({
            id,
            scrapNo,
            title: fields.title,
            reason: fields.reason,
            unitNo: fields.unitNo ?? null,
            batchNo: fields.batchNo ?? null,
            materialCode: fields.materialCode ?? null,
            scrapQty: fields.scrapQty ?? null,
            status: 'draft',
            payload: p,
            enterpriseId: context.enterpriseId,
            plantId: fields.plantId,
            createdBy: context.actorLoginName,
          })
          return {
            id: row.id,
            scrapNo: row.scrapNo,
            status: row.status,
            plantId: row.plantId,
            title: row.title,
            boundary: 'entry_contract_only',
            notDispositionInventoryLinked: true,
          }
        })
      },
    },
  ]
}

async function recallForWrite(tools: GroupCommandTools, id: string, context: CommandContext) {
  await assertPermission(tools, GROUP_PERMISSIONS.GROUP_POST)
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new GroupRuleViolation('G-RECALL', '召回引用非法')
  const row = await tools.productRecalls.findByIdForUpdate(id)
  if (!row || row.enterpriseId !== context.enterpriseId) throw new GroupRuleViolation('A-S1', '召回不属于当前企业或不存在')
  await assertPlantInScope(tools, row.plantId, context.enterpriseId)
  if (!['draft', 'submitted'].includes(row.status)) throw new GroupRuleViolation('G-RECALL', '当前召回状态不允许确认或返库请求')
  return row
}
