import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'

/**
 * disposition 测试环境：容器内独立数据库 cadenza_disposition（与共享 dev 库及并行线独立库隔离）。
 * 每轮先 DROP 再 CREATE（清掉上一轮业务行，保证唯一性断言干净）；迁移 = 注册表（0001–0010）+
 * 0014（L0 整合步 2026-10-28 已注册进注册表）。
 */

export const QD_TEST_DB_NAME = 'cadenza_disposition'

export function qdDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${QD_TEST_DB_NAME}`)
}

/** 重建测试库（PG13+ WITH (FORCE)）。 */
export async function ensureQdTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${QD_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${QD_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（0001–0010 注册表 + 0014 编程式）+ org 种子 + 处置授权。夹具由测试自取（seedQdFixtures，单次）。 */
export async function prepareQdTestDatabase(): Promise<pg.Pool> {
  await ensureQdTestDatabase()
  const pool = createPool(qdDatabaseUrl(), { max: 4 })
  await migrateUp(pool, [...migrations]) // L0 整合步（P2 批次）已注册 0014——注册表口径
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantQdPermissions(pool)
  return pool
}

/**
 * 授予处置许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东企业范围）：disposition.read/post + inventory.read/post
 *   （投料/质检/处置链证据用库存记账序）；
 * - plantadmin（合肥厂 plant 范围）：disposition.read（跨厂 403 与列表过滤证据）。
 */
export async function grantQdPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-qd')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-qd'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', [
    'disposition.read',
    'disposition.post',
    'inventory.read',
    'inventory.post',
  ])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['disposition.read'])
}

/** 库存所有者常量（IT-20 余额唯一键含 owner）。 */
export const QD_OWNER_ID = '22222222-2222-4222-8222-222222222331'
export const QD_OWNER_NAME = '华东电缆集团（处置线自有）'
export const QD_UOM_ID = '33333333-3333-4333-8333-3333333333d1'

/** disposition 域主数据夹具（0003/0004/0006 表 + 直插库存码；命令侧证据走命令总线）。 */
export interface QdFixtures {
  rawMaterialId: string
  finishedMaterialId: string
  /** 苏州 QD 普通仓（WAREHOUSE，RACK 010101）——已入库非线边仓拒绝证据 */
  qdWarehouseId: string
  qdRackLocationId: string
  /** 苏州 QD 线边仓（LINE_SIDE，NORMAL 92970101）——成品异常允许 */
  lineSideWarehouseId: string
  lineSideLocationId: string
  /** 批次 BATCH-QD-0001（pending，3 码：U-A/U-B/U-F）——版本化主链 */
  batch1No: string
  batch1Id: string
  /** 批次 BATCH-QD-0002（exempt，1 码 U-E）——CA-4 免检判不合格 */
  batch2No: string
  batch2Id: string
  /** 批次 BATCH-QD-0003（returned，1 码 U-R）——QD-17 硬拦截 */
  batch3No: string
  batch3Id: string
  /** 批次 BATCH-QD-0005（pending，1 码 U-H）——QD-16 下游使用拦截 */
  batch5No: string
  batch5Id: string
  /** 批次 BATCH-QD-0006（pending，1 码 U-I 无检验记录）——QD-14 补首检 */
  batch6No: string
  batch6Id: string
  unitAId: string
  unitBId: string
  unitFId: string
  unitEId: string
  unitRId: string
  unitHId: string
  unitIId: string
  unitCId: string
  unitDId: string
  unitGId: string
  szPlantId: string
  szWlDeptId: string
}

export async function seedQdFixtures(pool: pg.Pool): Promise<QdFixtures> {
  const szPlant = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM org_node WHERE code = 'PLNT-SZ'`,
  )
  const szPlantId = szPlant.rows[0]!.id
  const enterpriseId = szPlant.rows[0]!.enterprise_id
  const wlDept = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'DEPT-SZ-WL'`)
  const szWlDeptId = wlDept.rows[0]!.id

  const insertMaterial = async (code: string, name: string, materialType: number): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES ($1, $2, $3, $4, 'KG', 0, 'U9', 'seed-qd')
       ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET
         material_type = EXCLUDED.material_type, updated_at = now(), updated_by = 'seed-qd'
       RETURNING id`,
      [enterpriseId, code, name, materialType],
    )
    return r.rows[0]!.id
  }
  const rawMaterialId = await insertMaterial('MAT-QD-RAW', '处置线-原材料铜杆', 1)
  const finishedMaterialId = await insertMaterial('MAT-QD-FIN', '处置线-成品缆', 3)

  const insertWarehouse = async (
    code: string,
    name: string,
    warehouseType: 'WAREHOUSE' | 'LINE_SIDE',
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, '{1,2,3}', 'seed-qd')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-qd'
       RETURNING id`,
      [enterpriseId, szPlantId, szWlDeptId, code, name, warehouseType],
    )
    return r.rows[0]!.id
  }
  const qdWarehouseId = await insertWarehouse('9213', '苏州处置线原料仓', 'WAREHOUSE')
  const rackId = (
    await pool.query<{ id: string }>(
      `INSERT INTO rack (enterprise_id, plant_id, warehouse_id, code, zones, layers, created_by)
       VALUES ($1, $2, $3, '01', 1, 2, 'seed-qd')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, qdWarehouseId],
    )
  ).rows[0]!.id
  const qdRackLocationId = (
    await pool.query<{ id: string }>(
      `INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, rack_id, location_kind, code, created_by)
       VALUES ($1, $2, $3, $4, 'RACK', '010101', 'seed-qd')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, qdWarehouseId, rackId],
    )
  ).rows[0]!.id
  const lineSideWarehouseId = await insertWarehouse('9297', '苏州处置线线边仓', 'LINE_SIDE')
  const lineSideLocationId = (
    await pool.query<{ id: string }>(
      `INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, rack_id, location_kind, code, created_by)
       VALUES ($1, $2, $3, NULL, 'NORMAL', '92970101', 'seed-qd')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, lineSideWarehouseId],
    )
  ).rows[0]!.id

  /** 直插库存码（material_lot + inventory_unit + stock_balance；等价收货后状态）。 */
  const insertUnit = async (
    unitNo: string,
    materialId: string,
    materialCode: string,
    locationId: string,
    locationCode: string,
    quantity: string,
    qualityStatus: 'qualified' | 'pending_inspection' | 'unqualified',
  ): Promise<string> => {
    const lotId = (
      await pool.query<{ id: string }>(
        `INSERT INTO material_lot (lot_no, kind, material_id, material_code, plant_id, enterprise_id, created_by)
         VALUES ($1, 'purchase', $2, $3, $4, $5, 'seed-qd') RETURNING id`,
        [`LOT-QD-${unitNo}`, materialId, materialCode, szPlantId, enterpriseId],
      )
    ).rows[0]!.id
    const unitId = (
      await pool.query<{ id: string }>(
        `INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code,
           trace_mode, status, balance_open, plant_id, enterprise_id, created_by)
         VALUES ($1, $2, $3, $4, $5, 'KG', 'quantity', 'in_stock', true, $6, $7, 'seed-qd') RETURNING id`,
        [unitNo, materialId, materialCode, lotId, QD_UOM_ID, szPlantId, enterpriseId],
      )
    ).rows[0]!.id
    await pool.query(
      `INSERT INTO stock_balance (unit_id, location_id, location_code, owner_id, owner_name, quantity,
         uom_id, uom_code, measurement_basis, quality_status, plant_id, enterprise_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'KG', 'nominal', $8, $9, $10, 'seed-qd')`,
      [unitId, locationId, locationCode, QD_OWNER_ID, QD_OWNER_NAME, quantity, QD_UOM_ID, qualityStatus, szPlantId, enterpriseId],
    )
    return unitId
  }

  // 批次码（普通仓，待检/免检）与成品码（线边/普通仓）
  const unitAId = await insertUnit('U-QD-A', rawMaterialId, 'MAT-QD-RAW', qdRackLocationId, '010101', '100.0000', 'pending_inspection')
  const unitBId = await insertUnit('U-QD-B', rawMaterialId, 'MAT-QD-RAW', qdRackLocationId, '010101', '80.0000', 'pending_inspection')
  const unitFId = await insertUnit('U-QD-F', rawMaterialId, 'MAT-QD-RAW', qdRackLocationId, '010101', '60.0000', 'pending_inspection')
  const unitEId = await insertUnit('U-QD-E', rawMaterialId, 'MAT-QD-RAW', qdRackLocationId, '010101', '50.0000', 'qualified')
  const unitRId = await insertUnit('U-QD-R', rawMaterialId, 'MAT-QD-RAW', qdRackLocationId, '010101', '30.0000', 'qualified')
  const unitHId = await insertUnit('U-QD-H', rawMaterialId, 'MAT-QD-RAW', qdRackLocationId, '010101', '70.0000', 'pending_inspection')
  const unitIId = await insertUnit('U-QD-I', rawMaterialId, 'MAT-QD-RAW', qdRackLocationId, '010101', '40.0000', 'pending_inspection')
  const unitCId = await insertUnit('U-QD-C', finishedMaterialId, 'MAT-QD-FIN', lineSideLocationId, '92970101', '50.0000', 'qualified')
  const unitDId = await insertUnit('U-QD-D', finishedMaterialId, 'MAT-QD-FIN', qdRackLocationId, '010101', '60.0000', 'qualified')
  const unitGId = await insertUnit('U-QD-G', finishedMaterialId, 'MAT-QD-FIN', lineSideLocationId, '92970101', '30.0000', 'qualified')

  // 采购订单 + 行（0006；批次挂靠入口）
  const orderId = (
    await pool.query<{ id: string }>(
      `INSERT INTO purchase_order (order_no, org_code, source_system, plant_id, enterprise_id, supplier_name, created_by)
       VALUES ('PO-QD-0001', '9000', 'ERP', $1, $2, '处置线演示供应商', 'seed-qd')
       ON CONFLICT (source_system, org_code, order_no) DO UPDATE SET updated_at = now() RETURNING id`,
      [szPlantId, enterpriseId],
    )
  ).rows[0]!.id
  const purchaseLineId = (
    await pool.query<{ id: string }>(
      `INSERT INTO purchase_order_line (purchase_order_id, line_no, order_no, org_code, source_system,
         material_id, material_code, material_name, material_type, uom_code,
         planned_qty, received_qty, over_receipt_limit, status, plant_id, enterprise_id, created_by)
       VALUES ($1, 10, 'PO-QD-0001', '9000', 'ERP', $2, 'MAT-QD-RAW', '处置线-原材料铜杆', 1, 'KG',
         5000.0000, 390.0000, 50.0000, 0, $3, $4, 'seed-qd')
       ON CONFLICT (source_system, org_code, order_no, line_no) DO UPDATE SET updated_at = now() RETURNING id`,
      [orderId, rawMaterialId, szPlantId, enterpriseId],
    )
  ).rows[0]!.id

  /** 直插批次 + 明细（receipt_detail 绑定库存码；等价收货后状态）。 */
  const insertBatch = async (
    batchNo: string,
    inspectionStatus: 'pending' | 'exempt',
    storageStatus: 'stored' | 'returned',
    details: Array<{ unitId: string; barcode: string; detailQuality: string; qty: string }>,
  ): Promise<string> => {
    const batchId = (
      await pool.query<{ id: string }>(
        `INSERT INTO purchase_receipt_batch (batch_no, purchase_line_id, order_no, line_no, material_id,
           material_code, material_name, material_type, plant_id, enterprise_id, warehouse_id, warehouse_code,
           uom_id, uom_code, inspection_status, storage_status, received_qty, arrival_time, confirm_time, received_by, created_by)
         VALUES ($1, $2, 'PO-QD-0001', 10, $3, 'MAT-QD-RAW', '处置线-原材料铜杆', 1, $4, $5, $6, '9213',
           $7, 'KG', $8, $9, $10, now(), now(), 'seed-qd', 'seed-qd')
         RETURNING id`,
        [
          batchNo,
          purchaseLineId,
          rawMaterialId,
          szPlantId,
          enterpriseId,
          qdWarehouseId,
          QD_UOM_ID,
          inspectionStatus,
          storageStatus,
          details.reduce((acc, d) => acc + Number(d.qty), 0).toFixed(4),
        ],
      )
    ).rows[0]!.id
    for (const d of details) {
      await pool.query(
        `INSERT INTO receipt_detail (batch_id, barcode_value, supplier_lot_no, grade, quantity, uom_id,
           uom_code, quality_status, inventory_unit_id, created_by)
         VALUES ($1, $2, '', '', $3, $4, 'KG', $5, $6, 'seed-qd')`,
        [batchId, d.barcode, d.qty, QD_UOM_ID, d.detailQuality, d.unitId],
      )
    }
    return batchId
  }

  const batch1Id = await insertBatch('BATCH-QD-0001', 'pending', 'stored', [
    { unitId: unitAId, barcode: 'BC-QD-A', detailQuality: 'pending_inspection', qty: '100.0000' },
    { unitId: unitBId, barcode: 'BC-QD-B', detailQuality: 'pending_inspection', qty: '80.0000' },
    { unitId: unitFId, barcode: 'BC-QD-F', detailQuality: 'pending_inspection', qty: '60.0000' },
  ])
  const batch2Id = await insertBatch('BATCH-QD-0002', 'exempt', 'stored', [
    { unitId: unitEId, barcode: 'BC-QD-E', detailQuality: 'exempt', qty: '50.0000' },
  ])
  const batch3Id = await insertBatch('BATCH-QD-0003', 'pending', 'returned', [
    { unitId: unitRId, barcode: 'BC-QD-R', detailQuality: 'pending_inspection', qty: '30.0000' },
  ])
  const batch5Id = await insertBatch('BATCH-QD-0005', 'pending', 'stored', [
    { unitId: unitHId, barcode: 'BC-QD-H', detailQuality: 'pending_inspection', qty: '70.0000' },
  ])
  const batch6Id = await insertBatch('BATCH-QD-0006', 'pending', 'stored', [
    { unitId: unitIId, barcode: 'BC-QD-I', detailQuality: 'pending_inspection', qty: '40.0000' },
  ])

  return {
    rawMaterialId,
    finishedMaterialId,
    qdWarehouseId,
    qdRackLocationId,
    lineSideWarehouseId,
    lineSideLocationId,
    batch1No: 'BATCH-QD-0001',
    batch1Id,
    batch2No: 'BATCH-QD-0002',
    batch2Id,
    batch3No: 'BATCH-QD-0003',
    batch3Id,
    batch5No: 'BATCH-QD-0005',
    batch5Id,
    batch6No: 'BATCH-QD-0006',
    batch6Id,
    unitAId,
    unitBId,
    unitFId,
    unitEId,
    unitRId,
    unitHId,
    unitIId,
    unitCId,
    unitDId,
    unitGId,
    szPlantId,
    szWlDeptId,
  }
}

/** 取组织节点 id（按 code）。 */
export async function qdNodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}
