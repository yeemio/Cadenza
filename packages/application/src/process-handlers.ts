import { cmpQty } from '@cadenza/domain'
import { ERROR_CODES } from '@cadenza/contracts'
import { OrgRuleViolation, isPlantInScope } from '@cadenza/domain'
import type { CommandHandler, CommandTools, HandlerOutcome } from './command-bus'
// [L0-整合标记] 跨包新文件 dist 相对导入（Wave3 协议）：待 packages/domain/src/index.ts
// 导出 './process' 后改为 `from '@cadenza/domain'` 并删除下一行 eslint-disable。
// 注意：domain/src/process 源码变更后须先 `pnpm --filter @cadenza/domain build` 再 typecheck/test。
import {
  ProcessRuleViolation,
  assertCoreMultiple,
  assertNoExistingPublishedVersion,
  assertOfflineQty,
  assertOperationDefinitionLockedFieldsEditable,
  assertOperationDefinitionRetirable,
  assertOperationNameNoEdgeSpaces,
  assertOrderQty,
  assertOrderResumable,
  assertOrderStartable,
  assertOrderSuspendable,
  assertOrderTransition,
  assertOrderVoidable,
  assertRevisionContentMutable,
  assertRevisionPublishable,
  assertRevisionRetirable,
  assertRevisionStatus,
  assertStrandFactor,
  computeOperationRequirements,
  findOperationDefinitionConflict,
  nextRevisionVersion,
  type ProcessRevisionStatus,
} from '@cadenza/domain'
import type {
  BomLine,
  NewOrderOperation,
  NewProcessRevision,
  OperationDefinitionPatch,
  ProcessCommandTools,
  ProcessRevisionBase,
  ProcessRevisionKey,
  ProcessRevisionPatch,
  ProcessRevisionRepositoryPort,
  RouteStep,
} from './process-repositories'
import type { OrgNodeRecord } from './repositories'

/**
 * process 域命令处理器（全部在命令总线事务内运行；命令事务即 UoW）。
 * 规则来源为咨询底稿 03-production-chain-rules-T05T09T10T11.md 的 A1/A2 节
 * （本域尚无冻结合同，逐条对照见 delivery/L1/server-process/DELIVERY.md §6）；
 * 写路径范围二道防线沿用 OA-26 模式（HTTP 守卫首检 + 事务内服务端复核）。
 *
 * 命令面（24）：
 * - 产品族 create/update/retire；
 * - BOM/路线/参数规范 create/update/publish/retire（×3，[底稿 A2-2] 版本冻结）；
 * - 工序主数据 create/update/retire（[底稿 A1-3] 唯一性/引用保护/编辑锁）；
 * - 生产订单 receive（模拟 U9 入站：订单 + 工序展开 + 快照冻结，[底稿 A2-3]）/release/start
 *   （[底稿 A1-1] 开工前置）/suspend/resume/void。
 *
 * 预留（报工域未建）：开工后向 ERP 推送（Outbox 属报工/集成域）；
 * 变更版本执行命令（S04 规则与 0005 结构已就位，见 domain process/order-rules.ts）。
 */

type Payload = Record<string, unknown>

function bad(message: string, errorCode: string = ERROR_CODES.BUSINESS_RULE): HandlerOutcome {
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: message }
}

/** 辅助函数内提前拒绝（抛出后在 run() 内还原为 HandlerOutcome）。 */
class Rejection extends Error {
  constructor(readonly outcome: HandlerOutcome) {
    super(outcome.errorMessage ?? '业务拒绝')
    this.name = 'ProcessRejection'
  }
}

function violationOutcome(error: ProcessRuleViolation | OrgRuleViolation): HandlerOutcome {
  // 范围越界按 FORBIDDEN_SCOPE 语义（HTTP 层映射 403，沿用 OA-24 口径）
  const errorCode =
    error instanceof OrgRuleViolation ? ERROR_CODES.FORBIDDEN_SCOPE : ERROR_CODES.BUSINESS_RULE
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: `[${error.rule}] ${error.message}` }
}

async function run(body: () => Promise<HandlerOutcome>): Promise<HandlerOutcome> {
  try {
    return await body()
  } catch (error) {
    if (error instanceof Rejection) return error.outcome
    if (error instanceof ProcessRuleViolation || error instanceof OrgRuleViolation) {
      return violationOutcome(error)
    }
    throw error
  }
}

function str(payload: Payload, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' ? v : undefined
}

function num(payload: Payload, key: string): number | undefined {
  const v = payload[key]
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined
}

function bool(payload: Payload, key: string): boolean | undefined {
  const v = payload[key]
  return typeof v === 'boolean' ? v : undefined
}

function dec(payload: Payload, key: string): string | undefined {
  const v = payload[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function isoDate(value: string | undefined, field: string): Date | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new ProcessRuleViolation('NEW-1', `${field} 必须为合法 ISO-8601 时间：${value}`)
  }
  return parsed
}

/** 取 process 仓储束（组合根装配的 CommandTools 超集）。 */
function proc(tools: CommandTools): ProcessCommandTools['process'] {
  return (tools as ProcessCommandTools).process
}

/** 企业活动节点索引（dev 规模，全量载入用于部门→工厂解析）。 */
async function nodeMapOf(tools: CommandTools, enterpriseId: string): Promise<Map<string, OrgNodeRecord>> {
  const nodes = await tools.org.listActiveByEnterprise(enterpriseId)
  return new Map(nodes.map((n) => [n.id, n]))
}

function plantOf(node: OrgNodeRecord, map: ReadonlyMap<string, OrgNodeRecord>): OrgNodeRecord | null {
  let current: OrgNodeRecord | undefined = node
  let hops = 0
  while (current && hops < 64) {
    if (current.kind === 'plant') return current
    current = current.parentId ? map.get(current.parentId) : undefined
    hops += 1
  }
  return null
}

