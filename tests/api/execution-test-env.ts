import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'

/**
 * execution 域测试环境：容器内独立数据库 cadenza_exe（与共享 dev 库 cadenza、process 库
 * cadenza_proc 隔离；模式照 process-test-env：每次运行先 DROP 再 CREATE，保证全新态）。
 *
 * 0008 已由 L0 整合步（Wave5）注册进 registry：直接 migrateUp(pool, migrations)
 * 应用注册表全量（0001–0009）。曾以 [...migrations, migration0008] 程序式追加——
 * 注册后重复项会撞 schema_migrations 主键（process/purchase 先例），已收窄。
 */

export const EXECUTION_TEST_DB_NAME = 'cadenza_exe'

export function executionDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${EXECUTION_TEST_DB_NAME}`)
}

/** 重建测试库（每轮 DROP+CREATE；PG13+ WITH (FORCE)）。 */
export async function ensureExecutionTestDatabase(): Promise<boolean> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${EXECUTION_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${EXECUTION_TEST_DB_NAME}`)
    return true
  } finally {
    await admin.end()
  }
}

/** 应用注册表迁移（0001–0009，Wave5 注册后全量），播种组织种子与 execution 授权行。 */
export async function prepareExecutionTestDatabase(): Promise<pg.Pool> {
  await ensureExecutionTestDatabase()
  const pool = createPool(executionDatabaseUrl(), { max: 4 })
  await migrateUp(pool, [...migrations])
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantExecutionPermissions(pool)
  return pool
}

/**
 * 授予 execution 许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东，企业范围）：execution.read/report/review/feed/labor（admin 账号）；
 * - foreman（华东，苏州厂 plant 范围）：execution.read/report/feed/labor/review（szws01 班组长）；
 * - qc（华东，企业范围）：execution.report/read/feed/labor（szqc01 操作工口径——无 review
 *   → 查询与草稿限定本人，操作工仅自己守卫证据）。
 */
export async function grantExecutionPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-exe')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-exe'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  const all = ['execution.read', 'execution.report', 'execution.review', 'execution.feed', 'execution.labor']
  await grant('sysadmin', 'enterprise', 'ENT-HD', all)
  await grant('foreman', 'plant', 'PLNT-SZ', all)
  await grant('qc', 'enterprise', 'ENT-HD', ['execution.read', 'execution.report', 'execution.feed', 'execution.labor'])
}

/** 取组织节点 id（按 code）。 */
export async function nodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}

/**
 * 库存侧测试常量（线边库/成品线边库/非线边库位 + 所有者 + 单位；uuid 占位同 inventory 测试）。
 * D-1 修复：线边判定=库位隶属仓库类型 LINE_SIDE（主数据事实）——seedExecutionFixtures
 * 落对应 warehouse/storage_location 行（线边两个库位挂 LINE_SIDE 仓、非线边库位挂 WAREHOUSE 仓），
 * 库位码为 0003 合法 8 位数字码（仓库码 4 + 库位码 4）。
 */
export const LOC_LINE_SEMI = '11111111-1111-4111-8111-1111111111c3'
export const LOC_LINE_SEMI_CODE = '92010101'
export const LOC_LINE_FIN = '11111111-1111-4111-8111-1111111111c4'
export const LOC_LINE_FIN_CODE = '92010201'
export const LOC_NON_LINE = '11111111-1111-4111-8111-1111111111c5'
export const LOC_NON_LINE_CODE = '91010101'
export const OWNER_ID = '22222222-2222-4222-8222-222222222201'
export const OWNER_NAME = '华东电缆集团（自有）'
export const UOM_M_ID = '33333333-3333-4333-8333-3333333333c1'
export const UOM_M = 'M'

export interface ExecutionFixtureIds {
  enterpriseId: string
  szPlantId: string
  szJzDeptId: string
  szQcDeptId: string
  materialId: string
  workCenterId: string
  operationDefIds: { seq1: string; seq2: string; qcSeq3: string }
}

