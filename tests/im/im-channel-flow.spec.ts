import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { ImModule } from '../../apps/api/src/aiquery/im/im.module'
import {
  IM_GROUP_GUIDANCE_TEXT,
  IM_UNBOUND_GUIDANCE_TEXT,
} from '../../apps/api/src/aiquery/im/im.channel-event.service'
import {
  MockAiAuditSendResultPort,
  MockAiQuerySessionPort,
  MockAiQueryTurnPort,
  MockBindingCodeVerifier,
  MockImAccessRecheckPort,
} from '../../apps/api/src/aiquery/im/im.mock-seams'
import type { AiQueryTurnPort, ImProcessingRecord } from '../../apps/api/src/aiquery/im/im.ports'
import {
  FeishuImChannelAdapter,
  InMemoryImChannelEventCounters,
  InMemoryImIdentityBindingStore,
  InMemoryImProcessingRecordStore,
  MockChannelSender,
  MockImChannelAdapter,
  WecomImChannelAdapter,
} from '../../packages/integrations/im/src/index'

/**
 * im 渠道接入子模块全流程证据（frozen/p4/im-channels.md §6 C 线验收门；AR-02 不挂载，
 * supertest 自组装 ImModule.register 取证——同 shipping/aiquery 先例）。
 *
 * 五组专项证据：
 * ① mock 双向消息闭环：提问→澄清→回答（含绑定前置、requestId 延续、审计回写）；
 * ② IM-06 同一 platformMessageId 重推仅一次处理/一次回复；
 * ③ IM-04 发送 unknown 态不被改写为 sent（failed 三态完备）；
 * ④ IM-10/11 群目标拦截与固定引导语（不创建问数轮）；
 * ⑤ IM-13/IM-08 撤权后不发送（not_sent 审计语义）。
 * ⑥~⑧ 附加：IM-03 未绑定引导与绑定/解绑闭环、IM-16 渠道闸门与错误映射、IM-12 会话四元划分。
 */

interface ImAppHarness {
  app: INestApplication
  sender: MockChannelSender
  records: InMemoryImProcessingRecordStore
  counters: InMemoryImChannelEventCounters
  bindings: InMemoryImIdentityBindingStore
  sessions: MockAiQuerySessionPort
  audit: MockAiAuditSendResultPort
  recheck: MockImAccessRecheckPort
  verification: MockBindingCodeVerifier
  turn: MockAiQueryTurnPort
  turnCalls: string[]
}

async function buildImApp(): Promise<ImAppHarness> {
  const sender = new MockChannelSender()
  const records = new InMemoryImProcessingRecordStore()
  const counters = new InMemoryImChannelEventCounters()
  const bindings = new InMemoryImIdentityBindingStore()
  const sessions = new MockAiQuerySessionPort()
  const audit = new MockAiAuditSendResultPort()
  const recheck = new MockImAccessRecheckPort()
  const verification = new MockBindingCodeVerifier()
  const turn = new MockAiQueryTurnPort()
  const turnCalls: string[] = []
  const countingTurn: AiQueryTurnPort = {
    submitTurn: async (input) => {
      turnCalls.push(input.requestId)
      return turn.submitTurn(input)
    },
  }
  const moduleRef = await Test.createTestingModule({
    imports: [
      ImModule.register({
        adapters: [new MockImChannelAdapter(), new WecomImChannelAdapter(), new FeishuImChannelAdapter()],
        sender,
        records,
        counters,
        bindings,
        seams: { session: sessions, turn: countingTurn, audit, recheck, verification },
      }),
    ],
  }).compile()
  const app = moduleRef.createNestApplication()
  await app.init()
  return { app, sender, records, counters, bindings, sessions, audit, recheck, verification, turn, turnCalls }
}

async function withImApp(fn: (h: ImAppHarness) => Promise<void>): Promise<void> {
  const h = await buildImApp()
  try {
    await fn(h)
  } finally {
    await h.app.close()
  }
}

interface MockPayloadInput {
  msgId: string
  msgType?: 'text' | 'binding' | 'unbind'
  chatType?: 'single' | 'group'
  chatId?: string
  fromUser?: string
  app?: string
  text?: string
  verificationCode?: string
}