/** 写路径范围二道防线（OA-26 模式）：目标厂须在 actor 数据范围内。 */
async function assertWriteScope(tools: CommandTools, plantId: string): Promise<void> {
  const scope = await tools.actorDataScope()
  if (!isPlantInScope(scope, plantId)) {
    throw new OrgRuleViolation('OA-24', '目标工厂不在授权数据范围内（服务端范围检查）')
  }
}

/** 解析有效部门节点（须为 department 且 active），并给出其所属工厂。 */
async function requireDept(
  tools: CommandTools,
  enterpriseId: string,
  deptId: string,
): Promise<{ dept: OrgNodeRecord; plant: OrgNodeRecord }> {
  const map = await nodeMapOf(tools, enterpriseId)
  const dept = map.get(deptId)
  if (!dept || dept.kind !== 'department') {
    throw new Rejection(bad('所属部门不存在或不是部门节点', ERROR_CODES.NOT_FOUND))
  }
  const plant = plantOf(dept, map)
  if (plant === null) {
    throw new Rejection(bad('所属部门未挂在任何工厂之下，无法确定隔离归属'))
  }
  return { dept, plant }
}

/** 解析有效工厂节点（产品族等厂级对象的直接归属）。 */
async function requirePlant(tools: CommandTools, enterpriseId: string, plantId: string): Promise<OrgNodeRecord> {
  const map = await nodeMapOf(tools, enterpriseId)
  const plant = map.get(plantId)
  if (!plant || plant.kind !== 'plant') {
    throw new Rejection(bad('目标工厂不存在或不属于本企业', ERROR_CODES.NOT_FOUND))
  }
  return plant
}

/** 校验工作中心（0003 主数据；活动、同厂；返回快照视图）。 */
async function requireWorkCenter(
  tools: CommandTools,
  enterpriseId: string,
  plantId: string,
  workCenterId: string,
): Promise<{ id: string; code: string; name: string; deptId: string }> {
  const wc = await proc(tools).lookups.findWorkCenter(workCenterId)
  if (wc === null || wc.status !== 'active' || wc.enterpriseId !== enterpriseId) {
    throw new Rejection(bad('工作中心不存在或不属于本企业', ERROR_CODES.NOT_FOUND))
  }
  if (wc.plantId !== plantId) {
    throw new Rejection(bad('[NEW-1] 工作中心不属于目标工厂（厂级隔离）'))
  }
  return { id: wc.id, code: wc.code, name: wc.name, deptId: wc.deptId }
}

/** 校验料品（0003 主数据；活动、同企业组织范围）。 */
async function requireMaterial(
  tools: CommandTools,
  enterpriseId: string,
  materialId: string,
): Promise<{ id: string; code: string; name: string }> {
  const material = await proc(tools).lookups.findMaterial(materialId)
  if (material === null || material.status !== 'active' || material.orgScopeId !== enterpriseId) {
    throw new Rejection(bad('料品不存在或不属于本企业', ERROR_CODES.NOT_FOUND))
  }
  return { id: material.id, code: material.code, name: material.name }
}

/** 载荷工序条目（显式入站工序展开用）。 */
interface OperationEntry {
  seq: number
  operationDefinitionId: string
  workCenterId?: string
  coreMultiple?: number
  strandFactor?: string | null
  offlineQty?: string
  operationRemark?: string | null
}

/** 解析并校验载荷工序数组（显式入站工序或空）。 */
function parseOperationEntries(payload: Payload): OperationEntry[] {
  const raw = payload['operations']
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new ProcessRuleViolation('A2-3', 'operations 必须为数组（入站工序展开载荷）')
  }
  return raw.map((item, index) => {
    const p = (item ?? {}) as Payload
    const seq = num(p, 'seq')
    const operationDefinitionId = str(p, 'operationDefinitionId')
    if (seq === undefined || operationDefinitionId === undefined) {
      throw new ProcessRuleViolation('A2-3', `operations[${index}] 需要 seq/operationDefinitionId`)
    }
    return {
      seq,
      operationDefinitionId,
      workCenterId: str(p, 'workCenterId'),
      coreMultiple: num(p, 'coreMultiple'),
      strandFactor: str(p, 'strandFactor') ?? null,
      offlineQty: dec(p, 'offlineQty'),
      operationRemark: str(p, 'operationRemark') ?? null,
    }
  })
}

/** BOM 行载荷校验（[底稿 A2-1] 数量口径）。 */
function parseBomLines(payload: Payload): BomLine[] {
  const raw = payload['lines']
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new ProcessRuleViolation('A2-1', 'lines 必须为数组（BOM 行载荷）')
  }
  return raw.map((item, index) => {
    const p = (item ?? {}) as Payload
    const materialId = str(p, 'materialId')
    const materialCode = str(p, 'materialCode')
    const quantity = dec(p, 'quantity')
    const uom = str(p, 'uom')
    if (!materialId || !materialCode || quantity === undefined || !uom) {
      throw new ProcessRuleViolation('A2-1', `lines[${index}] 需要 materialId/materialCode/quantity/uom`)
    }
    assertOfflineQty(quantity, `lines[${index}]`)
    if (quantity === '0' || quantity.startsWith('-')) {
      throw new ProcessRuleViolation('A2-1', `lines[${index}] BOM 行数量必须大于 0`)
    }
    return { materialId, materialCode, quantity, uom }
  })
}

