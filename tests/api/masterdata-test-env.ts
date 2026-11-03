import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'

/**
 * 主数据测试环境：容器内独立数据库 cadenza_md（与共享 dev 库 cadenza 隔离）。
 *
 * 独立库原因：测试会创建业务行（换算/仓库/货架等），跨运行残留会破坏唯一性断言；
 * 每次运行先 DROP 再 CREATE，保证全新态。L0 整合步后 0003/0004 已入注册表，
 * migrateUp(pool, [...migrations]) 即应用全部版本。
 */

export const MASTERDATA_TEST_DB_NAME = 'cadenza_md'

export function masterdataDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${MASTERDATA_TEST_DB_NAME}`)
}

/** 重建测试库（每次运行先强制 DROP 再 CREATE，清掉上一轮测试行；PG13+ 支持 WITH (FORCE)）。 */
export async function ensureMasterdataTestDatabase(): Promise<boolean> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${MASTERDATA_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${MASTERDATA_TEST_DB_NAME}`)
    return true
  } finally {
    await admin.end()
  }
}

/** 应用注册表全部迁移（0001–0004）并播种 org 种子与主数据授权行。 */
export async function prepareMasterdataTestDatabase(): Promise<pg.Pool> {
  await ensureMasterdataTestDatabase()
  const pool = createPool(masterdataDatabaseUrl(), { max: 4 })
  await migrateUp(pool, [...migrations])
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantMasterdataPermissions(pool)
  return pool
}

/**
 * 授予主数据许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东，企业范围）：masterdata.read + masterdata.admin（admin 账号使用）；
 * - plantadmin（华东，合肥厂 plant 范围）：masterdata.read + masterdata.admin（hfadmin01 使用，
 *   用于跨厂 403 与列表过滤证据）。
 */
export async function grantMasterdataPermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-md')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-md'`,
      [
        role.rows[0]!.enterprise_id,
        role.rows[0]!.id,
        ['masterdata.read', 'masterdata.admin'],
        scopeType,
        scopeObject.rows[0]!.id,
      ],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD')
  await grant('plantadmin', 'plant', 'PLNT-HF')
}

/** 主数据演示料品（同步入口属集成块；测试直接落库等价模拟 U9 同步写入）。 */
export async function seedMasterdataFixtures(pool: pg.Pool): Promise<{ materialId: string }> {
  const enterprise = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'ENT-HD'`)
  const orgScopeId = enterprise.rows[0]!.id
  const r = await pool.query<{ id: string }>(
    `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
     VALUES ($1, 'MAT-TEST-CU', '测试铜丝', 1, 'KG', 1, 'U9', 'seed-md')
     ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET
       name = EXCLUDED.name, updated_at = now(), updated_by = 'seed-md'
     RETURNING id`,
    [orgScopeId],
  )
  return { materialId: r.rows[0]!.id }
}

/** 取组织节点 id（按 code）。 */
export async function nodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}
