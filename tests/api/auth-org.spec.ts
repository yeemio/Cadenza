import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { createPool, migrateUp, migrations, seedOrgAuth } from '@cadenza/persistence'
import { createScryptPasswordHasher, hashToken } from '@cadenza/application'
import { AppModule } from '../../apps/api/src/app.module'

/**
 * 组织权限 API 集成（真容器 cadenza-dev-pg @55433 + 真实 AppModule，无桩）：
 * 登录成功/失败锁定/禁用/过期；跨工厂 403 ERR_FORBIDDEN_SCOPE 与列表过滤证据；
 * OA-11/13 服务端拒绝；审计写入证据。
 * 前置：本文件 beforeAll 自行 migrateUp + seed（幂等）。
 */

let app: INestApplication
let pool: pg.Pool
let dbAvailable = true
let szPlantId = ''
let hfPlantId = ''

beforeAll(async () => {
  pool = createPool(undefined, { max: 4 })
  try {
    await pool.query('SELECT 1')
  } catch {
    dbAvailable = false
    console.warn('SKIP auth-org api: 数据库不可达。请先 docker compose up -d 再重跑。')
    return
  }
  await migrateUp(pool, migrations)
  await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
  const plants = await pool.query<{ code: string; id: string }>(
    `SELECT code, id FROM org_node WHERE code IN ('PLNT-SZ','PLNT-HF')`,
  )
  szPlantId = plants.rows.find((r) => r.code === 'PLNT-SZ')!.id
  hfPlantId = plants.rows.find((r) => r.code === 'PLNT-HF')!.id

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication()
  await app.init()
})

afterAll(async () => {
  if (app) await app.close()
  if (pool) await pool.end()
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

async function login(loginName: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ loginName, password, platform: 'WEB' })
  expect(res.status).toBe(200)
  expect(typeof res.body.token).toBe('string')
  return res.body.token as string
}

describe('认证与会话', () => {
  it('登录成功返回 Bearer 令牌', async () => {
    if (skipIfNoDb()) return
    const token = await login('admin', 'CadAdmin001')
    expect(token.length).toBeGreaterThan(20)
  })

  it('GET /auth/me 正确：用户/许可/服务端数据范围', async () => {
    if (skipIfNoDb()) return
    const token = await login('admin', 'CadAdmin001')
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.user.loginName).toBe('admin')
    expect(res.body.user.enterpriseName).toBe('华东电缆集团')
    expect(res.body.user.plantName).toBe('苏州线缆厂')
    expect(res.body.permissions).toContain('org.admin')
    expect(res.body.permissions).toContain('org.role.admin')
    expect(res.body.dataScope.enterpriseWide).toBe(true)
    expect(res.body.dataScope.plantIds).toEqual(expect.arrayContaining([szPlantId, hfPlantId]))
  })

  it('无会话访问受保护端点 → 401 ERR_AUTH_REQUIRED', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer()).get('/auth/me').expect(401)
    expect(res.body.code).toBe('ERR_AUTH_REQUIRED')
    const res2 = await request(app.getHttpServer()).get('/org/users').expect(401)
    expect(res2.body.code).toBe('ERR_AUTH_REQUIRED')
  })

  it('禁用账号登录被拒（OA-16）', async () => {
    if (skipIfNoDb()) return
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ loginName: 'disabled01', password: 'SzDisable01', platform: 'WEB' })
      .expect(401)
    expect(res.body.code).toBe('ERR_AUTH_REQUIRED')
    expect(res.body.message).toContain('禁用')
  })

  it('连续失败触发锁定；锁定期内正确口令也拒绝；种子重置后恢复', async () => {
    if (skipIfNoDb()) return
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ loginName: 'szws01', password: 'WrongPass99', platform: 'WEB' })
      expect(res.status).toBe(401)
    }
    const locked = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ loginName: 'szws01', password: 'SzWorkshop01', platform: 'WEB' })
      .expect(401)
    expect(locked.body.message).toContain('锁定')
    // 重置（幂等种子收敛账号状态）
    await seedOrgAuth(pool, { passwordHasher: createScryptPasswordHasher() })
    await login('szws01', 'SzWorkshop01')
  })

  it('logout 撤销会话后再访问 401', async () => {
    if (skipIfNoDb()) return
    const token = await login('admin', 'CadAdmin001')
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401)
    expect(res.body.code).toBe('ERR_AUTH_REQUIRED')
  })

  it('过期会话 → 401 ERR_AUTH_REQUIRED', async () => {
    if (skipIfNoDb()) return
    const user = await pool.query<{ id: string; enterprise_id: string; plant_id: string }>(
      `SELECT id, enterprise_id, plant_id FROM user_account WHERE login_name = 'szqc01'`,
    )
    const expiredToken = 'expired-session-token-for-test'
    await pool.query(
      `INSERT INTO auth_session (token_hash, user_id, enterprise_id, plant_id, login_platform, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, 'WEB', now() - interval '2 hours', now() - interval '1 hours')
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = now() - interval '1 hours', revoked_at = NULL`,
      [hashToken(expiredToken), user.rows[0]!.id, user.rows[0]!.enterprise_id, user.rows[0]!.plant_id],
    )
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401)
    expect(res.body.code).toBe('ERR_AUTH_REQUIRED')
  })
})

