import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { AiQueryService, AiSessionNotFoundError } from '../../packages/application/src/aiquery-service'
import type { AiQueryRepositories } from '../../packages/application/src/aiquery-repositories'
import { createPgAiQueryRepositories, seedAiQueryCapabilities } from '../../packages/persistence/src/aiquery-repositories'
import { AI_QUERY_CAPABILITY_SEEDS } from '../../packages/domain/src/aiquery'
import { AQ_TEST_DB_NAME, prepareAqTestDatabase } from '../api/aiquery-test-env'

/**
 * aiquery 服务级集成（真容器独立库 cadenza_query；直接构造 AiQueryService + Pg 仓储束，
 * 不经 HTTP——覆盖 HTTP 层难以稳定复现的语义位）：
 * - AQ-REG-10/DS-20：超时态（第七状态）——executeTimeoutMs=5ms + 延迟读面 → timeout 信封 + 审计行；
 * - AQ-AMB-02：无显式起止 → 默认最近 7 个自然日（Asia/Shanghai）+ contextEcho 回显实际起止；
 * - §3 最大查询范围：BOM 501 行 / 每料品采购行 201 → 截断 + totalKnown=false（未取全不得总结为完整总量）；
 * - AQ-REG-03：seed 幂等 + partial unique 库层双保险（同能力第二条 enabled 行被库拒绝）;
 * - AQ-S3：会话关闭后 execute → AiSessionNotFoundError（404 语义源）。
 */

let pool: pg.Pool
let repos: AiQueryRepositories
let dbAvailable = true

