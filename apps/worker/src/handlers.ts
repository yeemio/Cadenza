import { createHash } from 'node:crypto'

/**
 * T07 outbox 任务处理器注册表 + 外发通道。
 *
 * 内部可靠性真实（认领/分发/退避/恢复都在 processor 循环里落库），
 * 外部投递经可配置通道：默认 noop（真实外部接口 SITE_PENDING——外部样例缺失
 * 只阻塞现场适配，不阻塞内部状态机）。
 */

/** 认领后待处理的任务行（payload 为业务时点快照，重试不得改推当前值）。 */
export interface OutboxTaskRow {
  eventId: string
  aggregateType: string
  aggregateId: string
  taskKind: string
  payload: Record<string, unknown>
  attemptCount: number
  /** Resolved by claim from persisted aggregate scope, never used to mutate payload. */
  plantId?: string
}

/** 内部处理器结果（processor 据此落状态机，不在此触网外发）。 */
export type HandlerOutcome =
  | { kind: 'DISPATCHED'; externalRef?: string; requestDigest?: string }
  | { kind: 'NOOP_NEEDED'; reason: string }
  /** retry=true → 指数退避后重试；retry=false → FAILED+next_retry_at=NULL 隔离，不入常规重试 */
  | { kind: 'FAILED'; error: string; retry: boolean }
  /** 越范围：不外发、不改行，正确范围 worker 可正常认领 */
  | { kind: 'SCOPE_SKIPPED'; reason: string }
  | { kind: 'EXTERNAL_UNKNOWN'; reason: string }

export type TaskHandler = (row: OutboxTaskRow) => Promise<HandlerOutcome>

/**
 * task_kind 处理器注册表：精确匹配优先，其次最长前缀（如 'shipping.'），最后回落默认。
 * 注册表模式：新增任务种类只加注册项，不改循环。
 */
export class TaskHandlerRegistry {
  constructor(readonly scope?: WorkerScope) {}
  private readonly exact = new Map<string, TaskHandler>()
  private readonly prefixes: Array<{ prefix: string; handler: TaskHandler }> = []

  register(taskKind: string, handler: TaskHandler): this {
    this.exact.set(taskKind, handler)
    return this
  }

  registerPrefix(prefix: string, handler: TaskHandler): this {
    this.prefixes.push({ prefix, handler })
    return this
  }

  resolve(taskKind: string): TaskHandler | undefined {
    const exact = this.exact.get(taskKind)
    if (exact !== undefined) return exact
    const matched = this.prefixes
      .filter((p) => taskKind.startsWith(p.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0]
    return matched?.handler
  }

  /** 已注册的精确种类（诊断/测试用）。 */
  registeredKinds(): string[] {
    return [...this.exact.keys()]
  }
}

// ---------------- 外发通道（可配置；默认 noop） ----------------

/** 外发通道：deliver 返回外部引用与请求摘要（供外部幂等对账）。 */
export interface ExternalChannel {
  readonly name: string
  deliver(row: OutboxTaskRow): Promise<{ outcome?: 'confirmed' | 'unknown' | 'noop'; externalRef?: string; requestDigest?: string }>
}

/** 键序稳定序列化（与 pg-command-bus stableStringify 同算法；摘要跨进程可复算）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

/** 外发请求摘要：任务复合身份 + 时点快照载荷（同任务同载荷摘要不变，改推即变）。 */
export function outboxRequestDigest(row: Pick<OutboxTaskRow, 'aggregateType' | 'aggregateId' | 'taskKind' | 'payload'>): string {
  return createHash('sha256')
    .update(
      stableStringify({
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        taskKind: row.taskKind,
        payload: row.payload,
      }),
    )
    .digest('hex')
}

/**
 * noop 通道：真实外部接口 SITE_PENDING 期间的占位外发。
 * 产生确定性的 externalRef/requestDigest（可对账"该行确实走了通道"），不触网、不落外部状态。
 */
export function createNoopChannel(): ExternalChannel {
  return {
    name: 'noop(SITE_PENDING)',
    async deliver(row) {
      return {
        outcome: 'noop',
        externalRef: `noop:${row.taskKind}:${row.eventId}`,
        requestDigest: outboxRequestDigest(row),
      }
    },
  }
}

/** 通道工厂：'noop' → noop 通道；其余值拒绝启动（真实外部接入时在此扩展，不静默回落）。 */
export function createChannel(name: string): ExternalChannel {
  if (name === 'noop') return createNoopChannel()
  throw new Error(`未知外发通道 ${name}（当前仅 noop；真实外部接口 SITE_PENDING）`)
}

// ---------------- 后台范围过滤（P1 §3.5：后台任务同样受控） ----------------

export interface WorkerScope {
  /** Explicit authorized factory IDs. Empty scope must never mean every factory. */
  readonly plantIds: readonly string[]
}

export function parseScopePlants(raw: string | undefined): WorkerScope {
  const plantIds = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return { plantIds: [...new Set(plantIds)] }
}

/**
 * 默认处理器（未注册专属处理器的任务种类回落至此）：
 * 1) 已解析的真实工厂不在本处理器范围 → SCOPE_SKIPPED（不外发、不改行）；
 *    无法解析范围的行已在 claim 阶段排除。
 * 2) 载荷健全性：payload 非对象 → FAILED(retry=false)。
 * 3) 明确外部确认才 DISPATCHED；noop=NOOP_NEEDED，未知=EXTERNAL_UNKNOWN。
 */
export function createDefaultHandler(channel: ExternalChannel, scope: WorkerScope): TaskHandler {
  return async (row) => {
    if (row.payload === null || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
      return { kind: 'FAILED', error: 'payload 非对象，不可外发', retry: false }
    }
    // Defense after claim: a mismatched handler configuration leaves the row
    // untouched. Actual scope is resolved before acquiring the outbox row lock.
    const plantId = row.plantId ?? row.payload['plantId']
    if (typeof plantId !== 'string' || !scope.plantIds.includes(plantId)) {
      return { kind: 'SCOPE_SKIPPED', reason: '任务工厂不在处理器范围，保持原任务状态' }
    }
    let delivered: Awaited<ReturnType<ExternalChannel['deliver']>>
    try { delivered = await channel.deliver(row) } catch {
      return { kind: 'EXTERNAL_UNKNOWN', reason: 'External delivery threw; result unknown, reconcile the original event' }
    }
    if (delivered.outcome === 'noop') return { kind: 'NOOP_NEEDED', reason: 'SITE_PENDING: noop only; no external confirmation' }
    if (delivered.outcome !== 'confirmed' || !delivered.externalRef?.trim() || delivered.externalRef.startsWith('noop:') ||
        delivered.requestDigest !== outboxRequestDigest(row)) {
      return { kind: 'EXTERNAL_UNKNOWN', reason: 'External confirmation absent or not bound to the immutable request snapshot' }
    }
    return { kind: 'DISPATCHED', externalRef: delivered.externalRef, requestDigest: delivered.requestDigest }
  }
}

/** 装配默认注册表：全部种类回落默认处理器；专属种类在此 register（逐步补齐）。 */
export function buildRegistry(channel: ExternalChannel, scope: WorkerScope): TaskHandlerRegistry {
  const registry = new TaskHandlerRegistry(scope)
  const fallback = createDefaultHandler(channel, scope)
  // 未见过的种类也走同一通道外发（通道是 noop；真实接入时按种类显式注册后收紧）
  registry.registerPrefix('', fallback)
  return registry
}
