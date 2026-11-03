/**
 * SessionStorePort 本地实现：独立数据目录（AR-08）文件存储。
 *
 * 目录布局：<dataDir>/sessions/<sessionId>/meta.json + events.jsonl。
 * - meta.json：会话登记/生命周期状态（DS-06）；
 * - events.jsonl：append-only 事件归档（消息/工具调用/模型应答/澄清/取消/终态，按 requestId 关联，AR-17）。
 *
 * 完整事件始终落本地；可选 sink 只转发审计锚点与状态（AR-17/19）。
 *
 * 本目录不是业务账本（AR-18/19）。单进程串行写（apps/ai 唯一 writer），内存缓存 + 即时落盘。
 */
import { mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  SessionEventRecord,
  SessionRuntimeRecord,
  SessionStorePort,
} from '../../../packages/integrations/dsh'
import { NoopSessionEventSink, type SessionEventSink } from './session-event-sink'

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId)
}

interface SessionSlot {
  meta: SessionRuntimeRecord
  events: SessionEventRecord[]
}

export class FileSessionStore implements SessionStorePort {
  private readonly cache = new Map<string, SessionSlot>()
  private readonly sink: SessionEventSink

  constructor(
    private readonly dataDir: string,
    sink?: SessionEventSink,
  ) {
    this.sink = sink ?? new NoopSessionEventSink()
    mkdirSync(join(dataDir, 'sessions'), { recursive: true })
  }

  private sessionDir(sessionId: string): string {
    return join(this.dataDir, 'sessions', sessionId)
  }

  private loadSlot(sessionId: string): SessionSlot | null {
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) return cached
    try {
      const meta = JSON.parse(readFileSync(join(this.sessionDir(sessionId), 'meta.json'), 'utf8')) as SessionRuntimeRecord
      let events: SessionEventRecord[] = []
      try {
        const lines = readFileSync(join(this.sessionDir(sessionId), 'events.jsonl'), 'utf8').split('\n')
        events = lines.filter((line) => line.length > 0).map((line) => JSON.parse(line) as SessionEventRecord)
      } catch {
        events = []
      }
      const slot: SessionSlot = { meta, events }
      this.cache.set(sessionId, slot)
      return slot
    } catch {
      return null
    }
  }

  private persistMeta(sessionId: string, slot: SessionSlot): void {
    writeFileSync(join(this.sessionDir(sessionId), 'meta.json'), JSON.stringify(slot.meta, null, 2), 'utf8')
  }

  async registerSession(
    record: Omit<
      SessionRuntimeRecord,
      'status' | 'createdAt' | 'lastActiveAt' | 'closedAt' | 'closedReason' | 'expiredAt'
    >,
  ): Promise<SessionRuntimeRecord> {
    const existing = this.loadSlot(record.sessionId)
    const nowIso = new Date().toISOString()
    const meta: SessionRuntimeRecord = existing
      ? { ...existing.meta, ...record }
      : {
          ...record,
          status: 'open',
          createdAt: nowIso,
          lastActiveAt: nowIso,
          closedAt: null,
          closedReason: null,
          expiredAt: null,
        }
    const slot: SessionSlot = { meta, events: existing?.events ?? [] }
    mkdirSync(this.sessionDir(record.sessionId), { recursive: true })
    this.cache.set(record.sessionId, slot)
    this.persistMeta(record.sessionId, slot)
    if (existing !== null) {
      this.appendEvent(record.sessionId, {
        kind: 'session_lifecycle',
        at: nowIso,
        from: existing.meta.status,
        to: existing.meta.status,
        reason: 're-registered',
      })
    }
    return meta
  }

  async findSession(sessionId: string): Promise<SessionRuntimeRecord | null> {
    const slot = this.loadSlot(sessionId)
    return slot === null ? null : { ...slot.meta }
  }

  async appendEvent(sessionId: string, event: SessionEventRecord): Promise<void> {
    const slot = this.loadSlot(sessionId)
    if (slot === null) return
    slot.events.push(event)
    appendFileSync(join(this.sessionDir(sessionId), 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
    await this.sink.append(sessionId, event)
  }

  async listEvents(sessionId: string): Promise<SessionEventRecord[]> {
    const slot = this.loadSlot(sessionId)
    return slot === null ? [] : [...slot.events]
  }

  async touchActive(sessionId: string, at: string): Promise<void> {
    const slot = this.loadSlot(sessionId)
    if (slot === null) return
    const from = slot.meta.status
    if (from === 'open') {
      slot.meta.status = 'active'
      this.appendEvent(sessionId, { kind: 'session_lifecycle', at, from, to: 'active', reason: 'turn-started' })
    }
    slot.meta.lastActiveAt = at
    this.persistMeta(sessionId, slot)
  }

  async closeSession(sessionId: string, reason: 'user_closed' | 'idle_timeout', at: string): Promise<void> {
    const slot = this.loadSlot(sessionId)
    if (slot === null || slot.meta.status === 'closed' || slot.meta.status === 'expired') return
    const from = slot.meta.status
    slot.meta.status = 'closed'
    slot.meta.closedAt = at
    slot.meta.closedReason = reason
    this.persistMeta(sessionId, slot)
    this.appendEvent(sessionId, { kind: 'session_lifecycle', at, from, to: 'closed', reason })
  }

  async sweepSessions(idleMs: number, retentionMs: number, now: Date): Promise<string[]> {
    const affected: string[] = []
    let ids = [...this.cache.keys()]
    try {
      for (const name of readdirSync(join(this.dataDir, 'sessions'))) {
        if (!ids.includes(name)) ids.push(name)
      }
    } catch {
      // 目录不存在时仅扫缓存
    }
    ids = [...new Set(ids)]
    const nowMs = now.getTime()
    for (const sessionId of ids) {
      const slot = this.loadSlot(sessionId)
      if (slot === null) continue
      const lastActiveMs = Date.parse(slot.meta.lastActiveAt)
      if (
        (slot.meta.status === 'open' || slot.meta.status === 'active') &&
        Number.isFinite(lastActiveMs) &&
        nowMs - lastActiveMs >= idleMs
      ) {
        // DS-06：超时空闲 → closed
        await this.closeSession(sessionId, 'idle_timeout', now.toISOString())
        affected.push(sessionId)
        continue
      }
      if (slot.meta.status === 'closed' && slot.meta.closedAt !== null) {
        const closedMs = Date.parse(slot.meta.closedAt)
        if (Number.isFinite(closedMs) && nowMs - closedMs >= retentionMs) {
          // DS-06：过期清理 → expired
          const fresh = this.loadSlot(sessionId)
          if (fresh !== null) {
            fresh.meta.status = 'expired'
            fresh.meta.expiredAt = now.toISOString()
            this.persistMeta(sessionId, fresh)
            this.appendEvent(sessionId, {
              kind: 'session_lifecycle',
              at: now.toISOString(),
              from: 'closed',
              to: 'expired',
              reason: 'retention-sweep',
            })
            affected.push(sessionId)
          }
        }
      }
    }
    return affected
  }
}
