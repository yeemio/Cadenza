import { ERROR_CODES } from '@cadenza/contracts'
import {
  assertCapacityInput,
  assertConversionFactorInput,
  assertConversionLineMutable,
  assertConversionUnitName,
  assertEquipmentCodeValid,
  assertEquipmentDeptConsistent,
  assertEquipmentRetirable,
  assertEquipmentLockedFieldsEditable,
  assertEquipmentStatusValue,
  assertLocationRetirable,
  assertMaterialTypesAllowedForWarehouseType,
  assertNormalLocationCode,
  assertQrBoundLocationMutable,
  assertQrBoundRackEditable,
  assertQrBoundWarehouseEditable,
  assertRackCode,
  assertRackCodeImmutable,
  assertRackGridSize,
  assertRackLayersImmutable,
  assertRackRetirable,
  assertStatusLogSource,
  assertWarehouseCode,
  assertWarehouseCodeImmutable,
  assertWarehouseRetirable,
  assertWarehouseTypeAllowedForDept,
  assertWorkCenterRetirable,
  buildRackLocationCode,
  buildZoneCode,
  equipmentQrCode,
  shouldRecordStatusChange,
  isPlantInScope,
  EQUIPMENT_NAME_MAX,
  MasterDataRuleViolation,
  OrgRuleViolation,
  WAREHOUSE_TYPE_VALUES,
} from '@cadenza/domain'
import type { CommandHandler, CommandTools, HandlerOutcome } from './command-bus'
import type { MasterDataCommandTools } from './masterdata-repositories'
import type { OrgNodeRecord } from './repositories'

/**
 * masterdata 域命令处理器（全部在命令总线事务内运行；命令事务即 UoW）。
 * 逐条落实冻结合同 master-data.md 的写路径规则（编号见各处注释）；
 * 写路径范围二道防线沿用 OA-26 模式（HTTP 守卫首检 + 事务内服务端复核）。
 * 料品主表无任何写命令（MD-01/02：同步写入、本系统只读；换算行为唯一可编辑部分）。
 */

type Payload = Record<string, unknown>

function bad(message: string, errorCode: string = ERROR_CODES.BUSINESS_RULE): HandlerOutcome {
  return { status: 'BUSINESS_REJECTION', errorCode, errorMessage: message }
}

/** 辅助函数内提前拒绝（抛出后在 run() 内还原为 HandlerOutcome）。 */
class Rejection extends Error {
  constructor(readonly outcome: HandlerOutcome) {
    super(outcome.errorMessage ?? '业务拒绝')
    this.name = 'MasterDataRejection'
  }
}