function mockPayload(input: MockPayloadInput): Record<string, unknown> {
  return {
    app: input.app ?? 'app-1',
    fromUser: input.fromUser ?? 'u-1',
    msgId: input.msgId,
    chatType: input.chatType ?? 'single',
    chatId: input.chatId ?? 'chat-1',
    msgType: input.msgType ?? 'text',
    ...(input.msgType === 'binding' || input.verificationCode !== undefined
      ? { verificationCode: input.verificationCode }
      : {}),
    ...(input.msgType !== 'binding' && input.text !== undefined ? { text: input.text } : {}),
    ...(input.msgType === 'text' && input.text === undefined ? { text: '查一下订单进度' } : {}),
  }
}

function postMock(h: ImAppHarness, payload: Record<string, unknown>) {
  return request(h.app.getHttpServer()).post('/aiquery/im/channels/mock/callback').send(payload)
}

async function bindUser(
  h: ImAppHarness,
  args: { code: string; userId: string; fromUser?: string; app?: string; msgId?: string },
): Promise<void> {
  h.verification.issue(args.code, args.userId)
  const res = await postMock(
    h,
    mockPayload({
      msgId: args.msgId ?? `bind-${args.code}`,
      msgType: 'binding',
      verificationCode: args.code,
      fromUser: args.fromUser,
      app: args.app,
    }),
  )
  expect(res.status).toBe(201)
  expect(res.body.outcome).toBe('binding_ok')
}

async function recordOf(h: ImAppHarness, msgId: string, app = 'app-1'): Promise<ImProcessingRecord> {
  const record = await h.records.findByKey({ channelKind: 'mock', enterpriseAppRef: app, platformMessageId: msgId })
  if (!record) throw new Error(`处理记录缺失：${msgId}`)
  return record
}

describe('① mock 双向消息闭环：绑定→提问→澄清→续问→回答（IM-15/AR-15）', () => {
  it('全链一次会话；澄清与回答复用同一 requestId；发送结果回写审计', async () => {
    await withImApp(async (h) => {
      await bindUser(h, { code: 'BIND-1', userId: 'user-a' })

      const clarify = await postMock(h, mockPayload({ msgId: 'm-2', text: '查一下订单进度' }))
      expect(clarify.status).toBe(201)
      expect(clarify.body).toEqual({ received: true, messageKey: 'mock|app-1|m-2', outcome: 'clarify' })
      const clarifyOut = h.sender.captured.at(-1)
      expect(clarifyOut?.channelKind).toBe('mock')
      expect(clarifyOut?.conversationTarget).toEqual({ kind: 'direct', ref: 'chat-1' })
      expect(clarifyOut?.content.kind).toBe('clarify')
      expect(clarifyOut?.content.options?.length).toBe(2)
      expect(clarifyOut?.content.options?.[0]).toContain('PO-2026-0001')

      const answer = await postMock(h, mockPayload({ msgId: 'm-3', text: 'PO-2026-0001' }))
      expect(answer.body.outcome).toBe('answer')
      const answerOut = h.sender.captured.at(-1)
      expect(answerOut?.content.kind).toBe('answer')
      expect(answerOut?.content.text).toContain('PO-2026-0001')

      // AR-15/AQ-AMB-04：澄清续轮复用同一 requestId；两条记录各自关联
      const r2 = await recordOf(h, 'm-2')
      const r3 = await recordOf(h, 'm-3')
      expect(r2.requestId).toBeTypeOf('string')
      expect(r3.requestId).toBe(r2.requestId)
      expect(h.turnCalls).toEqual([r2.requestId, r2.requestId])
      expect(r2.phases.map((p) => p.phase)).toContain('clarify_sent')
      expect(r3.phases.map((p) => p.phase)).toContain('sent')
      expect(r3.sendResult).toEqual({ status: 'sent' })

      // IM-12：同用户同渠道同会话目标 → 恰一个会话键
      expect(h.sessions.sessionKeys()).toEqual(['user-a|mock|chat-1'])

      // AQ-S2：两轮发送（澄清+回答）均回写审计 sent（绑定通知不经审计）
      expect(h.audit.recorded.length).toBe(2)
      expect(h.audit.recorded.every((r) => r.sentResultStatus === 'sent' && r.requestId === r2.requestId)).toBe(true)
    })
  })
})

