import type pg from 'pg'
import { createPool, resolveDatabaseUrl } from '@cadenza/persistence'
import { buildRegistry, createChannel, parseScopePlants } from './handlers'
import { processBatch } from './outbox-claim'

/**
 * outbox 后台处理进程（T07 可靠派发）：
 * - 环境变量：WORKER_INTERVAL_MS（默认 5000）、WORKER_BATCH_LIMIT（默认 10）、
 *   WORKER_CHANNEL（默认 noop；真实外部接口 SITE_PENDING）、WORKER_SCOPE_PLANTS（逗号分隔
 *   工厂 id，必须显式非空）、WORKER_RETRY_BASE_MS（默认 30000）、
 *   WORKER_RETRY_MAX_MS（默认 3600000）、WORKER_ONCE（true=单批后退出，批处理/cron 模式）、
 *   DATABASE_URL；
 * - 每 tick 单事务认领一批（FOR UPDATE SKIP LOCKED）→ 注册表分发 → 落状态机；
 * - 认领失败/处理失败下轮重试；SIGINT/SIGTERM 优雅退出（停轮询、等当前批次、关池）。
 */

const intervalMs = Number(process.env['WORKER_INTERVAL_MS'] ?? 5000)
const batchLimit = Number(process.env['WORKER_BATCH_LIMIT'] ?? 10)
const channelName = process.env['WORKER_CHANNEL'] ?? 'noop'
const once = ['1', 'true', 'yes'].includes((process.env['WORKER_ONCE'] ?? '').toLowerCase())
const scope = parseScopePlants(process.env['WORKER_SCOPE_PLANTS'])
const retryBaseMs = Number(process.env['WORKER_RETRY_BASE_MS'] ?? 30_000)
const retryMaxMs = Number(process.env['WORKER_RETRY_MAX_MS'] ?? 3_600_000)

function positiveInt(value: number, fallback: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    console.warn(`[worker] ${name} 非法（${String(value)}），回落 ${String(fallback)}`)
    return fallback
  }
  return value
}

async function main(): Promise<void> {
  const safeInterval = positiveInt(intervalMs, 5000, 'WORKER_INTERVAL_MS')
  const safeLimit = positiveInt(batchLimit, 10, 'WORKER_BATCH_LIMIT')
  const safeBaseMs = positiveInt(retryBaseMs, 30_000, 'WORKER_RETRY_BASE_MS')
  const safeMaxMs = positiveInt(retryMaxMs, 3_600_000, 'WORKER_RETRY_MAX_MS')
  if (safeMaxMs < safeBaseMs) {
    console.warn('[worker] WORKER_RETRY_MAX_MS < BASE，封顶取基值')
  }
  if (scope.plantIds.length === 0) throw new Error('WORKER_SCOPE_PLANTS must name the authorized factories')
  const channel = createChannel(channelName) // 未知通道直接启动失败，不静默回落
  const registry = buildRegistry(channel, scope)
  const url = resolveDatabaseUrl()
  const pool: pg.Pool = createPool(url)

  let running = true
  let timer: NodeJS.Timeout | undefined

  const shutdown = (signal: string) => {
    if (!running) return
    running = false
    console.log(`[worker] 收到 ${signal}，优雅退出中…`)
    if (timer !== undefined) clearTimeout(timer)
    void pool
      .end()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error('[worker] 关闭连接池失败', error)
        process.exit(1)
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  console.log(
    `[worker] 启动：interval=${String(safeInterval)}ms batch=${String(safeLimit)} channel=${channel.name} ` +
      `scopePlants=${scope.plantIds.length === 0 ? '(不限)' : String(scope.plantIds.length)} ` +
      `retry=${String(safeBaseMs)}ms..${String(safeMaxMs)}ms db=${url.replace(/:[^:@/]*@/, ':***@')}`,
  )

  const tick = async (): Promise<void> => {
    if (!running) return
    try {
      const batch = await processBatch(pool, {
        limit: safeLimit,
        registry,
        scope,
        retryBaseMs: safeBaseMs,
        retryMaxMs: safeMaxMs,
      })
      if (batch.results.length > 0) {
        const byKind: Record<string, number> = {}
        for (const r of batch.results) byKind[r.outcome] = (byKind[r.outcome] ?? 0) + 1
        console.log(`[worker] 本批 ${String(batch.claimed)} 条：${JSON.stringify(byKind)}`)
      } else {
        console.log('[worker] 无到期任务')
      }
    } catch (error) {
      console.error('[worker] 批处理失败（下轮重试）', error instanceof Error ? error.message : error)
      if (once) {
        // 单批模式失败即退出非零（批处理消费者依赖退出码）
        await pool.end().catch(() => undefined)
        process.exit(1)
      }
    }
    if (once) {
      await pool.end()
      process.exit(0)
    }
    if (running) timer = setTimeout(() => void tick(), safeInterval)
  }

  await tick()
}

void main().catch((error: unknown) => {
  console.error('[worker] 启动失败', error)
  process.exit(1)
})
