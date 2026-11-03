import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'

/**
 * conversionform（T16 两种形态转换）测试环境：容器内独立数据库 cadenza_conversion
 * （与共享 dev 库 cadenza、并行 writer 独立库 cadenza_shp/cadenza_exe/cadenza_qw 等隔离）。
 * 每轮先 DROP 再 CREATE；迁移 = 注册表（L0 整合步 2026-10-28 已注册 0012）。
 *
 * 夹具事实链：
 * - 生产订单（0005）两枚 = 协议A转换前/后锚点；码归属经 0008 execution_session →
 *   production_report → report_output(stock_unit_id) 建立（conversion 只读反查）；
 * - 库存单元经真实命令链 inventory.receive-goods 入库（specs 内执行，本文件不持命令总线）；
 * - 仓库两型：WAREHOUSE（协议B可选源/收货位）与 LINE_SIDE（FC-17 拒收证据）。
 */

export const CV_TEST_DB_NAME = 'cadenza_conversion'

export function cvDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${CV_TEST_DB_NAME}`)
}

/** 重建测试库（每轮 DROP+CREATE；PG13+ WITH (FORCE)）。 */
export async function ensureCvTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${CV_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${CV_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（注册表全量，L0 已注册 0012）+ org 种子 + conversion 授权 + 主数据夹具。 */
export async function prepareCvTestDatabase(): Promise<pg.Pool> {
  await ensureCvTestDatabase()
  const pool = createPool(cvDatabaseUrl(), { max: 4 })
  await migrateUp(pool, [...migrations]) // L0 整合步（P2 批次）已注册 0012——注册表口径
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantCvPermissions(pool)
  await seedCvFixtures(pool)
  return pool
}

/**
 * 授予形态转换许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东企业范围，admin 账号）：conversion.read/post + inventory.read/post/reserve
 *   （扫码锁定与源库存预留需要 inventory 命令面；协议A/协议B共用同一许可面——差异在前端
 *   通道不在许可分层，FC-01/permissions.ts）；
 * - plantadmin（合肥厂 plant 范围，hfadmin01）：conversion.read（跨厂 403 与列表过滤证据）。
 */
export async function grantCvPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-cv')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-cv'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', [
    'conversion.read',
    'conversion.post',
    'inventory.read',
    'inventory.post',
    'inventory.reserve',
  ])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['conversion.read'])
}

/** 取组织节点 id（按 code）。 */
export async function nodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}

/** 库存侧测试常量（所有者/单位；uuid 占位同 execution/inventory 测试口径）。 */
export const CV_OWNER_ID = '22222222-2222-4222-8222-222222222201'
export const CV_OWNER_NAME = '华东电缆集团（自有）'
export const CV_UOM_ID = '33333333-3333-4333-8333-3333333333c1'
export const CV_UOM = 'KG'

export interface CvFixtures {
  enterpriseId: string
  szPlantId: string
  szJzDeptId: string
  /** 成品缆料（material_type=3；协议A锚点同料品 + 协议B 成品校验共用）。 */
  materialId: string
  /** 仓库型仓 + 库位（协议B 可选源；收货位）。 */
  warehouseId: string
  warehouseLocationId: string
  warehouseLocationCode: string
  /** 线边仓 + 库位（FC-17 仓库类型=仓库拒收证据）。 */
  lineSideLocationId: string
  lineSideLocationCode: string
  /** 工作中心/工序定义（0005 order_operation FK 依赖）。 */
  workCenterId: string
  operationDefinitionId: string
}

const FIXTURE_CODES = {
  material: 'MAT-CV-FIN',
  warehouse: '9301',
  warehouseLocation: '93010101',
  lineSideWarehouse: '9302',
  lineSideLocation: '93020101',
} as const

/** 主数据夹具（0003 表：成品缆料、仓库型仓/线边仓与库位）。 */
export async function seedCvFixtures(pool: pg.Pool): Promise<CvFixtures> {
  const enterprise = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'ENT-HD'`)
  const enterpriseId = enterprise.rows[0]!.id
  const szPlantId = await nodeId(pool, 'PLNT-SZ')
  const szJzDeptId = await nodeId(pool, 'DEPT-SZ-JZ')

  const material = await pool.query<{ id: string }>(
    `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
     VALUES ($1, $2, '形态转换测试-成品缆', 3, 'KG', 0, 'U9', 'seed-cv')
     ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET
       name = EXCLUDED.name, updated_at = now(), updated_by = 'seed-cv'
     RETURNING id`,
    [enterpriseId, FIXTURE_CODES.material],
  )

  const insertWarehouse = async (code: string, name: string, warehouseType: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, ARRAY[1,2,3]::smallint[], 'seed-cv')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-cv'
       RETURNING id`,
      [enterpriseId, szPlantId, szJzDeptId, code, name, warehouseType],
    )
    return r.rows[0]!.id
  }
  const warehouseId = await insertWarehouse(FIXTURE_CODES.warehouse, '形态转换测试仓库', 'WAREHOUSE')
  await insertWarehouse(FIXTURE_CODES.lineSideWarehouse, '形态转换测试线边仓', 'LINE_SIDE')

  const insertLocation = async (code: string, warehouseId: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, location_kind, code, created_by)
       VALUES ($1, $2, $3, 'NORMAL', $4, 'seed-cv')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-cv'
       RETURNING id`,
      [enterpriseId, szPlantId, warehouseId, code],
    )
    return r.rows[0]!.id
  }
  const warehouseLocationId = await insertLocation(FIXTURE_CODES.warehouseLocation, warehouseId)
  const lineSideLocationId = await insertLocation(FIXTURE_CODES.lineSideLocation, (
    await pool.query<{ id: string }>(`SELECT id FROM warehouse WHERE plant_id = $1 AND code = $2`, [
      szPlantId,
      FIXTURE_CODES.lineSideWarehouse,
    ])
  ).rows[0]!.id)

  // 工作中心 + 工序定义（0005 order_operation 的 FK 依赖；报工链夹具共用）
  const workCenter = await pool.query<{ id: string }>(
    `INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, created_by)
     VALUES ($1, $2, $3, 'CV-WC-01', '形态转换演示工作中心', 'seed-cv')
     ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-cv'
     RETURNING id`,
    [enterpriseId, szPlantId, szJzDeptId],
  )
  const operationDefinition = await pool.query<{ id: string }>(
    `INSERT INTO operation_definition (enterprise_id, plant_id, dept_id, work_center_id,
       company_org_code, code, name, created_by)
     VALUES ($1, $2, $3, $4, 'ORG-CV', 'CV-OP-01', '形态转换演示工序', 'seed-cv')
     ON CONFLICT (company_org_code, code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-cv'
     RETURNING id`,
    [enterpriseId, szPlantId, szJzDeptId, workCenter.rows[0]!.id],
  )

  return {
    enterpriseId,
    szPlantId,
    szJzDeptId,
    materialId: material.rows[0]!.id,
    warehouseId,
    warehouseLocationId,
    warehouseLocationCode: FIXTURE_CODES.warehouseLocation,
    lineSideLocationId,
    lineSideLocationCode: FIXTURE_CODES.lineSideLocation,
    workCenterId: workCenter.rows[0]!.id,
    operationDefinitionId: operationDefinition.rows[0]!.id,
  }
}

