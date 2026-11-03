import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'
// 已注册进 registry（L0 整合步），不再单独追加
// import {{ {mig} }} from '../../packages/persistence/src/migrations/0006-purchase'

/**
 * purchase 测试环境：容器内独立数据库 cadenza_pur（与共享 dev 库 cadenza 隔离）。
 * 每轮先 DROP 再 CREATE（清掉上一轮业务行，保证唯一性断言干净）；迁移 = 注册表（0001–0004）
 * + 本块 0006（不注册，编程式应用——L0 整合步统一注册；并行 writer 的 0005 同样未注册，
 * 与本块无表名/迁移号冲突，跳过不影响 0006 依赖）。
 */

export const PURCHASE_TEST_DB_NAME = 'cadenza_pur'

export function purchaseDatabaseUrl(): string {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  return base.replace(/\/cadenza$/, `/${PURCHASE_TEST_DB_NAME}`)
}

/** 重建测试库（PG13+ WITH (FORCE)）。 */
export async function ensurePurchaseTestDatabase(): Promise<void> {
  const base = process.env['DATABASE_URL'] ?? 'postgres://postgres:cadenza_dev@127.0.0.1:55433/cadenza'
  const adminUrl = base.replace(/\/cadenza$/, '/postgres')
  const admin = createPool(adminUrl, { max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${PURCHASE_TEST_DB_NAME} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${PURCHASE_TEST_DB_NAME}`)
  } finally {
    await admin.end()
  }
}

/** 应用迁移（0001–0004 + 0006）+ org 种子 + 采购/库存授权 + 演示料品。 */
export async function preparePurchaseTestDatabase(): Promise<pg.Pool> {
  await ensurePurchaseTestDatabase()
  const pool = createPool(purchaseDatabaseUrl(), { max: 4 })
  await migrateUp(pool, [...migrations])
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  await grantPurchasePermissions(pool)
  await seedPurchaseMaterials(pool)
  return pool
}

/**
 * 授予采购/库存许可（幂等合并，不覆盖种子 org 权限）：
 * - sysadmin（华东企业范围）：purchase.read/post + inventory.read/post（admin 账号，质量闸门消费侧发料用）；
 * - plantadmin（合肥厂 plant 范围）：purchase.read/post（hfadmin01，跨厂 403 与列表过滤证据）。
 */
export async function grantPurchasePermissions(pool: pg.Pool): Promise<void> {
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
       VALUES ($1, 'role', $2, $3, $4, $5, 'active', 'seed-pur')
       ON CONFLICT (principal_type, principal_id, scope_type, scope_object_id) DO UPDATE SET
         permissions = (
           SELECT array_agg(DISTINCT p) FROM unnest(scope_grant.permissions || EXCLUDED.permissions) AS t(p)
         ),
         updated_at = now(),
         updated_by = 'seed-pur'`,
      [role.rows[0]!.enterprise_id, role.rows[0]!.id, permissions, scopeType, scopeObject.rows[0]!.id],
    )
  }
  await grant('sysadmin', 'enterprise', 'ENT-HD', [
    'purchase.read',
    'purchase.post',
    'inventory.read',
    'inventory.post',
  ])
  await grant('plantadmin', 'plant', 'PLNT-HF', ['purchase.read', 'purchase.post'])
}

export interface PurchaseMaterials {
  /** 免检料（qc_flag=0，原料） */
  exemptMaterialId: string
  /** 需检料（qc_flag=1，原料） */
  qcMaterialId: string
}

/** 采购演示料品（同步入口属集成块；测试直插 material 等价模拟 U9 同步写入，0003 表）。 */
export async function seedPurchaseMaterials(pool: pg.Pool): Promise<PurchaseMaterials> {
  const enterprise = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'ENT-HD'`)
  const orgScopeId = enterprise.rows[0]!.id
  const insert = async (code: string, name: string, qcFlag: number): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES ($1, $2, $3, 1, 'KG', $4, 'U9', 'seed-pur')
       ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET
         qc_flag = EXCLUDED.qc_flag, updated_at = now(), updated_by = 'seed-pur'
       RETURNING id`,
      [orgScopeId, code, name, qcFlag],
    )
    return r.rows[0]!.id
  }
  return {
    exemptMaterialId: await insert('MAT-PUR-EXEMPT', '采购演示-免检铜杆', 0),
    qcMaterialId: await insert('MAT-PUR-QC', '采购演示-需检铜杆', 1),
  }
}

/** 取组织节点 id（按 code）。 */
export async function nodeId(pool: pg.Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = $1`, [code])
  if (r.rowCount === 0) throw new Error(`测试节点缺失：${code}`)
  return r.rows[0]!.id
}
