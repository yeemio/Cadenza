/** Optional forwarding of identity/audit anchors and fixed state values; full events remain local. */
import type { SessionEventRecord } from '../../../packages/integrations/dsh'

/** true means the metadata anchor was accepted; local full-event storage is unconditional. */
export type SessionEventSink = {
  append(sessionId: string, event: SessionEventRecord): Promise<boolean>
}

const SINK_TIMEOUT_MS = 3_000

/** HTTP 转发 sink：POST {url}（Bearer 内部令牌，同受控查询客户端凭据）。 */
export class HttpSessionEventSink implements SessionEventSink {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async append(sessionId: string, event: SessionEventRecord): Promise<boolean> {
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, event: eventAnchor(event) }),
        signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
      })
      return response.status === 201
    } catch {
      return false
    }
  }
}

/** 禁用态 sink（无转发配置时）：恒 false——FileSessionStore 全部走本地 events.jsonl。 */
export class NoopSessionEventSink implements SessionEventSink {
  async append(): Promise<boolean> {
    return false
  }
}

function eventAnchor(event: SessionEventRecord): Record<string, unknown> {
  const anchor: Record<string, unknown> = { kind: event.kind, at: event.at }
  if ('requestId' in event) anchor['requestId'] = event.requestId
  if (event.kind === 'turn_outcome') anchor['outcome'] = event.outcome
  if (event.kind === 'tool_call') anchor['status'] = event.result.status
  return anchor
}
