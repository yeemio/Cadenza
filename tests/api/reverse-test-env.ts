import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'

/**
 * reverse 测试环境：容器内独立数据库 cadenza_reverse（与共享 dev 库 cadenza、shipping 库
 * cadenza_shp、quality/warehousing 库 cadenza_qw 及并行 writer 独立库隔离）。每轮先 DROP
 * 再 CREATE（清掉上一轮业务行，保证唯一性断言干净）；迁移 = 注册表（0001–0010）+ 本线
 * 0013（L0 整合步 2026-10-28 已注册进注册表）。
 */

export const REV_TEST_DB_NAME = 'cadenza_reverse'

export function revDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${REV_TEST_DB_NAME}`)
}

/** 重建测试库（PG13+ WITH (FORCE)）。 */
export async function ensureRevTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${REV_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${REV_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（0001–0010 注册表 + 0013 编程式）+ org 种子 + 逆向授权 + 主数据夹具。 */
export async function prepareRevTestDatabase(): Promise<pg.Pool> {
  await ensureRevTestDatabase()
  const pool = createPool(revDatabaseUrl(), { max: 4 })
  await migrateUp(pool, [...migrations]) // L0 整合步（P2 批次）已注册 0013——注册表口径
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantRevPermissions(pool)
  await seedRevFixtures(pool)
  return pool
}

/**
 * 授予逆向许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东企业范围）：reverse.read/post + inventory.read/post/reserve
 *   （移库/调拨/调整消费库存记账序与锁定预留）；
 * - plantadmin（合肥厂 plant 范围）：reverse.read（跨厂 403 与列表过滤证据）。
 */
export async function grantRevPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-rev')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-rev'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', [
    'reverse.read',
    'reverse.post',
    'inventory.read',
    'inventory.post',
    'inventory.reserve',
  ])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['reverse.read'])
}

/** 逆向域主数据夹具（0003/0004/0006 表；库存单元由集成测试经 inventory 命令自建）。 */
export interface RevFixtures {
  /** 原材料料（material_type=1：生产调拨可调入线边仓的合法类型） */
  rawMaterialId: string
  /** 成品料（material_type=3：生产调拨禁扫证据用） */
  finishedMaterialId: string
  /** 苏州厂原料仓（WAREHOUSE，含 RACK 货架 01 两层 010101/010102） */
  szRawWarehouseId: string
  /** RACK 库位 010101（原料仓内） */
  szRackLocationId: string
  /** RACK 库位 010102（原料仓内：移库目标） */
  szRackLocationId2: string
  /** 苏州厂二号仓（WAREHOUSE，NORMAL 92120101：厂内即时转仓目标） */
  szSecondWarehouseId: string
  /** 二号仓 NORMAL 库位 */
  szSecondLocationId: string
  /** 苏州厂在途仓（WAREHOUSE，NORMAL 92900101：在途库位 transitLocationId） */
  szTransitWarehouseId: string
  szTransitLocationId: string
  /** 苏州厂线边仓（LINE_SIDE，NORMAL 92990101） */
  szLineSideWarehouseId: string
  szLineSideLocationId: string
  /** 合肥厂跨厂目的仓（WAREHOUSE，RACK 010101：WR-14 跨厂签收） */
  hfWarehouseId: string
  hfRackLocationId: string
  /** 载具（0004 carrier：spool 轴盘，苏州厂） */
  carrierId: string
  /** 采购订单行（0006：WR-18 receive-lines 纠正链入口） */
  purchaseLineId: string
  /** 苏州厂 id */
  szPlantId: string
  /** 合肥厂 id */
  hfPlantId: string
  /** 苏州物流部门 id（仓库挂靠部门：WR-03 移入库位范围） */
  szWlDeptId: string
  /** 演示单位 id（0004 口径：uom_id 无 FK，固定 UUID 即可） */
  uomId: string
}

/** 库存所有者常量（IT-20 余额唯一键含 owner；同 shipping-flow 口径）。 */
export const REV_OWNER_ID = '22222222-2222-4222-8222-222222222201'
export const REV_OWNER_NAME = '华东电缆集团（自有）'
/** 客户所有者（WR-26 所有权三分：客供料沿用实际所有者）。 */
export const REV_CUSTOMER_OWNER_ID = '44444444-4444-4444-8444-444444444401'
export const REV_CUSTOMER_OWNER_NAME = '客户甲（客供料）'

export async function seedRevFixtures(pool: pg.Pool): Promise<RevFixtures> {
  const szPlant = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM org_node WHERE code = 'PLNT-SZ'`,
  )
  const szPlantId = szPlant.rows[0]!.id
  const enterpriseId = szPlant.rows[0]!.enterprise_id
  const hfPlant = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'PLNT-HF'`)
  const hfPlantId = hfPlant.rows[0]!.id
  const wlDept = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'DEPT-SZ-WL'`)
  const szWlDeptId = wlDept.rows[0]!.id
  const hfDept = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'DEPT-HF-JZ'`).catch(() => null)
  const hfDeptId = hfDept !== null && hfDept.rows.length > 0 ? hfDept.rows[0]!.id : null

  const insertMaterial = async (code: string, name: string, materialType: number): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES ($1, $2, $3, $4, 'KG', 0, 'U9', 'seed-rev')
       ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET
         material_type = EXCLUDED.material_type, updated_at = now(), updated_by = 'seed-rev'
       RETURNING id`,
      [enterpriseId, code, name, materialType],
    )
    return r.rows[0]!.id
  }
  const rawMaterialId = await insertMaterial('MAT-REV-RAW', '逆向演示-原材料铜杆', 1)
  const finishedMaterialId = await insertMaterial('MAT-REV-FIN', '逆向演示-成品缆', 3)

  const insertWarehouse = async (
    plantId: string,
    deptId: string | null,
    code: string,
    name: string,
    warehouseType: 'WAREHOUSE' | 'LINE_SIDE',
    materialTypes: number[],
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'seed-rev')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-rev'
       RETURNING id`,
      [enterpriseId, plantId, deptId, code, name, warehouseType, materialTypes],
    )
    return r.rows[0]!.id
  }
  const insertRack = async (plantId: string, warehouseId: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO rack (enterprise_id, plant_id, warehouse_id, code, zones, layers, created_by)
       VALUES ($1, $2, $3, '01', 1, 2, 'seed-rev')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, plantId, warehouseId],
    )
    return r.rows[0]!.id
  }
  const insertLocation = async (
    plantId: string,
    warehouseId: string,
    code: string,
    locationKind: 'NORMAL' | 'RACK',
    rackRef: string | null,
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, rack_id, location_kind, code, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'seed-rev')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, plantId, warehouseId, rackRef, locationKind, code],
    )
    return r.rows[0]!.id
  }

  // 苏州厂：原料仓（RACK×2）+ 二号仓（NORMAL）+ 在途仓（NORMAL）+ 线边仓（NORMAL）
  const szRawWarehouseId = await insertWarehouse(szPlantId, szWlDeptId, '9211', '苏州逆向原料仓', 'WAREHOUSE', [1, 2, 3])
  const szRackId = await insertRack(szPlantId, szRawWarehouseId)
  const szRackLocationId = await insertLocation(szPlantId, szRawWarehouseId, '010101', 'RACK', szRackId)
  const szRackLocationId2 = await insertLocation(szPlantId, szRawWarehouseId, '010102', 'RACK', szRackId)
  const szSecondWarehouseId = await insertWarehouse(szPlantId, szWlDeptId, '9212', '苏州逆向二号仓', 'WAREHOUSE', [1, 2, 3])
  const szSecondLocationId = await insertLocation(szPlantId, szSecondWarehouseId, '92120101', 'NORMAL', null)
  const szTransitWarehouseId = await insertWarehouse(szPlantId, szWlDeptId, '9290', '苏州逆向在途仓', 'WAREHOUSE', [1, 2, 3])
  const szTransitLocationId = await insertLocation(szPlantId, szTransitWarehouseId, '92900101', 'NORMAL', null)
  const szLineSideWarehouseId = await insertWarehouse(szPlantId, szWlDeptId, '9299', '苏州逆向线边仓', 'LINE_SIDE', [1, 2])
  const szLineSideLocationId = await insertLocation(szPlantId, szLineSideWarehouseId, '92990101', 'NORMAL', null)

  // 合肥厂：跨厂目的仓（RACK；WR-14 跨厂签收接收方上架）
  const hfWarehouseId = await insertWarehouse(hfPlantId, hfDeptId, '9311', '合肥逆向跨厂仓', 'WAREHOUSE', [1, 2, 3])
  const hfRackId = await insertRack(hfPlantId, hfWarehouseId)
  const hfRackLocationId = await insertLocation(hfPlantId, hfWarehouseId, '010101', 'RACK', hfRackId)

  // 载具（0004 carrier：WR-27 借还）
  const carrierId = (
    await pool.query<{ id: string }>(
      `INSERT INTO carrier (carrier_code, carrier_kind, status, plant_id, enterprise_id, created_by)
       VALUES ('CARR-REV-01', 'spool', 'in_service', $1, $2, 'seed-rev')
       ON CONFLICT (plant_id, carrier_code) DO UPDATE SET updated_at = now() RETURNING id`,
      [szPlantId, enterpriseId],
    )
  ).rows[0]!.id

  // 采购订单 + 行（0006：WR-18 纠正链入口；直插夹具——api 层证据不依赖采购入站命令）
  const orderNo = 'PO-REV-0001'
  const orderId = (
    await pool.query<{ id: string }>(
      `INSERT INTO purchase_order (order_no, org_code, source_system, plant_id, enterprise_id, supplier_name, created_by)
       VALUES ($1, '9000', 'ERP', $2, $3, '逆向演示供应商', 'seed-rev')
       ON CONFLICT (source_system, org_code, order_no) DO UPDATE SET updated_at = now() RETURNING id`,
      [orderNo, szPlantId, enterpriseId],
    )
  ).rows[0]!.id
  const purchaseLineId = (
    await pool.query<{ id: string }>(
      `INSERT INTO purchase_order_line (purchase_order_id, line_no, order_no, org_code, source_system,
         material_id, material_code, material_name, material_type, uom_code,
         planned_qty, received_qty, over_receipt_limit, status, plant_id, enterprise_id, created_by)
       VALUES ($1, 10, $2, '9000', 'ERP', $3, 'MAT-REV-RAW', '逆向演示-原材料铜杆', 1, 'KG',
         1000.0000, 0.0000, 50.0000, 0, $4, $5, 'seed-rev')
       ON CONFLICT (source_system, org_code, order_no, line_no) DO UPDATE SET updated_at = now() RETURNING id`,
      [orderId, orderNo, rawMaterialId, szPlantId, enterpriseId],
    )
  ).rows[0]!.id

  return {
    rawMaterialId,
    finishedMaterialId,
    szRawWarehouseId,
    szRackLocationId,
    szRackLocationId2,
    szSecondWarehouseId,
    szSecondLocationId,
    szTransitWarehouseId,
    szTransitLocationId,
    szLineSideWarehouseId,
    szLineSideLocationId,
    hfWarehouseId,
    hfRackLocationId,
    carrierId,
    purchaseLineId,
    szPlantId,
    hfPlantId,
    szWlDeptId,
    uomId: '33333333-3333-4333-8333-3333333333c1',
  }
}

/** 取组织节点 id（按 code）。 */
export async function nodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}
