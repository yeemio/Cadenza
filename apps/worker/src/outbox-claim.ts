import type pg from 'pg'
import type { HandlerOutcome, OutboxTaskRow, TaskHandlerRegistry, WorkerScope } from './handlers'
import { TASK_PLANT_SQL } from './task-scope'
import { outboxRequestDigest } from './handlers'

/**
 * T07 outbox 真实处理循环核心：
 * - 单事务内 SELECT ... FOR UPDATE SKIP LOCKED 行锁认领（多 worker 同行只一处理）；
 * - 按 task_kind 经注册表分发内部处理器；处理器结果落 0001 状态机：
 *   PENDING --成功--> DISPATCHED（attempt_count+1、external_ref/request_digest）；
 *   PENDING --失败--> FAILED + next_retry_at 指数退避（attempt_count+1、last_error）；
 *   FAILED 到期 → 重新认领重试；FAILED+next_retry_at=NULL → 隔离，不入常规重试；
 *   NOOP_NEEDED 直通（认领条件不含它，落库即终态，不经 worker）；
 *   SYNC_FAILED / EXTERNAL_UNKNOWN 为隔离态，不经 worker 常规重试（人工/API 重试端点驱动）；
 * - 崩溃恢复：认领与结果写在同一事务，进程中断即回滚——未完成行回到原态，
 *   重启后重新认领；已 COMMIT 的 DISPATCHED 行不再匹配认领条件，不重复处理。
 */

/** 认领条件：PENDING 且到期（next_retry_at 为空或已过）；FAILED 仅在已排定且到期时重试。 */
export const CLAIM_LOCK_SQL = /* sql */ `
  SELECT o.event_id, o.aggregate_type, o.aggregate_id, o.task_kind, o.payload, o.attempt_count,
         (${TASK_PLANT_SQL}) AS plant_id
  FROM outbox o
  WHERE ((o.status = 'PENDING' AND (o.next_retry_at IS NULL OR o.next_retry_at <= now()))
     OR (o.status = 'FAILED' AND o.next_retry_at IS NOT NULL AND o.next_retry_at <= now()))
    AND (${TASK_PLANT_SQL}) = ANY($2::text[])
    AND (NOT (o.payload ? 'plantId') OR o.payload->>'plantId' = (${TASK_PLANT_SQL}))
    AND EXISTS (SELECT 1 FROM org_node p WHERE p.id::text=(${TASK_PLANT_SQL}) AND p.kind='plant' AND p.status='active')
  ORDER BY o.created_at, o.event_id
  LIMIT $1
  FOR UPDATE OF o SKIP LOCKED
`

/** 指数退避：第 n 次失败后延迟 base * 2^(n-1)，封顶 max。 */
export function retryDelayMs(attemptCountAfterIncrement: number, baseMs: number, maxMs: number): number {
  const exp = Math.max(0, attemptCountAfterIncrement - 1)
  // 2^exp 溢出防护：超封顶直接取封顶
  const scaled = baseMs * 2 ** Math.min(exp, 30)
  return Math.min(scaled, maxMs)
}

export interface ProcessBatchConfig {
  limit: number
  registry: TaskHandlerRegistry
  scope?: WorkerScope
  /** 退避基值 ms（默认 30_000）。 */
  retryBaseMs?: number
  /** 退避封顶 ms（默认 3_600_000）。 */
  retryMaxMs?: number
}

export interface RowProcessResult {
  eventId: string
  taskKind: string
  outcome: HandlerOutcome['kind']
  attemptCount: number
}

export interface BatchProcessResult {
  claimed: number
  results: RowProcessResult[]
}

/**
 * 处理一批到期任务（认领→分发→落状态机→COMMIT，单事务）。
 * 返回本批逐行结果；任何行级处理器异常按 FAILED(retry=true) 落库，不中断同批其它行。
 */
