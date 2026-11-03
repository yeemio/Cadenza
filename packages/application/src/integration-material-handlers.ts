import { ERROR_CODES } from '@cadenza/contracts'
import type { CommandHandler, HandlerOutcome } from './command-bus'
import {
  MATERIAL_MASTER_ENTITY_TYPE,
  type IntegrationMaterialCommandTools,
} from './integration-material-repositories'

/**
 * IF-01 料品主数据入站命令（集成块）。
 *
 * - integration.material-master.sync：模拟适配器（U9_SIM / SAP_SIM）经 HTTP 入站 upsert；
 *   遵守 IF-00.2 去重（external_mapping）、IF-00.3 external_revision 乱序保护、
 *   IF-00.8 缺组织映射 → inbox QUARANTINED。
 * - 不连真实 SAP/U9；GAP-B9（删除/停用、增量/全量）不在本命令范围。
 * - MD-01：本命令属集成面；业务面仍无 POST /masterdata/materials。
 */

type Payload = Record<string, unknown>

const ALLOWED_SOURCE_SYSTEMS = new Set(['U9_SIM', 'SAP_SIM'])

class MaterialInboundViolation extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message)
    this.name = 'MaterialInboundViolation'
  }
}

function bad(rule: string, message: string): never {
  throw new MaterialInboundViolation(rule, message)
}

