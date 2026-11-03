/**
 * 故障隔离证明（P4-B 硬验收门；dsh-edge.md §7-B / architecture AR-06/AR-11/AR-07）。
 *
 * 证明结构（测试内起停 apps/ai 真进程 + 生产侧 supertest 自组装对照）：
 * 1. apps/ai 进程运行中：真实生产命令路径（MasterDataModule 换算行创建命令，真容器独立库
 *    cadenza_md）与 apps/api 真实 GET /health（HealthModule+DbModule，apps/api/src/health
 *    同一控制器）行为基线采集；
 * 2. 停止 apps/ai 进程（端口拒绝=「AI 问数暂不可用」unreachable 判定源成立）后，
 *    同型生产命令与 GET /health 逐字段行为不变；
 * 3. AR-07 运行身份分离：apps/ai 进程环境携带 DATABASE_URL 时 fail-fast 拒绝启动。
 */
import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  PgCommandBus,
  PgAuditWriter,
  PgAuthSessionRepository,
  PgOrgNodeRepository,
  PgRoleRepository,
  PgScopeGrantRepository,
  PgUserAccountRepository,
} from '@cadenza/persistence'
import {
  computeActorAuthorization,
  createScryptPasswordHasher,
  login as loginUseCase,
  type CommandContext,
  type CommandTools,
} from '@cadenza/application'
import { createMasterDataCommandHandlers } from '../../packages/application/src/masterdata-handlers'
import { MasterDataQueryService } from '../../packages/application/src/masterdata-queries'
import type { MasterDataCommandTools } from '../../packages/application/src/masterdata-repositories'
import { createPgMasterDataRepositories } from '../../packages/persistence/src/masterdata-repositories'
import type { SqlClient } from '../../packages/persistence/src/sql-client'
import { DbModule } from '../../apps/api/src/db/db.module'
import { AuthModule } from '../../apps/api/src/auth/auth.module'
import { HealthModule } from '../../apps/api/src/health/health.module'
import { MasterDataModule } from '../../apps/api/src/masterdata/masterdata.module'
import { validateEnv } from '../../apps/api/src/env'
import {
  MASTERDATA_TEST_DB_NAME,
  masterdataDatabaseUrl,
  prepareMasterdataTestDatabase,
  seedMasterdataFixtures,
  grantMasterdataPermissions,
} from '../api/masterdata-test-env'
import { spawnAiRuntime, waitRefused } from './ai-runtime-spawn'
import type { SpawnedAiRuntime } from './ai-runtime-spawn'

let prodApp: INestApplication
let healthApp: INestApplication
let pool: pg.Pool
let dbAvailable = true
let materialId = ''
let adminToken = ''
let aiRuntime: SpawnedAiRuntime | null = null

beforeAll(async () => {
  try {
    pool = await prepareMasterdataTestDatabase()
    await grantMasterdataPermissions(pool)
  } catch {
    dbAvailable = false
    console.warn(`SKIP fault isolation: 数据库不可达（docker compose up -d 后重跑；独立库 ${MASTERDATA_TEST_DB_NAME}）`)
    return
  }
  const fixtures = await seedMasterdataFixtures(pool)
  materialId = fixtures.materialId

  const toolsFactory = (client: SqlClient, context: CommandContext, now: () => Date): CommandTools => {
    const org = new PgOrgNodeRepository(client)
    const users = new PgUserAccountRepository(client)
    const grants = new PgScopeGrantRepository(client)
    const tools: MasterDataCommandTools = {
      org,
      users,
      roles: new PgRoleRepository(client),
      grants,
      sessions: new PgAuthSessionRepository(client),
      audit: new PgAuditWriter(client),
      now,
      actorPermissions: async () =>
        (await computeActorAuthorization({ users, grants, org }, context.actorUserId)).permissions,
      actorDataScope: async () =>
        (await computeActorAuthorization({ users, grants, org }, context.actorUserId)).dataScope,
      masterdata: createPgMasterDataRepositories(client),
    }
    return tools
  }
  const commandBus = new PgCommandBus(pool, createMasterDataCommandHandlers(), toolsFactory, () => new Date())
  const queries = new MasterDataQueryService({ masterdata: createPgMasterDataRepositories(pool) })

  process.env['DATABASE_URL'] = masterdataDatabaseUrl()
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
      DbModule,
      AuthModule,
      MasterDataModule.register({ commandBus, queries }),
    ],
  }).compile()
  prodApp = moduleRef.createNestApplication()
  await prodApp.init()

  // 真实 GET /health 面：apps/api/src/health 同一控制器（HealthController→DbHealthService SELECT 1）
  const healthRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), DbModule, HealthModule],
  }).compile()
  healthApp = healthRef.createNestApplication()
  await healthApp.init()

  const login = await loginUseCase(
    {
      users: new PgUserAccountRepository(pool),
      org: new PgOrgNodeRepository(pool),
      sessions: new PgAuthSessionRepository(pool),
      audit: new PgAuditWriter(pool),
      hasher: createScryptPasswordHasher(),
      now: () => new Date(),
      sessionTtlMinutes: 720,
      maxLoginFailures: 5,
      lockMinutes: 15,
    },
    { loginName: 'admin', password: 'CadAdmin001', platform: 'WEB' },
  )
  adminToken = login.token
})