/** 路线步载荷校验（[底稿 A2-1] 系数口径；工序/工作中心存在性由 handler 查库复核）。 */
function parseRouteSteps(payload: Payload): RouteStep[] {
  const raw = payload['steps']
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new ProcessRuleViolation('A2-1', 'steps 必须为数组（工艺路线步载荷）')
  }
  return raw.map((item, index) => {
    const p = (item ?? {}) as Payload
    const seq = num(p, 'seq')
    const operationDefinitionId = str(p, 'operationDefinitionId')
    const workCenterId = str(p, 'workCenterId')
    if (seq === undefined || !operationDefinitionId || !workCenterId) {
      throw new ProcessRuleViolation('A2-1', `steps[${index}] 需要 seq/operationDefinitionId/workCenterId`)
    }
    if (num(p, 'coreMultiple') !== undefined) assertCoreMultiple(num(p, 'coreMultiple')!, `steps[${index}]`)
    assertStrandFactor(str(p, 'strandFactor') ?? null, `steps[${index}]`)
    return {
      seq,
      operationDefinitionId,
      workCenterId,
      coreMultiple: num(p, 'coreMultiple'),
      strandFactor: str(p, 'strandFactor') ?? null,
    }
  })
}

/** 参数规范载荷校验（数组承载）。 */
function parseParameters(payload: Payload): unknown[] {
  const raw = payload['parameters']
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new ProcessRuleViolation('A2-1', 'parameters 必须为数组（参数规范载荷）')
  }
  return raw
}

/** 三张版本表共用的版本命令工厂（BOM/路线/参数规范；差异经适配器注入）。 */
interface RevisionAdapter {
  kind: 'bom' | 'route' | 'parameter'
  label: string
  pickRepo: (tools: CommandTools) => ProcessRevisionRepositoryPort<ProcessRevisionBase>
  /** 载荷内容列键名（lines/steps/parameters）。 */
  contentKeys: string[]
  parseContent: (payload: Payload) => BomLine[] | RouteStep[] | unknown[]
  /** 版本定位键（publish 前置「同对象至多一条 published」查重用）。 */
  keyOf: (revision: ProcessRevisionBase) => ProcessRevisionKey
}

function createRevisionHandlers(config: RevisionAdapter): CommandHandler[] {
  const commandType = (action: string) => `process.${config.kind}.${action}`
  const subjectType = `${config.kind}_revision`

  const create: CommandHandler = {
    commandType: commandType('create'),
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const productFamilyId = str(p, 'productFamilyId')
        if (!productFamilyId) return bad('payload 需要 productFamilyId')
        const family = await proc(tools).families.findById(productFamilyId)
        if (family === null || family.status !== 'active' || family.enterpriseId !== ctx.enterpriseId) {
          return bad('产品族不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, family.plantId)
        const key: ProcessRevisionKey = { plantId: family.plantId, productFamilyId }
        const extra: { materialId?: string; name?: string } = {}
        if (config.kind === 'bom') {
          const materialId = str(p, 'materialId')
          if (!materialId) return bad('payload 需要 materialId')
          await requireMaterial(tools, ctx.enterpriseId, materialId)
          key.materialId = materialId
          extra.materialId = materialId
        }
        if (config.kind === 'parameter') {
          const name = str(p, 'name')
          if (!name) return bad('payload 需要 name')
          key.name = name
          extra.name = name
        }
        // 初始状态仅允许 draft/reviewed（reviewed 为 U9/工艺员带入的中间态；发布走发布命令）
        const initialStatus = str(p, 'initialStatus') ?? 'draft'
        assertRevisionStatus(initialStatus)
        if (initialStatus === 'published' || initialStatus === 'retired') {
          throw new ProcessRuleViolation('A2-2', '新版本初始状态仅允许 draft/reviewed（发布须走发布命令）')
        }
        const content = config.parseContent(p)
        const version = nextRevisionVersion(
          await config.pickRepo(tools).listVersionsByKey(key),
        )
        const input: NewProcessRevision = {
          enterpriseId: ctx.enterpriseId,
          plantId: family.plantId,
          productFamilyId,
          materialId: extra.materialId,
          name: extra.name,
          version,
          content,
          remark: str(p, 'remark') ?? null,
          initialStatus,
          createdBy: ctx.actorLoginName,
        }
        const created = await config.pickRepo(tools).insert(input)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: commandType('create'),
          subjectType,
          subjectId: created.id,
          after: { productFamilyId, version, initialStatus, content },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { revisionId: created.id, version } }
      }),
  }

  const update: CommandHandler = {
    commandType: commandType('update'),
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const revision = await config.pickRepo(tools).findById(envelope.targetId)
        if (revision === null || revision.enterpriseId !== ctx.enterpriseId) {
          return bad(`${config.label}版本不存在`, ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, revision.plantId)
        // [底稿 A2-2] published 冻结、retired 终态：内容不可改（published 后 PATCH 拒绝）
        assertRevisionContentMutable(revision.status)
        const p = envelope.payload as Payload
        const patch: ProcessRevisionPatch = {}
        if (config.contentKeys.some((k) => p[k] !== undefined)) {
          patch.content = config.parseContent(p)
        }
        if (str(p, 'remark') !== undefined) patch.remark = str(p, 'remark')
        if (str(p, 'status') !== undefined) {
          const next = str(p, 'status')!
          assertRevisionStatus(next)
          if (next !== 'reviewed' || revision.status !== 'draft') {
            throw new ProcessRuleViolation(
              'A2-2',
              '编辑载荷仅允许 draft→reviewed 中间态置位（其余状态迁移走发布/失效命令）',
            )
          }
          patch.status = next
        }
        const updated = await config.pickRepo(tools).update(revision.id, patch, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: commandType('update'),
          subjectType,
          subjectId: revision.id,
          before: { status: revision.status, version: revision.version },
          after: patch as unknown as Record<string, unknown>,
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: { revisionId: revision.id, status: updated?.status ?? revision.status },
        }
      }),
  }

  const publish: CommandHandler = {
    commandType: commandType('publish'),
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const revision = await config.pickRepo(tools).findById(envelope.targetId)
        if (revision === null || revision.enterpriseId !== ctx.enterpriseId) {
          return bad(`${config.label}版本不存在`, ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, revision.plantId)
        // [底稿 A2-2] 发布前置：draft/reviewed 可发布；同对象至多一条 published（partial unique 双保险）
        assertRevisionPublishable(revision.status)
        const existing = await config.pickRepo(tools).findPublishedByKey(config.keyOf(revision))
        assertNoExistingPublishedVersion({ publishedExists: existing !== null })
        const updated = await config.pickRepo(tools).updateStatus(
          revision.id,
          'published',
          ctx.actorLoginName,
          tools.now(),
        )
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: commandType('publish'),
          subjectType,
          subjectId: revision.id,
          before: { status: revision.status, version: revision.version },
          after: { status: 'published', publishedAt: updated?.publishedAt ?? null },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { revisionId: revision.id, status: 'published' } }
      }),
  }

  const retire: CommandHandler = {
    commandType: commandType('retire'),
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const revision = await config.pickRepo(tools).findById(envelope.targetId)
        if (revision === null || revision.enterpriseId !== ctx.enterpriseId) {
          return bad(`${config.label}版本不存在`, ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, revision.plantId)
        // [底稿 A2-2] 失效前置：retired 不可重复失效；已接订单的版本引用保留（FK 不动，A2-3）
        assertRevisionRetirable(revision.status)
        await config.pickRepo(tools).retire(revision.id, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: commandType('retire'),
          subjectType,
          subjectId: revision.id,
          before: { status: revision.status, version: revision.version },
          after: { status: 'retired' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { revisionId: revision.id } }
      }),
  }

  return [create, update, publish, retire]
}