describe('② IM-06 去重：同一 platformMessageId 重推仅一次处理/一次回复', () => {
  it('同键重推 → 幂等丢弃：处理记录复用、计数递增、不再问数/不再回复', async () => {
    await withImApp(async (h) => {
      await bindUser(h, { code: 'BIND-1', userId: 'user-a' })
      h.turn.scriptOutcome('answer') // 首问直接回答，单消息收口

      const first = await postMock(h, mockPayload({ msgId: 'm-dup', text: 'PO-2026-0001' }))
      expect(first.body.outcome).toBe('answer')
      expect(h.sender.captured.filter((m) => m.content.kind === 'answer').length).toBe(1)
      expect(h.turnCalls.length).toBe(1)

      const again = await postMock(h, mockPayload({ msgId: 'm-dup', text: 'PO-2026-0001' }))
      expect(again.status).toBe(201) // 平台重推同样受理成功（止推语义）
      expect(again.body.outcome).toBe('duplicate_dropped')
      expect(again.body.messageKey).toBe('mock|app-1|m-dup')

      const record = await recordOf(h, 'm-dup')
      expect(record.duplicateDropCount).toBe(1)
      expect(record.phases.map((p) => p.phase)).toContain('duplicate_dropped')
      expect(record.requestId).toBeTypeOf('string') // 首轮 requestId 不被重推覆盖
      expect(h.records.size).toBe(2) // 绑定消息 1 + 本问 1，无新增记录
      expect(h.turnCalls.length).toBe(1) // 不重复消耗模型
      expect(h.sender.captured.filter((m) => m.content.kind === 'answer').length).toBe(1) // 仅一次回复

      const stats = await request(h.app.getHttpServer()).get('/aiquery/im/stats')
      expect(stats.status).toBe(200)
      expect(stats.body['duplicate_dropped']).toBe(1)
    })
  })

  it('去重键含企业应用维度：同 msgId 不同 enterpriseAppRef → 独立处理（IM-06 键组成）', async () => {
    await withImApp(async (h) => {
      await bindUser(h, { code: 'BIND-A', userId: 'user-a', app: 'app-1' })
      await bindUser(h, { code: 'BIND-B', userId: 'user-a', app: 'app-2' })
      h.turn.scriptOutcome('answer', 'answer')

      const one = await postMock(h, mockPayload({ msgId: 'same-msg', app: 'app-1', text: 'PO-2026-0001' }))
      const two = await postMock(h, mockPayload({ msgId: 'same-msg', app: 'app-2', text: 'PO-2026-0001' }))
      expect(one.body.outcome).toBe('answer')
      expect(two.body.outcome).toBe('answer') // 非 duplicate：键三元组不同
      expect(one.body.messageKey).not.toBe(two.body.messageKey)
      expect((await recordOf(h, 'same-msg', 'app-1')).requestId).not.toBe(
        (await recordOf(h, 'same-msg', 'app-2')).requestId,
      )
      expect(h.turnCalls.length).toBe(2)
    })
  })
})

