import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'
import type { ExecutionEventPort, ExecutionEventRecord } from '../../packages/application/src/quality-repositories'

/**
 * quality/warehousing 测试环境：容器内独立数据库 cadenza_qw（与共享 dev 库 cadenza 及
 * 并行 writer 的独立库隔离）。每轮先 DROP 再 CREATE（清掉上一轮业务行，保证唯一性断言
 * 干净）；0009 已由 L0 整合步（Wave5）注册进 registry——直接应用注册表全量
 * （0001–0009；曾以 [...migrations, migration0009] 程序式追加，注册后重复项会撞
 * schema_migrations 主键，已收窄）。
 */

export const QW_TEST_DB_NAME = 'cadenza_qw'

export function qwDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${QW_TEST_DB_NAME}`)
}

/** 重建测试库（PG13+ WITH (FORCE)）。 */
export async function ensureQwTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${QW_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${QW_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（注册表全量 0001–0009）+ org 种子 + 质量/仓储授权 + 主数据夹具。 */
export async function prepareQwTestDatabase(): Promise<pg.Pool> {
  await ensureQwTestDatabase()
  const pool = createPool(qwDatabaseUrl(), { max: 4 })
  await migrateUp(pool, [...migrations])
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantQwPermissions(pool)
  await seedQwFixtures(pool)
  return pool
}

/**
 * 授予质量/仓储许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东企业范围）：quality.read/post + warehousing.read/post +
 *   inventory.read/post/reserve（闸门消费侧发料与锁定预留用）；
 * - plantadmin（合肥厂 plant 范围）：quality.read + warehousing.read（跨厂 403 与列表过滤证据）。
 */
export async function grantQwPermissions(pool: pg.Pool): Promise<void> {
  const grant = async (
    roleAlias: string,
    scopeType: 'enterprise' | 'plant',
    scopeCode: string,
    permissions: string[],
  ): Promise<void> => {
    const role = await pool.query<{ id: string; enterprise_id: string }>(
      `SELECT r.id, r.enterprise_id FROM role r JOIN org_node e ON e.id = r.enterprise_id
       WHERE e.code = 'ENT-HD' AND r.alias = $1`,
      [roleAlias],
    )
    if (role.rowCount === 0) throw new Error(`种子角色缺失：${roleAlias}`)
    const scopeObject = await pool.query<{ id: string }>(
      `SELECT id FROM org_node WHERE code = $1 AND enterprise_id = $2`,
      [scopeCode, role.rows[0]!.enterprise_id],
    )
    if (scopeObject.rowCount === 0) throw new Error(`种子范围对象缺失：${scopeCode}`)
    await pool.query(
      `INSERT INTO scope_grant (enterprise_id, principal_type, principal_id, permissions,
         scope_type, scope_object_id, status, created_by)
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-qw')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-qw'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', [
    'quality.read',
    'quality.post',
    'warehousing.read',
    'warehousing.post',
    'inventory.read',
    'inventory.post',
    'inventory.reserve',
  ])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['quality.read', 'warehousing.read'])
}

/** 主数据夹具（0003 表：成品/原料料品、四仓五库位；物流仓字典两值约束见交付记录偏差节）。 */
export interface QwFixtures {
  /** 成品料（material_type=3） */
  finishedMaterialId: string
  /** 原料料（material_type=1） */
  rawMaterialId: string
  /** 物流仓（实体表 warehouse_type='WAREHOUSE'；域规则按载荷 kind='LOGISTICS' 判定，GAP 登记） */
  logisticsWarehouseId: string
  /** 物流仓 RACK 库位 010101（上架目标一） */
  rackLocationId1: string
  /** 物流仓 RACK 库位 010102（上架目标二/移库目标） */
  rackLocationId2: string
  /** 线边仓（调出侧） */
  lineSideWarehouseId: string
  /** 线边仓库位（8 位普通码） */
  lineSideLocationId: string
  /** 普通仓（调拨调入侧） */
  targetWarehouseId: string
  /** 调入仓库位 */
  targetLocationId: string
  /** 在途专用库位（挂在独立在途仓） */
  transitWarehouseId: string
  transitLocationId: string
  /** 苏州厂 id */
  szPlantId: string
  /** 演示单位 id（0004 口径：uom_id 无 FK，固定 UUID 即可） */
  uomId: string
}

const FIXTURE_CODES = {
  finishedMaterial: 'MAT-QW-FIN',
  rawMaterial: 'MAT-QW-RAW',
  logisticsWarehouse: '9101',
  lineSideWarehouse: '9102',
  targetWarehouse: '9103',
  transitWarehouse: '9190',
  rackLocation1: '010101',
  rackLocation2: '010102',
  lineSideLocation: '91020101',
  targetLocation: '91030101',
  transitLocation: '91900101',
} as const

