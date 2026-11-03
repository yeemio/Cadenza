import { createHash } from 'node:crypto'
import {
  ERROR_CODES,
  CommandResultStatus,
  type CommandEnvelope,
  type CommandResult,
} from '@cadenza/contracts'
import type {
  CommandBus,
  CommandContext,
  CommandHandler,
  CommandTools,
} from '@cadenza/application'
import type pg from 'pg'
import type { SqlClient } from './sql-client'

/**
 * pg 命令总线（implements application CommandBus 端口）。
 *
 * 幂等合同（SYSTEM_ARCHITECTURE §4.1 + command_receipt 表）：
 * - 键 = (enterprise_id, command_type, operation_id)；
 * - 同键同载荷 → 返回原结果（原样回放，不重复入账）；
 * - 同键异载荷 → ERR_IDEMPOTENT_PAYLOAD_MISMATCH（不覆盖原回执）；
 * - 处理器在回执 INSERT 的同一事务内运行，业务变更 + 审计 + 回执共同 COMMIT。
 */

/** 命令工具集工厂：由组合根（apps/api）提供事务绑定的仓储/审计实现。 */
export type CommandToolsFactory = (
  client: SqlClient,
  context: CommandContext,
  now: () => Date,
) => CommandTools

/** 键序稳定序列化（对象键排序，数组保序）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

/** 载荷摘要：覆盖命令种类 + targetId + expectedRevision + payload（operationId 本身是幂等键，不进摘要）。 */
export function commandPayloadDigest(envelope: CommandEnvelope<unknown>): string {
  return createHash('sha256')
    .update(
      stableStringify({
        commandType: envelope.commandType,
        targetId: envelope.targetId,
        expectedRevision: envelope.expectedRevision,
        payload: envelope.payload,
      }),
    )
    .digest('hex')
}

export class PgCommandBus implements CommandBus {
  private readonly handlers: Map<string, CommandHandler>

  constructor(
    private readonly pool: pg.Pool,
    handlers: Iterable<CommandHandler>,
    private readonly toolsFactory: CommandToolsFactory,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.handlers = new Map(Array.from(handlers, (h) => [h.commandType, h]))
  }

  async execute<TPayload = Record<string, unknown>>(
    envelope: CommandEnvelope<TPayload>,
    context: CommandContext,
  ): Promise<CommandResult> {
    const digest = commandPayloadDigest(envelope)
    const client = await this.pool.connect()
    let txOpen = true
    try {
      await client.query('BEGIN')

      // 抢占幂等键：并发同键时唯一约束保证只有一个事务插入成功
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO command_receipt (enterprise_id, command_type, operation_id, payload_digest, status, result)
         VALUES ($1, $2, $3, $4, 'PENDING', '{}'::jsonb)
         ON CONFLICT (enterprise_id, command_type, operation_id) DO NOTHING
         RETURNING id`,
        [context.enterpriseId, envelope.commandType, envelope.operationId, digest],
      )

      if ((inserted.rowCount ?? 0) === 0) {
        // 同键既有回执：等并发事务落地后读出比对
        const existing = await client.query<{ payload_digest: string; result: CommandResult; created_at: Date }>(
          `SELECT payload_digest, result, created_at FROM command_receipt
           WHERE enterprise_id = $1 AND command_type = $2 AND operation_id = $3`,
          [context.enterpriseId, envelope.commandType, envelope.operationId],
        )
        await client.query('ROLLBACK')
        txOpen = false
        const row = existing.rows[0]
        if (row === undefined) {
          throw new Error('command_receipt 并发竞态：冲突插入后读取不到回执行')
        }
        if (row.payload_digest !== digest) {
          return {
            operationId: envelope.operationId,
            status: CommandResultStatus.BUSINESS_REJECTION,
            errorCode: ERROR_CODES.IDEMPOTENT_PAYLOAD_MISMATCH,
            errorMessage: '同一 operationId 已绑定不同载荷，拒绝执行（修复载荷后须更换 operationId）',
            occurredAt: new Date(row.created_at).toISOString(),
          }
        }
        // 同载荷：原样回放既有结果，不重复入账
        return { ...row.result, operationId: envelope.operationId }
      }

      const handler = this.handlers.get(envelope.commandType)
      if (handler === undefined) {
        await client.query('ROLLBACK')
        txOpen = false
        throw new Error(`未注册的命令种类：${envelope.commandType}`)
      }

      const tools = this.toolsFactory(client, context, this.now)
      const outcome = await handler.handle(envelope, context, tools)
      const result: CommandResult = {
        operationId: envelope.operationId,
        status: outcome.status,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        data: outcome.data,
        occurredAt: this.now().toISOString(),
      }
      await client.query(
        `UPDATE command_receipt SET status = $1, result = $2::jsonb, updated_at = now() WHERE id = $3`,
        [result.status, JSON.stringify(result), inserted.rows[0]!.id],
      )
      await client.query('COMMIT')
      txOpen = false
      return result
    } catch (error) {
      if (txOpen) await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}