beforeAll(async () => {
  try {
    pool = await prepareAqTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP aiquery integration: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${AQ_TEST_DB_NAME}）。`)
    return
  }
  repos = createPgAiQueryRepositories(pool)
})

afterAll(async () => {
  if (pool) await pool.end()
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

async function openMockSession(): Promise<string> {
  const admin = await pool.query<{ id: string; enterprise_id: string }>(`SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`)
  const session = await repos.sessions.insert({
    enterpriseId: admin.rows[0]!.enterprise_id,
    userId: admin.rows[0]!.id,
    channel: 'mock',
    conversationRef: 'integration',
  })
  return session.id
}

const C1_BODY = (sessionId: string, params: Record<string, unknown>, toolCallSeq = 1) => ({
  requestId: crypto.randomUUID(),
  toolCallSeq,
  sessionId,
  capabilityId: 'aq.order-progress',
  capabilityVersion: 1,
  params,
})

describe('AQ-REG-10/DS-20：超时态（第七状态，阶段=query）', () => {
  it('executeTimeoutMs=5 + 延迟读面 → status=timeout + 落审计（result_status=timeout）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const sessionId = await openMockSession()
    const slowRepos: AiQueryRepositories = {
      ...repos,
      reads: {
        ...repos.reads,
        listOrdersByOrderNoLike: async (filter) => {
          await new Promise((resolve) => setTimeout(resolve, 80))
          return repos.reads.listOrdersByOrderNoLike(filter)
        },
      },
    }
    const service = new AiQueryService({ repos: slowRepos, now: () => new Date(), executeTimeoutMs: 5 })
    const input = C1_BODY(sessionId, { orderRef: { kind: 'orderNoLike', value: 'ORDER-AQ' } })
    const envelope = await service.execute(input)
    expect(envelope.status).toBe('timeout')
    expect(envelope.statusLabel).toBe('查询超时')
    expect(envelope.message).toContain('AQ-REG-10')
    expect(envelope.message).toContain('阶段：query')
    expect(envelope.message).toContain('未取全不得总结为完整总量')
    expect(envelope.data).toBeNull()
    expect(envelope.completeness.totalKnown).toBe(false)
    const audit = await repos.audit.findByRequestAndSeq(input.requestId, input.toolCallSeq)
    expect(audit).not.toBeNull()
    expect(audit!.resultStatus).toBe('timeout')
  })
})

describe('AQ-AMB-02：时间范围不明 → 默认最近 7 个自然日（Asia/Shanghai）并回显实际起止', () => {
  it('注入 now=2026-01-25T04:00Z（上海 12:00）→ 窗口 [上海 2026-01-19 00:00 = UTC 2026-01-18T16:00Z, now]，仅命中 QIO-AQ-2', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const sessionId = await openMockSession()
    const now = new Date('2026-01-25T04:00:00Z')
    const service = new AiQueryService({ repos, now: () => now })
    const envelope = await service.execute({
      requestId: crypto.randomUUID(),
      toolCallSeq: 1,
      sessionId,
      capabilityId: 'aq.quality',
      capabilityVersion: 1,
      params: {}, // 无显式起止 → 默认窗口
    })
    expect(envelope.status).toBe('ok_with_data')
    expect(envelope.data?.capabilityId).toBe('aq.quality')
    const quality = envelope.data as Extract<typeof envelope.data, { capabilityId: 'aq.quality' }>
    expect(quality.timeRange).toEqual({ from: '2026-01-18T16:00:00.000Z', to: '2026-01-25T04:00:00.000Z', defaultApplied: true })
    expect(quality.inspectionOrders.map((o) => o.orderNo)).toEqual(['QIO-AQ-2'])
    expect(quality.purchaseBatches).toEqual([])
    expect(envelope.contextEcho.effectiveFilters['timeRange']).toMatchObject({ defaultApplied: true })
    expect((envelope.contextEcho.notes as string[]).some((n) => n.includes('默认最近 7 个自然日'))).toBe(true)
    expect((envelope.contextEcho.notes as string[]).some((n) => n.includes('可修改后重新查询'))).toBe(true)
  })
})

describe('§3 最大查询范围：截断与总量可知性（未取全不得总结为完整总量）', () => {
  it('BOM 501 行 + 每料品采购行 201 → truncated=true / totalKnown=false / total=null + 附注', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const sessionId = await openMockSession()
    const service = new AiQueryService({ repos, now: () => new Date('2026-01-25T04:00:00Z') })
    const envelope = await service.execute({
      requestId: crypto.randomUUID(),
      toolCallSeq: 1,
      sessionId,
      capabilityId: 'aq.material-shortage',
      capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-BULK' } },
    })
    expect(envelope.status).toBe('ok_with_data')
    const shortage = envelope.data as Extract<typeof envelope.data, { capabilityId: 'aq.material-shortage' }>
    expect(shortage.lines).toHaveLength(500) // 501 → 500 截断
    expect(envelope.completeness.truncated).toBe(true)
    expect(envelope.completeness.totalKnown).toBe(false)
    expect(envelope.completeness.total).toBeNull()
    expect((envelope.contextEcho.notes as string[]).some((n) => n.includes('截断'))).toBe(true)
    const bulk = shortage.lines.find((l) => l.materialCode === 'MAT-AQ-BULK')!
    expect(bulk.purchaseLines).toHaveLength(200) // 201 → 200 截断（每料品 ≤ 200）
    expect(bulk.inTransitQty).toBe('1000.0000') // 200 × (5 − 0)
    const audit = await repos.audit.listBySession(sessionId)
    expect(audit[audit.length - 1]!.truncated).toBe(true)
  })
})

describe('AQ-REG-03：注册行 seed 幂等与 partial unique 库层双保险', () => {
  it('重复 seed 不新建行；同能力第二条 enabled 版本被库拒绝', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const ent = await pool.query<{ id: string }>(`SELECT id FROM org_node WHERE code = 'ENT-HD'`)
    const inserted = await seedAiQueryCapabilities(pool, ent.rows[0]!.id, AI_QUERY_CAPABILITY_SEEDS, 'seed-aq')
    expect(inserted).toBe(0) // 已存在的三行 DO NOTHING
    const count = (
      await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ai_capability_registry WHERE enterprise_id = $1`, [
        ent.rows[0]!.id,
      ])
    ).rows[0]!.count
    expect(Number(count)).toBe(3)
    await expect(
      pool.query(
        `INSERT INTO ai_capability_registry (enterprise_id, capability_id, version, status, definition, created_by)
         VALUES ($1, 'aq.order-progress', 9, 'enabled', '{}'::jsonb, 'test')`,
        [ent.rows[0]!.id],
      ),
    ).rejects.toThrow(/ai_capability_registry_enabled_uidx/)
  })
})

describe('AQ-S3：会话生命周期', () => {
  it('关闭会话后 execute → AiSessionNotFoundError（DS-18 404 语义源）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const sessionId = await openMockSession()
    const service = new AiQueryService({ repos, now: () => new Date() })
    const closed = await repos.sessions.close(sessionId)
    expect(closed?.status).toBe('closed')
    await expect(
      service.execute({
        requestId: crypto.randomUUID(),
        toolCallSeq: 1,
        sessionId,
        capabilityId: 'aq.order-progress',
        capabilityVersion: 1,
        params: { orderRef: { kind: 'orderNo', value: 'ORDER-AQ-1001' } },
      }),
    ).rejects.toMatchObject({ name: 'AiSessionNotFoundError' })
    expect(new AiSessionNotFoundError('x').name).toBe('AiSessionNotFoundError')
  })
})