export async function seedQwFixtures(pool: pg.Pool): Promise<QwFixtures> {
  const szPlant = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM org_node WHERE code = 'PLNT-SZ'`,
  )
  const szPlantId = szPlant.rows[0]!.id
  const enterpriseId = szPlant.rows[0]!.enterprise_id
  const wlDept = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'DEPT-SZ-WL'`)
  const deptId = wlDept.rows[0]!.id

  const insertMaterial = async (code: string, name: string, materialType: number): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES ($1, $2, $3, $4, 'KG', 0, 'U9', 'seed-qw')
       ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET
         material_type = EXCLUDED.material_type, updated_at = now(), updated_by = 'seed-qw'
       RETURNING id`,
      [enterpriseId, code, name, materialType],
    )
    return r.rows[0]!.id
  }
  const finishedMaterialId = await insertMaterial(FIXTURE_CODES.finishedMaterial, '质量仓储演示-成品缆', 3)
  const rawMaterialId = await insertMaterial(FIXTURE_CODES.rawMaterial, '质量仓储演示-原料杆', 1)

  const insertWarehouse = async (code: string, name: string, warehouseType: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'seed-qw')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-qw'
       RETURNING id`,
      [
        enterpriseId,
        szPlantId,
        deptId,
        code,
        name,
        warehouseType,
        warehouseType === 'LINE_SIDE' ? [1, 2, 3] : [1, 3],
      ],
    )
    return r.rows[0]!.id
  }
  const logisticsWarehouseId = await insertWarehouse(FIXTURE_CODES.logisticsWarehouse, '苏州物流成品仓', 'WAREHOUSE')
  const lineSideWarehouseId = await insertWarehouse(FIXTURE_CODES.lineSideWarehouse, '苏州绞制线边仓', 'LINE_SIDE')
  const targetWarehouseId = await insertWarehouse(FIXTURE_CODES.targetWarehouse, '苏州原料仓', 'WAREHOUSE')
  const transitWarehouseId = await insertWarehouse(FIXTURE_CODES.transitWarehouse, '苏州在途专用仓', 'WAREHOUSE')

  // 货架（物流仓 01 号，1 区域 1 层）
  const rack = await pool.query<{ id: string }>(
    `INSERT INTO rack (enterprise_id, plant_id, warehouse_id, code, zones, layers, created_by)
     VALUES ($1, $2, $3, '01', 1, 1, 'seed-qw')
     ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
    [enterpriseId, szPlantId, logisticsWarehouseId],
  )
  const rackId = rack.rows[0]!.id

  const insertLocation = async (
    code: string,
    warehouseId: string,
    locationKind: 'NORMAL' | 'RACK',
    rackId: string | null,
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, rack_id, location_kind, code, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'seed-qw')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, warehouseId, rackId, locationKind, code],
    )
    return r.rows[0]!.id
  }
  const rackLocationId1 = await insertLocation(FIXTURE_CODES.rackLocation1, logisticsWarehouseId, 'RACK', rackId)
  const rackLocationId2 = await insertLocation(FIXTURE_CODES.rackLocation2, logisticsWarehouseId, 'RACK', rackId)
  const lineSideLocationId = await insertLocation(FIXTURE_CODES.lineSideLocation, lineSideWarehouseId, 'NORMAL', null)
  const targetLocationId = await insertLocation(FIXTURE_CODES.targetLocation, targetWarehouseId, 'NORMAL', null)
  const transitLocationId = await insertLocation(FIXTURE_CODES.transitLocation, transitWarehouseId, 'NORMAL', null)

  return {
    finishedMaterialId,
    rawMaterialId,
    logisticsWarehouseId,
    rackLocationId1,
    rackLocationId2,
    lineSideWarehouseId,
    lineSideLocationId,
    targetWarehouseId,
    targetLocationId,
    transitWarehouseId,
    transitLocationId,
    szPlantId,
    uomId: '33333333-3333-4333-8333-3333333333c1',
  }
}

/** 取组织节点 id（按 code）。 */
export async function nodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}

/**
 * 执行块事件端口内存实现（L0 整合接线的测试替身：T10 报工域未建，事件由测试注入；
 * 生产接线由 L0 在组合根把 process 域报工提交事件源接入本端口）。
 */
export class InMemoryExecutionEventPort implements ExecutionEventPort {
  constructor(private readonly events: ExecutionEventRecord[]) {}

  async fetchEvents(input: { types?: string[]; plantId?: string }): Promise<ExecutionEventRecord[]> {
    return this.events.filter(
      (e) =>
        (input.types === undefined || input.types.length === 0 || input.types.includes(e.eventType)) &&
        (input.plantId === undefined || e.plantId === input.plantId),
    )
  }
}

/** 构造报工确认事件（检验任务与待入库任务来源）。 */
export function workReportEvent(input: {
  eventId: string
  plantId: string
  sourceRef: string
  unitNo: string
  materialId: string
  quantity: string
  inspectionStage?: 'process' | 'finished'
  specCode?: string
  specVersion?: number
  palletCode?: string
}): ExecutionEventRecord {
  return {
    eventId: input.eventId,
    eventType: 'work_report_confirmed',
    occurredAt: new Date().toISOString(),
    plantId: input.plantId,
    payload: {
      sourceRef: input.sourceRef,
      unitNo: input.unitNo,
      materialId: input.materialId,
      materialCode: FIXTURE_CODES.finishedMaterial,
      quantity: input.quantity,
      uomId: '33333333-3333-4333-8333-3333333333c1',
      uomCode: 'KG',
      productionOrderNo: `MO-${input.sourceRef}`,
      productionDeptName: '苏州厂-绞制车间部',
      inspectionStage: input.inspectionStage ?? 'finished',
      specCode: input.specCode ?? 'QW-SPEC-FIN',
      specVersion: input.specVersion ?? 1,
      palletCode: input.palletCode,
    },
  }
}

/** 构造成品质检放行事件（待入库任务来源：质量已放行）。 */
export function finishedInspectionReleasedEvent(input: {
  eventId: string
  plantId: string
  sourceRef: string
  unitNo: string
  materialId: string
  quantity: string
}): ExecutionEventRecord {
  return {
    eventId: input.eventId,
    eventType: 'finished_inspection_released',
    occurredAt: new Date().toISOString(),
    plantId: input.plantId,
    payload: {
      sourceRef: input.sourceRef,
      unitNo: input.unitNo,
      materialId: input.materialId,
      materialCode: FIXTURE_CODES.finishedMaterial,
      quantity: input.quantity,
      uomId: '33333333-3333-4333-8333-3333333333c1',
      uomCode: 'KG',
    },
  }
}
