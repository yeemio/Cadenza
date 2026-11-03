import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'

/**
 * shipping 测试环境：容器内独立数据库 cadenza_shp（与共享 dev 库 cadenza、quality/warehousing
 * 独立库 cadenza_qw 及并行 writer 的独立库隔离）。每轮先 DROP 再 CREATE（清掉上一轮业务行，
 * 保证唯一性断言干净）；迁移 = 注册表（0001–0006）+ 本块 0010（不注册，编程式应用——
 * L0 整合步统一注册；并行 writer 的 0007/0008/0009 同样未注册，与本块无表名/迁移号冲突）。
 */

export const SHP_TEST_DB_NAME = 'cadenza_shp'

export function shpDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${SHP_TEST_DB_NAME}`)
}

/** 重建测试库（PG13+ WITH (FORCE)）。 */
export async function ensureShpTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SHP_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${SHP_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（0001–0006 注册表 + 0010）+ org 种子 + 发运授权 + 主数据夹具。 */
export async function prepareShpTestDatabase(): Promise<pg.Pool> {
  await ensureShpTestDatabase()
  const pool = createPool(shpDatabaseUrl(), { max: 4 })
  await migrateUp(pool, [...migrations])
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantShpPermissions(pool)
  await seedShpFixtures(pool)
  return pool
}

/**
 * 授予发运许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东企业范围）：shipping.read/post + inventory.read/post/reserve
 *   （确认出库消费库存记账、被锁定拒收需要预留命令）；
 * - plantadmin（合肥厂 plant 范围）：shipping.read（跨厂 403 与列表过滤证据）。
 */
export async function grantShpPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-shp')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-shp'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', [
    'shipping.read',
    'shipping.post',
    'inventory.read',
    'inventory.post',
    'inventory.reserve',
  ])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['shipping.read'])
}

/** 主数据夹具（0003 表：成品/附件料品、物流仓 RACK 库位；库存单元由集成测试经 inventory 命令自建）。 */
export interface ShpFixtures {
  /** 成品缆料（material_type=3） */
  finishedMaterialId: string
  /** 无轴散件料（material_type=3） */
  partMaterialId: string
  /** 物流仓（打包调入库位所在仓） */
  logisticsWarehouseId: string
  /** RACK 库位 010101（打包调入库位：货架码+层拼位） */
  rackLocationId: string
  /** RACK 库位 010102（换位只读证据用） */
  rackLocationId2: string
  /** 普通库位（库存收货位） */
  stockLocationId: string
  /** 苏州厂 id */
  szPlantId: string
  /** 演示单位 id（0004 口径：uom_id 无 FK，固定 UUID 即可） */
  uomId: string
}

const FIXTURE_CODES = {
  finishedMaterial: 'MAT-SHP-FIN',
  partMaterial: 'MAT-SHP-PART',
  logisticsWarehouse: '9111',
  rackLocation1: '010101',
  rackLocation2: '010102',
  stockLocation: '91110101',
} as const

export async function seedShpFixtures(pool: pg.Pool): Promise<ShpFixtures> {
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
       VALUES ($1, $2, $3, $4, 'KG', 0, 'U9', 'seed-shp')
       ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET
         material_type = EXCLUDED.material_type, updated_at = now(), updated_by = 'seed-shp'
       RETURNING id`,
      [enterpriseId, code, name, materialType],
    )
    return r.rows[0]!.id
  }
  const finishedMaterialId = await insertMaterial(FIXTURE_CODES.finishedMaterial, '发运演示-成品缆', 3)
  const partMaterialId = await insertMaterial(FIXTURE_CODES.partMaterial, '发运演示-无轴散件', 3)

  const logisticsWarehouseId = (
    await pool.query<{ id: string }>(
      `INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, created_by)
       VALUES ($1, $2, $3, '9111', '苏州发运物流仓', 'WAREHOUSE', ARRAY[3]::smallint[], 'seed-shp')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-shp'
       RETURNING id`,
      [enterpriseId, szPlantId, deptId],
    )
  ).rows[0]!.id

  const rackId = (
    await pool.query<{ id: string }>(
      `INSERT INTO rack (enterprise_id, plant_id, warehouse_id, code, zones, layers, created_by)
       VALUES ($1, $2, $3, '01', 1, 2, 'seed-shp')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, logisticsWarehouseId],
    )
  ).rows[0]!.id

  const insertLocation = async (
    code: string,
    locationKind: 'NORMAL' | 'RACK',
    rackRef: string | null,
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, rack_id, location_kind, code, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'seed-shp')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, logisticsWarehouseId, rackRef, locationKind, code],
    )
    return r.rows[0]!.id
  }
  const rackLocationId = await insertLocation(FIXTURE_CODES.rackLocation1, 'RACK', rackId)
  const rackLocationId2 = await insertLocation(FIXTURE_CODES.rackLocation2, 'RACK', rackId)
  const stockLocationId = await insertLocation(FIXTURE_CODES.stockLocation, 'NORMAL', null)

  return {
    finishedMaterialId,
    partMaterialId,
    logisticsWarehouseId,
    rackLocationId,
    rackLocationId2,
    stockLocationId,
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
