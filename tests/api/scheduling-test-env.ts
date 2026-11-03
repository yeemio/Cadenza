import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'
import { migration0007 } from '../../packages/persistence/src/migrations/0007-scheduling'

/**
 * scheduling 域测试环境：容器内独立数据库 cadenza_sch（与共享 dev 库 cadenza 隔离；
 * 模式照 process-test-env：每次运行先 DROP 再 CREATE，保证全新态）。
 *
 * 0007 已由 L0 整合步（Wave5）注册进 registry；migrateUp 前按版本号防御性去重
 * （两态皆通：注册前程序式追加、注册后注册表已含——重复项会撞 schema_migrations 主键）。
 */

export const SCHEDULING_TEST_DB_NAME = 'cadenza_sch'

export function schedulingDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${SCHEDULING_TEST_DB_NAME}`)
}

/** 重建测试库（每次运行先强制 DROP 再 CREATE，清掉上一轮测试行；PG13+ 支持 WITH (FORCE)）。 */
export async function ensureSchedulingTestDatabase(): Promise<boolean> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCHEDULING_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${SCHEDULING_TEST_DB_NAME}`)
    return true
  } finally {
    await admin.end()
  }
}

/**
 * 应用全部迁移 + 本块 0007，播种 org 种子与 scheduling 授权行。
 *
 * 防御性去重：L0 整合步把 0007 注册进 registry 后，`[...migrations, migration0007]`
 * 会出现重复项（migrateUp 的 applied 快照不含执行中版本，重复 up 会报 already exists
 * ——process/purchase 测试环境在 0005/0006 注册后即因此损坏）。此处按版本号去重，
 * 注册前（程序式追加）与注册后（注册表已含）两态皆通。
 */
export async function prepareSchedulingTestDatabase(): Promise<pg.Pool> {
  await ensureSchedulingTestDatabase()
  const pool = createPool(schedulingDatabaseUrl(), { max: 4 })
  const all = [...migrations, migration0007].filter(
    (m, i, list) => list.findIndex((x) => x.version === m.version) === i,
  )
  await migrateUp(pool, all)
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantSchedulingPermissions(pool)
  return pool
}

/**
 * 授予 scheduling 许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东，企业范围）：scheduling.read + scheduling.admin（admin 账号使用）；
 * - plantadmin（华东，合肥厂 plant 范围）：scheduling.read + scheduling.admin（hfadmin01 使用，
 *   用于跨厂 403 与列表过滤证据）。
 */
