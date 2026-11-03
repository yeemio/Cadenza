import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'
// 0018 未注册共享 registry（L0 整合步统一注册）：测试直接消费迁移源文件编程式应用。
import { migration0018 } from '../../packages/persistence/src/migrations/0018-constrained-scheduling'

/**
 * csw 测试环境（P3-B / T22）：容器内独立数据库 cadenza_p3b（与共享 dev 库 cadenza、
 * shipping 独立库 cadenza_shp、spc 独立库 cadenza_p3c 及并行 writer 独立库隔离）。
 * 每轮先 DROP 再 CREATE；迁移 = 注册表（0001–0010）+ 本线 0018（不注册，编程式应用——
 * L0 整合步统一注册；并行 writer 的 0011–0017/0019+ 同样未注册，与本线无表名/迁移号冲突；
 * 按版本号防御性去重，注册前后两态皆通）。
 */

export const CSW_TEST_DB_NAME = 'cadenza_p3b'

export function cswDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${CSW_TEST_DB_NAME}`)
}

/** 重建测试库（PG13+ WITH (FORCE)）。 */
export async function ensureCswTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${CSW_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${CSW_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（注册表 0001–0010 + 0018，版本去重）+ org 种子 + csw 授权。 */
export async function prepareCswTestDatabase(): Promise<pg.Pool> {
  await ensureCswTestDatabase()
  const pool = createPool(cswDatabaseUrl(), { max: 4 })
  const all = [...migrations, migration0018].filter(
    (m, i, list) => list.findIndex((x) => x.version === m.version) === i,
  )
  await migrateUp(pool, all)
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantCswPermissions(pool)
  return pool
}

/**
 * 授予 csw 许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东企业范围）：csw.read/post/unfreeze + inventory.read/post（外协收货建账）
 *   + scheduling.read/admin（T09 排程底座对照）；
 * - plantadmin（合肥厂 plant 范围）：csw.read（跨厂 403 与列表过滤证据；无 csw.unfreeze——
 *   解冻具名权限证据位）。
 */
export async function grantCswPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-csw')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-csw'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', [
    'csw.read',
    'csw.post',
    'csw.unfreeze',
    'inventory.read',
    'inventory.post',
    'scheduling.read',
    'scheduling.admin',
  ])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['csw.read'])
}

/** csw 夹具（组织/主数据/订单与工序/设备/产能直插；csw 与库存事实走命令）。 */
export interface CswFixtures {
  enterpriseId: string
  szPlantId: string
  szDeptId: string
  /** 工作中心一（绞线场景：正常 A / 维修 B / 校准失效 C） */
  wc1Id: string
  /** 工作中心二（软约束容量场景：设备 D） */
  wc2Id: string
  /** 工作中心三（无解场景：维修设备 E） */
  wc3Id: string
  eqAId: string
  eqBRepairId: string
  eqCCalibId: string
  eqDId: string
  eqERepairId: string
  /** 绞线工序定义（换型维度值 JX） */
  opDefJxId: string
  /** 束绞工序定义（换型维度值 SJ） */
  opDefSjId: string
  /** 料品（订单/外协共用） */
  materialId: string
  /** ORD-1（束绞，due T+3，offline 300） */
  order1Id: string
  order1OpId: string
  /** ORD-2（绞线，due T+1 更紧迫，offline 200） */
  order2Id: string
  order2OpId: string
  /** ORD-3（已开工工序，offline 500 无槽位→余量冲突须人工决策） */
  order3Id: string
  order3OpId: string
  /** ORD-4（外协占用场景，offline 100） */
  order4Id: string
  order4OpId: string
  /** ORD-5（软约束容量场景：束绞 offline 150，due T+2） */
  order5Id: string
  order5OpId: string
  /** ORD-6（无解场景：绞线 offline 80，due T+2） */
  order6Id: string
  order6OpId: string
  /** 外协在途位 / 回厂待检位（普通 NORMAL 库位，9211 外协仓） */
  transitLocationId: string
  transitLocationCode: string
  returnLocationId: string
  returnLocationCode: string
  /** 收货库位（外协测试建账用） */
  stockLocationId: string
  stockLocationCode: string
}

/**
 * 直插夹具（0003/0005/0007 表等价模拟上游写入；today 为引擎确定性锚点）。
 * 产能行：A 全窗口 1000（无软约束基线）；D 全窗口 100（软约束证据）。
 */
export async function seedCswFixtures(pool: pg.Pool, today: string): Promise<CswFixtures> {
  const shift = (date: string, days: number): string => {
    const next = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    return next.toISOString().slice(0, 10)
  }
  const enterprise = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'ENT-HD'`)
  const enterpriseId = enterprise.rows[0]!.id
  const nodes = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM org_node WHERE code IN ('PLNT-SZ', 'DEPT-SZ-JZ')`,
  )
  const byCode = new Map(nodes.rows.map((r) => [r.code, r.id]))
  const szPlantId = byCode.get('PLNT-SZ')!
  const szDeptId = byCode.get('DEPT-SZ-JZ')!

  const material = (
    await pool.query<{ id: string }>(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES ($1, 'MAT-CSW-CU', '排程外协测试铜缆', 3, 'M', 1, 'U9', 'seed-csw') RETURNING id`,
      [enterpriseId],
    )
  ).rows[0]!.id

  const wc = async (code: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, created_by)
       VALUES ($1, $2, $3, $4, $5, 'seed-csw')
       ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET name = EXCLUDED.name, updated_at = now()
       RETURNING id`,
      [enterpriseId, szPlantId, szDeptId, code, `${code}-排程外协测试`],
    )
    return r.rows[0]!.id
  }
  const wc1Id = await wc('WC-SZ-CSW-01')
  const wc2Id = await wc('WC-SZ-CSW-02')
  const wc3Id = await wc('WC-SZ-CSW-03')

  const eq = async (code: string, workCenterId: string, status: number): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO equipment (enterprise_id, plant_id, dept_id, work_center_id, code, name,
         equipment_status, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 'seed-csw')
       ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET
         equipment_status = EXCLUDED.equipment_status, updated_at = now()
       RETURNING id`,
      [enterpriseId, szPlantId, szDeptId, workCenterId, code, `${code}-排程外协测试设备`, status],
    )
    return r.rows[0]!.id
  }
  const eqAId = await eq('EQ-CSW-A', wc1Id, 1)
  const eqBRepairId = await eq('EQ-CSW-B', wc1Id, 2)
  const eqCCalibId = await eq('EQ-CSW-C', wc1Id, 1)
  const eqDId = await eq('EQ-CSW-D', wc2Id, 1)
  const eqERepairId = await eq('EQ-CSW-E', wc3Id, 2)

  const opDef = async (code: string, name: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO operation_definition (enterprise_id, plant_id, dept_id, work_center_id,
         company_org_code, code, name, created_by)
       VALUES ($1, $2, $3, $4, 'ORG-SZ-JZ', $5, $6, 'seed-csw') RETURNING id`,
      [enterpriseId, szPlantId, szDeptId, wc1Id, code, name],
    )
    return r.rows[0]!.id
  }
  const opDefJxId = await opDef('OP-CSW-JX', '绞线')
  const opDefSjId = await opDef('OP-CSW-SJ', '束绞')

  const order = async (
    orderNo: string,
    plannedFinish: string | null,
    qty: string,
    orderStatus = 'released',
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id,
         material_snapshot, production_dept_id, production_qty, uom, order_status,
         process_config_status, process_confirmed_at, planned_finish_at, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'M', $8, 'configured', now(), $9::timestamptz, 'seed-csw')
       RETURNING id`,
      [
        enterpriseId,
        szPlantId,
        orderNo,
        material,
        JSON.stringify({ code: 'MAT-CSW-CU', name: '排程外协测试铜缆', spec: 'YJV-3x70', materialId: material }),
        szDeptId,
        qty,
        orderStatus,
        plannedFinish,
      ],
    )
    return r.rows[0]!.id
  }
  const orderOp = async (
    orderId: string,
    opDefId: string,
    opCode: string,
    name: string,
    offlineQty: string,
    workCenterId: string,
    executionStatus: 'pending' | 'executed' = 'pending',
  ): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO order_operation (enterprise_id, plant_id, order_id, seq, settings_version,
         execution_status, operation_definition_id, operation_code, operation_name,
         core_multiple, strand_factor, offline_qty, work_center_id, work_center_code,
         work_center_name, uom, production_dept_id, created_by)
       VALUES ($1, $2, $3, 1, 1, $4, $5, $6, $7, 1, NULL, $8, $9,
         'WC-CSW', '排程外协测试工作中心', 'M', (SELECT dept_id FROM work_center WHERE id = $9), 'seed-csw')
       RETURNING id`,
      [enterpriseId, szPlantId, orderId, executionStatus, opDefId, opCode, name, offlineQty, workCenterId],
    )
    return r.rows[0]!.id
  }

  const order1Id = await order('CSW-SZ-001', `${shift(today, 3)}T00:00:00Z`, '1000')
  const order1OpId = await orderOp(order1Id, opDefSjId, 'OP-CSW-SJ', '束绞', '300', wc1Id)
  const order2Id = await order('CSW-SZ-002', `${shift(today, 1)}T00:00:00Z`, '800')
  const order2OpId = await orderOp(order2Id, opDefJxId, 'OP-CSW-JX', '绞线', '200', wc1Id)
  const order3Id = await order('CSW-SZ-003', `${shift(today, 5)}T00:00:00Z`, '600')
  const order3OpId = await orderOp(order3Id, opDefJxId, 'OP-CSW-JX', '绞线', '500', wc1Id, 'executed')
  const order4Id = await order('CSW-SZ-004', `${shift(today, 7)}T00:00:00Z`, '400')
  const order4OpId = await orderOp(order4Id, opDefJxId, 'OP-CSW-JX', '绞线', '100', wc1Id)
  const order5Id = await order('CSW-SZ-005', `${shift(today, 2)}T00:00:00Z`, '300')
  const order5OpId = await orderOp(order5Id, opDefSjId, 'OP-CSW-SJ', '束绞', '150', wc2Id)
  const order6Id = await order('CSW-SZ-006', `${shift(today, 2)}T00:00:00Z`, '200')
  const order6OpId = await orderOp(order6Id, opDefJxId, 'OP-CSW-JX', '绞线', '80', wc3Id)

  // 产能行（0007 capacity_calendar 直插：A 全窗口 1000、D 全窗口 100——软约束证据位）
  const capacity = async (equipmentId: string, date: string, cap: string): Promise<void> => {
    await pool.query(
      `INSERT INTO capacity_calendar (enterprise_id, plant_id, equipment_id, production_date, capacity, uom, created_by)
       VALUES ($1, $2, $3, $4::date, $5, 'M', 'seed-csw')
       ON CONFLICT (equipment_id, production_date) DO UPDATE SET capacity = EXCLUDED.capacity`,
      [enterpriseId, szPlantId, equipmentId, date, cap],
    )
  }
  for (let i = 0; i < 10; i += 1) {
    const d = shift(today, i)
    await capacity(eqAId, d, '1000')
    await capacity(eqCCalibId, d, '500') // 产能低于 A：确定性择优（A 负载成本更低）
    await capacity(eqDId, d, '100')
  }

  // 外协仓 + 库位（9211：外协在途位 92110101 / 回厂待检位 92110102 / 收货位 92110201）
  const warehouseId = (
    await pool.query<{ id: string }>(
      `INSERT INTO warehouse (enterprise_id, plant_id, dept_id, code, name, warehouse_type, material_types, created_by)
       VALUES ($1, $2, $3, '9211', '苏州外协仓', 'WAREHOUSE', ARRAY[3]::smallint[], 'seed-csw')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, szDeptId],
    )
  ).rows[0]!.id
  const location = async (code: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO storage_location (enterprise_id, plant_id, warehouse_id, location_kind, code, created_by)
       VALUES ($1, $2, $3, 'NORMAL', $4, 'seed-csw')
       ON CONFLICT (plant_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
      [enterpriseId, szPlantId, warehouseId, code],
    )
    return r.rows[0]!.id
  }
  const transitLocationId = await location('92110101')
  const returnLocationId = await location('92110102')
  const stockLocationId = await location('92110201')

  return {
    enterpriseId,
    szPlantId,
    szDeptId,
    wc1Id,
    wc2Id,
    wc3Id,
    eqAId,
    eqBRepairId,
    eqCCalibId,
    eqDId,
    eqERepairId,
    opDefJxId,
    opDefSjId,
    materialId: material,
    order1Id,
    order1OpId,
    order2Id,
    order2OpId,
    order3Id,
    order3OpId,
    order4Id,
    order4OpId,
    order5Id,
    order5OpId,
    order6Id,
    order6OpId,
    transitLocationId,
    transitLocationCode: '92110101',
    returnLocationId,
    returnLocationCode: '92110102',
    stockLocationId,
    stockLocationCode: '92110201',
  }
}

/** 取组织节点 id（按 code）。 */
export async function cswNodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}

/** 库存所有者常量（0004 口径：owner_id 为文本 uuid，无 FK）。 */
export const CSW_OWNER_ID = '22222222-2222-4222-8222-222222222201'
export const CSW_OWNER_NAME = '华东电缆集团（自有）'