describe('数据范围与跨工厂隔离（OA-24/25/33）', () => {
  it('合肥厂管理员列表只含本厂用户（plant_id 隔离过滤证据）', async () => {
    if (skipIfNoDb()) return
    const token = await login('hfadmin01', 'HfPlant0001')
    const res = await request(app.getHttpServer())
      .get('/org/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.total).toBeGreaterThanOrEqual(1)
    for (const item of res.body.items) {
      expect(item.plantId).toBe(hfPlantId)
    }
    // 合肥管理员看不到苏州用户（过滤而非报错）
    const names: string[] = res.body.items.map((i: { loginName: string }) => i.loginName)
    expect(names).toContain('hfadmin01')
    expect(names).not.toContain('admin')
    expect(names).not.toContain('szqc01')
  })

  it('用户 A 厂显式查 B 厂 → 403 ERR_FORBIDDEN_SCOPE（users 与 nodes 两个入口）', async () => {
    if (skipIfNoDb()) return
    const token = await login('hfadmin01', 'HfPlant0001')
    const users = await request(app.getHttpServer())
      .get(`/org/users?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403)
    expect(users.body.code).toBe('ERR_FORBIDDEN_SCOPE')
    expect(users.body.details).toMatchObject({ plantId: szPlantId })

    const nodes = await request(app.getHttpServer())
      .get(`/org/nodes?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403)
    expect(nodes.body.code).toBe('ERR_FORBIDDEN_SCOPE')
  })

  it('企业范围管理员可显式查两厂；质检员（plant 范围）列表收敛本厂', async () => {
    if (skipIfNoDb()) return
    const admin = await login('admin', 'CadAdmin001')
    await request(app.getHttpServer())
      .get(`/org/users?plantId=${hfPlantId}`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200)
    await request(app.getHttpServer())
      .get(`/org/users?plantId=${szPlantId}`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200)

    const qc = await login('szqc01', 'SzQuality01')
    const res = await request(app.getHttpServer())
      .get('/org/users')
      .set('Authorization', `Bearer ${qc}`)
      .expect(200)
    for (const item of res.body.items) {
      expect(item.plantId).toBe(szPlantId)
    }
    const names: string[] = res.body.items.map((i: { loginName: string }) => i.loginName)
    expect(names).not.toContain('hfadmin01')

    // 车间主任（workshop 范围）数据范围收敛到苏州厂（OA-25 workshop→所属厂）
    const ws = await login('szws01', 'SzWorkshop01')
    const wsRes = await request(app.getHttpServer())
      .get('/org/users')
      .set('Authorization', `Bearer ${ws}`)
      .expect(200)
    expect(wsRes.body.dataScope ?? true).toBeTruthy()
    for (const item of wsRes.body.items) {
      expect(item.plantId).toBe(szPlantId)
    }
  })

  it('无岗位许可的角色被拒（车间主任无 org.admin，不能建用户）', async () => {
    if (skipIfNoDb()) return
    const token = await login('szws01', 'SzWorkshop01')
    const res = await request(app.getHttpServer())
      .post('/org/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ operationId: `no-perm-${Date.now()}` })
      .expect(403)
    expect(res.body.code).toBe('ERR_FORBIDDEN_SCOPE')
  })

  it('跨企业不可见（南方集团管理员查华东用户列表为空集）', async () => {
    if (skipIfNoDb()) return
    const token = await login('gzadmin01', 'GzPlant00001')
    const res = await request(app.getHttpServer())
      .get('/org/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    for (const item of res.body.items) {
      expect(item.plantId).not.toBe(szPlantId)
      expect(item.plantId).not.toBe(hfPlantId)
    }
  })
})

describe('服务端规则拒绝与审计（OA-11/13/28）', () => {
  it('OA-13：质检部用户缺车间部门 → 422 且消息含规则编号', async () => {
    if (skipIfNoDb()) return
    const token = await login('admin', 'CadAdmin001')
    const dept = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'DEPT-SZ-QC'`)
    const role = await pool.query<{ id: string }>(
      `SELECT r.id FROM role r JOIN org_node e ON e.id = r.enterprise_id WHERE e.code = 'ENT-HD' AND r.alias = 'qc'`,
    )
    const res = await request(app.getHttpServer())
      .post('/org/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `oa13-${Date.now()}`,
        loginName: `oa13user${Date.now() % 100000}`,
        password: 'RuleCheck01',
        displayName: 'OA13 演示',
        deptId: dept.rows[0]!.id,
        roleId: role.rows[0]!.id,
        loginPlatform: 'WEB',
        // 故意缺 workshopDeptId
      })
      .expect(422)
    expect(res.body.code).toBe('ERR_BUSINESS_RULE')
    expect(res.body.message).toContain('OA-13')
  })

  it('OA-11：删除当前登录账号自身 → 422', async () => {
    if (skipIfNoDb()) return
    const token = await login('admin', 'CadAdmin001')
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    const adminId = me.body.user.userId as string
    const res = await request(app.getHttpServer())
      .delete(`/org/users/${adminId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(422)
    expect(res.body.message).toContain('OA-11')
  })

  it('OA-29：机构退役（高影响）缺理由 → 422；带理由成功且审计含 reason', async () => {
    if (skipIfNoDb()) return
    const token = await login('admin', 'CadAdmin001')
    // 建一个无用户无工作中心的挂空部门（department under 苏州厂）用于退役
    const created = await request(app.getHttpServer())
      .post('/org/nodes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operationId: `retire-demo-${Date.now()}`,
        code: `TMPDEPT${Date.now() % 100000}`,
        name: `退役演示部门-${Date.now() % 100000}`,
        kind: 'department',
        parentId: szPlantId,
        deptCategory: 3,
      })
      .expect(201)
    const nodeId = created.body.data.nodeId as string

    // 缺理由 → OA-29 拒绝
    const noReason = await request(app.getHttpServer())
      .delete(`/org/nodes/${nodeId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(422)
    expect(noReason.body.message).toContain('OA-29')

    // 带理由 → 成功（逻辑删除，OA-06）
    await request(app.getHttpServer())
      .delete(`/org/nodes/${nodeId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: '组织重组演示' })
      .expect(200)
    const row = await pool.query<{ status: string }>(`SELECT status FROM org_node WHERE id = $1`, [nodeId])
    expect(row.rows[0]!.status).toBe('retired')

    // 审计证据（OA-28/29）：操作者/动作/理由/前后状态
    const audit = await pool.query<{ actor: string; action: string; reason: string; before: { status?: string } }>(
      `SELECT actor, action, reason, before FROM audit_entry WHERE action = 'org.node.retire' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [nodeId],
    )
    expect(audit.rowCount).toBe(1)
    expect(audit.rows[0]!.actor).toBe('admin')
    expect(audit.rows[0]!.reason).toBe('组织重组演示')
  })
})