function violationOutcome(error: MasterDataRuleViolation | OrgRuleViolation): HandlerOutcome {
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
    if (error instanceof MasterDataRuleViolation || error instanceof OrgRuleViolation) {
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

function numArray(payload: Payload, key: string): number[] | undefined {
  const v = payload[key]
  return Array.isArray(v) && v.every((x): x is number => typeof x === 'number') ? v : undefined
}

/** 取 masterdata 仓储束（组合根装配的 CommandTools 超集）。 */
function md(tools: CommandTools): MasterDataCommandTools['masterdata'] {
  return (tools as MasterDataCommandTools).masterdata
}

/** 企业活动节点索引（dev 规模，全量载入用于部门→工厂解析）。 */
async function nodeMapOf(
  tools: CommandTools,
  enterpriseId: string,
): Promise<Map<string, OrgNodeRecord>> {
  const nodes = await tools.org.listActiveByEnterprise(enterpriseId)
  return new Map(nodes.map((n) => [n.id, n]))
}

function plantOf(
  node: OrgNodeRecord,
  map: ReadonlyMap<string, OrgNodeRecord>,
): OrgNodeRecord | null {
  let current: OrgNodeRecord | undefined = node
  let hops = 0
  while (current && hops < 64) {
    if (current.kind === 'plant') return current
    current = current.parentId ? map.get(current.parentId) : undefined
    hops += 1
  }
  return null
}

/** 写路径范围二道防线（OA-26 模式）：目标厂须在 actor 数据范围内；企业级对象要求企业范围。 */
async function assertWriteScope(
  tools: CommandTools,
  plantId: string | null,
): Promise<void> {
  const scope = await tools.actorDataScope()
  if (plantId === null) {
    if (!scope.enterpriseWide) {
      throw new OrgRuleViolation('OA-24', '企业级主数据对象仅企业范围授权可操作')
    }
    return
  }
  if (!isPlantInScope(scope, plantId)) {
    throw new OrgRuleViolation('OA-24', '目标工厂不在授权数据范围内（服务端范围检查）')
  }
}

/** 解析有效部门节点（须为 department 且 active）。 */
async function requireDept(
  tools: CommandTools,
  enterpriseId: string,
  deptId: string,
): Promise<{ dept: OrgNodeRecord; plant: OrgNodeRecord; map: Map<string, OrgNodeRecord> }> {
  const map = await nodeMapOf(tools, enterpriseId)
  const dept = map.get(deptId)
  if (!dept || dept.kind !== 'department') {
    throw new Rejection(bad('所属部门不存在或不是部门节点', ERROR_CODES.NOT_FOUND))
  }
  const plant = plantOf(dept, map)
  if (plant === null) {
    throw new Rejection(bad('所属部门未挂在任何工厂之下，无法确定隔离归属'))
  }
  return { dept, plant, map }
}

export function createMasterDataCommandHandlers(): CommandHandler[] {
  const repos = (tools: CommandTools) => md(tools)

  // ---------------- 换算行（MD-04/05：料品页唯一可编辑部分，MD-01） ----------------

  const conversionCreate: CommandHandler = {
    commandType: 'masterdata.conversion.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const materialId = str(p, 'materialId')
        const unitName = str(p, 'unitName')
        const factor = str(p, 'factor')
        if (!materialId || !unitName || factor === undefined) {
          return bad('payload 需要 materialId/unitName/factor')
        }
        // 换算行属料品（企业级主数据）→ 企业范围方可编辑（OA-24 口径）
        await assertWriteScope(tools, null)
        const material = await repos(tools).materials.findById(materialId)
        if (material === null || material.status !== 'active' || material.orgScopeId !== ctx.enterpriseId) {
          return bad('料品不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        // MD-04 数值与单位名口径
        assertConversionUnitName(unitName)
        assertConversionFactorInput(factor)
        const version = await repos(tools).conversions.nextVersion(materialId)
        const line = await repos(tools).conversions.insert({
          materialId,
          version,
          unitName,
          factor,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.conversion.create',
          subjectType: 'conversion_revision',
          subjectId: line.id,
          after: { materialId, version, unitName, factor },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { conversionId: line.id, version: line.version } }
      }),
  }

  const conversionUpdate: CommandHandler = {
    commandType: 'masterdata.conversion.update',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const line = await repos(tools).conversions.findById(envelope.targetId)
        if (line === null || line.status !== 'active') {
          return bad('换算行不存在', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, null)
        const material = await repos(tools).materials.findById(line.materialId)
        if (material === null || material.orgScopeId !== ctx.enterpriseId) {
          return bad('料品不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        // MD-05：被采购收货引用的换算行不可修改
        assertConversionLineMutable(line)
        const p = envelope.payload as Payload
        const patch: { unitName?: string; factor?: string } = {}
        if (str(p, 'unitName') !== undefined) {
          assertConversionUnitName(str(p, 'unitName')!)
          patch.unitName = str(p, 'unitName')
        }
        if (str(p, 'factor') !== undefined) {
          assertConversionFactorInput(str(p, 'factor')!)
          patch.factor = str(p, 'factor')
        }
        await repos(tools).conversions.update(line.id, patch, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.conversion.update',
          subjectType: 'conversion_revision',
          subjectId: line.id,
          before: { unitName: line.unitName, factor: line.factor },
          after: patch,
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { conversionId: line.id } }
      }),
  }

  const conversionNewVersion: CommandHandler = {
    commandType: 'masterdata.conversion.newVersion',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        // MD-05：换算变更生成新版本——原行不动（含 referenced 行），新版本行落 conversion_revision
        const line = await repos(tools).conversions.findById(envelope.targetId)
        if (line === null || line.status !== 'active') {
          return bad('换算行不存在', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, null)
        const material = await repos(tools).materials.findById(line.materialId)
        if (material === null || material.orgScopeId !== ctx.enterpriseId) {
          return bad('料品不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        const p = envelope.payload as Payload
        const factor = str(p, 'factor')
        if (factor === undefined) return bad('payload 需要 factor')
        const unitName = str(p, 'unitName') ?? line.unitName
        assertConversionUnitName(unitName)
        assertConversionFactorInput(factor)
        const version = await repos(tools).conversions.nextVersion(line.materialId)
        const created = await repos(tools).conversions.insert({
          materialId: line.materialId,
          version,
          unitName,
          factor,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.conversion.newVersion',
          subjectType: 'conversion_revision',
          subjectId: created.id,
          before: { basedOnVersion: line.version, referenced: line.referenced },
          after: { version, unitName, factor },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { conversionId: created.id, version } }
      }),
  }

  const conversionRetire: CommandHandler = {
    commandType: 'masterdata.conversion.retire',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const line = await repos(tools).conversions.findById(envelope.targetId)
        if (line === null || line.status !== 'active') {
          return bad('换算行不存在', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, null)
        const material = await repos(tools).materials.findById(line.materialId)
        if (material === null || material.orgScopeId !== ctx.enterpriseId) {
          return bad('料品不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        // MD-05：被引用的换算行不可删除
        assertConversionLineMutable(line)
        // MD-37：被库存流水引用拒绝退役
        const refs = await repos(tools).stockRefs.countByConversionLineIds([line.id])
        if (refs.transactionRefs > 0) {
          return bad('[MD-37] 换算行已被库存流水引用，拒绝删除')
        }
        await repos(tools).conversions.retire(line.id, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.conversion.retire',
          subjectType: 'conversion_revision',
          subjectId: line.id,
          before: { unitName: line.unitName, factor: line.factor, version: line.version },
          after: { status: 'retired' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { conversionId: line.id } }
      }),
  }

  // ---------------- 设备（MD-09～16） ----------------

  const equipmentCreate: CommandHandler = {
    commandType: 'masterdata.equipment.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const code = str(p, 'code')
        const name = str(p, 'name')
        const deptId = str(p, 'deptId')
        const workCenterId = str(p, 'workCenterId')
        const equipmentStatus = num(p, 'equipmentStatus')
        const capacity = str(p, 'capacity')
        if (!code || !name || !deptId || !workCenterId || equipmentStatus === undefined) {
          return bad('payload 需要 code/name/deptId/workCenterId/equipmentStatus')
        }
        // MD-13 状态字典 / MD-09+MD-15 编码口径 / MD-09 名称长度 / MD-16 产能口径
        assertEquipmentStatusValue(equipmentStatus)
        assertEquipmentCodeValid(code)
        if (name.length > EQUIPMENT_NAME_MAX) {
          return bad(`[MD-09] 设备名称最长 ${EQUIPMENT_NAME_MAX} 字符`)
        }
        if (capacity !== undefined) assertCapacityInput(capacity)

        const { plant } = await requireDept(tools, ctx.enterpriseId, deptId)
        const workCenter = await repos(tools).workCenters.findById(workCenterId)
        if (workCenter === null || workCenter.status !== 'active' || workCenter.enterpriseId !== ctx.enterpriseId) {
          return bad('工作中心不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        // MD-10：设备所属部门须与工作中心所属部门一致
        assertEquipmentDeptConsistent(deptId, workCenter.deptId)
        // 范围二道防线（设备随部门/工作中心落 plant）
        await assertWriteScope(tools, plant.id)

        // MD-09：编码/名称全局唯一
        if ((await repos(tools).equipment.findActiveByCode(code)) !== null) {
          return bad('[MD-09] 设备编码重复')
        }
        if ((await repos(tools).equipment.findActiveByName(name)) !== null) {
          return bad('[MD-09] 设备名称重复')
        }
        const created = await repos(tools).equipment.insert({
          enterpriseId: plant.enterpriseId,
          plantId: plant.id,
          deptId,
          workCenterId,
          code,
          name,
          actualNo: str(p, 'actualNo') ?? null,
          model: str(p, 'model') ?? null,
          stdRateText: str(p, 'stdRateText') ?? null,
          equipmentStatus,
          capacity: capacity ?? null,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.equipment.create',
          subjectType: 'equipment',
          subjectId: created.id,
          after: { code, name, deptId, workCenterId, equipmentStatus, capacity: capacity ?? null },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: { equipmentId: created.id, equipmentQrCode: equipmentQrCode(created.code) },
        }
      }),
  }

  const equipmentUpdate: CommandHandler = {
    commandType: 'masterdata.equipment.update',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const equipment = await repos(tools).equipment.findById(envelope.targetId)
        if (equipment === null || equipment.status !== 'active' || equipment.enterpriseId !== ctx.enterpriseId) {
          return bad('设备不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, equipment.plantId)
        const p = envelope.payload as Payload
        // MD-12：被排产引用时工作中心/部门锁定（排产表未建，schedulingReferenced 按 false 预留）
        assertEquipmentLockedFieldsEditable(
          { schedulingReferenced: false },
          { workCenterId: str(p, 'workCenterId'), deptId: str(p, 'deptId') },
        )
        if (num(p, 'equipmentStatus') !== undefined && num(p, 'equipmentStatus') !== equipment.equipmentStatus) {
          return bad('设备状态变更请使用 masterdata.equipment.change-status（状态变化须记流水，MD-14）')
        }
        const patch: Record<string, unknown> = {}
        if (str(p, 'name') !== undefined) {
          const name = str(p, 'name')!
          if (name.length > EQUIPMENT_NAME_MAX) return bad(`[MD-09] 设备名称最长 ${EQUIPMENT_NAME_MAX} 字符`)
          if (name !== equipment.name) {
            // MD-09 名称全局唯一（排除自身）
            const dup = await repos(tools).equipment.findActiveByName(name)
            if (dup !== null && dup.id !== equipment.id) return bad('[MD-09] 设备名称重复')
          }
          patch['name'] = name
        }
        if (str(p, 'capacity') !== undefined) {
          const capacity = str(p, 'capacity')!
          assertCapacityInput(capacity)
          patch['capacity'] = capacity
        }
        if (str(p, 'actualNo') !== undefined) patch['actualNo'] = str(p, 'actualNo')
        if (str(p, 'model') !== undefined) patch['model'] = str(p, 'model')
        if (str(p, 'stdRateText') !== undefined) patch['stdRateText'] = str(p, 'stdRateText')

        let nextDeptId = equipment.deptId
        let nextWorkCenterId = equipment.workCenterId
        const deptProvided = str(p, 'deptId') !== undefined
        const wcProvided = str(p, 'workCenterId') !== undefined
        if (deptProvided || wcProvided) {
          nextDeptId = str(p, 'deptId') ?? equipment.deptId
          nextWorkCenterId = str(p, 'workCenterId') ?? equipment.workCenterId
          const { plant } = await requireDept(tools, ctx.enterpriseId, nextDeptId)
          const workCenter = await repos(tools).workCenters.findById(nextWorkCenterId)
          if (workCenter === null || workCenter.status !== 'active' || workCenter.enterpriseId !== ctx.enterpriseId) {
            return bad('工作中心不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
          }
          // MD-10 一致性复检
          assertEquipmentDeptConsistent(nextDeptId, workCenter.deptId)
          await assertWriteScope(tools, plant.id)
          if (deptProvided) patch['deptId'] = nextDeptId
          if (wcProvided) patch['workCenterId'] = nextWorkCenterId
        }
        await repos(tools).equipment.update(equipment.id, patch, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.equipment.update',
          subjectType: 'equipment',
          subjectId: equipment.id,
          before: {
            name: equipment.name,
            deptId: equipment.deptId,
            workCenterId: equipment.workCenterId,
            capacity: equipment.capacity,
          },
          after: patch,
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { equipmentId: equipment.id } }
      }),
  }

  const equipmentChangeStatus: CommandHandler = {
    commandType: 'masterdata.equipment.changeStatus',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const equipment = await repos(tools).equipment.findById(envelope.targetId)
        if (equipment === null || equipment.status !== 'active' || equipment.enterpriseId !== ctx.enterpriseId) {
          return bad('设备不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, equipment.plantId)
        const p = envelope.payload as Payload
        const next = num(p, 'equipmentStatus')
        const source = str(p, 'source') ?? 'WEB'
        if (next === undefined) return bad('payload 需要 equipmentStatus')
        // MD-13 字典 / MD-14 来源
        assertEquipmentStatusValue(next)
        assertStatusLogSource(source)
        // MD-14：新值=旧值时不产生流水
        if (!shouldRecordStatusChange(equipment.equipmentStatus, next)) {
          await tools.audit.record({
            actor: ctx.actorLoginName,
            action: 'masterdata.equipment.changeStatus',
            subjectType: 'equipment',
            subjectId: equipment.id,
            before: { equipmentStatus: equipment.equipmentStatus },
            after: { equipmentStatus: next, journaled: false },
            reason: ctx.reason ?? null,
          })
          return { status: 'COMMITTED', data: { equipmentId: equipment.id, journaled: false } }
        }
        await repos(tools).equipment.update(equipment.id, { equipmentStatus: next }, ctx.actorLoginName)
        const log = await repos(tools).equipment.appendStatusLog({
          equipmentId: equipment.id,
          oldStatus: equipment.equipmentStatus,
          newStatus: next,
          source,
          actor: ctx.actorLoginName,
          occurredAt: tools.now(),
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.equipment.changeStatus',
          subjectType: 'equipment',
          subjectId: equipment.id,
          before: { equipmentStatus: equipment.equipmentStatus },
          after: { equipmentStatus: next, journaled: true, source },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: { equipmentId: equipment.id, journaled: true, statusLogId: log.id },
        }
      }),
  }

  const equipmentRetire: CommandHandler = {
    commandType: 'masterdata.equipment.retire',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const equipment = await repos(tools).equipment.findById(envelope.targetId)
        if (equipment === null || equipment.status !== 'active' || equipment.enterpriseId !== ctx.enterpriseId) {
          return bad('设备不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, equipment.plantId)
        // MD-11：未被排产引用且未被报工引用才可删（两表未建，仓储实现按 0 预留并注明）
        assertEquipmentRetirable({
          schedulingRefs: await repos(tools).equipment.countSchedulingRefs(equipment.id),
          workReportRefs: await repos(tools).equipment.countWorkReportRefs(equipment.id),
        })
        await repos(tools).equipment.retire(equipment.id, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.equipment.retire',
          subjectType: 'equipment',
          subjectId: equipment.id,
          before: { code: equipment.code, name: equipment.name, status: 'active' },
          after: { status: 'retired' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { equipmentId: equipment.id } }
      }),
  }

  // ---------------- 仓库（MD-22～27） ----------------

  const warehouseCreate: CommandHandler = {
    commandType: 'masterdata.warehouse.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const code = str(p, 'code')
        const name = str(p, 'name')
        const deptId = str(p, 'deptId')
        const warehouseType = str(p, 'warehouseType')
        const materialTypes = numArray(p, 'materialTypes')
        if (!code || !name || !deptId || !warehouseType || !materialTypes) {
          return bad('payload 需要 code/name/deptId/warehouseType/materialTypes')
        }
        // MD-22 编码/名称口径
        assertWarehouseCode(code)
        if (name.length === 0 || name.length > 20) return bad('[MD-22] 仓库名称必填且最长 20 字符')
        // MD-23：仓库类型限定可收料品类型集合（先校验类型字典值）
        if (!WAREHOUSE_TYPE_VALUES.includes(warehouseType as 'WAREHOUSE' | 'LINE_SIDE')) {
          return bad(`仓库类型须为 ${WAREHOUSE_TYPE_VALUES.join('/')}`)
        }
        assertMaterialTypesAllowedForWarehouseType(
          warehouseType as 'WAREHOUSE' | 'LINE_SIDE',
          materialTypes,
        )
        const { dept, plant } = await requireDept(tools, ctx.enterpriseId, deptId)
        // MD-24：建仓部门类型约束（首期默认规则=原文基线，配置化）
        assertWarehouseTypeAllowedForDept(
          dept.deptCategory ?? 0,
          warehouseType as 'WAREHOUSE' | 'LINE_SIDE',
        )
        await assertWriteScope(tools, plant.id)
        // MD-22：同工厂编码唯一 + 名称全局唯一
        if ((await repos(tools).warehouses.findActiveByPlantAndCode(plant.id, code)) !== null) {
          return bad('[MD-22] 同一工厂下仓库编码不能重复')
        }
        if ((await repos(tools).warehouses.findActiveByName(name)) !== null) {
          return bad('[MD-22] 仓库名称全局不能重复')
        }
        const created = await repos(tools).warehouses.insert({
          enterpriseId: plant.enterpriseId,
          plantId: plant.id,
          deptId,
          code,
          name,
          warehouseType: warehouseType as 'WAREHOUSE' | 'LINE_SIDE',
          materialTypes,
          managerUserId: str(p, 'managerUserId') ?? null,
          phone: str(p, 'phone') ?? null,
          address: str(p, 'address') ?? null,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.warehouse.create',
          subjectType: 'warehouse',
          subjectId: created.id,
          after: { code, name, deptId, warehouseType, materialTypes, plantId: plant.id },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { warehouseId: created.id } }
      }),
  }

  const warehouseUpdate: CommandHandler = {
    commandType: 'masterdata.warehouse.update',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const warehouse = await repos(tools).warehouses.findById(envelope.targetId)
        if (warehouse === null || warehouse.status !== 'active' || warehouse.enterpriseId !== ctx.enterpriseId) {
          return bad('仓库不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, warehouse.plantId)
        const p = envelope.payload as Payload
        const nextCode = str(p, 'code') ?? warehouse.code
        const nextName = str(p, 'name') ?? warehouse.name
        const nextDeptId = str(p, 'deptId') ?? warehouse.deptId
        const nextType = (str(p, 'warehouseType') ?? warehouse.warehouseType) as 'WAREHOUSE' | 'LINE_SIDE'
        const nextMaterialTypes = numArray(p, 'materialTypes') ?? warehouse.materialTypes
        const codeChanged = nextCode !== warehouse.code

        // MD-25：存在普通库位时仓库编码不可改
        assertWarehouseCodeImmutable({
          activeNormalLocations: await repos(tools).warehouses.countActiveNormalLocations(warehouse.id),
          codeChanged,
        })
        // MD-26：被二维码占用时类型/料品类型不可改
        assertQrBoundWarehouseEditable(
          { qrBound: warehouse.qrBound },
          { warehouseType: str(p, 'warehouseType'), materialTypes: numArray(p, 'materialTypes') },
        )
        if (str(p, 'code') !== undefined && codeChanged) assertWarehouseCode(nextCode)
        if (str(p, 'name') !== undefined && nextName.length === 0) {
          return bad('[MD-22] 仓库名称必填且最长 20 字符')
        }
        // MD-23 复检（组合后的最终值）
        assertMaterialTypesAllowedForWarehouseType(nextType, nextMaterialTypes)

        let nextPlantId = warehouse.plantId
        if (nextDeptId !== warehouse.deptId) {
          const { dept, plant } = await requireDept(tools, ctx.enterpriseId, nextDeptId)
          // MD-24 复检
          assertWarehouseTypeAllowedForDept(dept.deptCategory ?? 0, nextType)
          await assertWriteScope(tools, plant.id)
          nextPlantId = plant.id
        }
        // MD-22 唯一性复检（排除自身）
        if (codeChanged) {
          const dup = await repos(tools).warehouses.findActiveByPlantAndCode(nextPlantId, nextCode)
          if (dup !== null && dup.id !== warehouse.id) return bad('[MD-22] 同一工厂下仓库编码不能重复')
        }
        if (nextName !== warehouse.name) {
          const dup = await repos(tools).warehouses.findActiveByName(nextName)
          if (dup !== null && dup.id !== warehouse.id) return bad('[MD-22] 仓库名称全局不能重复')
        }
        const patch: Record<string, unknown> = {}
        if (str(p, 'code') !== undefined) patch['code'] = nextCode
        if (str(p, 'name') !== undefined) patch['name'] = nextName
        if (str(p, 'deptId') !== undefined) patch['deptId'] = nextDeptId
        if (str(p, 'warehouseType') !== undefined) patch['warehouseType'] = nextType
        if (numArray(p, 'materialTypes') !== undefined) patch['materialTypes'] = nextMaterialTypes
        if (str(p, 'managerUserId') !== undefined) patch['managerUserId'] = str(p, 'managerUserId')
        if (str(p, 'phone') !== undefined) patch['phone'] = str(p, 'phone')
        if (str(p, 'address') !== undefined) patch['address'] = str(p, 'address')
        await repos(tools).warehouses.update(warehouse.id, patch, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.warehouse.update',
          subjectType: 'warehouse',
          subjectId: warehouse.id,
          before: {
            code: warehouse.code,
            name: warehouse.name,
            deptId: warehouse.deptId,
            warehouseType: warehouse.warehouseType,
            materialTypes: warehouse.materialTypes,
          },
          after: patch,
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { warehouseId: warehouse.id } }
      }),
  }

  const warehouseRetire: CommandHandler = {
    commandType: 'masterdata.warehouse.retire',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const warehouse = await repos(tools).warehouses.findById(envelope.targetId)
        if (warehouse === null || warehouse.status !== 'active' || warehouse.enterpriseId !== ctx.enterpriseId) {
          return bad('仓库不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, warehouse.plantId)
        // MD-37：库存余额/流水引用拒删（stock_balance/stock_transaction 未落地阶段按 0 预留）
        const locationIds = await repos(tools).warehouses.listActiveLocationIds(warehouse.id)
        const refs = await repos(tools).stockRefs.countByLocationIds(locationIds)
        // MD-26/27：二维码占用拒删；有库存引用拒删；无引用时下级普通库位级联失效
        assertWarehouseRetirable({
          qrBound: warehouse.qrBound,
          stockRefs: refs.balanceRefs + refs.transactionRefs,
        })
        await repos(tools).warehouses.retire(warehouse.id, ctx.actorLoginName)
        const affectedLocations = await repos(tools).warehouses.retireNormalLocations(
          warehouse.id,
          ctx.actorLoginName,
        )
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.warehouse.retire',
          subjectType: 'warehouse',
          subjectId: warehouse.id,
          before: { code: warehouse.code, name: warehouse.name, status: 'active' },
          after: { status: 'retired', affectedNormalLocations: affectedLocations },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: { warehouseId: warehouse.id, affectedNormalLocations: affectedLocations },
        }
      }),
  }

  // ---------------- 普通库位（MD-28/29/37） ----------------

  const locationCreate: CommandHandler = {
    commandType: 'masterdata.location.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const warehouseId = str(p, 'warehouseId')
        const code = str(p, 'code')
        if (!warehouseId || !code) return bad('payload 需要 warehouseId/code')
        const warehouse = await repos(tools).warehouses.findById(warehouseId)
        if (warehouse === null || warehouse.status !== 'active' || warehouse.enterpriseId !== ctx.enterpriseId) {
          return bad('所属仓库不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, warehouse.plantId)
        // MD-28：8 位数字 = 仓库码 4 位 + 库位码 4 位；前缀须匹配所属仓库
        assertNormalLocationCode(code, warehouse.code)
        // MD-28：同工厂内唯一
        if ((await repos(tools).locations.findActiveByPlantAndCode(warehouse.plantId, code)) !== null) {
          return bad('[MD-28] 同一工厂下库位编码不能重复')
        }
        const created = await repos(tools).locations.insert({
          enterpriseId: warehouse.enterpriseId,
          plantId: warehouse.plantId,
          warehouseId,
          locationKind: 'NORMAL',
          code,
          remark: str(p, 'remark') ?? null,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.location.create',
          subjectType: 'storage_location',
          subjectId: created.id,
          after: { code, warehouseId, locationKind: 'NORMAL' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { locationId: created.id } }
      }),
  }

  const locationUpdate: CommandHandler = {
    commandType: 'masterdata.location.update',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const location = await repos(tools).locations.findById(envelope.targetId)
        if (location === null || location.status !== 'active' || location.enterpriseId !== ctx.enterpriseId) {
          return bad('库位不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        if (location.locationKind !== 'NORMAL') {
          return bad('货架库位由货架维护（masterdata.rack.*），本命令仅维护普通库位')
        }
        await assertWriteScope(tools, location.plantId)
        const p = envelope.payload as Payload
        const nextCode = str(p, 'code') ?? location.code
        const codeChanged = nextCode !== location.code
        // MD-29：被二维码占用的库位不可改码
        assertQrBoundLocationMutable({ qrBound: location.qrBound, codeChanged })
        if (codeChanged) {
          const warehouse = await repos(tools).warehouses.findById(location.warehouseId)
          if (warehouse === null) return bad('所属仓库不存在', ERROR_CODES.NOT_FOUND)
          // MD-28 复检
          assertNormalLocationCode(nextCode, warehouse.code)
          const dup = await repos(tools).locations.findActiveByPlantAndCode(location.plantId, nextCode)
          if (dup !== null && dup.id !== location.id) {
            return bad('[MD-28] 同一工厂下库位编码不能重复')
          }
        }
        const patch: Record<string, unknown> = {}
        if (str(p, 'code') !== undefined) patch['code'] = nextCode
        if (str(p, 'remark') !== undefined) patch['remark'] = str(p, 'remark')
        await repos(tools).locations.update(location.id, patch, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.location.update',
          subjectType: 'storage_location',
          subjectId: location.id,
          before: { code: location.code, remark: location.remark },
          after: patch,
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { locationId: location.id } }
      }),
  }

  const locationRetire: CommandHandler = {
    commandType: 'masterdata.location.retire',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const location = await repos(tools).locations.findById(envelope.targetId)
        if (location === null || location.status !== 'active' || location.enterpriseId !== ctx.enterpriseId) {
          return bad('库位不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, location.plantId)
        // MD-29 + MD-37（库存引用计数在库存表未落地阶段按 0 预留）
        const refs = await repos(tools).stockRefs.countByLocationIds([location.id])
        assertLocationRetirable({
          qrBound: location.qrBound,
          stockRefs: refs.balanceRefs + refs.transactionRefs,
        })
        await repos(tools).locations.retire(location.id, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.location.retire',
          subjectType: 'storage_location',
          subjectId: location.id,
          before: { code: location.code, status: 'active' },
          after: { status: 'retired' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { locationId: location.id } }
      }),
  }

  // ---------------- 货架（MD-30/31/33；区域 MD-32 派生） ----------------

  const rackCreate: CommandHandler = {
    commandType: 'masterdata.rack.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const warehouseId = str(p, 'warehouseId')
        const code = str(p, 'code')
        const zones = num(p, 'zones')
        const layers = num(p, 'layers')
        if (!warehouseId || !code || zones === undefined || layers === undefined) {
          return bad('payload 需要 warehouseId/code/zones/layers')
        }
        const warehouse = await repos(tools).warehouses.findById(warehouseId)
        if (warehouse === null || warehouse.status !== 'active' || warehouse.enterpriseId !== ctx.enterpriseId) {
          return bad('所属仓库不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, warehouse.plantId)
        // MD-30/31 口径
        assertRackCode(code)
        assertRackGridSize(zones, layers)
        // MD-30：同工厂内货架编号唯一
        if ((await repos(tools).racks.findActiveByPlantAndCode(warehouse.plantId, code)) !== null) {
          return bad('[MD-30] 同一工厂下货架编号不能重复')
        }
        const rack = await repos(tools).racks.insert({
          enterpriseId: warehouse.enterpriseId,
          plantId: warehouse.plantId,
          warehouseId,
          code,
          zones,
          layers,
          remark: str(p, 'remark') ?? null,
          createdBy: ctx.actorLoginName,
        })
        // MD-31：按「区域数×层数」自动生成区域码（2+2 位）与库位码（2+2+2 位）
        for (let zoneSeq = 1; zoneSeq <= zones; zoneSeq += 1) {
          const zoneCode = buildZoneCode(code, zoneSeq)
          for (let layerSeq = 1; layerSeq <= layers; layerSeq += 1) {
            await repos(tools).locations.insert({
              enterpriseId: warehouse.enterpriseId,
              plantId: warehouse.plantId,
              warehouseId,
              rackId: rack.id,
              locationKind: 'RACK',
              code: buildRackLocationCode(code, zoneSeq, layerSeq),
              zoneCode,
              createdBy: ctx.actorLoginName,
            })
          }
        }
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.rack.create',
          subjectType: 'rack',
          subjectId: rack.id,
          after: { code, zones, layers, warehouseId, generatedLocations: zones * layers },
          reason: ctx.reason ?? null,
        })
        return {
          status: 'COMMITTED',
          data: { rackId: rack.id, generatedLocations: zones * layers },
        }
      }),
  }

  const rackUpdate: CommandHandler = {
    commandType: 'masterdata.rack.update',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const rack = await repos(tools).racks.findById(envelope.targetId)
        if (rack === null || rack.status !== 'active' || rack.enterpriseId !== ctx.enterpriseId) {
          return bad('货架不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, rack.plantId)
        const p = envelope.payload as Payload
        // MD-31：层数编辑时不可改；区域数量仅新增可设（PRD 货架管理 §2.1）
        if (num(p, 'layers') !== undefined && num(p, 'layers') !== rack.layers) {
          assertRackLayersImmutable(true)
        }
        if (num(p, 'zones') !== undefined && num(p, 'zones') !== rack.zones) {
          throw new MasterDataRuleViolation('MD-31', '区域数量仅新增货架时可设置，编辑不可修改')
        }
        // MD-31：货架被二维码占用时不可修改区域数量/层数/所属仓库
        assertQrBoundRackEditable(
          { qrBound: (await repos(tools).locations.countQrBoundActiveByRack(rack.id)) > 0 },
          { zones: num(p, 'zones'), layers: num(p, 'layers'), warehouseId: str(p, 'warehouseId') },
        )
        const patch: Record<string, unknown> = {}
        // MD-31：货架下已有货架库位时不允许修改货架编号
        const nextCode = str(p, 'code') ?? rack.code
        if (nextCode !== rack.code) {
          assertRackCodeImmutable({
            activeLocations: await repos(tools).locations.countActiveByRack(rack.id),
            codeChanged: true,
          })
          assertRackCode(nextCode)
          const dup = await repos(tools).racks.findActiveByPlantAndCode(rack.plantId, nextCode)
          if (dup !== null && dup.id !== rack.id) return bad('[MD-30] 同一工厂下货架编号不能重复')
          patch['code'] = nextCode
        }
        // MD-31：换仓时同步更新其下全部库位的所属仓库
        if (str(p, 'warehouseId') !== undefined && str(p, 'warehouseId') !== rack.warehouseId) {
          const nextWarehouse = await repos(tools).warehouses.findById(str(p, 'warehouseId')!)
          if (
            nextWarehouse === null ||
            nextWarehouse.status !== 'active' ||
            nextWarehouse.enterpriseId !== ctx.enterpriseId
          ) {
            return bad('目标仓库不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
          }
          await assertWriteScope(tools, nextWarehouse.plantId)
          const affected = await repos(tools).locations.updateWarehouseOfRackLocations(
            rack.id,
            nextWarehouse.id,
            ctx.actorLoginName,
          )
          patch['warehouseId'] = nextWarehouse.id
          patch['plantId'] = nextWarehouse.plantId
          await tools.audit.record({
            actor: ctx.actorLoginName,
            action: 'masterdata.rack.update',
            subjectType: 'storage_location',
            subjectId: rack.id,
            after: { warehouseId: nextWarehouse.id, affectedLocations: affected },
            reason: ctx.reason ?? null,
          })
        }
        if (str(p, 'remark') !== undefined) patch['remark'] = str(p, 'remark')
        await repos(tools).racks.update(rack.id, patch, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.rack.update',
          subjectType: 'rack',
          subjectId: rack.id,
          before: { code: rack.code, warehouseId: rack.warehouseId, remark: rack.remark },
          after: patch,
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { rackId: rack.id } }
      }),
  }

  const rackRetire: CommandHandler = {
    commandType: 'masterdata.rack.retire',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const rack = await repos(tools).racks.findById(envelope.targetId)
        if (rack === null || rack.status !== 'active' || rack.enterpriseId !== ctx.enterpriseId) {
          return bad('货架不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, rack.plantId)
        // MD-33/37：二维码占用或库存引用即拒
        const locationIds = await repos(tools).locations.listActiveIdsByRack(rack.id)
        const refs = await repos(tools).stockRefs.countByLocationIds(locationIds)
        assertRackRetirable({
          qrBoundLocations: await repos(tools).locations.countQrBoundActiveByRack(rack.id),
          stockRefs: refs.balanceRefs + refs.transactionRefs,
        })
        // 级联失效其下货架库位（retire 语义，不物理删行，MD-36）
        const locations = await repos(tools).locations.listActiveByRack(rack.id)
        for (const location of locations) {
          await repos(tools).locations.retire(location.id, ctx.actorLoginName)
        }
        await repos(tools).racks.retire(rack.id, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.rack.retire',
          subjectType: 'rack',
          subjectId: rack.id,
          before: { code: rack.code, zones: rack.zones, layers: rack.layers, status: 'active' },
          after: { status: 'retired', affectedLocations: locations.length },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { rackId: rack.id, affectedLocations: locations.length } }
      }),
  }

  // ---------------- 工作中心（MD-17/18） ----------------

  const workCenterCreate: CommandHandler = {
    commandType: 'masterdata.workcenter.create',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const p = envelope.payload as Payload
        const code = str(p, 'code')
        const name = str(p, 'name')
        const deptId = str(p, 'deptId')
        if (!code || !name || !deptId) return bad('payload 需要 code/name/deptId')
        const { dept, plant } = await requireDept(tools, ctx.enterpriseId, deptId)
        await assertWriteScope(tools, plant.id)
        // MD-17：编码全局唯一 + 同部门内名称唯一
        if ((await repos(tools).workCenters.findActiveByCode(code)) !== null) {
          return bad('[MD-17] 工作中心编码全局不能重复')
        }
        if ((await repos(tools).workCenters.findActiveByDeptAndName(dept.id, name)) !== null) {
          return bad('[MD-17] 同一部门内工作中心名称不能重复')
        }
        const created = await repos(tools).workCenters.insert({
          enterpriseId: plant.enterpriseId,
          plantId: plant.id,
          deptId,
          code,
          name,
          createdBy: ctx.actorLoginName,
        })
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.workcenter.create',
          subjectType: 'work_center',
          subjectId: created.id,
          after: { code, name, deptId, plantId: plant.id },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { workCenterId: created.id } }
      }),
  }

  const workCenterUpdate: CommandHandler = {
    commandType: 'masterdata.workcenter.update',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const workCenter = await repos(tools).workCenters.findById(envelope.targetId)
        if (workCenter === null || workCenter.status !== 'active' || workCenter.enterpriseId !== ctx.enterpriseId) {
          return bad('工作中心不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, workCenter.plantId)
        const p = envelope.payload as Payload
        const nextCode = str(p, 'code') ?? workCenter.code
        const nextName = str(p, 'name') ?? workCenter.name
        const nextDeptId = str(p, 'deptId') ?? workCenter.deptId
        const patch: Record<string, unknown> = {}
        // MD-17 复检（排除自身）
        if (nextCode !== workCenter.code) {
          if (nextCode.length === 0) return bad('[MD-17] 工作中心编码必填')
          const dup = await repos(tools).workCenters.findActiveByCode(nextCode)
          if (dup !== null && dup.id !== workCenter.id) {
            return bad('[MD-17] 工作中心编码全局不能重复')
          }
          patch['code'] = nextCode
        }
        if (nextName !== workCenter.name || nextDeptId !== workCenter.deptId) {
          const dup = await repos(tools).workCenters.findActiveByDeptAndName(nextDeptId, nextName)
          if (dup !== null && dup.id !== workCenter.id) {
            return bad('[MD-17] 同一部门内工作中心名称不能重复')
          }
        }
        if (nextDeptId !== workCenter.deptId) {
          const { plant } = await requireDept(tools, ctx.enterpriseId, nextDeptId)
          await assertWriteScope(tools, plant.id)
          patch['deptId'] = nextDeptId
          patch['plantId'] = plant.id
        }        if (str(p, 'name') !== undefined) patch['name'] = nextName
        await repos(tools).workCenters.update(workCenter.id, patch, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.workcenter.update',
          subjectType: 'work_center',
          subjectId: workCenter.id,
          before: { code: workCenter.code, name: workCenter.name, deptId: workCenter.deptId },
          after: patch,
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { workCenterId: workCenter.id } }
      }),
  }

  const workCenterRetire: CommandHandler = {
    commandType: 'masterdata.workcenter.retire',
    handle: (envelope, ctx, tools) =>
      run(async () => {
        const workCenter = await repos(tools).workCenters.findById(envelope.targetId)
        if (workCenter === null || workCenter.status !== 'active' || workCenter.enterpriseId !== ctx.enterpriseId) {
          return bad('工作中心不存在或不属于本企业', ERROR_CODES.NOT_FOUND)
        }
        await assertWriteScope(tools, workCenter.plantId)
        // MD-18：① 设备引用 → ② 工序引用 → ③ 订单工序引用（②③表未建，仓储实现按 0 预留）
        assertWorkCenterRetirable({
          equipmentRefs: await repos(tools).workCenters.countActiveEquipment(workCenter.id),
          processRefs: await repos(tools).workCenters.countProcessRefs(workCenter.id),
          orderProcessRefs: await repos(tools).workCenters.countOrderProcessRefs(workCenter.id),
        })
        await repos(tools).workCenters.retire(workCenter.id, ctx.actorLoginName)
        await tools.audit.record({
          actor: ctx.actorLoginName,
          action: 'masterdata.workcenter.retire',
          subjectType: 'work_center',
          subjectId: workCenter.id,
          before: { code: workCenter.code, name: workCenter.name, status: 'active' },
          after: { status: 'retired' },
          reason: ctx.reason ?? null,
        })
        return { status: 'COMMITTED', data: { workCenterId: workCenter.id } }
      }),
  }

  return [
    conversionCreate,
    conversionUpdate,
    conversionNewVersion,
    conversionRetire,
    equipmentCreate,
    equipmentUpdate,
    equipmentChangeStatus,
    equipmentRetire,
    warehouseCreate,
    warehouseUpdate,
    warehouseRetire,
    locationCreate,
    locationUpdate,
    locationRetire,
    rackCreate,
    rackUpdate,
    rackRetire,
    workCenterCreate,
    workCenterUpdate,
    workCenterRetire,
  ]
}