export function createProcessCommandHandlers(): CommandHandler[] {
  // ---------------- 产品族 ----------------

  const familyCreate: CommandHandler = {
    commandType: 'process.family.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const plantId = str(p, 'plantId')
        const code = str(p, 'code')
        const name = str(p, 'name')
        if (!plantId || !code || !name) return bad('payload 需要 plantId/code/name')
        const plant = await requirePlant(tools, ctx.enterpriseId, plantId)
        await assertWriteScope(tools, plant.id)
        if ((await proc(tools).families.findActiveByPlantAndCode(plant.id, code)) !== null) {
          return bad('[A1-3] 同一工厂下产品族编码不能重复')
        }
        const created = await proc(tools).families.insert({
          enterpriseId: ctx.enterpriseId,
          plantId: plant.id,
          code,
          name,
          description: str(p, 'description') ?? null,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'process.family.create',
          subjectType: 'product_family',
          subjectId: created.id,
          after: { code, name, plantId: plant.id },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { familyId: created.id } }
      }),
  }

  const familyUpdate: CommandHandler = {
    commandType: 'process.family.update',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const family = await proc(tools).families.findById(envelope.targetId)
        if (family === null || family.status !== 'active' || family.enterpriseId !== ctx.enterpriseId) {
          return bad('产品族不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, family.plantId)
        const p = envelope.payload as Payload
        const patch: { name?: string; description?: string | null } = {}
        if (str(p, 'name') !== undefined) {
          if (!str(p, 'name')) return bad('产品族名称不能为空')
          patch.name = str(p, 'name')
        }
        if (str(p, 'description') !== undefined) patch.description = str(p, 'description')
        await proc(tools).families.update(family.id, patch, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'process.family.update',
          subjectType: 'product_family',
          subjectId: family.id,
          before: { name: family.name, description: family.description },
          after: patch,
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { familyId: family.id } }
      }),
  }

  const familyRetire: CommandHandler = {
    commandType: 'process.family.retire',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const family = await proc(tools).families.findById(envelope.targetId)
        if (family === null || family.status !== 'active' || family.enterpriseId !== ctx.enterpriseId) {
          return bad('产品族不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, family.plantId)
        // 引用保护：未失效版本（BOM/路线/参数）与未作废订单仍引用产品族时拒绝失效
        const usages = await proc(tools).families.countActiveUsages(family.id)
        if (usages > 0) {
          return bad(`[A1-3] 产品族仍被 ${usages} 条未失效工艺版本或未作废订单引用，不可失效`)
        }
        await proc(tools).families.retire(family.id, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'process.family.retire',
          subjectType: 'product_family',
          subjectId: family.id,
          before: { code: family.code, name: family.name, status: 'active' },
          after: { status: 'retired' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { familyId: family.id } }
      }),
  }

  // ---------------- BOM / 路线 / 参数规范（版本冻结，[底稿 A2-2]） ----------------

  const bomHandlers = createRevisionHandlers({
    kind: 'bom',
    label: '制造 BOM',
    pickRepo: (tools) => proc(tools).boms,
    contentKeys: ['lines'],
    parseContent: parseBomLines,
    keyOf: (revision) => ({
      plantId: revision.plantId,
      materialId: (revision as { materialId?: string }).materialId,
    }),
  })

  const routeHandlers = createRevisionHandlers({
    kind: 'route',
    label: '工艺路线',
    pickRepo: (tools) => proc(tools).routes,
    contentKeys: ['steps'],
    parseContent: parseRouteSteps,
    keyOf: (revision) => ({ plantId: revision.plantId, productFamilyId: revision.productFamilyId }),
  })

  const parameterHandlers = createRevisionHandlers({
    kind: 'parameter',
    label: '参数规范',
    pickRepo: (tools) => proc(tools).parameters,
    contentKeys: ['parameters'],
    parseContent: parseParameters,
    keyOf: (revision) => ({
      plantId: revision.plantId,
      productFamilyId: revision.productFamilyId,
      name: (revision as { name?: string }).name,
    }),
  })

  // ---------------- 工序主数据（[底稿 A1-3]） ----------------

  const operationCreate: CommandHandler = {
    commandType: 'process.operation.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const deptId = str(p, 'deptId')
        const workCenterId = str(p, 'workCenterId')
        const companyOrgCode = str(p, 'companyOrgCode')
        const code = str(p, 'code')
        const name = str(p, 'name')
        if (!deptId || !workCenterId || !companyOrgCode || !code || !name) {
          return bad('payload 需要 deptId/workCenterId/companyOrgCode/code/name')
        }
        assertOperationNameNoEdgeSpaces(name)
        const { dept, plant } = await requireDept(tools, ctx.enterpriseId, deptId)
        await assertWriteScope(tools, plant.id)
        const workCenter = await requireWorkCenter(tools, ctx.enterpriseId, plant.id, workCenterId)
        // 工序管理 PRD §2.1：所属部门须与工作中心所属部门一致
        if (workCenter.deptId !== dept.id) {
          return bad('[A1-3] 工序所属部门须与工作中心所属部门一致')
        }
        // [底稿 A1-3] 唯一性：部门内名称唯一、组织编码内编码唯一（域规则判定）
        const nameDup = await proc(tools).operations.findActiveByDeptAndName(dept.id, name)
        const codeDup = await proc(tools).operations.findActiveByOrgAndCode(companyOrgCode, code)
        const conflict = findOperationDefinitionConflict(
          { deptId: dept.id, name, companyOrgCode, code },
          [nameDup, codeDup].filter((r): r is NonNullable<typeof r> => r !== null),
        )
        if (conflict !== null) {
          return bad(
            conflict.field === 'name'
              ? '[A1-3] 同一所属部门下工序名称不能重复'
              : '[A1-3] 同一公司组织编码下工序编码不能重复',
          )
        }
        const created = await proc(tools).operations.insert({
          enterpriseId: ctx.enterpriseId,
          plantId: plant.id,
          deptId: dept.id,
          workCenterId,
          companyOrgCode,
          code,
          name,
          remark: str(p, 'remark') ?? null,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'process.operation.create',
          subjectType: 'operation_definition',
          subjectId: created.id,
          after: { deptId: dept.id, workCenterId, companyOrgCode, code, name, plantId: plant.id },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { operationId: created.id } }
      }),
  }

  const operationUpdate: CommandHandler = {
    commandType: 'process.operation.update',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const operation = await proc(tools).operations.findById(envelope.targetId)
        if (operation === null || operation.status !== 'active' || operation.enterpriseId !== ctx.enterpriseId) {
          return bad('工序不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, operation.plantId)
        const p = envelope.payload as Payload
        // [底稿 A1-3] 编辑锁：被订单排产引用时工作中心/所属部门不可改（排产表未建按 0 预留）
        assertOperationDefinitionLockedFieldsEditable(
          { schedulingReferenced: (await proc(tools).operations.countSchedulingRefs(operation.id)) > 0 },
          { workCenterId: str(p, 'workCenterId'), deptId: str(p, 'deptId') },
        )
        const patch: OperationDefinitionPatch = {}
        const nextDeptId = str(p, 'deptId') ?? operation.deptId
        const nextWorkCenterId = str(p, 'workCenterId') ?? operation.workCenterId
        if (str(p, 'name') !== undefined) {
          const name = str(p, 'name')!
          assertOperationNameNoEdgeSpaces(name)
          if (name !== operation.name) {
            // [底稿 A1-3] 部门内名称唯一（排除自身）
            const dup = await proc(tools).operations.findActiveByDeptAndName(nextDeptId, name)
            if (dup !== null && dup.id !== operation.id) {
              return bad('[A1-3] 同一所属部门下工序名称不能重复')
            }
          }
          patch.name = name
        }
        if (str(p, 'remark') !== undefined) patch.remark = str(p, 'remark')
        if (str(p, 'deptId') !== undefined || str(p, 'workCenterId') !== undefined) {
          // 部门/工作中心联动一致性（工序管理 PRD §2.1）
          const { dept, plant } = await requireDept(tools, ctx.enterpriseId, nextDeptId)
          await assertWriteScope(tools, plant.id)
          const workCenter = await requireWorkCenter(tools, ctx.enterpriseId, plant.id, nextWorkCenterId)
          if (workCenter.deptId !== dept.id) {
            return bad('[A1-3] 工序所属部门须与工作中心所属部门一致')
          }
          if (str(p, 'deptId') !== undefined) patch.deptId = dept.id
          if (str(p, 'workCenterId') !== undefined) patch.workCenterId = nextWorkCenterId
        }
        await proc(tools).operations.update(operation.id, patch, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'process.operation.update',
          subjectType: 'operation_definition',
          subjectId: operation.id,
          before: {
            name: operation.name,
            deptId: operation.deptId,
            workCenterId: operation.workCenterId,
            remark: operation.remark,
          },
          after: patch,
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { operationId: operation.id } }
      }),
  }

  const operationRetire: CommandHandler = {
    commandType: 'process.operation.retire',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const operation = await proc(tools).operations.findById(envelope.targetId)
        if (operation === null || operation.status !== 'active' || operation.enterpriseId !== ctx.enterpriseId) {
          return bad('工序不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, operation.plantId)
        // [底稿 A1-3] 删除拦截顺序：①模板（未建按 0 预留）→②订单排产（未建按 0 预留）→③订单工序（真实计数）
        assertOperationDefinitionRetirable({
          templateRefs: await proc(tools).operations.countTemplateRefs(operation.id),
          schedulingRefs: await proc(tools).operations.countSchedulingRefs(operation.id),
          orderOperationRefs: await proc(tools).operations.countOrderOperationRefs(operation.id),
        })
        await proc(tools).operations.retire(operation.id, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'process.operation.retire',
          subjectType: 'operation_definition',
          subjectId: operation.id,
          before: { code: operation.code, name: operation.name, status: 'active' },
          after: { status: 'retired' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { operationId: operation.id } }
      }),
  }

  // ---------------- 生产订单（[底稿 A1-1 / A2-3]） ----------------

  const orderReceive: CommandHandler = {
    commandType: 'process.order.receive',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const orderNo = str(p, 'orderNo')
        const materialId = str(p, 'materialId')
        const productionDeptId = str(p, 'productionDeptId')
        const productionQty = dec(p, 'productionQty')
        const uom = str(p, 'uom')
        if (!orderNo || !materialId || !productionDeptId || productionQty === undefined || !uom) {
          return bad('payload 需要 orderNo/materialId/productionDeptId/productionQty/uom')
        }
        // [底稿 A2-1] 数量口径
        assertOrderQty(productionQty, '订单产量')
        if (dec(p, 'overrunRatio') !== undefined) {
          assertOfflineQty(dec(p, 'overrunRatio')!, '超额比例')
        }
        const { plant } = await requireDept(tools, ctx.enterpriseId, productionDeptId)
        await assertWriteScope(tools, plant.id)
        // 同企业生产单号唯一（U9 入站查重；同 operationId 重放由总线幂等承担）
        if ((await proc(tools).orders.findByEnterpriseAndOrderNo(ctx.enterpriseId, orderNo)) !== null) {
          return bad(`[NEW-1] 生产单号 ${orderNo} 已存在（同企业唯一）`)
        }
        const material = await requireMaterial(tools, ctx.enterpriseId, materialId)
        // 入站初始状态：approved（已核准）/released（模拟上游已放行）
        const initialStatus = str(p, 'initialStatus') ?? 'approved'
        if (initialStatus !== 'approved' && initialStatus !== 'released') {
          throw new ProcessRuleViolation('A1-1', '入站初始状态仅允许 approved/released（模拟上游放行口径）')
        }
        // 工艺确认（01 §3.1 开工前置；确认动作页面承载为 C11 缺口，接收载荷声明确认口径）
        const processConfirmed = bool(p, 'processConfirmed') ?? false

        // 产品族（选填；须同厂活动）
        let familyId: string | null = null
        if (str(p, 'productFamilyId') !== undefined) {
          const family = await proc(tools).families.findById(str(p, 'productFamilyId')!)
          if (family === null || family.status !== 'active' || family.enterpriseId !== ctx.enterpriseId) {
            return bad('产品族不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
          }
          if (family.plantId !== plant.id) {
            return bad('[NEW-1] 产品族不属于订单生产部门所在工厂（厂级隔离）')
          }
          familyId = family.id
        }

        // BOM 版本引用（[底稿 A2] 订单只引用已发布版本；显式指定或按 plant+material 自动取 published）
        let bomRevisionId: string | null = null
        if (str(p, 'bomRevisionId') !== undefined) {
          const bom = await proc(tools).boms.findById(str(p, 'bomRevisionId')!)
          if (
            bom === null || bom.status !== 'published' ||
            bom.plantId !== plant.id || bom.enterpriseId !== ctx.enterpriseId
          ) {
            return bad('指定 BOM 版本不存在、未发布或不属于本厂', ERROR_CODES.NOT_FOUND)
          }
          bomRevisionId = bom.id
        } else {
          const published = await proc(tools).boms.findPublishedByKey({ plantId: plant.id, materialId })
          bomRevisionId = published?.id ?? null
        }

        // 路线版本引用（同口径；familyId 存在时可自动取 published 路线）
        let routeRevisionId: string | null = null
        if (str(p, 'routeRevisionId') !== undefined) {
          const route = await proc(tools).routes.findById(str(p, 'routeRevisionId')!)
          if (
            route === null || route.status !== 'published' ||
            route.plantId !== plant.id || route.enterpriseId !== ctx.enterpriseId
          ) {
            return bad('指定工艺路线版本不存在、未发布或不属于本厂', ERROR_CODES.NOT_FOUND)
          }
          routeRevisionId = route.id
        } else if (familyId !== null) {
          const published = await proc(tools).routes.findPublishedByKey({
            plantId: plant.id,
            productFamilyId: familyId,
          })
          routeRevisionId = published?.id ?? null
        }

        // 工序来源：显式入站工序 > 已发布路线展开 > 无（工序未配置）
        const explicitOperations = parseOperationEntries(p)
        let routeSteps: RouteStep[] = []
        if (explicitOperations.length === 0 && routeRevisionId !== null) {
          const route = await proc(tools).routes.findById(routeRevisionId)
          routeSteps = route?.steps ?? []
        }

        // [底稿 A2-3] 快照冻结：工序行快照自工序主数据/工作中心主数据，接收后模板再改不影响本单
        const operationRows: NewOrderOperation[] = []
        if (explicitOperations.length > 0 || routeSteps.length > 0) {
          const sources: OperationEntry[] =
            explicitOperations.length > 0
              ? explicitOperations
              : routeSteps.map((s) => ({
                  seq: s.seq,
                  operationDefinitionId: s.operationDefinitionId,
                  workCenterId: s.workCenterId,
                  coreMultiple: s.coreMultiple,
                  strandFactor: s.strandFactor ?? null,
                  offlineQty: undefined,
                  operationRemark: null,
                }))
          for (const entry of sources) {
            const definition = await proc(tools).operations.findById(entry.operationDefinitionId)
            if (definition === null || definition.status !== 'active' || definition.plantId !== plant.id) {
              return bad(`工序定义 ${entry.operationDefinitionId} 不存在、已失效或不属于本厂`, ERROR_CODES.NOT_FOUND)
            }
            const workCenter = await requireWorkCenter(
              tools,
              ctx.enterpriseId,
              plant.id,
              entry.workCenterId ?? definition.workCenterId,
            )
            if (entry.coreMultiple !== undefined) assertCoreMultiple(entry.coreMultiple, `工序 ${entry.seq}`)
            assertStrandFactor(entry.strandFactor ?? null, `工序 ${entry.seq}`)
            if (entry.offlineQty !== undefined) assertOfflineQty(entry.offlineQty, `工序 ${entry.seq}`)
            operationRows.push({
              enterpriseId: ctx.enterpriseId,
              plantId: plant.id,
              orderId: '',
              seq: entry.seq,
              operationDefinitionId: definition.id,
              operationCode: definition.code,
              operationName: definition.name,
              operationRemark: entry.operationRemark ?? null,
              coreMultiple: entry.coreMultiple ?? 1,
              strandFactor: entry.strandFactor ?? null,
              offlineQty: entry.offlineQty ?? productionQty,
              workCenterId: workCenter.id,
              workCenterCode: workCenter.code,
              workCenterName: workCenter.name,
              uom,
              productionDeptId: definition.deptId,
              routeRevisionId,
              bomRevisionId,
              createdBy: ctx.actorLoginName,
            })
          }
          // [底稿 A2-1] 自末道向上递推下线数量（末道=产量×芯×绞合；绞合未填该行跳过重算）
          const derived = computeOperationRequirements({
            orderQty: productionQty,
            operations: operationRows.map((row) => ({
              seq: row.seq,
              coreMultiple: row.coreMultiple,
              strandFactor: row.strandFactor ?? null,
              currentOfflineQty: row.offlineQty,
            })),
          })
          const bySeq = new Map(derived.map((d) => [d.seq, d.offlineQty]))
          for (const row of operationRows) row.offlineQty = bySeq.get(row.seq) ?? row.offlineQty
        }

        let stageParent: Record<string, unknown> | null = null
        if (str(p, 'stageParentOrderId') !== undefined || str(p, 'stageParentOperationId') !== undefined) {
          const parent = await proc(tools).orders.findById(str(p, 'stageParentOrderId') ?? '')
          const stageMaterial = await proc(tools).lookups.findMaterial(materialId)
          if (parent === null || parent.enterpriseId !== ctx.enterpriseId || parent.plantId !== plant.id ||
              parent.materialSnapshot['_cadenzaStageParent'] !== undefined || stageMaterial?.materialType !== 2 ||
              parent.salesOrderNo !== (str(p, 'salesOrderNo') ?? null) || parent.lineNo !== (str(p, 'lineNo') ?? null)) {
            return bad('阶段父订单/销售行/物料关系不合法', ERROR_CODES.FORBIDDEN_SCOPE)
          }
          await assertWriteScope(tools, parent.plantId)
          const parentOps = await proc(tools).orderOperations.listCurrentByOrder(parent.id, parent.currentSettingsVersion)
          const parentOp = parentOps.find(op => op.id === str(p, 'stageParentOperationId'))
          const parentBom = parent.bomRevisionId === null ? null : await proc(tools).boms.findById(parent.bomRevisionId)
          if (parentOp === undefined || parentOp.seq >= Math.max(...parentOps.map(op => op.seq)) ||
              !parentBom?.lines.some(line => line.materialId === materialId) || cmpQty(productionQty,parentOp.offlineQty)>0) {
            return bad('阶段父工序必须为真实非最终工序，阶段物料须在父BOM且数量不超父工序')
          }
          stageParent = { source: 'PROCESS_RECEIVE_VERIFIED_STAGE', parentOrderId: parent.id, parentOperationId: parentOp.id,
            parentOperationSeq: parentOp.seq, parentSettingsVersion: parent.currentSettingsVersion,
            enterpriseId: ctx.enterpriseId, plantId: plant.id }
        }

        const created = await proc(tools).orders.insert({
          enterpriseId: ctx.enterpriseId,
          plantId: plant.id,
          orderNo,
          orderType: str(p, 'orderType') ?? null,
          salesContractNo: str(p, 'salesContractNo') ?? null,
          salesOrderNo: str(p, 'salesOrderNo') ?? null,
          lineNo: str(p, 'lineNo') ?? null,
          materialId,
          materialSnapshot: {
            code: material.code,
            name: str(p, 'materialName') ?? material.name,
            spec: str(p, 'materialSpec') ?? null,
            color: str(p, 'materialColor') ?? null,
            diameter: str(p, 'materialDiameter') ?? null,
            ...(stageParent === null ? {} : { _cadenzaStageParent: stageParent }),
          },
          productFamilyId: familyId,
          productionDeptId,
          productionQty,
          uom,
          overrunRatio: dec(p, 'overrunRatio') ?? null,
          orderStatus: initialStatus,
          processConfigStatus: operationRows.length > 0 ? 'configured' : 'unconfigured',
          processConfirmedAt: processConfirmed ? tools.now() : null,
          bomRevisionId,
          routeRevisionId,
          plannedStartAt: isoDate(str(p, 'plannedStartAt'), '计划开工时间'),
          plannedFinishAt: isoDate(str(p, 'plannedFinishAt'), '计划完工时间'),
          segmentRequirement: str(p, 'segmentRequirement') ?? null,
          remark: str(p, 'remark') ?? null,
          createdBy: ctx.actorLoginName,
        })
        for (const row of operationRows) row.orderId = created.id
        if (operationRows.length > 0) {
          await proc(tools).orderOperations.insertBatch(operationRows)
        }
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'process.order.receive',
          subjectType: 'production_order',
          subjectId: created.id,
          after: {
            orderNo,
            productionQty,
            uom,
            orderStatus: initialStatus,
            processConfigStatus: created.processConfigStatus,
            routeRevisionId,
            bomRevisionId,
            operationCount: operationRows.length,
            stageParent,
          },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: {
            orderId: created.id,
            orderNo,
            orderStatus: created.orderStatus,
            processConfigStatus: created.processConfigStatus,
            operationCount: operationRows.length,
            routeRevisionId,
            bomRevisionId,
          },
        }
      }),
  }

  const orderRelease: CommandHandler = {
    commandType: 'process.order.release',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const order = await proc(tools).orders.findById(envelope.targetId)
        if (order === null || order.enterpriseId !== ctx.enterpriseId) {
          return bad('生产订单不存在', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, order.plantId)
        // [底稿 A1-1] 状态轴顺次迁移（模拟上游放行）
        assertOrderTransition(order.orderStatus, 'released')
        const updated = await proc(tools).orders.update(order.id, { orderStatus: 'released' }, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'process.order.release',
          subjectType: 'production_order',
          subjectId: order.id,
          before: { orderStatus: order.orderStatus },
          after: { orderStatus: 'released' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { orderId: order.id, orderStatus: updated?.orderStatus ?? 'released' } }
      }),
  }

  const orderStart: CommandHandler = {
    commandType: 'process.order.start',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const order = await proc(tools).orders.findById(envelope.targetId)
        if (order === null || order.enterpriseId !== ctx.enterpriseId) {
          return bad('生产订单不存在', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, order.plantId)
        const p = envelope.payload as Payload
        // 开工时间必填、缺省以服务端当前时间补齐（PRD §2.1 开工弹窗默认当前时间）
        const actualStartAt = str(p, 'actualStartAt') ?? tools.now().toISOString()
        // [底稿 A1-1] 开工前置：状态/已配置且存在工序行/工艺已确认/未挂起/时间合法
        const currentOperations = await proc(tools).orderOperations.listCurrentByOrder(
          order.id,
          order.currentSettingsVersion,
        )
        assertOrderStartable({
          orderStatus: order.orderStatus,
          processConfigStatus: order.processConfigStatus,
          operationCount: currentOperations.length,
          processConfirmedAt: order.processConfirmedAt,
          suspended: order.suspended,
          actualStartAt,
        })
        const updated = await proc(tools).orders.update(
          order.id,
          { orderStatus: 'in_progress', actualStartAt: new Date(actualStartAt) },
          ctx.actorLoginName,
        )
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'process.order.start',
          subjectType: 'production_order',
          subjectId: order.id,
          before: { orderStatus: order.orderStatus, suspended: order.suspended },
          after: { orderStatus: 'in_progress', actualStartAt },
          reason: ctx.reason ?? null,
        })
        // 开工后向 ERP 推送属报工/集成域 Outbox（D3），本块不外发（预留）
        return {
          status: 'COMMITTED',
          data: { orderId: order.id, orderStatus: updated?.orderStatus ?? 'in_progress', actualStartAt },
        }
      }),
  }

  const orderSuspend: CommandHandler = {
    commandType: 'process.order.suspend',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const order = await proc(tools).orders.findById(envelope.targetId)
        if (order === null || order.enterpriseId !== ctx.enterpriseId) {
          return bad('生产订单不存在', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, order.plantId)
        // [底稿 A1-1] 挂起独立开关：非作废/非已结束可挂起
        assertOrderSuspendable({ orderStatus: order.orderStatus, suspended: order.suspended })
        const p = envelope.payload as Payload
        await proc(tools).orders.update(
          order.id,
          { suspended: true, suspendedReason: str(p, 'reason') ?? null },
          ctx.actorLoginName,
        )
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'process.order.suspend',
          subjectType: 'production_order',
          subjectId: order.id,
          before: { suspended: order.suspended, orderStatus: order.orderStatus },
          after: { suspended: true, reason: str(p, 'reason') ?? null },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { orderId: order.id, suspended: true } }
      }),
  }

  const orderResume: CommandHandler = {
    commandType: 'process.order.resume',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const order = await proc(tools).orders.findById(envelope.targetId)
        if (order === null || order.enterpriseId !== ctx.enterpriseId) {
          return bad('生产订单不存在', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, order.plantId)
        assertOrderResumable({ suspended: order.suspended })
        await proc(tools).orders.update(
          order.id,
          { suspended: false, suspendedReason: null },
          ctx.actorLoginName,
        )
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'process.order.resume',
          subjectType: 'production_order',
          subjectId: order.id,
          before: { suspended: true },
          after: { suspended: false },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { orderId: order.id, suspended: false } }
      }),
  }

  const orderVoid: CommandHandler = {
    commandType: 'process.order.void',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const order = await proc(tools).orders.findById(envelope.targetId)
        if (order === null || order.enterpriseId !== ctx.enterpriseId) {
          return bad('生产订单不存在', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, order.plantId)
        const p = envelope.payload as Payload
        const reason = str(p, 'reason') ?? ctx.reason
        if (reason === undefined || reason === null || reason.trim() === '') {
          return bad('作废生产订单必须填写原因（高影响操作，审计留痕）')
        }
        // [底稿 A1-1] 作废独立：非作废且非已结束可作废；已结束订单的更正走冲销（DM §8）
        assertOrderVoidable({ orderStatus: order.orderStatus })
        await proc(tools).orders.update(order.id, { orderStatus: 'voided' }, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'process.order.void',
          subjectType: 'production_order',
          subjectId: order.id,
          before: { orderStatus: order.orderStatus, orderNo: order.orderNo },
          after: { orderStatus: 'voided' },
          reason,
        })
        return { status: 'COMMITTED', data: { orderId: order.id, orderStatus: 'voided' } }
      }),
  }

  return [
    familyCreate,
    familyUpdate,
    familyRetire,
    ...bomHandlers,
    ...routeHandlers,
    ...parameterHandlers,
    operationCreate,
    operationUpdate,
    operationRetire,
    orderReceive,
    orderRelease,
    orderStart,
    orderSuspend,
    orderResume,
    orderVoid,
  ]
}

/** 载荷解析器再导出（查询/测试侧复用，保持单一定义）。 */
export const processPayloadParsers = {
  parseBomLines,
  parseRouteSteps,
  parseOperationEntries,
} as const

/** 域规则状态类型再导出（避免 dist 相对导入泄漏到多文件）。 */
export type { ProcessRevisionStatus }