export async function grantSchedulingPermissions(pool: pg.Pool): Promise<void> {
  const grant = async (roleAlias: string, scopeType: 'enterprise' | 'plant', scopeCode: string): Promise<void> => {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-sch')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-sch'`,
      [
        role.rows[0]!.enterprise_id,
        role.rows[0]!.id,
        ['scheduling.read', 'scheduling.admin'],
        scopeType,
        scopeObject.rows[0]!.id,
      ],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD')
  await grant('plantadmin', 'plant', 'PLNT-HF')
}

/** 排产测试夹具（组织节点/料品/工作中心/设备/工序主数据/订单与工序行直插）。 */
export interface SchedulingFixtureIds {
  enterpriseId: string
  szPlantId: string
  hfPlantId: string
  szDeptId: string
  hfDeptId: string
  szWorkCenterId: string
  hfWorkCenterId: string
  /** 苏州正常设备（状态 1） */
  szEquipmentAId: string
  /** 苏州维修设备（状态 2；[A3-3] 证据位） */
  szEquipmentBRepairId: string
  /** 合肥正常设备（跨厂隔离证据位） */
  hfEquipmentId: string
  operationDefinitionId: string
  /** 苏州订单 A（released，工序 1 下线 3060 / 工序 2 下线 3000） */
  orderAId: string
  orderAOp1Id: string
  orderAOp2Id: string
  /** 苏州订单 B（approved，工序 1 下线 500） */
  orderBId: string
  orderBOp1Id: string
  /** 合肥订单 C（released，工序 1 下线 800） */
  orderCId: string
  orderCOp1Id: string
}

/**
 * 排产基础夹具：料品/工作中心/设备/工序主数据/生产订单与订单工序行直插
 * （0003/0005 表等价模拟上游写入；排产槽位/产能/班次走 API 命令）。
 */
export async function seedSchedulingFixtures(pool: pg.Pool): Promise<SchedulingFixtureIds> {
  const enterprise = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'ENT-HD'`)
  const enterpriseId = enterprise.rows[0]!.id
  const nodes = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM org_node WHERE code IN ('PLNT-SZ', 'PLNT-HF', 'DEPT-SZ-JZ', 'DEPT-HF-JZ')`,
  )
  const byCode = new Map(nodes.rows.map((r) => [r.code, r.id]))
  const szPlantId = byCode.get('PLNT-SZ')!
  const hfPlantId = byCode.get('PLNT-HF')!
  const szDeptId = byCode.get('DEPT-SZ-JZ')!
  const hfDeptId = byCode.get('DEPT-HF-JZ')!

  // 料品（enterprise 级）
  const material = await pool.query<{ id: string }>(
    `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
     VALUES ($1, 'MAT-SCH-CU', '排产测试铜缆', 3, 'M', 1, 'U9', 'seed-sch')
     RETURNING id`,
    [enterpriseId],
  )

  // 工作中心（苏州/合肥各一）
  const wc = async (code: string, plantId: string, deptId: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, created_by)
       VALUES ($1, $2, $3, $4, $5, 'seed-sch')
       ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET name = EXCLUDED.name, updated_at = now()
       RETURNING id`,
      [enterpriseId, plantId, deptId, code, `${code}-排产测试`],
    )
    return r.rows[0]!.id
  }
  const szWorkCenterId = await wc('WC-SZ-SCH-01', szPlantId, szDeptId)
  const hfWorkCenterId = await wc('WC-HF-SCH-01', hfPlantId, hfDeptId)

  // 设备（苏州正常 / 苏州维修 / 合肥正常）
  const eq = async (
    code: string,
    plantId: string,
    deptId: string,
    workCenterId: string,
    status: number,
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO equipment (enterprise_id, plant_id, dept_id, work_center_id, code, name,
         equipment_status, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 'seed-sch')
       ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET
         equipment_status = EXCLUDED.equipment_status, updated_at = now()
       RETURNING id`,
      [enterpriseId, plantId, deptId, workCenterId, code, `${code}-排产测试设备`, status],
    )
    return r.rows[0]!.id
  }
  const szEquipmentAId = await eq('EQ-SZ-A', szPlantId, szDeptId, szWorkCenterId, 1)
  const szEquipmentBRepairId = await eq('EQ-SZ-B', szPlantId, szDeptId, szWorkCenterId, 2)
  const hfEquipmentId = await eq('EQ-HF-A', hfPlantId, hfDeptId, hfWorkCenterId, 1)

  // 工序主数据（苏州绞制部）
  const operation = await pool.query<{ id: string }>(
    `INSERT INTO operation_definition (enterprise_id, plant_id, dept_id, work_center_id,
       company_org_code, code, name, created_by)
     VALUES ($1, $2, $3, $4, 'ORG-SZ-JZ', 'OP-SCH-JX', '绞线', 'seed-sch')
     RETURNING id`,
    [enterpriseId, szPlantId, szDeptId, szWorkCenterId],
  )
  const operationDefinitionId = operation.rows[0]!.id

  // 生产订单 + 订单工序行
  const order = async (
    orderNo: string,
    plantId: string,
    deptId: string,
    qty: string,
    orderStatus: string,
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id,
         material_snapshot, production_dept_id, production_qty, uom, order_status,
         process_config_status, process_confirmed_at, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'M', $8, 'configured', now(), 'seed-sch')
       RETURNING id`,
      [
        enterpriseId,
        plantId,
        orderNo,
        material.rows[0]!.id,
        JSON.stringify({ code: 'MAT-SCH-CU', name: '排产测试铜缆', spec: 'YJV-3x70', color: null }),
        deptId,
        qty,
        orderStatus,
      ],
    )
    return r.rows[0]!.id
  }
  const orderOp = async (
    orderId: string,
    plantId: string,
    seq: number,
    name: string,
    offlineQty: string,
    workCenterId: string,
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, settings_version,
         execution_status, operation_definition_id, operation_code, operation_name,
         core_multiple, strand_factor, offline_qty, work_center_id, work_center_code,
         work_center_name, uom, production_dept_id, created_by)
       VALUES ($1, $2, $3, $4, 1, 'pending', $5, 'OP-SCH-JX', $6, 1, NULL, $7, $8,
         'WC-SCH', '排产测试工作中心', 'M', (SELECT dept_id FROM work_center WHERE id = $8), 'seed-sch')
       RETURNING id`,
      [enterpriseId, plantId, orderId, seq, operationDefinitionId, name, offlineQty, workCenterId],
    )
    return r.rows[0]!.id
  }

  // 苏州订单 A：released，两道工序（下线 3060 / 3000——A2-1 推导样例同口径）
  const orderAId = await order('SCH-SZ-A-001', szPlantId, szDeptId, '1000', 'released')
  const orderAOp1Id = await orderOp(orderAId, szPlantId, 1, '绞线', '3060', szWorkCenterId)
  const orderAOp2Id = await orderOp(orderAId, szPlantId, 2, '束绞', '3000', szWorkCenterId)
  // 苏州订单 B：approved，单工序（下线 500）
  const orderBId = await order('SCH-SZ-B-002', szPlantId, szDeptId, '500', 'approved')
  const orderBOp1Id = await orderOp(orderBId, szPlantId, 1, '绞线', '500', szWorkCenterId)
  // 合肥订单 C：released，单工序（下线 800；跨厂隔离证据位）
  const orderCId = await order('SCH-HF-C-003', hfPlantId, hfDeptId, '800', 'released')
  const orderCOp1Id = await orderOp(orderCId, hfPlantId, 1, '绞线', '800', hfWorkCenterId)

  return {
    enterpriseId,
    szPlantId,
    hfPlantId,
    szDeptId,
    hfDeptId,
    szWorkCenterId,
    hfWorkCenterId,
    szEquipmentAId,
    szEquipmentBRepairId,
    hfEquipmentId,
    operationDefinitionId,
    orderAId,
    orderAOp1Id,
    orderAOp2Id,
    orderBId,
    orderBOp1Id,
    orderCId,
    orderCOp1Id,
  }
}

/** 取组织节点 id（按 code）。 */
export async function schNodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}