describe('③ IM-04 发送未知态：unknown 不被改写为 sent、不自动补发', () => {
  it('发送端口返回 unknown → 记录与审计均保持 send_unknown，无二次发送', async () => {
    await withImApp(async (h) => {
      await bindUser(h, { code: 'BIND-1', userId: 'user-a' })
      h.turn.scriptOutcome('answer')
      h.sender.scriptOutcomes('unknown')

      const res = await postMock(h, mockPayload({ msgId: 'm-unk', text: 'PO-2026-0001' }))
      expect(res.body.outcome).toBe('answer')

      const record = await recordOf(h, 'm-unk')
      expect(record.sendResult).toEqual({ status: 'unknown' }) // 未被改写为 sent
      const phases = record.phases.map((p) => p.phase)
      expect(phases).toContain('send_unknown')
      expect(phases).not.toContain('sent')
      expect(h.audit.recorded).toEqual([
        {
          requestId: record.requestId,
          sentResultStatus: 'send_unknown',
          detail: 'IM-04-1 发送结果未知（不自动补发）',
        },
      ])
      expect(h.counters.snapshot()['send_unknown']).toBe(1)
      expect(h.counters.snapshot()['sent']).toBe(0)
      // 不自动补发：绑定通知 1 条 + 恰一次 answer 发送尝试，无重发
      expect(h.sender.captured.filter((m) => m.content.kind === 'answer').length).toBe(1)
      expect(h.sender.captured.length).toBe(2)
    })
  })

  it('failed 态同构：记录 send_failed、审计 failed（三态完备）', async () => {
    await withImApp(async (h) => {
      await bindUser(h, { code: 'BIND-1', userId: 'user-a' })
      h.turn.scriptOutcome('answer')
      h.sender.scriptOutcomes('failed')

      const res = await postMock(h, mockPayload({ msgId: 'm-fail', text: 'PO-2026-0001' }))
      expect(res.body.outcome).toBe('answer')
      const record = await recordOf(h, 'm-fail')
      expect(record.sendResult).toEqual({ status: 'failed' })
      expect(record.phases.map((p) => p.phase)).toContain('send_failed')
      expect(h.audit.recorded[0]?.sentResultStatus).toBe('failed')
      expect(h.counters.snapshot()['send_failed']).toBe(1)
    })
  })
})

describe('④ IM-10/11 群目标拦截与固定引导语', () => {
  it('群内提问 → 拦截：固定引导语、不创建问数轮、requestId=null、无会话', async () => {
    await withImApp(async (h) => {
      await bindUser(h, { code: 'BIND-1', userId: 'user-a' })
      const res = await postMock(
        h,
        mockPayload({ msgId: 'm-group', chatType: 'group', chatId: 'group-1', text: '查订单' }),
      )
      expect(res.status).toBe(201)
      expect(res.body.outcome).toBe('group_intercepted')

      const out = h.sender.captured.at(-1)
      expect(out?.conversationTarget).toEqual({ kind: 'group', ref: 'group-1' })
      expect(out?.content.kind).toBe('guidance')
      expect(out?.content.text).toBe(IM_GROUP_GUIDANCE_TEXT)
      expect(out?.content.text).toContain('个人会话')
      expect(out?.content.status).toBe('intercepted')

      const record = await recordOf(h, 'm-group')
      expect(record.requestId).toBeNull() // 未创建问数轮（IM-11）
      expect(record.phases.map((p) => p.phase)).toContain('group_intercepted')
      expect(h.turnCalls.length).toBe(0)
      expect(h.sessions.sessionKeys().length).toBe(0)
      expect(h.audit.recorded.length).toBe(0)
      expect(h.counters.snapshot()['group_intercepted']).toBe(1)
    })
  })

  it('群内绑定动作同样拦截（群目标一律引导，不放行任何问数前置动作）', async () => {
    await withImApp(async (h) => {
      h.verification.issue('BIND-G', 'user-a')
      const res = await postMock(
        h,
        mockPayload({ msgId: 'm-bind-group', chatType: 'group', chatId: 'group-1', msgType: 'binding', verificationCode: 'BIND-G' }),
      )
      expect(res.body.outcome).toBe('group_intercepted')
      expect(h.sender.captured.at(-1)?.content.text).toBe(IM_GROUP_GUIDANCE_TEXT)
      expect(
        await h.bindings.resolve({ channelKind: 'mock', enterpriseAppRef: 'app-1', platformUserId: 'u-1' }),
      ).toBeNull() // 未登记绑定
    })
  })
})

