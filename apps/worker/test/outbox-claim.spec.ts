import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createPool, resolveDatabaseUrl } from '@cadenza/persistence'
import {
  TaskHandlerRegistry,
  buildRegistry,
  createNoopChannel,
  outboxRequestDigest,
  parseScopePlants,
  type HandlerOutcome,
  type OutboxTaskRow,
} from '../src/handlers'
import { CLAIM_LOCK_SQL, processBatch, retryDelayMs } from '../src/outbox-claim'

/**
 * T07 worker 真容器测试（docker compose up -d 后运行；容器未启动逐条 skip）：
 * - 行锁认领不重复：并发两 worker 同批认领，每行只被一个事务处理；
 * - 失败退避重试：FAILED + next_retry_at 指数退避，到期后重新认领成功收敛 DISPATCHED；
 * - NOOP_NEEDED 直通：不经 worker，落库即终态；
 * - 崩溃恢复：处理中事务被杀（模拟进程崩溃）→ 行锁释放回滚原态 → 重启重新认领；
 *   已 COMMIT 的 DISPATCHED 不再被认领；
 * - 隔离态不入常规重试：SYNC_FAILED / FAILED+next_retry_at=NULL 不被认领；
 * - 范围过滤：越厂行 SCOPE_SKIPPED 标记 FAILED+NULL 不外发，厂内行正常 DISPATCHED。
 */

const DATABASE_URL = resolveDatabaseUrl()
let pool: pg.Pool | undefined
let dbAvailable = false

beforeAll(async () => {
  const p = createPool(DATABASE_URL, { max: 4 })
  try {
    await p.query('SELECT 1')
    dbAvailable = true
    pool = p
  } catch {
    await p.end().catch(() => undefined)
    console.warn(`SKIP worker outbox 测试: 数据库不可达（${DATABASE_URL}）。请先 docker compose up -d 再重跑。`)
  }
})

afterAll(async () => {
  if (pool !== undefined) await pool.end()
})

/** 测试专用任务行（tag 唯一，避免与共享 dev 库既有数据纠缠）。 */
async function insertTask(tag: string, input: {
  taskKind?: string
  payload?: Record<string, unknown>
  status?: string
  nextRetryAt?: string | null
}): Promise<string> {
  const r = await pool!.query<{ event_id: string }>(
    `INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload, next_retry_at)
     VALUES ('worker_test', $1, $2, $3, $4::jsonb, $5) RETURNING event_id`,
    [
      `agg-${tag}`,
      input.taskKind ?? `${tag}.test-task`,
      input.status ?? 'PENDING',
      JSON.stringify(input.payload ?? { note: tag }),
      input.nextRetryAt ?? null,
    ],
  )
  return r.rows[0]!.event_id
}

async function row(eventId: string) {
  const r = await pool!.query<{
    status: string
    attempt_count: number
    next_retry_at: string | null
    last_error: string | null
    external_ref: string | null
    request_digest: string | null
  }>(
    `SELECT status, attempt_count, next_retry_at, last_error, external_ref, request_digest
     FROM outbox WHERE event_id = $1`,
    [eventId],
  )
  return r.rows[0] ?? null
}

/** 成功处理器（经 noop 通道语义：返回 DISPATCHED + 确定性摘要）。 */
function okHandler(): (r: OutboxTaskRow) => Promise<HandlerOutcome> {
  return async (r) => ({
    kind: 'DISPATCHED',
    externalRef: `noop:${r.taskKind}:${r.eventId}`,
    requestDigest: outboxRequestDigest(r),
  })
}

