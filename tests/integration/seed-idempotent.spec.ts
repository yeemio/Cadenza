import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher } from '@cadenza/application'

/**
 * 幂等种子实测（真容器 cadenza-dev-pg @55433）：
 * 迁移 up 后种子可重复执行——两次运行行数一致、关键行存在（不产生重复）。
 */

let pool: pg.Pool
let dbAvailable = true

beforeAll(async () => {
  pool = createPool(undefined, { max: 2 })
  try {
    await pool.query('SELECT 1')
  } catch {
    dbAvailable = false
    console.warn('SKIP seed-idempotent: 数据库不可达。请先 docker compose up -d 再重跑。')
    return
  }
  await migrateUp(pool, migrations)
})

afterAll(async () => {
  if (pool) await pool.end()
})

describe('幂等 seed（真实容器）', () => {
  it('迁移 up 后种子执行成功且关键行存在', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const counts = await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
    expect(counts.orgNodes).toBeGreaterThanOrEqual(17)
    expect(counts.roles).toBeGreaterThanOrEqual(5)
    expect(counts.users).toBeGreaterThanOrEqual(6)
    expect(counts.grants).toBeGreaterThanOrEqual(5)
    const admin = await pool.query(`SELECT login_name, plant_id FROM user_account WHERE login_name = 'admin'`)
    expect(admin.rowCount).toBe(1)
  })

  it('重复执行收敛同一状态（行数不变、无重复行）', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const first = await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
    const second = await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
    expect(second).toEqual(first)

    const dupNodes = await pool.query(
      `SELECT code, count(*)::int AS n FROM org_node WHERE status = 'active' GROUP BY code HAVING count(*) > 1`,
    )
    expect(dupNodes.rowCount).toBe(0)
    const dupUsers = await pool.query(
      `SELECT login_name, count(*)::int AS n FROM user_account GROUP BY login_name HAVING count(*) > 1`,
    )
    expect(dupUsers.rowCount).toBe(0)
    const dupGrants = await pool.query(
      `SELECT principal_type, principal_id, scope_type, scope_object_id, count(*)::int AS n
       FROM scope_grant GROUP BY 1,2,3,4 HAVING count(*) > 1`,
    )
    expect(dupGrants.rowCount).toBe(0)
  })
})