describe('⑤ IM-13/IM-08 撤权后不发送：not_sent 审计语义', () => {
  it('问数轮完成但发送前再检拒绝 → 不发送，审计 not_sent；恢复授权后同流程可发送', async () => {
    await withImApp(async (h) => {
      await bindUser(h, { code: 'BIND-1', userId: 'user-a' })
      h.turn.scriptOutcome('answer', 'answer')

      // 撤权（AQ-AUTH-01 口径实时重验失败）
      h.recheck.deny('user-a', 'aiquery.use 许可已撤销')
      const denied = await postMock(h, mockPayload({ msgId: 'm-rev', text: 'PO-2026-0001' }))
      expect(denied.body.outcome).toBe('answer') // 问数轮本身完成
      expect(h.turnCalls.length).toBe(1) // 轮已执行（证明拦截发生在发送前再检，非入口拦截）
      expect(h.sender.captured.filter((m) => m.content.kind === 'answer').length).toBe(0) // 不发送

      const record = await recordOf(h, 'm-rev')
      expect(record.phases.map((p) => p.phase)).toContain('not_sent')
      const notSentPhase = record.phases.find((p) => p.phase === 'not_sent')
      expect(notSentPhase?.note).toContain('IM-08-1')
      expect(record.sendResult).toBeNull()
      expect(h.audit.recorded.length).toBe(1)
      expect(h.audit.recorded[0]?.requestId).toBe(record.requestId)
      expect(h.audit.recorded[0]?.sentResultStatus).toBe('not_sent')
      expect(h.audit.recorded[0]?.detail).toContain('IM-08-1')
      expect(h.counters.snapshot()['not_sent']).toBe(1)
      expect(h.counters.snapshot()['sent']).toBe(0)

      // 对照：恢复授权后同型消息正常发送（撤权不留下永久拒发态）
      h.recheck.allow('user-a')
      const ok = await postMock(h, mockPayload({ msgId: 'm-re-ok', text: 'PO-2026-0001' }))
      expect(ok.body.outcome).toBe('answer')
      expect(h.sender.captured.filter((m) => m.content.kind === 'answer').length).toBe(1)
      expect(h.audit.recorded.at(-1)?.sentResultStatus).toBe('sent')
    })
  })

  it('取消（DS-11）：轮被取消后不产生任何发送动作', async () => {
    await withImApp(async (h) => {
      await bindUser(h, { code: 'BIND-1', userId: 'user-a' })
      h.turn.scriptOutcome('cancelled')
      const res = await postMock(h, mockPayload({ msgId: 'm-cancel', text: '查订单' }))
      expect(res.body.outcome).toBe('cancelled')
      expect(h.sender.captured.length).toBe(1) // 仅有绑定通知一条；取消轮零发送动作
      expect(h.sender.captured[0]?.content.kind).toBe('notice')
      expect(h.audit.recorded.length).toBe(0)
      expect((await recordOf(h, 'm-cancel')).phases.map((p) => p.phase)).toContain('cancelled')
    })
  })
})

describe('⑥ IM-03 未绑定引导与绑定/解绑闭环', () => {
  it('未绑定提问 → no_permission + 绑定引导文案；不建会话/不问数/不写审计', async () => {
    await withImApp(async (h) => {
      const res = await postMock(h, mockPayload({ msgId: 'm-anon', text: '查订单' }))
      expect(res.body.outcome).toBe('unbound_guidance')
      const out = h.sender.captured.at(-1)
      expect(out?.content.kind).toBe('guidance')
      expect(out?.content.text).toBe(IM_UNBOUND_GUIDANCE_TEXT)
      expect(out?.content.text).toContain('no_permission')
      expect(out?.content.status).toBe('no_permission')
      expect(h.turnCalls.length).toBe(0)
      expect(h.sessions.sessionKeys().length).toBe(0)
      expect((await recordOf(h, 'm-anon')).phases.map((p) => p.phase)).toContain('identity_unresolved')
      expect(h.counters.snapshot()['unbound_guidance']).toBe(1)
    })
  })

  it('无效绑定码 → binding_rejected；解绑后回未绑定引导（绑定闭环）', async () => {
    await withImApp(async (h) => {
      const bad = await postMock(h, mockPayload({ msgId: 'm-b1', msgType: 'binding', verificationCode: 'WRONG' }))
      expect(bad.body.outcome).toBe('binding_rejected')
      expect((await recordOf(h, 'm-b1')).phases.map((p) => p.phase)).toContain('binding_rejected')

      await bindUser(h, { code: 'BIND-1', userId: 'user-a' })
      const unbind = await postMock(h, mockPayload({ msgId: 'm-u1', msgType: 'unbind' }))
      expect(unbind.body.outcome).toBe('unbind_done')
      const reQuestion = await postMock(h, mockPayload({ msgId: 'm-q', text: '再查一次' }))
      expect(reQuestion.body.outcome).toBe('unbound_guidance')
      const unbindAgain = await postMock(h, mockPayload({ msgId: 'm-u2', msgType: 'unbind' }))
      expect(unbindAgain.body.outcome).toBe('unbind_noop')
    })
  })
})

