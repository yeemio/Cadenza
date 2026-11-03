import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'

/**
 * rework 测试环境：容器内独立数据库 cadenza_rework（与共享 dev 库 cadenza、reverse 库
 * cadenza_reverse、shipping 库 cadenza_shp 及其它并行线独立库隔离）。每轮先 DROP 再
 * CREATE（清掉上一轮业务行，保证唯一性断言干净）；迁移 = 注册表（0001–0010）+ 本线
 * 0011（L0 整合步 2026-10-28 已注册进注册表）。
 */

export const RWK_TEST_DB_NAME = 'cadenza_rework'

export function rwkDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${RWK_TEST_DB_NAME}`)
}

/** 重建测试库（PG13+ WITH (FORCE)）。 */
export async function ensureRwkTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${RWK_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${RWK_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（注册表全量，L0 已注册 0011）+ org 种子 + rework 许可 + 主数据夹具。 */
export async function prepareRwkTestDatabase(): Promise<pg.Pool> {
  await ensureRwkTestDatabase()
  const pool = createPool(rwkDatabaseUrl(), { max: 4 })
  await migrateUp(pool, [...migrations]) // L0 整合步（P2 批次）已注册 0011——注册表口径
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantRwkPermissions(pool)
  await seedRwkFixtures(pool)
  return pool
}

/**
 * 授予 rework 许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东企业范围）：rework.read/post + 轴号占用重分配/回撤（GAP-F4 最小机制）
 *   + inventory.read/post/reserve（复用记账序与作业预留）；
 * - plantadmin（合肥厂 plant 范围）：rework.read（跨厂 403 与列表过滤证据）。
 */
export async function grantRwkPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-rwk')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-rwk'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', [
    'rework.read',
    'rework.post',
    'rework.axis-correction.reassign',
    'rework.axis-correction.withdraw',
    'inventory.read',
    'inventory.post',
    'inventory.reserve',
  ])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['rework.read'])
}

/** rework 域主数据夹具（0003/0004 表；库存单元由集成测试经 inventory 命令自建）。 */
export interface RwkFixtures {
  /** 成品缆料（material_type=3：倒轴/修正/退役对象） */
  finishedMaterialId: string
  /** 苏州车间线边仓（LINE_SIDE，挂车间部门——倒轴/修正/退役主链库位） */
  szLineSideWarehouseId: string
  szLineSideLocationId: string
  /** 苏州物流部仓（WAREHOUSE，dept_category=3——RS-03 物流部拒绝链 + 子轴入库拦截） */
  szLogisticsWarehouseId: string
  szLogisticsLocationId: string
  /** 苏州普通仓（WAREHOUSE，挂车间部门——分托非车间目标库位，非物流部） */
  szPlainWarehouseId: string
  szPlainRackLocationId: string
  szPlainRackLocationId2: string
  /** 苏州厂 id */
  szPlantId: string
  /** 合肥厂 id */
  hfPlantId: string
  /** 演示单位 id（0004 口径：uom_id 无 FK，固定 UUID 即可） */
  uomId: string
}

/** 库存所有者常量（IT-20 余额唯一键含 owner）。 */
export const RWK_OWNER_ID = '22222222-2222-4222-8222-222222222301'
export const RWK_OWNER_NAME = '华东电缆集团（自有）'

export async function seedRwkFixtures(pool: pg.Pool): Promise<RwkFixtures> {
  const szPlant = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM org_node WHERE code = 'PLNT-SZ'`,
  )
  const szPlantId = szPlant.rows[0]!.id
  const enterpriseId = szPlant.rows[0]!.enterprise_id
  const hfPlant = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'PLNT-HF'`)
  const hfPlantId = hfPlant.rows[0]!.id
  const jzDeptId = (await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'DEPT-SZ-JZ'`)).rows[0]!.id
  const wlDeptId = (await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'DEPT-SZ-WL'`)).rows[0]!.id

  const finishedMaterialId = (
    await pool.query<{ id: string }>(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES ($1, 'MAT-RWK-FIN', 'rework演示-成品缆', 3, 'M', 0, 'U9', 'seed-rwk')
       ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET
         updated_at = now(), updated_by = 'seed-rwk'
       RETURNING id`,
      [enterpriseId],
    )
  ).rows[0]!.id

  const insertWarehouse = async (
    deptId: string | null,
    code: string,
    name: string,
    warehouseType: 'WAREHOUSE' | 'LINE_SIDE',
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'seed-rwk')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-rwk'
       RETURNING id`,
      [enterpriseId, szPlantId, deptId, code, name, warehouseType, [1, 2, 3]],
    )
    return r.rows[0]!.id
  }
  const insertRack = async (warehouseId: string, code: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO rack (enterprise_id, plant_id, warehouse_id, code, zones, layers, created_by)
       VALUES ($1, $2, $3, $4, 1, 2, 'seed-rwk')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, warehouseId, code],
    )
    return r.rows[0]!.id
  }
  const insertLocation = async (
    warehouseId: string,
    code: string,
    locationKind: 'NORMAL' | 'RACK',
    rackRef: string | null,
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, rack_id, location_kind, code, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'seed-rwk')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, warehouseId, rackRef, locationKind, code],
    )
    return r.rows[0]!.id
  }

  // 线边仓（LINE_SIDE，挂车间部门）
  const szLineSideWarehouseId = await insertWarehouse(jzDeptId, '9298', '苏州rework线边仓', 'LINE_SIDE')
  const szLineSideLocationId = await insertLocation(szLineSideWarehouseId, '92980101', 'NORMAL', null)
  // 物流部仓（WAREHOUSE，dept_category=3）
  const szLogisticsWarehouseId = await insertWarehouse(wlDeptId, '9216', '苏州rework物流部仓', 'WAREHOUSE')
  const szLogisticsRackId = await insertRack(szLogisticsWarehouseId, '01')
  const szLogisticsLocationId = await insertLocation(szLogisticsWarehouseId, '010101', 'RACK', szLogisticsRackId)
  // 普通仓（WAREHOUSE，挂车间部门——非物流部的仓库型库位）
  const szPlainWarehouseId = await insertWarehouse(jzDeptId, '9217', '苏州rework普通仓', 'WAREHOUSE')
  const plainRackId = await insertRack(szPlainWarehouseId, '02')
  const szPlainRackLocationId = await insertLocation(szPlainWarehouseId, '010101', 'RACK', plainRackId)
  const szPlainRackLocationId2 = await insertLocation(szPlainWarehouseId, '010102', 'RACK', plainRackId)

  return {
    finishedMaterialId,
    szLineSideWarehouseId,
    szLineSideLocationId,
    szLogisticsWarehouseId,
    szLogisticsLocationId,
    szPlainWarehouseId,
    szPlainRackLocationId,
    szPlainRackLocationId2,
    szPlantId,
    hfPlantId,
    uomId: '33333333-3333-4333-8333-3333333333d1',
  }
}

/** 取组织节点 id（按 code）。 */
export async function rwkNodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}
