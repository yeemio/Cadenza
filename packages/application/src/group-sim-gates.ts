import type { CommandEnvelope, CommandResult } from '@cadenza/contracts'
import { addQty, cmpQty } from '@cadenza/domain'
import type { CommandBus, CommandContext } from './command-bus'

/** Server-owned adapters bind frozen SIM identities to this run's actual business objects. */
export interface GroupSimFacts {
  sourceHash: string
  enterpriseId: string
  tools: Array<{ id: string; equipmentId: string; plantId: string; validUntil: string; status: string }>
  amounts: Array<{ id: string; currency: string; amount: string }>
  conversion: { referenceId: string; sourceBasis: string; targetBasis: string; unit: string; sourcePerTarget: string; sourceQty: string; plantId: string }
  permits: Array<{ id: string; orderId: string; plantId: string; orderVersion: number; issuedAt: string; expiresAt: string; maxOutput: string }>
}
export interface GroupSimOrderScope {
  enterpriseId: string
  plantId: string
  version: number
}
export interface GroupSimGatesDeps {
  facts: GroupSimFacts
  now(): Date
  scheduling: CommandBus
  group: CommandBus
  shipping: CommandBus
  execution: CommandBus
  orderScope(orderId: string): Promise<GroupSimOrderScope | null>
}

/** These are local SIM entry points, not production offline authorization or a tool platform. */
export class GroupSimExecutionService {
  private readonly facts: GroupSimFacts
  constructor(private readonly deps: GroupSimGatesDeps) {
    // Request objects cannot mutate the server configuration after composition.
    this.facts = structuredClone(deps.facts)
  }

  private rejected(envelope: CommandEnvelope, rule: string, message: string): CommandResult {
    return { operationId: envelope.operationId, status: 'BUSINESS_REJECTION', errorCode: 'ERR_BUSINESS_RULE',
      errorMessage: `[${rule}] ${message}`, occurredAt: this.deps.now().toISOString() }
  }
  private sameEnterprise(context: CommandContext): boolean { return context.enterpriseId === this.facts.enterpriseId }

  async scheduleWithTool(toolId: string, envelope: CommandEnvelope<Record<string, unknown>>, context: CommandContext): Promise<CommandResult> {
    const tool = this.facts.tools.find(row => row.id === toolId)
    if (!this.sameEnterprise(context) || !tool || envelope.commandType !== 'scheduling.slot.save' ||
        envelope.payload['equipmentId'] !== tool.equipmentId) return this.rejected(envelope, 'SIM_TOOL_BINDING', '工装与设备/企业绑定不匹配')
    if (!['VALID', 'EXPIRED'].includes(tool.status) || this.deps.now().getTime() > Date.parse(tool.validUntil) ||
        String(envelope.payload['productionDate']) > tool.validUntil.slice(0, 10)) {
      return this.rejected(envelope, 'SIM_TOOL_EXPIRED', `工装资格已到期：${tool.id}`)
    }
    return this.deps.scheduling.execute(envelope, context)
  }

  /** Actual consumer: a SIM allocation proposal stores separated monetary summaries, not financial ledger facts. */
  async createAllocationProposal(input: { amountRefs: string[]; omitCurrency: boolean }, envelope: CommandEnvelope<Record<string, unknown>>, context: CommandContext): Promise<CommandResult> {
    if (!this.sameEnterprise(context) || envelope.commandType !== 'group.allocation-revision.create') return this.rejected(envelope, 'SIM_CURRENCY_ENTRY', '分配提案入口或企业不匹配')
    const refs = [...new Set(input.amountRefs)]
    const amounts = refs.map(ref => this.facts.amounts.find(row => row.id === ref))
    if (amounts.length === 0 || amounts.some(row => row === undefined)) return this.rejected(envelope, 'SIM_CURRENCY_SOURCE', '金额来源不存在')
    const byCurrency: Record<string, string> = {}
    for (const amount of amounts) {
      if (!amount) continue
      byCurrency[amount.currency] = addQty(byCurrency[amount.currency] ?? '0.0000', amount.amount)
    }
    if (input.omitCurrency) return this.rejected(envelope, 'SIM_CURRENCY_REQUIRED', '拒绝无币种总金额；没有汇率，不做跨币种换算')
    const currencySummary = { byCurrency, amountRefs: refs, convertedTotal: null, sourceHash: this.facts.sourceHash }
    const result = await this.deps.group.execute({ ...envelope, payload: { ...envelope.payload, currencySummary } }, context)
    return result.status === 'COMMITTED'
      ? { ...result, data: { ...(result.data as Record<string, unknown> | undefined), currencySummary } }
      : result
  }

