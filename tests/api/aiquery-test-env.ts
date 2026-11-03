import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'
import { seedAiQueryCapabilities } from '../../packages/persistence/src/aiquery-repositories'
import { AI_QUERY_CAPABILITY_SEEDS } from '../../packages/domain/src/aiquery'

/** P4 tests own newly created local databases; existing databases are never reset or dropped. */
export let AQ_TEST_DB_NAME = 'cadenza_sol_p4_1031'

function localDatabaseUrl(database: string): string {
  const url = new URL(process.env['AQ_TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/postgres')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('P4 tests require an explicit local PostgreSQL connection')
  }
  url.pathname = `/${database}`
  return url.toString()
}

export function aqDatabaseUrl(): string {
  return localDatabaseUrl(AQ_TEST_DB_NAME)
}

/** Allocate an empty, exclusive database; retain it (including failures) for evidence. */
export async function ensureAqTestDatabase(): Promise<void> {
  const admin = createPool(localDatabaseUrl('postgres'), { max: 1 })
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [AQ_TEST_DB_NAME])
    if (existing.rowCount !== 0) AQ_TEST_DB_NAME = `cadenza_sol_p4_1031_${process.pid}_${Date.now()}`
    await admin.query(`CREATE DATABASE "${AQ_TEST_DB_NAME}"`)
    console.info(`[P4 database] ${AQ_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** Preparation errors propagate: no migration/fixture failure may become a passing test. */
export async function prepareAqTestDatabase(): Promise<pg.Pool> {
  await ensureAqTestDatabase()
  const pool = createPool(aqDatabaseUrl(), { max: 4 })
  try {
    await migrateUp(pool, [...migrations])
    await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
    await grantAqPermissions(pool)
    await seedAqCapabilities(pool)
    await seedAqFixtures(pool)
    return pool
  } catch (error) {
    await pool.end()
    throw error
  }
}

/** 授予 aiquery 许可（幂等合并，不覆盖种子 org 权限；先例 shipping-test-env grant）。 */
export async function grantAqPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-aq')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-aq'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  // sysadmin（华东企业范围）：三能力全量许可（aiquery.use + 六域读）
  await grant('sysadmin', 'enterprise', 'ENT-HD', [
    'aiquery.use',
    'process.read',
    'execution.read',
    'scheduling.read',
    'inventory.read',
    'purchase.read',
    'quality.read',
  ])
  // plantadmin（合肥厂 plant 范围）：仅 C1 域读 → capabilities 预检只见 aq.order-progress（AQ-REG-05）
  await grant('plantadmin', 'plant', 'PLNT-HF', ['aiquery.use', 'process.read', 'execution.read', 'scheduling.read'])
  // qc 角色（苏州质检员 szqc01）：不授 aiquery.use → 会话登记 403 / capabilities 空
}

/** 首版三能力注册行 seed（AQ-REG-03：部署初始化写入；幂等）。 */
export async function seedAqCapabilities(pool: pg.Pool): Promise<void> {
  const ent = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'ENT-HD'`)
  await seedAiQueryCapabilities(pool, ent.rows[0]!.id, AI_QUERY_CAPABILITY_SEEDS, 'seed-aq')
}

/** 取组织节点 id（按 code）。 */
export async function nodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}

async function nodeIdOrFail(pool: pg.Pool, code: string): Promise<string> {
  return nodeId(pool, code)
}

/** 固定演示单位 id（0004 口径：uom_id 无 FK，固定 UUID 即可，先例 shipping-test-env）。 */
export const AQ_UOM_ID = '33333333-3333-4333-8333-3333333333c1'

/** 三能力夹具产物（关键 id 供断言定位）。 */
export interface AqFixtures {
  enterpriseId: string
  szPlantId: string
  hfPlantId: string
  /** 黄金订单（五量/排程/未完成对照源） */
  goldenOrderId: string
  goldenOp1Id: string
  goldenOp2Id: string
  /** 未冻结 BOM 订单 */
  noBomOrderId: string
  /** 零值订单（无任何报工/排程 → 五量全 0 仍是 ok_with_data） */
  zeroOrderId: string
  /** 采购超限订单（BOM 501 行 + 201 采购行 → 截断） */
  bulkOrderId: string
  /** 歧义组订单（orderNoLike/salesOrderNo 多命中） */
  ambigOrder1Id: string
  ambigOrder2Id: string
  /** 合肥厂订单（plantadmin 数据范围过滤对照） */
  hfOrderId: string
  bomRevisionId: string
  bomBigRevisionId: string
  qioUnqualifiedId: string
  qioQualifiedId: string
  batchUnqualifiedId: string
  adminUserId: string
}

