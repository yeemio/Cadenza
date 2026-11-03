import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'
// 0019 未注册共享 registry（L0 整合步统一注册）：测试直接消费迁移源文件编程式应用。
import { migration0019 } from '../../packages/persistence/src/migrations/0019-process-change-spc'

/**
 * spc 测试环境（P3-C / T23）：容器内独立数据库 cadenza_p3c（与共享 dev 库 cadenza、
 * shipping 独立库 cadenza_shp 及并行 writer 的独立库隔离）。每轮先 DROP 再 CREATE；
 * 迁移 = 注册表（0001–0010）+ 本线 0019（不注册，编程式应用——L0 整合步统一注册；
 * 并行 writer 的 0011–0018 同样未注册，与本线无表名/迁移号冲突）。
 */

export const SPC_TEST_DB_NAME = 'cadenza_p3c'

export function spcDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${SPC_TEST_DB_NAME}`)
}

/** 重建测试库（PG13+ WITH (FORCE)）。 */
export async function ensureSpcTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SPC_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${SPC_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（注册表 0001–0010 + 0019）+ org 种子 + spc 授权 + 跨域夹具。 */
export async function prepareSpcTestDatabase(): Promise<pg.Pool> {
  await ensureSpcTestDatabase()
  const pool = createPool(spcDatabaseUrl(), { max: 4 })
  // [L0-整合标记] 0019 已注册共享 registry（2026-10-28）：去重防 schema_migrations 主键冲突（csw/cost 同款防护）。
  const all = [...migrations, migration0019].filter(
    (m, i, list) => list.findIndex((x) => x.version === m.version) === i,
  )
  await migrateUp(pool, all)
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantSpcPermissions(pool)
  return pool
}

/**
 * 授予 spc 许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东企业范围）：spc.read/post；
 * - plantadmin（合肥厂 plant 范围）：spc.read（跨厂 403 与列表过滤证据）。
 */
export async function grantSpcPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-spc')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-spc'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', ['spc.read', 'spc.post'])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['spc.read'])
}

/** 跨域夹具（0003/0005/0007/0008/0009/0004 表直插——影响扫描/样本来源/圈定的事实底座）。 */
export interface SpcFixtures {
  szPlantId: string
  enterpriseId: string
  /** 产品族（参数规范/订单挂接） */
  productFamilyId: string
  /** 参数规范版本对（v1 已失效 / v2 已发布——变更单引用） */
  oldSpecRevisionId: string
  newSpecRevisionId: string
  /** MO-A：未执行+已排产（可调整未执行，PE-03） */
  orderA: { id: string; orderNo: string; operationId: string }
  /** MO-B：在制（工序 1 已提交报工 = 在制；工序 2 未报工 = 未执行） */
  orderB: { id: string; orderNo: string; reportedOperationId: string; unreportedOperationId: string }
  /** MO-C：已结束（提示范围） */
  orderC: { id: string; orderNo: string; operationId: string }
  /** 人工样本引用的检验实测结果（在库单元 U-SPC-1） */
  testResultStock: { resultId: string; inspectionOrderNo: string; unitId: string; unitNo: string; lotNo: string }
  /** 人工样本引用的检验实测结果（已发运单元 U-SPC-2 → 客诉提示范围） */
  testResultShipped: { resultId: string; inspectionOrderNo: string; unitId: string; unitNo: string; lotNo: string }
  /** 排产槽位设备（schedule_slot FK） */
  equipmentId: string
  uomId: string
}

const FIXTURE_CODES = {
  productFamily: 'PF-SPC',
  material: 'MAT-SPC',
  workCenter: 'WC-SPC-01',
  operationDefinition: 'OP-SPC-JZ',
  equipment: 'EQ-SPC-01',
  specName: '绞制参数规范-SPC',
  orderA: 'MO-SPC-A',
  orderB: 'MO-SPC-B',
  orderC: 'MO-SPC-C',
  lot: 'LOT-SPC',
  unitStock: 'U-SPC-1',
  unitShipped: 'U-SPC-2',
} as const

export async function seedSpcFixtures(pool: pg.Pool): Promise<SpcFixtures> {
  const szPlant = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM org_node WHERE code = 'PLNT-SZ'`,
  )
  const szPlantId = szPlant.rows[0]!.id
  const enterpriseId = szPlant.rows[0]!.enterprise_id
  const jzDept = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'DEPT-SZ-JZ'`)
  const deptId = jzDept.rows[0]!.id
  const admin = await pool.query<{ id: string }>(
    `SELECT id FROM user_account WHERE login_name = 'admin'`,
  )
  const adminId = admin.rows[0]!.id

  // ---- 主数据：产品族 / 料品 / 工作中心 / 标准工序 / 设备（0003/0005） ----
  const productFamilyId = (
    await pool.query<{ id: string }>(
      `INSERT INTO product_family (enterprise_id, plant_id, code, name, created_by)
       VALUES ($1, $2, $3, 'SPC 演示产品族', 'seed-spc') RETURNING id`,
      [enterpriseId, szPlantId, FIXTURE_CODES.productFamily],
    )
  ).rows[0]!.id

  const materialId = (
    await pool.query<{ id: string }>(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES ($1, $2, 'SPC 演示缆料', 3, 'KG', 0, 'U9', 'seed-spc')
       ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, FIXTURE_CODES.material],
    )
  ).rows[0]!.id

  const workCenterId = (
    await pool.query<{ id: string }>(
      `INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, created_by)
       VALUES ($1, $2, $3, $4, 'SPC 演示工作中心', 'seed-spc') RETURNING id`,
      [enterpriseId, szPlantId, deptId, FIXTURE_CODES.workCenter],
    )
  ).rows[0]!.id

  const operationDefinitionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO operation_definition (enterprise_id, plant_id, dept_id, work_center_id, company_org_code, code, name, created_by)
       VALUES ($1, $2, $3, $4, 'ENT-HD', $5, 'SPC 绞制工序', 'seed-spc') RETURNING id`,
      [enterpriseId, szPlantId, deptId, workCenterId, FIXTURE_CODES.operationDefinition],
    )
  ).rows[0]!.id

  const equipmentId = (
    await pool.query<{ id: string }>(
      `INSERT INTO equipment (enterprise_id, plant_id, dept_id, work_center_id, code, name, equipment_status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'SPC 演示设备', 1, 'seed-spc') RETURNING id`,
      [enterpriseId, szPlantId, deptId, workCenterId, FIXTURE_CODES.equipment],
    )
  ).rows[0]!.id

  // ---- 参数规范版本对（v1 已失效、v2 已发布；系数 7×1 → 7×2，重算因子比 2:1） ----
  const oldSpecRevisionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO parameter_spec_revision
         (enterprise_id, plant_id, product_family_id, name, version, status, parameters, published_at, published_by, created_by)
       VALUES ($1, $2, $3, $4, 1, 'retired',
         $5::jsonb, '2026-09-01T00:00:00Z', '工艺-张工', 'seed-spc') RETURNING id`,
      [
        enterpriseId,
        szPlantId,
        productFamilyId,
        FIXTURE_CODES.specName,
        JSON.stringify([{ coreMultiple: 7, strandFactor: '1.0000' }]),
      ],
    )
  ).rows[0]!.id
  const newSpecRevisionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO parameter_spec_revision
         (enterprise_id, plant_id, product_family_id, name, version, status, parameters, published_at, published_by, created_by)
       VALUES ($1, $2, $3, $4, 2, 'published',
         $5::jsonb, '2026-10-27T00:00:00Z', '工艺-张工', 'seed-spc') RETURNING id`,
      [
        enterpriseId,
        szPlantId,
        productFamilyId,
        FIXTURE_CODES.specName,
        JSON.stringify([{ coreMultiple: 7, strandFactor: '2.0000' }]),
      ],
    )
  ).rows[0]!.id

  // ---- 生产订单 + 订单工序（0005） ----
  const insertOrder = async (
    orderNo: string,
    orderStatus: string,
    ops: Array<{ seq: number; coreMultiple: number; strandFactor: string; offlineQty: string }>,
  ): Promise<{ id: string; orderNo: string; operations: Map<number, string> }> => {
    const order = (
      await pool.query<{ id: string }>(
        `INSERT INTO production_order
           (enterprise_id, plant_id, order_no, order_type, material_id, product_family_id,
            production_dept_id, production_qty, uom, order_status, created_by)
         VALUES ($1, $2, $3, 'normal', $4, $5, $6, 1000.0000, 'KG', $7, 'seed-spc') RETURNING id`,
        [enterpriseId, szPlantId, orderNo, materialId, productFamilyId, deptId, orderStatus],
      )
    ).rows[0]!
    const operations = new Map<number, string>()
    for (const op of ops) {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO order_operation
           (enterprise_id, plant_id, order_id, seq, operation_definition_id, operation_code, operation_name,
            core_multiple, strand_factor, offline_qty, work_center_id, work_center_code, work_center_name,
            uom, production_dept_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'SPC 绞制工序', $7, $8, $9, $10, $11, 'SPC 演示工作中心', 'KG', $12)
         RETURNING id`,
        [
          enterpriseId,
          szPlantId,
          order.id,
          op.seq,
          operationDefinitionId,
          FIXTURE_CODES.operationDefinition,
          op.coreMultiple,
          op.strandFactor,
          op.offlineQty,
          workCenterId,
          FIXTURE_CODES.workCenter,
          deptId,
        ],
      )
      operations.set(op.seq, r.rows[0]!.id)
    }
    return { id: order.id, orderNo, operations }
  }

  const orderA = await insertOrder(FIXTURE_CODES.orderA, 'released', [
    { seq: 1, coreMultiple: 7, strandFactor: '1.0000', offlineQty: '100.0000' },
  ])
  const orderB = await insertOrder(FIXTURE_CODES.orderB, 'in_progress', [
    { seq: 1, coreMultiple: 7, strandFactor: '1.0000', offlineQty: '80.0000' },
    { seq: 2, coreMultiple: 7, strandFactor: '1.0000', offlineQty: '60.0000' },
  ])
  const orderC = await insertOrder(FIXTURE_CODES.orderC, 'closed', [
    { seq: 1, coreMultiple: 7, strandFactor: '1.0000', offlineQty: '40.0000' },
  ])

  // ---- MO-A 已排产（schedule_slot：已排产未开工 = 可调整未执行，PE-03） ----
  await pool.query(
    `INSERT INTO schedule_slot
       (enterprise_id, plant_id, order_id, order_operation_id, operation_definition_id, equipment_id,
        production_date, planned_qty, uom, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-10-29', 100.0000, 'KG', 'seed-spc')`,
    [enterpriseId, szPlantId, orderA.id, orderA.operations.get(1)!, operationDefinitionId, equipmentId],
  )

  // ---- MO-B 工序 1 已提交报工（0008：execution_session + production_report submitted） ----
  const session = (
    await pool.query<{ id: string }>(
      `INSERT INTO execution_session
         (enterprise_id, plant_id, order_id, source, order_operation_id, operation_seq, operator_user_id,
          operator_login, shift_date, status, business_time)
       VALUES ($1, $2, $3, 'workbench', $4, 1, $5, 'admin', '2026-10-28', 'submitted', '2026-10-28T02:00:00Z')
       RETURNING id`,
      [enterpriseId, szPlantId, orderB.id, orderB.operations.get(1)!, adminId],
    )
  ).rows[0]!
  await pool.query(
    `INSERT INTO production_report
       (enterprise_id, plant_id, session_id, order_id, order_operation_id, operation_seq, source,
        status, review_status, operator_user_id, operator_login, business_time, shift_date)
     VALUES ($1, $2, $3, $4, $5, 1, 'workbench', 'submitted', 'auto_approved', $6, 'admin',
       '2026-10-28T02:00:00Z', '2026-10-28')`,
    [enterpriseId, szPlantId, session.id, orderB.id, orderB.operations.get(1)!, adminId],
  )

  // ---- 库存单元 + 批次（0004）：在库 / 已发运（圈定分桶） ----
  const lotId = (
    await pool.query<{ id: string }>(
      `INSERT INTO material_lot
         (enterprise_id, plant_id, lot_no, kind, material_id, material_code, business_time, created_by)
       VALUES ($1, $2, $3, 'production', $4, $5, '2026-10-20T00:00:00Z', 'seed-spc') RETURNING id`,
      [enterpriseId, szPlantId, FIXTURE_CODES.lot, materialId, FIXTURE_CODES.material],
    )
  ).rows[0]!.id
  const uomId = '33333333-3333-4333-8333-3333333333c1'
  const insertUnit = async (unitNo: string, status: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO inventory_unit
           (enterprise_id, plant_id, unit_no, material_id, material_code, lot_id, uom_id, uom_code,
            trace_mode, status, business_time, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'KG', 'quantity', $8, '2026-10-20T00:00:00Z', 'seed-spc')
         RETURNING id`,
        [enterpriseId, szPlantId, unitNo, materialId, FIXTURE_CODES.material, lotId, uomId, status],
      )
    ).rows[0]!.id
  const unitStockId = await insertUnit(FIXTURE_CODES.unitStock, 'in_stock')
  const unitShippedId = await insertUnit(FIXTURE_CODES.unitShipped, 'shipped')

  // ---- 检验单 + 实测结果（0009：人工样本引用来源；一单挂 MO-B 在制、一单挂 MO-C 已发运） ----
  const insertInspection = async (
    orderNo: string,
    unitId: string,
    unitNo: string,
    productionOrderNo: string,
  ): Promise<{ orderId: string; resultId: string; orderNo: string }> => {
    const io = (
      await pool.query<{ id: string; order_no: string }>(
        `INSERT INTO quality_inspection_order
           (order_no, source_type, source_ref, inspection_stage, spec_code, spec_version,
            inventory_unit_id, unit_no, material_id, material_code, lot_id, quantity, uom_id, uom_code,
            status, production_order_no, plant_id, enterprise_id, created_by)
         VALUES ($1, 'work_report', $2, 'process', 'INS-CABLE', 3, $3, $4, $5, $6, $7, 100.0000, $8, 'KG',
           'concluded', $9, $10, $11, 'seed-spc') RETURNING id, order_no`,
        [
          `INS-${orderNo}`,
          `report-${orderNo}`,
          unitId,
          unitNo,
          materialId,
          FIXTURE_CODES.material,
          lotId,
          uomId,
          productionOrderNo,
          szPlantId,
          enterpriseId,
        ],
      )
    ).rows[0]!
    const tr = (
      await pool.query<{ id: string }>(
        `INSERT INTO quality_test_result
           (inspection_order_id, version, conclusion, items, result_kind, is_effective, inspector, inspected_at, created_by)
         VALUES ($1, 1, 'qualified', $2::jsonb, 'test', true, 'szqc01', '2026-10-25T08:00:00Z', 'seed-spc')
         RETURNING id`,
        [io.id, JSON.stringify([{ itemNo: 'OD-01', measuredValue: '2.0500', judgement: 'pass' }])],
      )
    ).rows[0]!
    return { orderId: io.id, resultId: tr.id, orderNo: io.order_no }
  }
  const insStock = await insertInspection('STK', unitStockId, FIXTURE_CODES.unitStock, FIXTURE_CODES.orderB)
  const insShipped = await insertInspection('SHP', unitShippedId, FIXTURE_CODES.unitShipped, FIXTURE_CODES.orderC)

  return {
    szPlantId,
    enterpriseId,
    productFamilyId,
    oldSpecRevisionId,
    newSpecRevisionId,
    orderA: { id: orderA.id, orderNo: orderA.orderNo, operationId: orderA.operations.get(1)! },
    orderB: {
      id: orderB.id,
      orderNo: orderB.orderNo,
      reportedOperationId: orderB.operations.get(1)!,
      unreportedOperationId: orderB.operations.get(2)!,
    },
    orderC: { id: orderC.id, orderNo: orderC.orderNo, operationId: orderC.operations.get(1)! },
    testResultStock: {
      resultId: insStock.resultId,
      inspectionOrderNo: insStock.orderNo,
      unitId: unitStockId,
      unitNo: FIXTURE_CODES.unitStock,
      lotNo: FIXTURE_CODES.lot,
    },
    testResultShipped: {
      resultId: insShipped.resultId,
      inspectionOrderNo: insShipped.orderNo,
      unitId: unitShippedId,
      unitNo: FIXTURE_CODES.unitShipped,
      lotNo: FIXTURE_CODES.lot,
    },
    equipmentId,
    uomId,
  }
}

/** 取组织节点 id（按 code）。 */
export async function spcNodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}
