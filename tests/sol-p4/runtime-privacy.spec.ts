import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../apps/ai/src/config'
import { PgAiRuntimeEventRepository } from '../../packages/persistence/src/aiquery-repositories'

describe('runtime event storage boundary', () => {
  it('HTTP query mode keeps metadata forwarding opt-in', () => {
    expect(loadConfig({ AI_CONTROLLED_QUERY_MODE: 'http' }).sessionEventSinkUrl).toBeNull()
    expect(loadConfig({ AI_SESSION_EVENT_SINK_URL: 'http://127.0.0.1/anchors' }).sessionEventSinkUrl).toBe('http://127.0.0.1/anchors')
  })
  it.each(['user_message', 'model_turn', 'tool_call'] as const)('repository rejects arbitrary %s payload fields at the SQL boundary', async (kind) => {
    const query = vi.fn().mockImplementation(async (_sql: string, values: unknown[]) => ({
      rows: [{ id: 'event-id', seq: 1, session_id: 'session-id', enterprise_id: null, user_id: null, request_id: null, kind,
        event_at: values[5], event: JSON.parse(values[6] as string), received_at: values[5] }],
    }))
    const repository = new PgAiRuntimeEventRepository({ query })
    const row = await repository.append({ sessionId: 'session-id', kind, eventAt: new Date().toISOString(), event: {
      content: 'private-chat', result: { answer: 'private-model' }, params: { secret: 'private-tool' }, status: 'ok_with_data',
    } })
    expect(row.event).toEqual(kind === 'tool_call' ? { status: 'ok_with_data' } : {})
    expect(JSON.stringify(query.mock.calls)).not.toContain('private-')
  })
})