  /** Actual consumer: only a validated cable length can become a real shipping plan line. */
  async receiveConvertedDeliveryPlan(input: { referenceId: string; sourceQty: string; sourceBasis: string; targetQty: string; targetBasis: string; unit: string }, envelope: CommandEnvelope<Record<string, unknown>>, context: CommandContext): Promise<CommandResult> {
    const rule = this.facts.conversion
    if (!this.sameEnterprise(context) || envelope.commandType !== 'shipping.pl.inbound' || envelope.payload['plantId'] !== rule.plantId ||
        input.referenceId !== rule.referenceId || input.sourceBasis !== rule.sourceBasis || input.targetBasis !== rule.targetBasis || input.unit !== rule.unit) {
      return this.rejected(envelope, 'SIM_BASIS_BINDING', '源对象、单位或计量basis与签发规则不匹配')
    }
    if (!isPositiveDecimal(input.sourceQty) || !isPositiveDecimal(input.targetQty) || cmpQty(input.sourceQty, rule.sourceQty) > 0 || !productEquals(input.targetQty, rule.sourcePerTarget, input.sourceQty)) {
      return this.rejected(envelope, 'SIM_BASIS_CONVERSION', `源${rule.sourceBasis}必须按${rule.sourcePerTarget}换算为${rule.targetBasis}，不能按相同单位直接交货`)
    }
    const lines = envelope.payload['lines']
    if (!Array.isArray(lines) || lines.length !== 1) return this.rejected(envelope, 'SIM_BASIS_LINE', '本SIM入口需要一个明确交货明细')
    const line = lines[0] as Record<string, unknown>
    if (line['lineKind'] !== 'plain_item' || line['requiredCount'] !== 1 || line['segmentLength'] !== input.targetQty) {
      return this.rejected(envelope, 'SIM_BASIS_LINE', '交货行数量必须与换算结果一致')
    }
    const result = await this.deps.shipping.execute(envelope, context)
    if (result.status !== 'COMMITTED') return result
    return { ...result, data: { ...(result.data as Record<string, unknown> | undefined), conversion: {
      referenceId: rule.referenceId, sourceQty: input.sourceQty, targetQty: input.targetQty,
      sourceBasis: rule.sourceBasis, targetBasis: rule.targetBasis, unit: rule.unit, sourceHash: this.facts.sourceHash,
    } } }
  }

  async submitOfflineReport(permitId: string, envelope: CommandEnvelope<Record<string, unknown>>, context: CommandContext): Promise<CommandResult> {
    const permit = this.facts.permits.find(row => row.id === permitId)
    if (!this.sameEnterprise(context) || !permit || envelope.commandType !== 'execution.report.submit' || envelope.payload['orderId'] !== permit.orderId) {
      return this.rejected(envelope, 'SIM_PERMIT_BINDING', '离线许可未绑定当前企业/订单/动作')
    }
    const scope = await this.deps.orderScope(permit.orderId)
    if (!scope || scope.enterpriseId !== context.enterpriseId || scope.plantId !== permit.plantId || scope.version !== permit.orderVersion) {
      return this.rejected(envelope, 'SIM_PERMIT_BINDING', '订单当前工厂或版本不在许可内')
    }
    const now = this.deps.now()
    if (now.getTime() < Date.parse(permit.issuedAt) || now.getTime() >= Date.parse(permit.expiresAt)) {
      return this.rejected(envelope, 'SIM_PERMIT_EXPIRED', '离线授权未生效或已到期，停止新增执行')
    }
    const outputs = envelope.payload['outputs']
    if (!Array.isArray(outputs) || outputs.length === 0) return this.rejected(envelope, 'SIM_PERMIT_OUTPUT', '本地许可仅允许有明确产出的报工')
    let total = '0.0000'
    for (const output of outputs as Array<Record<string, unknown>>) {
      if (!isPositiveDecimal(output['quantity']) || output['measurementBasis'] !== 'cable_m' || output['uomCode'] !== 'M') return this.rejected(envelope, 'SIM_PERMIT_OUTPUT', '许可只允许明确的成品米产出')
      total = addQty(total, output['quantity'])
    }
    if (cmpQty(total, permit.maxOutput) > 0) return this.rejected(envelope, 'SIM_PERMIT_OUTPUT', '单次申报超出许可产出上限')
    // No request-supplied timestamp, permit or approval fields can extend this server-side deadline.
    return this.deps.execution.execute(envelope, context)
  }
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(?:\.\d{1,4})?$/.test(value) && cmpQty(value, '0') > 0
}

function productEquals(left: string, factor: string, expected: string): boolean {
  const scaled = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    return BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, '0'))
  }
  return scaled(left) * scaled(factor) === scaled(expected) * 10000n
}