/**
 * 直落一枚生产订单（0005，协议A转换前后锚点；带销售单号/行号供 FC-05 明细事实比对）。
 * 同步落一道工序行（0008 报工链 FK 依赖）。
 */
export async function seedProductionOrder(
  pool: pg.Pool,
  fx: CvFixtures,
  input: { orderNo: string; salesOrderNo: string | null; lineNo: string | null; orderStatus?: string },
): Promise<{ orderId: string; operationId: string }> {
  const order = await pool.query<{ id: string }>(
    `INSERT INTO production_order (enterprise_id, plant_id, order_no, sales_order_no, line_no, material_id,
       production_dept_id, production_qty, uom, order_status, process_config_status, process_confirmed_at,
       actual_start_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1000.0000, 'KG', $8, 'configured', now(), now(), 'seed-cv')
     RETURNING id`,
    [
      fx.enterpriseId,
      fx.szPlantId,
      input.orderNo,
      input.salesOrderNo,
      input.lineNo,
      fx.materialId,
      fx.szJzDeptId,
      input.orderStatus ?? 'in_progress',
    ],
  )
  const orderId = order.rows[0]!.id
  const op = await pool.query<{ id: string }>(
    `INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, operation_definition_id,
       operation_code, operation_name, core_multiple, offline_qty, work_center_id, work_center_code,
       work_center_name, uom, production_dept_id, created_by)
     VALUES ($1, $2, $3, 1, $4, 'CV-OP-01', '形态转换演示工序', 1, 0, $5, 'CV-WC-01',
       '形态转换演示工作中心', 'KG', $6, 'seed-cv')
     RETURNING id`,
    [fx.enterpriseId, fx.szPlantId, orderId, fx.operationDefinitionId, fx.workCenterId, fx.szJzDeptId],
  )
  return { orderId, operationId: op.rows[0]!.id }
}

/**
 * 建立码归属事实（0008 报工链）：execution_session → production_report → report_output
 * (stock_unit_id = 库存单元)。conversion 协议A扫码经 findOrderForUnit 反查归属订单。
 */
