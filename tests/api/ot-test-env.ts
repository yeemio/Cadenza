import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'
// 0017 未注册共享 registry（L0 整合步统一注册）：测试程序式应用（源码相对导入）。
import { migration0017 } from '../../packages/persistence/src/migrations/0017-ot-collection'

/**
 * ot 测试环境：容器内独立数据库 cadenza_p3a（与共享 dev 库及其它线独立库隔离）。
 * 每轮先 DROP 再 CREATE；迁移 = 注册表（0001–0010，随 L0 整合动态）+ 本块 0017。
 */

export const OT_TEST_DB_NAME = 'cadenza_p3a'

export function otDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${OT_TEST_DB_NAME}`)
}

/** 重建测试库（PG13+ WITH (FORCE)）。 */
export async function ensureOtTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${OT_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${OT_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（注册表 + 0017）+ org 种子 + ot 授权 + 主数据夹具。 */
export async function prepareOtTestDatabase(): Promise<pg.Pool> {
  await ensureOtTestDatabase()
  const pool = createPool(otDatabaseUrl(), { max: 4 })
  // [L0-整合标记] 0017 已注册共享 registry（2026-10-28）：去重防 schema_migrations 主键冲突（csw/cost 同款防护）。
  const all = [...migrations, migration0017].filter(
    (m, i, list) => list.findIndex((x) => x.version === m.version) === i,
  )
  await migrateUp(pool, all)
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantOtPermissions(pool)
  lastFixtures = await seedOtFixtures(pool)
  return pool
}

let lastFixtures: OtFixtures | null = null

/** 最近一次 prepareOtTestDatabase 的夹具（集成测试直接取用）。 */
export function otFixtures(): OtFixtures {
  if (lastFixtures === null) throw new Error('夹具未初始化：先调用 prepareOtTestDatabase')
  return lastFixtures
}

/**
 * 授予采集许可（幂等合并）：
 * - sysadmin（华东企业范围）：ot.read/post；
 * - plantadmin（合肥厂 plant 范围）：ot.read（跨厂 403 与列表过滤证据）。
 */
export async function grantOtPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-ot')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-ot'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', ['ot.read', 'ot.post'])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['ot.read'])
}

/** 主数据夹具（0003 表：单位/工作中心/设备；0005/0008：生产订单+报工会话供 OT-13 关联）。 */
export interface OtFixtures {
  szPlantId: string
  enterpriseId: string
  uomId: string
  /** 正常设备（equipment_status=1） */
  equipmentId: string
  equipmentCode: string
  /** 维修中设备（equipment_status=2，OT-21 坏点源） */
  repairEquipmentId: string
  repairEquipmentCode: string
  /** 报工会话 1（开放中，覆盖 sessionAnchorIso 起） */
  session1Id: string
  /** 报工会话 2（已提交，覆盖 sessionAnchorIso−1h ～ sessionAnchorIso+30min；与会话 1 重叠制造 pending_confirm） */
  session2Id: string
  /**
   * 会话时间锚（now−4h，动态）：会话 1 自锚起开放、会话 2 覆盖 [锚−1h, 锚+30min]，
   * 重叠窗 [锚, 锚+30min) → pending_confirm；锚+30min 起仅会话 1 → auto_bound。
   * OT-20 offset 源按 |事件时间−接收时间(墙钟)| 判定——固定历史时间戳会随墙钟推进
   * 超出设备阈值而误标时钟偏差，故时间线一律锚定最近 24h 内。
   */
  sessionAnchorIso: string
  /** 无会话设备编码（unlinked 证据） */
  noSessionEquipmentCode: string
}

const FIX = {
  uom: 'OT-UOM-M',
  workCenter: 'WC-OT-01',
  equipment: 'EQU-OT-01',
  repairEquipment: 'EQU-OT-R1',
  noSessionEquipment: 'EQU-OT-N1',
  material: 'MAT-OT-01',
  order: 'PO-OT-0001',
} as const

export async function seedOtFixtures(pool: pg.Pool): Promise<OtFixtures> {
  const szPlant = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM org_node WHERE code = 'PLNT-SZ'`,
  )
  const szPlantId = szPlant.rows[0]!.id
  const enterpriseId = szPlant.rows[0]!.enterprise_id
  const deptId = (await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'DEPT-SZ-JZ'`)).rows[0]!.id

  const uomId = (
    await pool.query<{ id: string }>(
      `INSERT INTO uom (code, name, is_custom, created_by) VALUES ('${FIX.uom}', '米(OT)', false, 'seed-ot')
       ON CONFLICT DO NOTHING RETURNING id`,
    )
  ).rows[0]!.id

  const wcId = (
    await pool.query<{ id: string }>(
      `INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, created_by)
       VALUES ($1,$2,$3,'${FIX.workCenter}','OT 采集演示工作中心','seed-ot') RETURNING id`,
      [enterpriseId, szPlantId, deptId],
    )
  ).rows[0]!.id

  const insertEquipment = async (code: string, name: string, status: 1 | 2): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO equipment (enterprise_id, plant_id, dept_id, work_center_id, code, name, equipment_status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'seed-ot') RETURNING id`,
        [enterpriseId, szPlantId, deptId, wcId, code, name, status],
      )
    ).rows[0]!.id
  const equipmentId = await insertEquipment(FIX.equipment, 'OT 采集演示设备（正常）', 1)
  const repairEquipmentId = await insertEquipment(FIX.repairEquipment, 'OT 采集演示设备（维修中）', 2)
  await insertEquipment(FIX.noSessionEquipment, 'OT 采集演示设备（无会话）', 1)

  // 生产订单 + 报工会话（OT-13：设备+时间窗匹配）
  const materialId = (
    await pool.query<{ id: string }>(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES ($1,'${FIX.material}','OT 采集演示缆料',3,'M',0,'U9','seed-ot') RETURNING id`,
      [enterpriseId],
    )
  ).rows[0]!.id
  const orderId = (
    await pool.query<{ id: string }>(
      `INSERT INTO production_order (enterprise_id, plant_id, order_no, material_id, material_snapshot,
         production_dept_id, production_qty, uom, order_status, created_by)
       VALUES ($1,$2,'${FIX.order}',$3,'{}'::jsonb,$4,1000,'M','in_progress','seed-ot') RETURNING id`,
      [enterpriseId, szPlantId, materialId, deptId],
    )
  ).rows[0]!.id
  const operator = (
    await pool.query<{ id: string; login: string }>(
      `SELECT id, login_name AS login FROM user_account WHERE login_name = 'szws01'`,
    )
  ).rows[0]!

  // 会话时间锚（now−4h，动态；理由见 OtFixtures.sessionAnchorIso 注释）
  const sessionAnchorMs = Date.now() - 4 * 3600_000
  const sessionAnchorIso = new Date(sessionAnchorMs).toISOString()
  const session2StartIso = new Date(sessionAnchorMs - 3600_000).toISOString()
  const session2EndIso = new Date(sessionAnchorMs + 30 * 60_000).toISOString()
  const sessionDate = sessionAnchorIso.slice(0, 10)

  const session1Id = (
    await pool.query<{ id: string }>(
      `INSERT INTO execution_session (enterprise_id, plant_id, order_id, source, equipment_code,
         operator_user_id, operator_login, shift_date, status, business_time, created_by)
       VALUES ($1,$2,$3,'workbench','${FIX.equipment}',$4,$5,$6,'open',$7,'seed-ot')
       RETURNING id`,
      [enterpriseId, szPlantId, orderId, operator.id, operator.login, sessionDate, sessionAnchorIso],
    )
  ).rows[0]!.id
  const session2Id = (
    await pool.query<{ id: string }>(
      `INSERT INTO execution_session (enterprise_id, plant_id, order_id, source, equipment_code,
         operator_user_id, operator_login, shift_date, status, business_time, created_by)
       VALUES ($1,$2,$3,'order','${FIX.equipment}',$4,$5,$6,'submitted',$7,'seed-ot')
       RETURNING id`,
      [enterpriseId, szPlantId, orderId, operator.id, operator.login, sessionDate, session2StartIso],
    )
  ).rows[0]!.id
  // 会话 2 已提交，结束时间固化为 锚+30min（覆盖 [锚−1h, 锚+30min]，与会话 1〔锚起，开放〕
  // 制造 锚起 30 分钟重叠窗 → pending_confirm 证据；锚+30min 起仅会话 1 → auto_bound 证据）
  await pool.query(`UPDATE execution_session SET updated_at = $1 WHERE id = $2`, [session2EndIso, session2Id])

  return {
    szPlantId,
    enterpriseId,
    uomId,
    equipmentId,
    equipmentCode: FIX.equipment,
    repairEquipmentId,
    repairEquipmentCode: FIX.repairEquipment,
    session1Id,
    session2Id,
    sessionAnchorIso,
    noSessionEquipmentCode: FIX.noSessionEquipment,
  }
}

/** 取组织节点 id（按 code）。 */
export async function nodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}