afterAll(async () => {
  if (aiRuntime !== null) await aiRuntime.stop()
  if (prodApp) await prodApp.close()
  if (healthApp) await healthApp.close()
  if (pool) await pool.end()
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

interface CommandEvidence {
  statusCode: number
  version: number
  conversionIdPresent: boolean
}

/** 真实生产命令路径：换算行创建（MasterData 命令面，写独立测试库 cadenza_md）。 */
async function runProductionCommand(tag: string): Promise<CommandEvidence> {
  const response = await request(prodApp.getHttpServer())
    .post('/masterdata/conversions')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ materialId, unitName: `隔离证明-${tag}`, factor: '25.5', operationId: `ai-iso-${tag}-${Date.now()}` })
  expect(response.status).toBe(201)
  return {
    statusCode: response.status,
    version: response.body.data.version as number,
    conversionIdPresent: typeof response.body.data.conversionId === 'string',
  }
}

async function healthCheck(): Promise<{ statusCode: number; status: string; db: string }> {
  const response = await request(healthApp.getHttpServer()).get('/health')
  return { statusCode: response.status, status: response.body.status as string, db: response.body.db as string }
}

describe('故障隔离证明（AR-06/AR-11：停 apps/ai 后生产命令路径与 GET /health 行为不变）', () => {
  it('核心对照：apps/ai 运行→停止，生产命令与 /health 两轮逐字段一致；ai 停机端口拒绝（unreachable 判定源）', async () => {
    if (skipIfNoDb()) return
    // 1) apps/ai 运行中的基线
    aiRuntime = await spawnAiRuntime({
      scenario: { modelSteps: [{ kind: 'answer', text: 'ok' }], queryScript: [], capabilities: { capabilities: [], unreadyTopics: [] } },
    })
    const aiHealthUp = await aiRuntime.get('/ai-runtime/health')
    expect(aiHealthUp.status).toBe(200)
    expect(aiHealthUp.body['runtime']).toEqual({ kind: 'mock', version: 'mock-1', profileRef: null })

    const commandWithAiUp = await runProductionCommand('ai-up')
    const healthWithAiUp = await healthCheck()
    expect(healthWithAiUp).toEqual({ statusCode: 200, status: 'ok', db: 'ok' })

    // 2) 停止 apps/ai 进程（SIGTERM 优雅停机）
    await aiRuntime.stop()
    expect(await waitRefused(aiRuntime.port)).toBe(true) // AI 问数入口 unreachable（降级判定成立）
    aiRuntime = null

    // 3) 停机后：同型生产命令与 /health 行为不变（命令均为 201 COMMITTED+新行；
    //    version 按 material 递增〔masterdata.conversions.nextVersion 真实语义〕，故断言连续递增而非相等）
    const commandWithAiDown = await runProductionCommand('ai-down')
    const healthWithAiDown = await healthCheck()
    expect(commandWithAiDown.statusCode).toBe(commandWithAiUp.statusCode)
    expect(commandWithAiDown.conversionIdPresent).toBe(commandWithAiUp.conversionIdPresent)
    expect(commandWithAiDown.version).toBe(commandWithAiUp.version + 1)
    expect(healthWithAiDown).toEqual(healthWithAiUp)

    // 4) 生产数据完整性：两轮命令均真实落库（AI 侧零生产写通道，两行均来自生产命令面）
    const rows = await pool.query('SELECT count(*)::int AS n FROM conversion_revision WHERE unit_name LIKE $1', ['隔离证明-%'])
    expect(rows.rows[0]?.n).toBe(2)
  })

  it('AR-07 运行身份分离：apps/ai 进程环境携带 DATABASE_URL 即拒绝启动（fail-fast 证据）', async () => {
    if (skipIfNoDb()) return
    await spawnAiRuntime({
      scenario: { modelSteps: [], queryScript: [], capabilities: { capabilities: [], unreadyTopics: [] } },
      env: { DATABASE_URL: 'postgres://should-not-exist:5432/prod' },
      expectStartupFailure: true,
    })
    // spawnAiRuntime 内部已断言：退出码非 0 且 stderr 包含 DATABASE_URL 拒绝信息
  })
})