const FIXED_TIME = {
  inWindowFrom: '2026-01-01T00:00:00Z',
  inWindowTo: '2026-02-01T00:00:00Z',
  qio1: '2026-01-10T08:00:00Z',
  qio2: '2026-01-20T08:00:00Z',
  outOfWindow: '2025-06-01T08:00:00Z',
  batch1: '2026-01-15T08:00:00Z',
  batchOld: '2025-06-01T08:00:00Z',
  slotDate: '2026-01-05',
  report1: '2026-01-06T10:00:00Z',
  report2: '2026-01-08T10:00:00Z',
}

export async function seedAqFixtures(pool: pg.Pool): Promise<AqFixtures> {
  const enterpriseId = await nodeIdOrFail(pool, 'ENT-HD')
  const szPlantId = await nodeIdOrFail(pool, 'PLNT-SZ')
  const hfPlantId = await nodeIdOrFail(pool, 'PLNT-HF')
  const jzDeptId = await nodeIdOrFail(pool, 'DEPT-SZ-JZ')
  const qcDeptId = await nodeIdOrFail(pool, 'DEPT-SZ-QC')
  const adminUser = await pool.query<{ id: string }>(`SELECT id FROM user_account WHERE login_name = 'admin'`)
  const adminUserId = adminUser.rows[0]!.id

  // ---- 主数据：工作中心/工序/设备/产品族/料品/仓库/库位 ----
  const wcId = (
    await pool.query<{ id: string }>(
      `INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, created_by)
       VALUES ($1, $2, $3, 'WCAQ1', 'AI演示绞制中心', 'seed-aq') RETURNING id`,
      [enterpriseId, szPlantId, jzDeptId],
    )
  ).rows[0]!.id
  const opDefJz = (
    await pool.query<{ id: string }>(
      `INSERT INTO operation_definition (enterprise_id, plant_id, dept_id, work_center_id, company_org_code, code, name, created_by)
       VALUES ($1, $2, $3, $4, 'HDMIKE', 'OPAQ1', 'AI演示绞制工序', 'seed-aq') RETURNING id`,
      [enterpriseId, szPlantId, jzDeptId, wcId],
    )
  ).rows[0]!.id
  const opDefQc = (
    await pool.query<{ id: string }>(
      `INSERT INTO operation_definition (enterprise_id, plant_id, dept_id, work_center_id, company_org_code, code, name, created_by)
       VALUES ($1, $2, $3, $4, 'HDMIKE', 'OPAQ2', 'AI演示质检工序', 'seed-aq') RETURNING id`,
      [enterpriseId, szPlantId, qcDeptId, wcId],
    )
  ).rows[0]!.id
  const equipmentId = (
    await pool.query<{ id: string }>(
      `INSERT INTO equipment (enterprise_id, plant_id, dept_id, work_center_id, code, name, equipment_status, created_by)
       VALUES ($1, $2, $3, $4, 'EQAQ1', 'AI演示设备一', 1, 'seed-aq') RETURNING id`,
      [enterpriseId, szPlantId, jzDeptId, wcId],
    )
  ).rows[0]!.id
  const familyId = (
    await pool.query<{ id: string }>(
      `INSERT INTO product_family (enterprise_id, plant_id, code, name, created_by)
       VALUES ($1, $2, 'PF-AQ', 'AI演示产品族', 'seed-aq') RETURNING id`,
      [enterpriseId, szPlantId],
    )
  ).rows[0]!.id
  const insertMaterial = async (code: string, name: string, materialType: number, baseUom: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
         VALUES ($1, $2, $3, $4, $5, 0, 'U9', 'seed-aq') RETURNING id`,
        [enterpriseId, code, name, materialType, baseUom],
      )
    ).rows[0]!.id
  const cableMaterialId = await insertMaterial('MAT-AQ-CABLE', 'AI演示-成品缆', 3, 'KM')
  const cable2MaterialId = await insertMaterial('MAT-AQ-CABLE2', 'AI演示-成品缆二', 3, 'KM')
  const copperMaterialId = await insertMaterial('MAT-AQ-COPPER', 'AI演示-铜丝', 1, 'T')
  const insuMaterialId = await insertMaterial('MAT-AQ-INSU', 'AI演示-绝缘料', 1, 'KG')
  const mixedMaterialId = await insertMaterial('MAT-AQ-MIXED', 'AI演示-混合单位料', 1, 'M')
  const bulkMaterialId = await insertMaterial('MAT-AQ-BULK', 'AI演示-大宗料', 1, 'KG')
  const warehouseId = (
    await pool.query<{ id: string }>(
      `INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, created_by)
       VALUES ($1, $2, $3, '9211', 'AI演示仓库', 'WAREHOUSE', ARRAY[1,3]::integer[], 'seed-aq') RETURNING id`,
      [enterpriseId, szPlantId, jzDeptId],
    )
  ).rows[0]!.id
  const locationId = (
    await pool.query<{ id: string }>(
      `INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, location_kind, code, created_by)
       VALUES ($1, $2, $3, 'NORMAL', '92110101', 'seed-aq') RETURNING id`,
      [enterpriseId, szPlantId, warehouseId],
    )
  ).rows[0]!.id

  // ---- BOM（AQ-C2）：黄金 3 行 + 超限 501 行 ----
  const bomRevisionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO manufacturing_bom_revision (enterprise_id, plant_id, product_family_id, material_id, version, status, lines, created_by)
       VALUES ($1, $2, $3, $4, 1, 'published', $5::jsonb, 'seed-aq') RETURNING id`,
      [
        enterpriseId,
        szPlantId,
        familyId,
        cableMaterialId,
        JSON.stringify([
          { materialId: copperMaterialId, materialCode: 'MAT-AQ-COPPER', quantity: '0.5000', uom: 'T' },
          { materialId: insuMaterialId, materialCode: 'MAT-AQ-INSU', quantity: '20.0000', uom: 'KG' },
          { materialId: mixedMaterialId, materialCode: 'MAT-AQ-MIXED', quantity: '5.0000', uom: 'M' },
        ]),
      ],
    )
  ).rows[0]!.id
  const bulkLines = Array.from({ length: 501 }, (_, i) => ({
    materialId: bulkMaterialId,
    materialCode: 'MAT-AQ-BULK',
    quantity: '1.0000',
    uom: 'KG',
    note: `line-${String(i + 1)}`,
  }))
  const bomBigRevisionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO manufacturing_bom_revision (enterprise_id, plant_id, product_family_id, material_id, version, status, lines, created_by)
       VALUES ($1, $2, $3, $4, 1, 'published', $5::jsonb, 'seed-aq') RETURNING id`,
      [enterpriseId, szPlantId, familyId, cable2MaterialId, JSON.stringify(bulkLines)],
    )
  ).rows[0]!.id

  // ---- 生产订单（0005） ----
  const insertOrder = async (input: {
    orderNo: string
    plantId: string
    orderStatus: string
    bomRevisionId: string | null
    salesOrderNo?: string | null
    productionQty?: string
    materialId?: string
  }): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO production_order (enterprise_id, plant_id, order_no, order_type, sales_order_no,
           material_id, material_snapshot, product_family_id, production_dept_id, production_qty, uom,
           order_status, process_config_status, bom_revision_id, created_by)
         VALUES ($1, $2, $3, 'NORMAL', $4, $5, $6::jsonb, $7, $8, $9, 'KM', $10, 'configured', $11, 'seed-aq')
         RETURNING id`,
        [
          enterpriseId,
          input.plantId,
          input.orderNo,
          input.salesOrderNo ?? null,
          input.materialId ?? cableMaterialId,
          JSON.stringify({ code: 'MAT-AQ-CABLE', name: 'AI演示-成品缆', spec: '3×95', color: '红' }),
          familyId,
          input.plantId === szPlantId ? jzDeptId : await nodeIdOrFail(pool, 'DEPT-HF-JZ'),
          input.productionQty ?? '100.0000',
          input.orderStatus,
          input.bomRevisionId,
        ],
      )
    ).rows[0]!.id
  const goldenOrderId = await insertOrder({ orderNo: 'ORDER-AQ-1001', plantId: szPlantId, orderStatus: 'in_progress', bomRevisionId })
  const noBomOrderId = await insertOrder({ orderNo: 'ORDER-AQ-1002', plantId: szPlantId, orderStatus: 'released', bomRevisionId: null })
  const zeroOrderId = await insertOrder({ orderNo: 'ORDER-AQ-ZERO', plantId: szPlantId, orderStatus: 'approved', bomRevisionId })
  const bulkOrderId = await insertOrder({ orderNo: 'ORDER-AQ-BULK', plantId: szPlantId, orderStatus: 'released', bomRevisionId: bomBigRevisionId, materialId: cable2MaterialId })
  const ambigOrder1Id = await insertOrder({ orderNo: 'ORDER-AQ-AMB-1', plantId: szPlantId, orderStatus: 'released', bomRevisionId: null, salesOrderNo: 'SO-AQ-SHARED' })
  const ambigOrder2Id = await insertOrder({ orderNo: 'ORDER-AQ-AMB-2', plantId: szPlantId, orderStatus: 'in_progress', bomRevisionId: null, salesOrderNo: 'SO-AQ-SHARED' })
  // 候选「最近者」排序锚：显式错开 created_at（AMB-1 更近 → 候选首位）
  await pool.query(`UPDATE production_order SET created_at = '2026-01-15T08:00:00Z' WHERE id = $1`, [ambigOrder1Id])
  await pool.query(`UPDATE production_order SET created_at = '2026-01-10T08:00:00Z' WHERE id = $1`, [ambigOrder2Id])
  const hfOrderId = await insertOrder({ orderNo: 'ORDER-AQ-HF-1', plantId: hfPlantId, orderStatus: 'released', bomRevisionId: null })

  // ---- 订单工序（0005）：黄金单 2 道；零值单 1 道 ----
  const insertOperation = async (orderId: string, seq: number, name: string, opDefId: string, deptId: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, settings_version,
           operation_definition_id, operation_code, operation_name, core_multiple, offline_qty,
           work_center_id, work_center_code, work_center_name, uom, production_dept_id, created_by)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, 1, 100.0000, $8, 'WCAQ1', 'AI演示绞制中心', 'KM', $9, 'seed-aq')
         RETURNING id`,
        [enterpriseId, szPlantId, orderId, seq, opDefId, `OPAQ${String(seq)}`, name, wcId, deptId],
      )
    ).rows[0]!.id
  const goldenOp1Id = await insertOperation(goldenOrderId, 1, 'AI演示绞制工序', opDefJz, jzDeptId)
  const goldenOp2Id = await insertOperation(goldenOrderId, 2, 'AI演示质检工序', opDefQc, qcDeptId)
  await insertOperation(zeroOrderId, 1, 'AI演示绞制工序', opDefJz, jzDeptId)

  // ---- 排程（0007）：op1 全排（100/100）；op2 未排 → 订单 partially_scheduled、op2 未完成 ----
  await pool.query(
    `INSERT INTO schedule_slot (enterprise_id, plant_id, order_id, order_operation_id, operation_definition_id,
       equipment_id, production_date, planned_qty, uom, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, 100.0000, 'KM', 'seed-aq')`,
    [enterpriseId, szPlantId, goldenOrderId, goldenOp1Id, opDefJz, equipmentId, FIXED_TIME.slotDate],
  )

  // ---- 报工（0008）：R1 审核通过 80/78/入库 80；R2 草稿 30 ----
  const insertExecutionSession = async (orderId: string, status: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO execution_session (enterprise_id, plant_id, order_id, source, operator_user_id, operator_login,
           shift_date, status, business_time, created_by)
         VALUES ($1, $2, $3, 'order', $4, 'admin', '2026-01-06', $5, '2026-01-06T10:00:00Z', 'seed-aq') RETURNING id`,
        [enterpriseId, szPlantId, orderId, adminUserId, status],
      )
    ).rows[0]!.id
  const session1 = await insertExecutionSession(goldenOrderId, 'submitted')
  const session2 = await insertExecutionSession(goldenOrderId, 'open')
  const report1 = (
    await pool.query<{ id: string }>(
      `INSERT INTO production_report (enterprise_id, plant_id, session_id, order_id, order_operation_id, operation_seq,
         source, status, review_status, operator_user_id, operator_login, business_time, shift_date,
         reviewed_at, reviewed_by, created_by)
       VALUES ($1, $2, $3, $4, $5, 1, 'order', 'submitted', 'manual_approved', $6, 'admin', $7, '2026-01-06', $7, 'qc01', 'seed-aq')
       RETURNING id`,
      [enterpriseId, szPlantId, session1, goldenOrderId, goldenOp1Id, adminUserId, FIXED_TIME.report1],
    )
  ).rows[0]!.id
  const report2 = (
    await pool.query<{ id: string }>(
      `INSERT INTO production_report (enterprise_id, plant_id, session_id, order_id, order_operation_id, operation_seq,
         source, status, review_status, operator_user_id, operator_login, business_time, shift_date, created_by)
       VALUES ($1, $2, $3, $4, $5, 2, 'order', 'draft', 'pending_review', $6, 'admin', $7, '2026-01-08', 'seed-aq')
       RETURNING id`,
      [enterpriseId, szPlantId, session2, goldenOrderId, goldenOp2Id, adminUserId, FIXED_TIME.report2],
    )
  ).rows[0]!.id
  // 产出已转线边库的入库单元（RO1 stock_unit_id FK 真实落位：产出单元=成品缆）
  const lotStock = (
    await pool.query<{ id: string }>(
      `INSERT INTO material_lot (lot_no, kind, material_id, material_code, plant_id, enterprise_id, created_by)
       VALUES ('LOT-AQ-STOCK', 'production', $1, 'MAT-AQ-CABLE', $2, $3, 'seed-aq') RETURNING id`,
      [cableMaterialId, szPlantId, enterpriseId],
    )
  ).rows[0]!.id
  const stockUnitIdForOutput = (
    await pool.query<{ id: string }>(
      `INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code, plant_id, enterprise_id, created_by)
       VALUES ('U-AQ-STOCK', $1, 'MAT-AQ-CABLE', $2, $3, 'KM', $4, $5, 'seed-aq') RETURNING id`,
      [cableMaterialId, lotStock, AQ_UOM_ID, szPlantId, enterpriseId],
    )
  ).rows[0]!.id
  await pool.query(
    `INSERT INTO report_output (enterprise_id, plant_id, report_id, line_no, quantity, qualified_qty, uom_id, uom_code,
       target_location_id, target_location_code, owner_id, owner_name, measurement_basis, stock_unit_id, created_by)
     VALUES ($1, $2, $3, 1, 80.0000, 78.0000, $4, 'KM', $5, '92110101', $6, 'AI演示货主', 'nominal', $7, 'seed-aq')`,
    [enterpriseId, szPlantId, report1, AQ_UOM_ID, locationId, adminUserId, stockUnitIdForOutput],
  )
  await pool.query(
    `INSERT INTO report_output (enterprise_id, plant_id, report_id, line_no, quantity, qualified_qty, uom_id, uom_code,
       target_location_id, target_location_code, owner_id, owner_name, measurement_basis, created_by)
     VALUES ($1, $2, $3, 1, 30.0000, 30.0000, $4, 'KM', $5, '92110101', $6, 'AI演示货主', 'nominal', 'seed-aq')`,
    [enterpriseId, szPlantId, report2, AQ_UOM_ID, locationId, adminUserId],
  )

  // ---- 库存（0004）：铜丝 0.3000 T（合格）+ 活动预留 0.1000 T → 可用 0.2000 T；混合料 50.0000 M ----
  const insertLot = async (lotNo: string, materialId: string, materialCode: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO material_lot (lot_no, kind, material_id, material_code, plant_id, enterprise_id, created_by)
         VALUES ($1, 'purchase', $2, $3, $4, $5, 'seed-aq') RETURNING id`,
        [lotNo, materialId, materialCode, szPlantId, enterpriseId],
      )
    ).rows[0]!.id
  const lotCopper = await insertLot('LOT-AQ-C1', copperMaterialId, 'MAT-AQ-COPPER')
  const lotMixed = await insertLot('LOT-AQ-M2', mixedMaterialId, 'MAT-AQ-MIXED')
  const insertUnit = async (unitNo: string, materialId: string, materialCode: string, lotId: string, uomCode: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO inventory_unit (unit_no, material_id, material_code, lot_id, uom_id, uom_code, plant_id, enterprise_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'seed-aq') RETURNING id`,
        [unitNo, materialId, materialCode, lotId, AQ_UOM_ID, uomCode, szPlantId, enterpriseId],
      )
    ).rows[0]!.id
  const unitCopper = await insertUnit('U-AQ-C1', copperMaterialId, 'MAT-AQ-COPPER', lotCopper, 'T')
  const unitCableForHold = await insertUnit('U-AQ-Q1', cableMaterialId, 'MAT-AQ-CABLE', await insertLot('LOT-AQ-Q1', cableMaterialId, 'MAT-AQ-CABLE'), 'KM')
  const unitMixed = await insertUnit('U-AQ-M1', mixedMaterialId, 'MAT-AQ-MIXED', lotMixed, 'M')
  await pool.query(
    `INSERT INTO stock_balance (unit_id, location_id, location_code, owner_id, owner_name, quantity, uom_id, uom_code,
       measurement_basis, quality_status, plant_id, enterprise_id, created_by)
     VALUES ($1, $2, '92110101', $3, 'AI演示货主', 0.3000, $4, 'T', 'nominal', 'qualified', $5, $6, 'seed-aq')`,
    [unitCopper, locationId, adminUserId, AQ_UOM_ID, szPlantId, enterpriseId],
  )
  await pool.query(
    `INSERT INTO stock_balance (unit_id, location_id, location_code, owner_id, owner_name, quantity, uom_id, uom_code,
       measurement_basis, quality_status, plant_id, enterprise_id, created_by)
     VALUES ($1, $2, '92110101', $3, 'AI演示货主', 50.0000, $4, 'M', 'nominal', 'qualified', $5, $6, 'seed-aq')`,
    [unitMixed, locationId, adminUserId, AQ_UOM_ID, szPlantId, enterpriseId],
  )
  await pool.query(
    `INSERT INTO reservation (unit_id, holder_type, holder_ref, quantity, uom_id, uom_code, measurement_basis,
       status, valid_until, plant_id, enterprise_id, created_by)
     VALUES ($1, 'manual', 'AQ-RESERVE-1', 0.1000, $2, 'T', 'nominal', 'active', '2027-01-01T00:00:00Z', $3, $4, 'seed-aq')`,
    [unitCopper, AQ_UOM_ID, szPlantId, enterpriseId],
  )

  // ---- 采购（0006）：在途行（铜丝部分收货 6 T 在途）+ 单位不一致行（KG vs BOM M）+ 排除行 ----
  const poId = (
    await pool.query<{ id: string }>(
      `INSERT INTO purchase_order (order_no, org_code, source_system, plant_id, enterprise_id, created_by)
       VALUES ('PO-AQ-001', 'HDMIKE-PO', 'ERP', $1, $2, 'seed-aq') RETURNING id`,
      [szPlantId, enterpriseId],
    )
  ).rows[0]!.id
  const insertPurchaseLine = async (lineNo: number, materialId: string, materialCode: string, uomCode: string, planned: string, received: string, status: number, erpClosed: boolean): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO purchase_order_line (purchase_order_id, line_no, order_no, org_code, source_system, material_id,
           material_code, material_name, spec, model, color, uom_code, planned_qty, received_qty, over_receipt_limit,
           status, erp_closed, planned_receipt_date, plant_id, enterprise_id, created_by)
         VALUES ($1, $2, 'PO-AQ-001', 'HDMIKE-PO', 'ERP', $3, $4, $5, 'SPEC-1', 'MODEL-1', '白', $6, $7, $8, 0.0000,
           $9, $10, '2026-03-01', $11, $12, 'seed-aq') RETURNING id`,
        [poId, lineNo, materialId, materialCode, `${materialCode}-名称`, uomCode, planned, received, status, erpClosed, szPlantId, enterpriseId],
      )
    ).rows[0]!.id
  const poLineCopper = await insertPurchaseLine(1, copperMaterialId, 'MAT-AQ-COPPER', 'T', '10.0000', '4.0000', 1, false)
  await insertPurchaseLine(2, insuMaterialId, 'MAT-AQ-INSU', 'KG', '50.0000', '0.0000', 0, false)
  await insertPurchaseLine(3, mixedMaterialId, 'MAT-AQ-MIXED', 'KG', '10.0000', '0.0000', 0, false)
  await insertPurchaseLine(4, copperMaterialId, 'MAT-AQ-COPPER', 'T', '10.0000', '10.0000', 5, false)
  await insertPurchaseLine(5, copperMaterialId, 'MAT-AQ-COPPER', 'T', '8.0000', '0.0000', 3, false)
  // 超限组：MAT-AQ-BULK 201 条 status 0 行（每料品 > 200 → 截断）
  const bulkLineValues = Array.from({ length: 201 }, (_, i) => {
    const lineNo = 100 + i
    return `('${poId}', ${lineNo}, 'PO-AQ-001', 'HDMIKE-PO', 'ERP', '${bulkMaterialId}', 'MAT-AQ-BULK',
      'MAT-AQ-BULK-名称', 'SPEC-B', 'MODEL-B', '白', 'KG', 5.0000, 0.0000, 0.0000, 0, false, '2026-03-01',
      '${szPlantId}', '${enterpriseId}', 'seed-aq')`
  })
  await pool.query(
    `INSERT INTO purchase_order_line (purchase_order_id, line_no, order_no, org_code, source_system, material_id,
       material_code, material_name, spec, model, color, uom_code, planned_qty, received_qty, over_receipt_limit,
       status, erp_closed, planned_receipt_date, plant_id, enterprise_id, created_by)
     VALUES ${bulkLineValues.join(', ')}`,
  )
  // 收货批次（AQ-C3 来料族）：窗口内不合格批次 + 窗口外旧批次；L1 最近批次=all_unqualified
  const batchUnqualifiedId = (
    await pool.query<{ id: string }>(
      `INSERT INTO purchase_receipt_batch (batch_no, purchase_line_id, order_no, line_no, material_id, material_code,
         material_name, plant_id, warehouse_id, uom_id, uom_code, inspection_status, storage_status, received_qty,
         arrival_time, confirm_time, received_by, created_by, enterprise_id)
       VALUES ('B-AQ-1', $1, 'PO-AQ-001', 1, $2, 'MAT-AQ-COPPER', 'MAT-AQ-COPPER-名称', $3, $4, $5, 'T',
         'all_unqualified', 'stored', 4.0000, $6, $7, 'admin', 'seed-aq', $8) RETURNING id`,
      [poLineCopper, copperMaterialId, szPlantId, warehouseId, AQ_UOM_ID, FIXED_TIME.batch1, FIXED_TIME.batch1, enterpriseId],
    )
  ).rows[0]!.id
  await pool.query(
    `INSERT INTO purchase_receipt_batch (batch_no, purchase_line_id, order_no, line_no, material_id, material_code,
       material_name, plant_id, warehouse_id, uom_id, uom_code, inspection_status, storage_status, received_qty,
       arrival_time, confirm_time, received_by, created_by, enterprise_id)
     VALUES ('B-AQ-OLD', $1, 'PO-AQ-001', 1, $2, 'MAT-AQ-COPPER', 'MAT-AQ-COPPER-名称', $3, $4, $5, 'T',
       'all_qualified', 'stored', 2.0000, $6, $6, 'admin', 'seed-aq', $7)`,
    [poLineCopper, copperMaterialId, szPlantId, warehouseId, AQ_UOM_ID, FIXED_TIME.batchOld, enterpriseId],
  )
  const insertDetail = async (batchId: string, barcode: string, qualityStatus: string): Promise<void> => {
    await pool.query(
      `INSERT INTO receipt_detail (batch_id, barcode_value, supplier_lot_no, grade, quantity, uom_id, uom_code, quality_status, created_by)
       VALUES ($1, $2, 'SL-1', 'A', 1.0000, $3, 'T', $4, 'seed-aq')`,
      [batchId, barcode, AQ_UOM_ID, qualityStatus],
    )
  }
  await insertDetail(batchUnqualifiedId, 'BC-AQ-1', 'unqualified')
  await insertDetail(batchUnqualifiedId, 'BC-AQ-2', 'unqualified')
  await insertDetail(batchUnqualifiedId, 'BC-AQ-3', 'qualified')

  // ---- 质量（0009）：QIO-1 不合格+让步+活动隔离；QIO-2 合格+放行；窗口外旧单 ----
  const insertQio = async (orderNo: string, stage: string, businessTime: string, unitId: string | null, status: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO quality_inspection_order (order_no, source_type, source_ref, inspection_stage, spec_code, spec_version,
           inventory_unit_id, unit_no, material_id, material_code, quantity, uom_id, uom_code, status,
           production_order_no, production_dept_name, plant_id, enterprise_id, business_time, created_by)
         VALUES ($1, 'work_report', $2, $3, 'SPEC-AQ', 2, $4, $5, $6, 'MAT-AQ-CABLE', 80.0000, $7, 'KM', $8,
           'ORDER-AQ-1001', 'AI演示质检部', $9, $10, $11, 'seed-aq') RETURNING id`,
        [orderNo, orderNo, stage, unitId, unitId === null ? null : 'U-AQ-Q1', cableMaterialId, AQ_UOM_ID, status, szPlantId, enterpriseId, businessTime],
      )
    ).rows[0]!.id
  const qioUnqualifiedId = await insertQio('QIO-AQ-1', 'process', FIXED_TIME.qio1, unitCableForHold, 'concluded')
  const qioQualifiedId = await insertQio('QIO-AQ-2', 'finished', FIXED_TIME.qio2, null, 'concluded')
  await insertQio('QIO-AQ-OLD', 'process', FIXED_TIME.outOfWindow, null, 'concluded')
  await pool.query(
    `INSERT INTO quality_test_result (inspection_order_id, version, conclusion, result_kind, is_effective, inspected_at, created_by)
     VALUES ($1, 1, 'pending', 'initial', false, $2, 'seed-aq'), ($1, 2, 'unqualified', 're_inspection', true, $2, 'seed-aq')`,
    [qioUnqualifiedId, FIXED_TIME.qio1],
  )
  await pool.query(
    `INSERT INTO quality_test_result (inspection_order_id, version, conclusion, result_kind, is_effective, inspected_at, created_by)
     VALUES ($1, 1, 'qualified', 'initial', true, $2, 'seed-aq')`,
    [qioQualifiedId, FIXED_TIME.qio2],
  )
  await pool.query(
    `INSERT INTO quality_disposition (inspection_order_id, disposition_kind, based_on_version, released_by, released_at, reason, created_by)
     VALUES ($1, 'concession', 2, 'qc01', '2026-01-12T08:00:00Z', 'AI演示让步理由', 'seed-aq'),
            ($2, 'release', 1, 'qc01', '2026-01-21T08:00:00Z', NULL, 'seed-aq')`,
    [qioUnqualifiedId, qioQualifiedId],
  )
  // [激活级修复 2026-10-30] 0023（2026-10-29 17:53 落地）为 quality_hold 补 plant_id/
  // enterprise_id NOT NULL 后，本夹具插入缺列 → prepareAqTestDatabase 抛错被各 spec 的
  // 「数据库不可达」catch 吞成整族 SKIP（上一绿灯基线在其之前）。补两列恢复真实执行。
  await pool.query(
    `INSERT INTO quality_hold (inventory_unit_id, unit_no, hold_kind, status, raised_by, raised_at, plant_id, enterprise_id, created_by)
     VALUES ($1, 'U-AQ-Q1', 'unqualified', 'active', 'qc01', '2026-01-11T08:00:00Z', $2, $3, 'seed-aq')`,
    [unitCableForHold, szPlantId, enterpriseId],
  )

  return {
    enterpriseId,
    szPlantId,
    hfPlantId,
    goldenOrderId,
    goldenOp1Id,
    goldenOp2Id,
    noBomOrderId,
    zeroOrderId,
    bulkOrderId,
    ambigOrder1Id,
    ambigOrder2Id,
    hfOrderId,
    bomRevisionId,
    bomBigRevisionId,
    qioUnqualifiedId,
    qioQualifiedId,
    batchUnqualifiedId,
    adminUserId,
  }
}

/** AQ-C3 测试窗口（与夹具 business_time/confirm_time 对齐）。 */
export const AQ_TEST_TIME_RANGE = { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }
