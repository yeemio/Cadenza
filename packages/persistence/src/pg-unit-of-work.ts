import type { UnitOfWork, OutboxIntent } from '@cadenza/application'
import type pg from 'pg'
import type { SqlClient } from './sql-client'

/**
 * pg 事务工作单元（implements application UnitOfWork 端口）。
 * 一个业务命令 = 一个 UoW；collectOutbox 登记的任务在 commit 前原子写入 outbox 平台表。
 */
export class PgUnitOfWork implements UnitOfWork {
  private client: pg.PoolClient | null = null
  private readonly intents: OutboxIntent[] = []

  constructor(private readonly pool: pg.Pool) {}

  /** 当前事务客户端（须在 begin 之后使用；命令处理器内仓储绑定此客户端）。 */
  get executor(): SqlClient {
    if (this.client === null) throw new Error('UnitOfWork 未 begin：无可用的执行上下文')
    return this.client
  }

  async begin(): Promise<void> {
    if (this.client !== null) throw new Error('UnitOfWork 已 begin，不得重复')
    this.client = await this.pool.connect()
    await this.client.query('BEGIN')
  }

  async commit(): Promise<void> {
    const client = this.mustClient()
    try {
      for (const intent of this.intents) {
        await client.query(
          `INSERT INTO outbox (aggregate_type, aggregate_id, task_kind, status, payload)
           VALUES ($1, $2, $3, 'PENDING', $4::jsonb)`,
          [intent.aggregateType, intent.aggregateId, intent.taskKind, JSON.stringify(intent.payload)],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
      this.client = null
      this.intents.length = 0
    }
  }

  async rollback(): Promise<void> {
    if (this.client === null) return
    const client = this.client
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
    this.client = null
    this.intents.length = 0
  }

  collectOutbox(intent: OutboxIntent): void {
    this.intents.push(intent)
  }

  private mustClient(): pg.PoolClient {
    if (this.client === null) throw new Error('UnitOfWork 未 begin：无活动事务')
    return this.client
  }
}