export async function seedUnitOwner(
  pool: pg.Pool,
  fx: CvFixtures,
  input: { orderId: string; operationId: string; unitId: string; quantity: string },
): Promise<void> {
  const admin = await pool.query<{ id: string }>(`SELECT id FROM user_account WHERE login_name = 'admin'`)
  const session = await pool.query<{ id: string }>(
    `INSERT INTO execution_session (enterprise_id, plant_id, order_id, source, order_operation_id,
       operation_seq, operator_user_id, operator_login, shift_date, status, business_time, created_by)
     VALUES ($1, $2, $3, 'order', $4, 1, $5, 'admin', CURRENT_DATE, 'submitted', now(), 'seed-cv')
     RETURNING id`,
    [fx.enterpriseId, fx.szPlantId, input.orderId, input.operationId, admin.rows[0]!.id],
  )
  const report = await pool.query<{ id: string }>(
    `INSERT INTO production_report (enterprise_id, plant_id, session_id, order_id, order_operation_id,
       operation_seq, source, status, operator_user_id, operator_login, business_time, shift_date, created_by)
     VALUES ($1, $2, $3, $4, $5, 1, 'order', 'submitted', $6, 'admin', now(), CURRENT_DATE, 'seed-cv')
     RETURNING id`,
    [fx.enterpriseId, fx.szPlantId, session.rows[0]!.id, input.orderId, input.operationId, admin.rows[0]!.id],
  )
  await pool.query(
    `INSERT INTO report_output (enterprise_id, plant_id, report_id, line_no, quantity, qualified_qty,
       uom_id, uom_code, target_location_id, target_location_code, owner_id, owner_name, stock_unit_id, created_by)
     VALUES ($1, $2, $3, 1, $4, $4, $5, 'KG', $6, $7, $8, $9, $10, 'seed-cv')`,
    [
      fx.enterpriseId,
      fx.szPlantId,
      report.rows[0]!.id,
      input.quantity,
      CV_UOM_ID,
      fx.warehouseLocationId,
      fx.warehouseLocationCode,
      CV_OWNER_ID,
      CV_OWNER_NAME,
      input.unitId,
    ],
  )
}

/**
 * 托盘绑定（0004 carrier + carrier_binding；IT-03 单载具单单元——一托绑一单元）：
 * 有托单元在 FC-17 候选源按托汇总一行（产品轴号 `-`、axisCount=分段轴数）。
 */
export async function seedPalletBinding(
  pool: pg.Pool,
  fx: CvFixtures,
  input: { palletCode: string; unitId: string },
): Promise<void> {
  const carrier = await pool.query<{ id: string }>(
    `INSERT INTO carrier (carrier_code, carrier_kind, plant_id, enterprise_id, created_by)
     VALUES ($1, 'tray', $2, $3, 'seed-cv') RETURNING id`,
    [input.palletCode, fx.szPlantId, fx.enterpriseId],
  )
  await pool.query(
    `INSERT INTO carrier_binding (carrier_id, unit_id, effective_from, loaded_by, plant_id, enterprise_id, created_by)
     VALUES ($1, $2, now(), 'seed-cv', $3, $4, 'seed-cv')`,
    [carrier.rows[0]!.id, input.unitId, fx.szPlantId, fx.enterpriseId],
  )
}

/** 平行轴分段（0004 material_segment）：有托单元的分段轴数（FC-17 axisCount 证据）。 */
export async function seedSegments(
  pool: pg.Pool,
  fx: CvFixtures,
  input: { unitId: string; count: number },
): Promise<void> {
  for (let seq = 1; seq <= input.count; seq += 1) {
    await pool.query(
      `INSERT INTO material_segment (unit_id, seq_no, kind, quantity, uom_id, uom_code, measurement_basis,
         plant_id, enterprise_id, created_by)
       VALUES ($1, $2, 'independent', 50.0000, $3, 'KG', 'nominal', $4, $5, 'seed-cv')`,
      [input.unitId, seq, CV_UOM_ID, fx.szPlantId, fx.enterpriseId],
    )
  }
}

/** 客户轴段占用（0004 customer_segment：FC-19 按原销售单＋行号补原项目号/订单信息的来源事实）。 */
export async function seedCustomerSegment(
  pool: pg.Pool,
  fx: CvFixtures,
  input: { unitId: string; orderNo: string; customerRef: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO customer_segment (unit_id, order_no, customer_ref, plant_id, enterprise_id, created_by)
     VALUES ($1, $2, $3, $4, $5, 'seed-cv')`,
    [input.unitId, input.orderNo, input.customerRef, fx.szPlantId, fx.enterpriseId],
  )
}