export async function processBatch(pool: pg.Pool, config: ProcessBatchConfig): Promise<BatchProcessResult> {
  const scope = config.scope ?? config.registry.scope
  if (!scope || scope.plantIds.length === 0) throw new Error('Worker requires explicit nonempty WORKER_SCOPE_PLANTS; no implicit enterprise scope')
  const retryBaseMs = config.retryBaseMs ?? 30_000
  const retryMaxMs = config.retryMaxMs ?? 3_600_000
  const client = await pool.connect()
  let txOpen = true
  try {
    await client.query('BEGIN')
    const claimed = await client.query<{
      event_id: string
      aggregate_type: string
      aggregate_id: string
      task_kind: string
      payload: Record<string, unknown> | null
      attempt_count: number
      plant_id: string
    }>(CLAIM_LOCK_SQL, [config.limit, [...scope.plantIds]])

    const results: RowProcessResult[] = []
    for (const raw of claimed.rows) {
      const row: OutboxTaskRow = {
        eventId: raw.event_id,
        aggregateType: raw.aggregate_type,
        aggregateId: raw.aggregate_id,
        taskKind: raw.task_kind,
        payload: raw.payload ?? {},
        attemptCount: raw.attempt_count,
        plantId: raw.plant_id,
      }
      const handler = config.registry.resolve(row.taskKind)
      let outcome: HandlerOutcome
      if (handler === undefined) {
        // 注册表未覆盖且无回落（装配错误）：不外发，可重试（修复注册后自动恢复）
        outcome = { kind: 'FAILED', error: `无注册处理器（task_kind=${row.taskKind}）`, retry: true }
      } else {
        try {
          outcome = await handler(row)
        } catch (error) {
          outcome = {
            kind: 'FAILED',
            error: `处理器异常：${error instanceof Error ? error.message : String(error)}`,
            retry: true,
          }
        }
      }
      if (!outcome || !['DISPATCHED','NOOP_NEEDED','FAILED','SCOPE_SKIPPED','EXTERNAL_UNKNOWN'].includes(outcome.kind)) {
        outcome = { kind: 'EXTERNAL_UNKNOWN', reason: 'Handler returned no valid outcome' }
      } else if (outcome.kind === 'DISPATCHED') {
        if (outcome.externalRef?.startsWith('noop:')) outcome = { kind: 'NOOP_NEEDED', reason: 'SITE_PENDING: noop is not external confirmation' }
        else if (!outcome.externalRef?.trim() || outcome.requestDigest !== outboxRequestDigest(row)) {
          outcome = { kind: 'EXTERNAL_UNKNOWN', reason: 'Handler confirmation is not bound to the original task digest' }
        }
      }
      const attemptCount = row.attemptCount + (outcome.kind === 'SCOPE_SKIPPED' ? 0 : 1)
      await writeOutcome(client, row.eventId, attemptCount, outcome, retryBaseMs, retryMaxMs)
      results.push({ eventId: row.eventId, taskKind: row.taskKind, outcome: outcome.kind, attemptCount })
    }

    await client.query('COMMIT')
    txOpen = false
    return { claimed: claimed.rows.length, results }
  } catch (error) {
    if (txOpen) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** 处理器结果 → outbox 状态机落库（同事务）。 */
async function writeOutcome(
  client: pg.PoolClient,
  eventId: string,
  attemptCount: number,
  outcome: HandlerOutcome,
  retryBaseMs: number,
  retryMaxMs: number,
): Promise<void> {
  switch (outcome.kind) {
    case 'DISPATCHED':
      await client.query(
        `UPDATE outbox
         SET status = 'DISPATCHED', attempt_count = $2, external_ref = $3,
             request_digest = $4, last_error = NULL, next_retry_at = NULL, updated_at = now()
         WHERE event_id = $1`,
        [eventId, attemptCount, outcome.externalRef ?? null, outcome.requestDigest ?? null],
      )
      return
    case 'NOOP_NEEDED':
      await client.query(
        `UPDATE outbox
         SET status = 'NOOP_NEEDED', attempt_count = $2, last_error = $3, external_ref=NULL, request_digest=NULL,
             next_retry_at = NULL, updated_at = now()
         WHERE event_id = $1`,
        [eventId, attemptCount, outcome.reason],
      )
      return
    case 'SCOPE_SKIPPED':
      return // no status, attempt, retry, timestamp or receipt mutation
    case 'EXTERNAL_UNKNOWN':
      await client.query(`UPDATE outbox SET status='EXTERNAL_UNKNOWN', attempt_count=$2,
        last_error=$3, next_retry_at=NULL, external_ref=NULL, request_digest=NULL, updated_at=now() WHERE event_id=$1`,
      [eventId, attemptCount, outcome.reason])
      return
    case 'FAILED': {
      const delayMs = outcome.retry ? retryDelayMs(attemptCount, retryBaseMs, retryMaxMs) : null
      await client.query(
        `UPDATE outbox
         SET status = 'FAILED', attempt_count = $2, last_error = $3,
             next_retry_at = ${delayMs === null ? 'NULL' : 'now() + make_interval(secs => $4)'},
             external_ref = NULL, updated_at = now()
         WHERE event_id = $1`,
        delayMs === null ? [eventId, attemptCount, outcome.error] : [eventId, attemptCount, outcome.error, delayMs / 1000],
      )
      return
    }
  }
}