function str(p: Payload, key: string): string | undefined {
  const v = p[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

function requireStr(p: Payload, key: string): string {
  const v = str(p, key)
  if (v === undefined) bad('IF-01', `料品入站载荷缺少必填字段 ${key}`)
  return v
}

function num(p: Payload, key: string): number | undefined {
  const v = p[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function requireMaterialType(p: Payload): number {
  const v = num(p, 'materialType')
  if (v === undefined || ![1, 2, 3].includes(v)) {
    bad('IF-01', 'materialType 必须为 1|2|3')
  }
  return v
}

function requireQcFlag(p: Payload): number {
  const v = num(p, 'qcFlag')
  if (v === undefined) return 0
  if (v !== 0 && v !== 1) bad('IF-01', 'qcFlag 必须为 0|1')
  return v
}

function requireRevision(p: Payload): number {
  const v = num(p, 'externalRevision')
  if (v === undefined || !Number.isInteger(v) || v < 1) {
    bad('IF-00.3', 'externalRevision 必须为正整数')
  }
  return v
}

async function materialMasterSync(
  tools: IntegrationMaterialCommandTools,
  enterpriseId: string,
  actorLoginName: string,
  p: Payload,
): Promise<Record<string, unknown>> {
  const companyOrgCode = str(p, 'companyOrgCode') ?? str(p, 'orgCode')
  if (companyOrgCode === undefined) bad('IF-01', '料品入站载荷缺少 companyOrgCode（或 orgCode）')
  const code = requireStr(p, 'code')
  const name = requireStr(p, 'name')
  const baseUom = requireStr(p, 'baseUom')
  const materialType = requireMaterialType(p)
  const qcFlag = requireQcFlag(p)
  const revision = requireRevision(p)
  const sourceSystem = str(p, 'sourceSystem') ?? 'U9_SIM'
  if (!ALLOWED_SOURCE_SYSTEMS.has(sourceSystem)) {
    bad('IF-01', `sourceSystem 须为模拟适配器标识（U9_SIM|SAP_SIM），收到 ${sourceSystem}`)
  }

  // IF-00.8：解析组织映射 → org_scope（企业）
  let orgScopeId: string | null = null
  const explicitScope = str(p, 'orgScopeId')
  if (explicitScope !== undefined) {
    const node = await tools.org.findById(explicitScope)
    if (node !== null && node.enterpriseId === enterpriseId && node.status === 'active') {
      orgScopeId = enterpriseId
    }
  }
  if (orgScopeId === null) {
    const mapped = await tools.org.findByCode(companyOrgCode)
    if (mapped !== null && mapped.status === 'active' && mapped.enterpriseId === enterpriseId) {
      orgScopeId = enterpriseId
    }
  }
  if (orgScopeId === null) {
    await tools.materialInbound.insertQuarantinedInbox({
      sourceSystem,
      organizationCode: companyOrgCode,
      externalKey: code,
      entityType: MATERIAL_MASTER_ENTITY_TYPE,
      quarantineReason: `缺组织映射（route_key=material_master）：companyOrgCode=${companyOrgCode} 无法解析到本企业，入隔离队列待人工补绑`,
      payload: p,
    })
    bad(
      'IF-00.8',
      `料品 ${code} 缺组织映射（companyOrgCode=${companyOrgCode}），已写入隔离队列（QUARANTINED），不生成默认料品`,
    )
  }

  // IF-00.2：映射命中 → IF-00.3 修订比较
  const existingMap = await tools.materialInbound.findLineMapping({
    sourceSystem,
    organizationCode: companyOrgCode,
    externalId: code,
  })

  if (existingMap !== null) {
    const existing = await tools.masterdata.materials.findById(existingMap.localObjectId)
    if (existing === null || existing.status !== 'active') {
      bad('IF-00.2', `料品映射指向的主数据不存在或已失效（${companyOrgCode}/${code}）`)
    }
    const applied = existing.externalRevision ?? 1
    if (revision <= applied) {
      return {
        materialId: existing.id,
        code: existing.code,
        applied: false,
        stale: revision < applied,
        reason:
          revision < applied
            ? 'external_revision 低于已应用版本，stale 不覆盖'
            : '业务键幂等命中，原结果重放',
        externalRevision: applied,
      }
    }
    const updated = await tools.materialInbound.applySyncRevision(
      existing.id,
      {
        name,
        materialGroupCode: str(p, 'materialGroupCode') ?? null,
        materialGroupName: str(p, 'materialGroupName') ?? null,
        descriptionZh: str(p, 'descriptionZh') ?? null,
        descriptionEn: str(p, 'descriptionEn') ?? null,
        voltage: str(p, 'voltage') ?? null,
        standard: str(p, 'standard') ?? null,
        customer: str(p, 'customer') ?? null,
        materialType,
        spec: str(p, 'spec') ?? null,
        color: str(p, 'color') ?? null,
        baseUom,
        qcFlag,
        remark: str(p, 'remark') ?? null,
        sourceSystem,
        companyOrgCode,
        externalRevision: revision,
      },
      actorLoginName,
    )
    await tools.audit.record({
      actor: actorLoginName,
      action: 'integration.material-master.sync',
      subjectType: MATERIAL_MASTER_ENTITY_TYPE,
      subjectId: existing.id,
      after: { code, companyOrgCode, sourceSystem, revisionApplied: revision },
      reason: str(p, 'reason') ?? null,
    })
    return {
      materialId: existing.id,
      code,
      applied: true,
      revisionApplied: revision,
      name: updated?.name ?? name,
    }
  }

  // 同企业同码已有行但无映射（历史种子/手工）→ 挂映射并按修订应用，避免唯一索引冲突
  const byCode = await tools.masterdata.materials.findActiveByCode(orgScopeId, code)
  if (byCode !== null) {
    await tools.materialInbound.insertLineMapping({
      sourceSystem,
      organizationCode: companyOrgCode,
      externalId: code,
      localObjectId: byCode.id,
      createdBy: actorLoginName,
    })
    const applied = byCode.externalRevision ?? 0
    if (revision <= applied) {
      return {
        materialId: byCode.id,
        code: byCode.code,
        applied: false,
        stale: revision < applied,
        reason: '同码已存在，修订未高于已应用版本',
        externalRevision: applied,
      }
    }
    const updated = await tools.materialInbound.applySyncRevision(
      byCode.id,
      {
        name,
        materialType,
        baseUom,
        qcFlag,
        sourceSystem,
        companyOrgCode,
        externalRevision: revision,
        descriptionZh: str(p, 'descriptionZh') ?? null,
        descriptionEn: str(p, 'descriptionEn') ?? null,
        spec: str(p, 'spec') ?? null,
        color: str(p, 'color') ?? null,
        remark: str(p, 'remark') ?? null,
      },
      actorLoginName,
    )
    return {
      materialId: byCode.id,
      code,
      applied: true,
      revisionApplied: revision,
      name: updated?.name ?? name,
      linkedExisting: true,
    }
  }

  const inserted = await tools.materialInbound.insert({
    orgScopeId,
    code,
    name,
    companyOrgCode,
    materialGroupCode: str(p, 'materialGroupCode') ?? null,
    materialGroupName: str(p, 'materialGroupName') ?? null,
    descriptionZh: str(p, 'descriptionZh') ?? null,
    descriptionEn: str(p, 'descriptionEn') ?? null,
    voltage: str(p, 'voltage') ?? null,
    standard: str(p, 'standard') ?? null,
    customer: str(p, 'customer') ?? null,
    materialType,
    spec: str(p, 'spec') ?? null,
    color: str(p, 'color') ?? null,
    baseUom,
    qcFlag,
    remark: str(p, 'remark') ?? null,
    sourceSystem,
    externalRevision: revision,
    createdBy: actorLoginName,
  })
  await tools.materialInbound.insertLineMapping({
    sourceSystem,
    organizationCode: companyOrgCode,
    externalId: code,
    localObjectId: inserted.id,
    createdBy: actorLoginName,
  })
  await tools.audit.record({
    actor: actorLoginName,
    action: 'integration.material-master.sync',
    subjectType: MATERIAL_MASTER_ENTITY_TYPE,
    subjectId: inserted.id,
    after: { code, companyOrgCode, sourceSystem, revisionApplied: revision },
    reason: str(p, 'reason') ?? null,
  })
  return {
    materialId: inserted.id,
    code: inserted.code,
    applied: true,
    revisionApplied: revision,
    name: inserted.name,
  }
}

function violationOutcome(error: MaterialInboundViolation): HandlerOutcome {
  return {
    status: 'BUSINESS_REJECTION',
    errorCode: ERROR_CODES.BUSINESS_RULE,
    errorMessage: `[${error.rule}] ${error.message}`,
  }
}

async function run(body: () => Promise<Record<string, unknown>>): Promise<HandlerOutcome> {
  try {
    const data = await body()
    return { status: 'COMMITTED', data }
  } catch (error) {
    if (error instanceof MaterialInboundViolation) return violationOutcome(error)
    throw error
  }
}

/** 命令处理器清单（组合根装配进 PgCommandBus）。 */
export function createIntegrationMaterialCommandHandlers(): CommandHandler[] {
  return [
    {
      commandType: 'integration.material-master.sync',
      handle: (envelope, ctx, tools): Promise<HandlerOutcome> =>
        run(async () => {
          const inboundTools = tools as IntegrationMaterialCommandTools
          const payload = (envelope.payload ?? {}) as Payload
          return materialMasterSync(inboundTools, ctx.enterpriseId, ctx.actorLoginName, payload)
        }),
    },
  ]
}
