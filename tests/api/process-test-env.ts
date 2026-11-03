import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'
// 已注册进 registry（L0 整合步），不再单独追加
// import {{ {mig} }} from '../../packages/persistence/src/migrations/0005-process-order'

/**
 * process 域测试环境：容器内独立数据库 cadenza_proc（与共享 dev 库 cadenza 隔离；
 * 模式照 masterdata-test-env：每次运行先 DROP 再 CREATE，保证全新态）。
 *
 * 0005 未注册进 registry（派发约束）：以 migrateUp(pool, [...migrations])
 * 程序式应用（语义与注册后一致）；共享 dev 库保持 0001–0004（已核验）。
 */

export const PROCESS_TEST_DB_NAME = 'cadenza_proc'

export function processDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${PROCESS_TEST_DB_NAME}`)
}

/** 重建测试库（每次运行先强制 DROP 再 CREATE，清掉上一轮测试行；PG13+ 支持 WITH (FORCE)）。 */
export async function ensureProcessTestDatabase(): Promise<boolean> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${PROCESS_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${PROCESS_TEST_DB_NAME}`)
    return true
  } finally {
    await admin.end()
  }
}

/** 应用注册表全部迁移（0001–0004）+ 本块 0005，播种 org 种子与 process 授权行。 */
export async function prepareProcessTestDatabase(): Promise<pg.Pool> {
  await ensureProcessTestDatabase()
  const pool = createPool(processDatabaseUrl(), { max: 4 })
  await migrateUp(pool, [...migrations])
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantProcessPermissions(pool)
  return pool
}

/**
 * 授予 process 许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东，企业范围）：process.read + process.admin（admin 账号使用）；
 * - plantadmin（华东，合肥厂 plant 范围）：process.read + process.admin（hfadmin01 使用，
 *   用于跨厂 403 与列表过滤证据）。
 */
export async function grantProcessPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-proc')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-proc'`,
      [
        role.rows[0]!.enterprise_id,
        role.rows[0]!.id,
        ['process.read', 'process.admin'],
        scopeType,
        scopeObject.rows[0]!.id,
      ],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD')
  await grant('plantadmin', 'plant', 'PLNT-HF')
}

export interface ProcessFixtureIds {
  /** U9 同步占位料品（enterprise 级；测试直接落库等价模拟同步写入） */
  materialId: string
  /** 0003 工作中心表行（订单工序快照引用源） */
  szWorkCenterId: string
  hfWorkCenterId: string
  /** 苏州厂绞制车间部（工序主数据/订单生产部门） */
  szDeptId: string
  /** 苏州厂质量检验部（同厂异部门：A1-3 部门/工作中心一致性校验用） */
  szQcDeptId: string
  hfDeptId: string
}

/** 工艺/订单测试基础夹具（料品 + 工作中心行；生产订单/工艺版本走 API 命令创建）。 */
export async function seedProcessFixtures(pool: pg.Pool): Promise<ProcessFixtureIds> {
  const enterprise = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'ENT-HD'`)
  const enterpriseId = enterprise.rows[0]!.id
  const material = await pool.query<{ id: string }>(
    `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
     VALUES ($1, 'MAT-PROC-CU', '测试工艺铜缆', 3, 'M', 1, 'U9', 'seed-proc')
     ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET
       name = EXCLUDED.name, updated_at = now(), updated_by = 'seed-proc'
     RETURNING id`,
    [enterpriseId],
  )
  const ids = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM org_node WHERE code IN ('PLNT-SZ', 'PLNT-HF', 'DEPT-SZ-JZ', 'DEPT-SZ-QC', 'DEPT-HF-JZ')`,
  )
  const byCode = new Map(ids.rows.map((r) => [r.code, r.id]))
  const szPlantId = byCode.get('PLNT-SZ')!
  const hfPlantId = byCode.get('PLNT-HF')!
  const szDeptId = byCode.get('DEPT-SZ-JZ')!
  const szQcDeptId = byCode.get('DEPT-SZ-QC')!
  const hfDeptId = byCode.get('DEPT-HF-JZ')!
  // 0003 work_center 表行（苏州绞制一线/苏州质检工作中心/合肥绞制一线）
  const wc = async (code: string, plantId: string, deptId: string): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO work_center (enterprise_id, plant_id, dept_id, code, name, created_by)
       VALUES ($1, $2, $3, $4, $5, 'seed-proc')
       ON CONFLICT (code) WHERE status = 'active' DO UPDATE SET name = EXCLUDED.name, updated_at = now()
       RETURNING id`,
      [enterpriseId, plantId, deptId, code, `${code}-工艺测试`],
    )
    return r.rows[0]!.id
  }
  return {
    materialId: material.rows[0]!.id,
    szWorkCenterId: await wc('WC-SZ-PROC-01', szPlantId, szDeptId),
    hfWorkCenterId: await wc('WC-HF-PROC-01', hfPlantId, hfDeptId),
    szDeptId,
    szQcDeptId,
    hfDeptId,
  }
}

/** 取组织节点 id（按 code）。 */
export async function nodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}