/** 基础夹具：料品 + 工作中心 + 工序定义（JZ 部门两道 + QC 部门一道）。 */
export async function seedExecutionFixtures(pool: pg.Pool): Promise<ExecutionFixtureIds> {
  const enterprise = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'ENT-HD'`)
  const enterpriseId = enterprise.rows[0]!.id
  const szPlantId = await nodeId(pool, 'PLNT-SZ')
  const szJzDeptId = await nodeId(pool, 'DEPT-SZ-JZ')
  const szQcDeptId = await nodeId(pool, 'DEPT-SZ-QC')
  const material = await pool.query<{ id: string }>(
    `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
     VALUES ($1, 'MAT-EXE-CU', '执行域测试铜缆', 3, 'M', 1, 'U9', 'seed-exe')
     ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET
       name = EXCLUDED.name, updated_at = now(), updated_by = 'seed-exe'
     RETURNING id`,
    [enterpriseId],
  )
  const wc = await pool.query<{ id: string }>(
    `INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, created_by)
     VALUES ($1, $2, $3, 'WC-EXE-01', '执行域测试工作中心', 'seed-exe')
     ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id`,
    [enterpriseId, szPlantId, szJzDeptId],
  )
  const opDef = async (code: string, name: string, deptId: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO operation_definition (enterprise_id, plant_id, dept_id, work_center_id,
         company_org_code, code, name, created_by)
       VALUES ($1, $2, $3, $4, 'ORG-EXE', $5, $6, 'seed-exe')
       ON CONFLICT (company_org_code, code) WHERE status = 'active' DO UPDATE SET
         name = EXCLUDED.name, updated_at = now()
       RETURNING id`,
      [enterpriseId, szPlantId, deptId, wc.rows[0]!.id, code, name],
    )
    return r.rows[0]!.id
  }

  // D-1：线边判定主数据事实（仓库类型 LINE_SIDE / WAREHOUSE + 库位行；库位 id 用测试常量固定值）
  const insertWarehouse = async (code: string, name: string, warehouseType: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'seed-exe')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now(), updated_by = 'seed-exe'
       RETURNING id`,
      [enterpriseId, szPlantId, szJzDeptId, code, name, warehouseType, warehouseType === 'LINE_SIDE' ? [1, 2, 3] : [1, 3]],
    )
    return r.rows[0]!.id
  }
  const lineSideWarehouseId = await insertWarehouse('9201', '执行域线边仓', 'LINE_SIDE')
  const normalWarehouseId = await insertWarehouse('9101', '执行域普通仓', 'WAREHOUSE')
  const insertLocation = async (id: string, code: string, warehouseId: string): Promise<void> => {
    await pool.query(
      `INSERT INTO storage_location (id, enterprise_id, plant_id, warehouse_id, location_kind, code, created_by)
       VALUES ($1, $2, $3, $4, 'NORMAL', $5, 'seed-exe')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET
         warehouse_id = EXCLUDED.warehouse_id, updated_at = now(), updated_by = 'seed-exe'`,
      [id, enterpriseId, szPlantId, warehouseId, code],
    )
  }
  await insertLocation(LOC_LINE_SEMI, LOC_LINE_SEMI_CODE, lineSideWarehouseId)
  await insertLocation(LOC_LINE_FIN, LOC_LINE_FIN_CODE, lineSideWarehouseId)
  await insertLocation(LOC_NON_LINE, LOC_NON_LINE_CODE, normalWarehouseId)

  return {
    enterpriseId,
    szPlantId,
    szJzDeptId,
    szQcDeptId,
    materialId: material.rows[0]!.id,
    workCenterId: wc.rows[0]!.id,
    operationDefIds: {
      seq1: await opDef('OP-EXE-01', '执行域拉丝', szJzDeptId),
      seq2: await opDef('OP-EXE-02', '执行域绞制', szJzDeptId),
      qcSeq3: await opDef('OP-EXE-QC', '执行域质检', szQcDeptId),
    },
  }
}

export interface OrderSeedOp {
  seq: number
  operationDefinitionId: string
  deptId: string
  offlineQty: string
}

export interface SeededOrder {
  orderId: string
  operationIds: string[]
}

/** 直落订单 + 工序行（工艺展开已完成、已开工口径；报工域行为全部走真实命令链）。 */
export async function seedOrder(
  pool: pg.Pool,
  fx: ExecutionFixtureIds,
  input: {
    orderNo: string
    plannedQty: string
    overrunRatio?: string | null
    ops: OrderSeedOp[]
    orderStatus?: string
    workCenterId?: string
  },
): Promise<SeededOrder> {
  const wcId = input.workCenterId ?? fx.workCenterId
  const order = await pool.query<{ id: string }>(
    `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, production_dept_id,
       production_qty, uom, overrun_ratio, order_status, process_config_status, process_confirmed_at,
       actual_start_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'M', $7, $8, 'configured', now(), now(), 'seed-exe')
     RETURNING id`,
    [
      fx.enterpriseId,
      fx.szPlantId,
      input.orderNo,
      fx.materialId,
      input.ops[0]!.deptId,
      input.plannedQty,
      input.overrunRatio ?? null,
      input.orderStatus ?? 'in_progress',
    ],
  )
  const orderId = order.rows[0]!.id
  const operationIds: string[] = []
  for (const op of input.ops) {
    const def = await pool.query<{ code: string; name: string }>(
      `SELECT code, name FROM operation_definition WHERE id = $1`,
      [op.operationDefinitionId],
    )
    const row = await pool.query<{ id: string }>(
      `INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, operation_definition_id,
         operation_code, operation_name, core_multiple, offline_qty, work_center_id, work_center_code,
         work_center_name, uom, production_dept_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, 'WC-EXE-01', '执行域测试工作中心', 'M', $10, 'seed-exe')
       RETURNING id`,
      [
        fx.enterpriseId,
        fx.szPlantId,
        orderId,
        op.seq,
        op.operationDefinitionId,
        def.rows[0]!.code,
        def.rows[0]!.name,
        op.offlineQty,
        wcId,
        op.deptId,
      ],
    )
    operationIds.push(row.rows[0]!.id)
  }
  return { orderId, operationIds }
}