describe('worker outbox 处理循环（真实容器）', () => {
  it('认领 SQL 形状：FOR UPDATE SKIP LOCKED + PENDING 到期 + FAILED 已排定到期，不含隔离态', () => {
    expect(CLAIM_LOCK_SQL).toMatch(/FOR UPDATE SKIP LOCKED/)
    expect(CLAIM_LOCK_SQL).toMatch(/status = 'PENDING' AND \(next_retry_at IS NULL OR next_retry_at <= now\(\)\)/)
    expect(CLAIM_LOCK_SQL).toMatch(/status = 'FAILED' AND next_retry_at IS NOT NULL AND next_retry_at <= now\(\)/)
    // NOOP_NEEDED / SYNC_FAILED / EXTERNAL_UNKNOWN 不在认领条件中（直通/隔离态）
    expect(CLAIM_LOCK_SQL).not.toMatch(/NOOP_NEEDED/)
    expect(CLAIM_LOCK_SQL).not.toMatch(/SYNC_FAILED/)
    expect(CLAIM_LOCK_SQL).not.toMatch(/EXTERNAL_UNKNOWN/)
  })

  it('退避公式：指数增长且封顶', () => {
    expect(retryDelayMs(1, 30_000, 3_600_000)).toBe(30_000)
    expect(retryDelayMs(2, 30_000, 3_600_000)).toBe(60_000)
    expect(retryDelayMs(3, 30_000, 3_600_000)).toBe(120_000)
    expect(retryDelayMs(20, 30_000, 3_600_000)).toBe(3_600_000)
  })

  it('行锁认领不重复：并发两 worker 同行只一处理（另一 SKIP LOCKED 不认领）', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const tag = `wt-conc-${Date.now()}`
    const firstId = await insertTask(tag, { payload: { seq: 1 } })
    const secondId = await insertTask(tag, { payload: { seq: 2 } }) // created_at 晚于 firstId

    // W1 认领 firstId（limit=1）后持锁阻塞，模拟长事务窗口
    let w1Claimed = () => {}
    const claimedGate = new Promise<void>((resolve) => {
      w1Claimed = resolve
    })
    let releaseW1 = () => {}
    const holdGate = new Promise<void>((resolve) => {
      releaseW1 = resolve
    })
    const heldHandler = async (r: OutboxTaskRow): Promise<HandlerOutcome> => {
      w1Claimed() // 已进入 W1 事务（行锁持有中）
      await holdGate
      return { kind: 'DISPATCHED', externalRef: `noop:${r.eventId}`, requestDigest: outboxRequestDigest(r) }
    }
    const w1Registry = new TaskHandlerRegistry()
    w1Registry.registerPrefix('', heldHandler)
    const w1 = processBatch(pool!, { limit: 1, registry: w1Registry })

    // 等 W1 确已认领（持锁）后再起 W2：W2 须 SKIP LOCKED 跳过 firstId、只处理 secondId
    await Promise.race([claimedGate, new Promise((res) => setTimeout(res, 3000))])
    const p2 = createPool(DATABASE_URL, { max: 1 })
    const w2Registry = new TaskHandlerRegistry()
    w2Registry.registerPrefix('', okHandler())
    try {
      const w2 = await processBatch(p2, { limit: 5, registry: w2Registry })
      expect(w2.results.map((r) => r.eventId)).toEqual([secondId]) // 不含被 W1 持锁的 firstId
      expect((await row(secondId))?.status).toBe('DISPATCHED')
      releaseW1()
      const w1Result = await w1
      expect(w1Result.results.map((r) => r.eventId)).toEqual([firstId])
      // 同行只一处理：两行各 attempt_count=1、各 DISPATCHED，无重复外发
      for (const id of [firstId, secondId]) {
        const r = await row(id)
        expect(r?.status).toBe('DISPATCHED')
        expect(r?.attempt_count).toBe(1)
        expect(r?.external_ref).toContain(id) // 每行恰一次外发引用（含自身 event_id）
      }
    } finally {
      releaseW1()
      await p2.end()
    }
  })

  it('失败退避重试：首次失败 FAILED+退避，到期重试成功收敛 DISPATCHED', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const tag = `wt-retry-${Date.now()}`
    const id = await insertTask(tag, {})

    let calls = 0
    const flaky = async (r: OutboxTaskRow): Promise<HandlerOutcome> => {
      calls += 1
      if (calls === 1) return { kind: 'FAILED', error: '首次失败（测试注入）', retry: true }
      return { kind: 'DISPATCHED', externalRef: `noop:${r.eventId}`, requestDigest: outboxRequestDigest(r) }
    }
    const registry = new TaskHandlerRegistry()
    registry.register(`${tag}.test-task`, flaky)

    const first = await processBatch(pool!, { limit: 5, registry, retryBaseMs: 200, retryMaxMs: 1000 })
    expect(first.results[0]?.outcome).toBe('FAILED')
    const failedRow = await row(id)
    expect(failedRow?.status).toBe('FAILED')
    expect(failedRow?.attempt_count).toBe(1)
    expect(failedRow?.last_error).toContain('首次失败')
    expect(failedRow?.next_retry_at).not.toBeNull()

    // 未到期：认领不到
    const early = await processBatch(pool!, { limit: 5, registry })
    expect(early.claimed).toBe(0)

    // 到期后重试成功
    await pool!.query(`UPDATE outbox SET next_retry_at = now() - interval '1 second' WHERE event_id = $1`, [id])
    const second = await processBatch(pool!, { limit: 5, registry, retryBaseMs: 200, retryMaxMs: 1000 })
    expect(second.results[0]?.outcome).toBe('DISPATCHED')
    const doneRow = await row(id)
    expect(doneRow?.status).toBe('DISPATCHED')
    expect(doneRow?.attempt_count).toBe(2)
    expect(doneRow?.last_error).toBeNull()
  })

  it('NOOP_NEEDED 直通：不经 worker（认领不到、状态不变）', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const tag = `wt-noop-${Date.now()}`
    const id = await insertTask(tag, { status: 'NOOP_NEEDED' })
    const registry = new TaskHandlerRegistry()
    registry.registerPrefix('', okHandler())
    const batch = await processBatch(pool!, { limit: 10, registry })
    expect(batch.results.find((r) => r.eventId === id)).toBeUndefined()
    const r = await row(id)
    expect(r?.status).toBe('NOOP_NEEDED')
    expect(r?.attempt_count).toBe(0) // 未被 worker 触碰
  })

  it('隔离态不入常规重试：SYNC_FAILED 与 FAILED+next_retry_at=NULL 认领不到', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const tag = `wt-quar-${Date.now()}`
    const syncFailedId = await insertTask(tag, { status: 'SYNC_FAILED' })
    const quarantinedId = await insertTask(tag, { status: 'FAILED', nextRetryAt: null })
    const registry = new TaskHandlerRegistry()
    registry.registerPrefix('', okHandler())
    const batch = await processBatch(pool!, { limit: 10, registry })
    const touched = batch.results.filter((r) => r.eventId === syncFailedId || r.eventId === quarantinedId)
    expect(touched).toEqual([])
    expect((await row(syncFailedId))?.status).toBe('SYNC_FAILED')
    expect((await row(quarantinedId))?.status).toBe('FAILED')
    expect((await row(quarantinedId))?.attempt_count).toBe(0)
  })

  it('崩溃恢复：处理中杀事务 → 回滚回 PENDING 重启重认领；已 DISPATCHED 不重复处理', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const tag = `wt-crash-${Date.now()}`
    const doneId = await insertTask(tag, { payload: { seq: 'done' } })

    // 先把 doneId 正常处理掉（模拟上一轮已完成的行；此刻 crashId 尚未插入，不会被本批带走）
    const okRegistry = new TaskHandlerRegistry()
    okRegistry.registerPrefix('', okHandler())
    const pre = await processBatch(pool!, { limit: 10, registry: okRegistry })
    expect(pre.results.find((r) => r.eventId === doneId)?.outcome).toBe('DISPATCHED')

    const crashId = await insertTask(tag, { payload: { seq: 'crash' } })
    // 模拟崩溃：独立连接开事务锁行后不提交，直接关闭连接（进程被杀等效：服务端回滚、行锁释放）
    const crashClient = new pg.Client({ connectionString: DATABASE_URL })
    await crashClient.connect()
    try {
      await crashClient.query('BEGIN')
      const locked = await crashClient.query<{ event_id: string }>(CLAIM_LOCK_SQL, [10])
      const claimedIds = locked.rows.map((r) => r.event_id)
      expect(claimedIds).toContain(crashId)
    } finally {
      await crashClient.end().catch(() => undefined) // 未 COMMIT 即断开 → 回滚
    }
    // 行锁已随连接终止释放，行回到 PENDING（未完成）
    const afterCrash = await row(crashId)
    expect(afterCrash?.status).toBe('PENDING')

    // 重启后重新认领处理，收敛 DISPATCHED；已 DISPATCHED 的 doneId 不再被认领
    const recovered = await processBatch(pool!, { limit: 10, registry: okRegistry })
    expect(recovered.results.find((r) => r.eventId === crashId)?.outcome).toBe('DISPATCHED')
    expect(recovered.results.find((r) => r.eventId === doneId)).toBeUndefined()
    expect((await row(crashId))?.attempt_count).toBe(1) // 崩溃那次未落库不计尝试
    expect((await row(doneId))?.attempt_count).toBe(1) // 不重复处理
  })

  it('范围过滤：越厂行标记 FAILED+NULL 不外发，厂内行正常 DISPATCHED', async (ctx) => {
    if (!dbAvailable) return ctx.skip()
    const tag = `wt-scope-${Date.now()}`
    const szPlant = '11111111-1111-4111-8111-111111111111'
    const hfPlant = '22222222-2222-4222-8222-222222222222'
    const inScopeId = await insertTask(tag, { payload: { plantId: szPlant } })
    const outScopeId = await insertTask(tag, { payload: { plantId: hfPlant } })

    const registry = buildRegistry(createNoopChannel(), parseScopePlants(szPlant))
    const batch = await processBatch(pool!, { limit: 10, registry })

    expect(batch.results.find((r) => r.eventId === inScopeId)?.outcome).toBe('DISPATCHED')
    // SCOPE_SKIPPED 处理器结果落库为 FAILED（断言见下）
    expect(batch.results.find((r) => r.eventId === outScopeId)?.outcome).toBe('SCOPE_SKIPPED')
    const skipped = await row(outScopeId)
    expect(skipped?.status).toBe('FAILED')
    expect(skipped?.next_retry_at).toBeNull() // 隔离，不入常规重试
    expect(skipped?.last_error).toContain('scope-skip')
    expect(skipped?.external_ref).toBeNull() // 未外发
    const dispatched = await row(inScopeId)
    expect(dispatched?.status).toBe('DISPATCHED')
    expect(dispatched?.external_ref).not.toBeNull()
  })
})