describe('⑦ IM-16 渠道闸门与错误映射（HTTP 面）', () => {
  it('企微/飞书回调 → 503 SITE_PENDING；未知渠道 → 400；mock 坏载荷 → 422', async () => {
    await withImApp(async (h) => {
      const server = h.app.getHttpServer()
      const wecom = await request(server)
        .post('/aiquery/im/channels/wecom/callback')
        .send({ toUserName: 'corp', fromUserName: 'u', msgId: 'w1', chatType: 'single', chatId: 'c', msgType: 'text', content: 'hi' })
      expect(wecom.status).toBe(503)
      expect(wecom.body.code).toBe('ERR_IM_SITE_PENDING')
      expect(wecom.body.message).toContain('SITE_PENDING')

      const feishu = await request(server).post('/aiquery/im/channels/feishu/callback').send({})
      expect(feishu.status).toBe(503)
      expect(feishu.body.code).toBe('ERR_IM_SITE_PENDING')

      const unknown = await request(server).post('/aiquery/im/channels/telegram/callback').send({})
      expect(unknown.status).toBe(400)
      expect(unknown.body.code).toBe('ERR_IM_UNKNOWN_CHANNEL')

      const malformed = await request(server).post('/aiquery/im/channels/mock/callback').send({ app: 'app-1' })
      expect(malformed.status).toBe(422)
      expect(malformed.body.code).toBe('ERR_IM_MESSAGE_SHAPE')
      expect(malformed.body.message).toContain('[IM-02-1]')
    })
  })

  it('问数服务不可用（AR-12）→ 降级提示照发、状态 unavailable', async () => {
    await withImApp(async (h) => {
      await bindUser(h, { code: 'BIND-1', userId: 'user-a' })
      h.turn.scriptOutcome('unavailable')
      const res = await postMock(h, mockPayload({ msgId: 'm-down', text: '查订单' }))
      expect(res.body.outcome).toBe('unavailable')
      const out = h.sender.captured.at(-1)
      expect(out?.content.kind).toBe('notice')
      expect(out?.content.text).toContain('暂不可用')
      expect(out?.content.status).toBe('unavailable')
    })
  })
})

describe('⑧ IM-12 会话四元划分（userId|channel|conversationRef 承载键）', () => {
  it('同键复用会话；用户/渠道/会话目标任一不同 → 不同会话键', async () => {
    const sessions = new MockAiQuerySessionPort()
    const a1 = await sessions.ensureSession({ userId: 'user-a', channel: 'mock', conversationRef: 'chat-1' })
    const a1again = await sessions.ensureSession({ userId: 'user-a', channel: 'mock', conversationRef: 'chat-1' })
    expect(a1again.sessionId).toBe(a1.sessionId)
    const a2 = await sessions.ensureSession({ userId: 'user-a', channel: 'mock', conversationRef: 'chat-2' })
    expect(a2.sessionId).not.toBe(a1.sessionId)
    const b1 = await sessions.ensureSession({ userId: 'user-b', channel: 'mock', conversationRef: 'chat-1' })
    expect(b1.sessionId).not.toBe(a1.sessionId)
    const cross = await sessions.ensureSession({ userId: 'user-a', channel: 'feishu', conversationRef: 'chat-1' })
    expect(cross.sessionId).not.toBe(a1.sessionId) // 渠道不同不自动拼接（IM-12）
    expect(sessions.sessionKeys().length).toBe(4)
  })
})
