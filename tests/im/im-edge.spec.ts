import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ImMessageShapeError,
  SitePendingImError,
  MockImChannelAdapter,
  MockChannelSender,
  WecomImChannelAdapter,
  FeishuImChannelAdapter,
  InMemoryImIdentityBindingStore,
  InMemoryImProcessingRecordStore,
  InMemoryImChannelEventCounters,
  imMessageKeyString,
  type MockInboundPayload,
} from '../../packages/integrations/im/src/index'

/**
 * @cadenza/im 边缘包单元证据（frozen/p4/im-channels.md IM-01~04/06/07/16/17）。
 *
 * - IM-02：三渠道载荷 → 统一消息映射与形状校验（全中文错误 + 规则码 [IM-02-1]）；
 * - IM-16：企微/飞书真实验签/解密/token/ticket = SITE_PENDING 桩（抛 SitePendingImError，
 *   未经授权不接通）；mock 渠道无外部签名面恒通过；
 * - IM-03：身份绑定存储（resolve/bind 覆盖/unbind/键安全）；
 * - IM-06/07：处理记录存储（claim 原子占位/重复计数/阶段推进/requestId/发送结果）；
 * - IM-04：MockChannelSender 三态脚本化；
 * - IM-01/16/17：结构断言（零业务依赖、不外呼、零凭据字段）。
 */

const imSrcDir = join(__dirname, '..', '..', 'packages', 'integrations', 'im', 'src')

function listSrcFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listSrcFiles(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

function mockPayload(over: Partial<MockInboundPayload> = {}): MockInboundPayload {
  return {
    app: 'app-1',
    fromUser: 'u-1',
    msgId: 'm-1',
    chatType: 'single',
    chatId: 'chat-1',
    msgType: 'text',
    text: '查一下订单进度',
    ...over,
  }
}

describe('① IM-02 统一消息形状：三渠道适配与校验', () => {
  it('mock 载荷 → 统一消息逐字段映射（app/fromUser/msgId/chatType/chatId/text）', () => {
    const msg = new MockImChannelAdapter().parseInbound(
      mockPayload({ timestamp: '2026-10-28T08:00:00.000Z' }),
    )
    expect(msg.channelKind).toBe('mock')
    expect(msg.enterpriseAppRef).toBe('app-1')
    expect(msg.platformUserId).toBe('u-1')
    expect(msg.platformMessageId).toBe('m-1')
    expect(msg.conversationTarget).toEqual({ kind: 'direct', ref: 'chat-1' })
    expect(msg.messageType).toBe('text')
    expect(msg.content).toEqual({ kind: 'text', text: '查一下订单进度' })
    expect(msg.receivedAt).toBe('2026-10-28T08:00:00.000Z')
  })

  it('wecom 载荷：toUserName/fromUserName/content/single → enterpriseAppRef/platformUserId/text/direct', () => {
    const msg = new WecomImChannelAdapter().parseInbound({
      toUserName: 'corp-1$agent-1',
      fromUserName: 'wecom-user-1',
      msgId: 'wm-1',
      chatType: 'single',
      chatId: 'wecom-chat-1',
      msgType: 'text',
      content: '订单进度？',
    })
    expect(msg).toMatchObject({
      channelKind: 'wecom',
      enterpriseAppRef: 'corp-1$agent-1',
      platformUserId: 'wecom-user-1',
      platformMessageId: 'wm-1',
      conversationTarget: { kind: 'direct', ref: 'wecom-chat-1' },
      content: { kind: 'text', text: '订单进度？' },
    })
  })

  it('feishu 载荷：appRef/fromUserId/p2p → 统一消息（p2p 归一为 direct）', () => {
    const msg = new FeishuImChannelAdapter().parseInbound({
      appRef: 'cli-1',
      fromUserId: 'ou-1',
      messageId: 'fm-1',
      chatType: 'p2p',
      chatId: 'feishu-chat-1',
      msgType: 'binding',
      verificationCode: 'BIND-1',
    })
    expect(msg.channelKind).toBe('feishu')
    expect(msg.conversationTarget).toEqual({ kind: 'direct', ref: 'feishu-chat-1' })
    expect(msg.content).toEqual({ kind: 'binding', verificationCode: 'BIND-1' })
  })

  it('载荷缺字段 → ImMessageShapeError（全中文、指名字段、规则码 [IM-02-1]）', () => {
    const broken = mockPayload()
    delete (broken as Partial<MockInboundPayload>).msgId
    try {
      new MockImChannelAdapter().parseInbound(broken)
      expect.unreachable('应抛 ImMessageShapeError')
    } catch (error) {
      expect(error).toBeInstanceOf(ImMessageShapeError)
      const e = error as ImMessageShapeError
      expect(e.ruleCode).toBe('IM-02-1')
      expect(e.message).toContain('msgId')
      expect(e.message).toContain('[IM-02-1]')
    }
  })

  it('非法值：text 无正文 / binding 无验证码 / chatType 非法 / 键字段含“|”均拒绝', () => {
    const mock = new MockImChannelAdapter()
    expect(() => mock.parseInbound(mockPayload({ text: undefined }))).toThrow(ImMessageShapeError)
    expect(() => mock.parseInbound(mockPayload({ msgType: 'binding', verificationCode: undefined }))).toThrow(
      ImMessageShapeError,
    )
    expect(() => mock.parseInbound(mockPayload({ chatType: 'channel' as never }))).toThrow(ImMessageShapeError)
    // 键字段含 '|' → 去重键歧义风险，直接拒绝（IM-06 键安全）
    expect(() => mock.parseInbound(mockPayload({ app: 'a|b' }))).toThrow(ImMessageShapeError)
  })
})

describe('② IM-16 真实验签解密/凭据 = SITE_PENDING 桩（GAP-P2）', () => {
  it('wecom：验签/解密/access_token/jsapi_ticket 四桩全部抛 SitePendingImError [IM-16-1]', () => {
    const adapter = new WecomImChannelAdapter()
    expect(() => adapter.verifyInboundAuthenticity({})).toThrow(SitePendingImError)
    expect(() => adapter.decryptInboundPayload('cipher')).toThrow(SitePendingImError)
    expect(() => adapter.getAccessToken()).toThrow(SitePendingImError)
    expect(() => adapter.getJsapiTicket()).toThrow(SitePendingImError)
    try {
      adapter.verifyInboundAuthenticity({})
      expect.unreachable()
    } catch (error) {
      const e = error as SitePendingImError
      expect(e.ruleCode).toBe('IM-16-1')
      expect(e.message).toContain('SITE_PENDING')
      expect(e.message).toContain('不接通')
      expect(e.message).toContain('不落真实凭据')
      expect(e.message).toContain('不产生外呼')
    }
  })

  it('feishu：验签/解密/tenant_access_token 三桩同样抛 SitePendingImError', () => {
    const adapter = new FeishuImChannelAdapter()
    expect(() => adapter.verifyInboundAuthenticity({})).toThrow(SitePendingImError)
    expect(() => adapter.decryptInboundPayload('cipher')).toThrow(SitePendingImError)
    expect(() => adapter.getTenantAccessToken()).toThrow(SitePendingImError)
  })

  it('mock 渠道无外部签名面：验签闸门恒通过（不抛）', () => {
    expect(() => new MockImChannelAdapter().verifyInboundAuthenticity({})).not.toThrow()
  })
})

describe('③ IM-03 身份绑定存储（企业应用维度三元组键）', () => {
  const key = { channelKind: 'mock' as const, enterpriseAppRef: 'app-1', platformUserId: 'u-1' }

  it('未绑定 resolve → null；bind 后 resolve 命中；同键重复 bind=覆盖不叠加', async () => {
    const store = new InMemoryImIdentityBindingStore()
    expect(await store.resolve(key)).toBeNull()
    await store.bind(key, 'user-a', '2026-10-28T08:00:00Z')
    expect(await store.resolve(key)).toEqual({ userId: 'user-a' })
    await store.bind(key, 'user-b', '2026-10-28T09:00:00Z')
    expect(await store.resolve(key)).toEqual({ userId: 'user-b' })
    expect(store.size).toBe(1)
  })

  it('不同企业应用维度互不串扰（IM-03 键含 enterpriseAppRef）', async () => {
    const store = new InMemoryImIdentityBindingStore()
    await store.bind(key, 'user-a', '2026-10-28T08:00:00Z')
    expect(await store.resolve({ ...key, enterpriseAppRef: 'app-2' })).toBeNull()
  })

  it('unbind 返回是否确有绑定；键非法（空/含“|”）与空 userId 拒绝', async () => {
    const store = new InMemoryImIdentityBindingStore()
    expect(await store.unbind(key)).toBe(false)
    await store.bind(key, 'user-a', '2026-10-28T08:00:00Z')
    expect(await store.unbind(key)).toBe(true)
    expect(await store.resolve(key)).toBeNull()
    await expect(
      store.bind({ ...key, enterpriseAppRef: 'a|b' }, 'user-a', '2026-10-28T08:00:00Z'),
    ).rejects.toThrow('[IM-03-4]')
    await expect(store.bind({ ...key, platformUserId: '' }, 'user-a', '2026-10-28T08:00:00Z')).rejects.toThrow(
      '[IM-03-4]',
    )
    await expect(store.bind(key, '', '2026-10-28T08:00:00Z')).rejects.toThrow('[IM-03-4]')
  })
})

describe('④ IM-06/07 处理记录存储：claim 原子占位与生命周期推进', () => {
  const key = { channelKind: 'mock' as const, enterpriseAppRef: 'app-1', platformMessageId: 'm-1' }

  it('首受理建记录（received）；同键再 claim → duplicate 且复用同一记录、丢弃计数递增', async () => {
    const store = new InMemoryImProcessingRecordStore()
    const first = await store.claim(key, '2026-10-28T08:00:00Z')
    expect(first.duplicate).toBe(false)
    expect(first.record.phases).toEqual([{ phase: 'received', at: '2026-10-28T08:00:00Z' }])
    const second = await store.claim(key, '2026-10-28T08:05:00Z')
    const third = await store.claim(key, '2026-10-28T08:06:00Z')
    expect(second.duplicate).toBe(true)
    expect(third.duplicate).toBe(true)
    expect(second.record).toBe(first.record) // IM-07：重试复用同一记录，不新建
    expect(first.record.duplicateDropCount).toBe(2)
    expect(store.size).toBe(1)
  })

  it('阶段推进/requestId/发送结果落记录；键组成 channelKind|enterpriseAppRef|platformMessageId', async () => {
    const store = new InMemoryImProcessingRecordStore()
    await store.claim(key, '2026-10-28T08:00:00Z')
    await store.appendPhase(key, 'turn_started', '2026-10-28T08:00:01Z', 'req-1')
    await store.setRequestId(key, 'req-1')
    await store.recordSendResult(key, { status: 'unknown', detail: 'IM-04-1 发送结果未知' })
    const record = await store.findByKey(key)
    expect(record?.requestId).toBe('req-1')
    expect(record?.phases.map((p) => p.phase)).toEqual(['received', 'turn_started'])
    expect(record?.sendResult).toEqual({ status: 'unknown', detail: 'IM-04-1 发送结果未知' })
    expect((await store.list()).length).toBe(1)
    expect(imMessageKeyString(key)).toBe('mock|app-1|m-1')
  })

  it('未受理先推进/记录 → 拒绝；非法键（空/含“|”）拒绝', async () => {
    const store = new InMemoryImProcessingRecordStore()
    await expect(store.appendPhase(key, 'sent', '2026-10-28T08:00:00Z')).rejects.toThrow('[IM-07-3]')
    expect(() => imMessageKeyString({ ...key, platformMessageId: 'a|b' })).toThrow('[IM-06-2]')
    expect(() => imMessageKeyString({ ...key, enterpriseAppRef: '' })).toThrow('[IM-06-2]')
  })
})

describe('⑤ IM-04 MockChannelSender：三态脚本化与捕获', () => {
  it('缺省恒 sent；脚本化按序产生 unknown/failed/sent，出站全捕获', async () => {
    const sender = new MockChannelSender()
    const message = {
      channelKind: 'mock' as const,
      conversationTarget: { kind: 'direct' as const, ref: 'chat-1' },
      content: { kind: 'answer' as const, text: '回答' },
    }
    expect(await sender.send(message)).toEqual({ status: 'sent' })
    sender.scriptOutcomes('unknown', 'failed')
    expect((await sender.send(message)).status).toBe('unknown')
    expect((await sender.send(message)).status).toBe('failed')
    expect((await sender.send(message)).status).toBe('sent') // 队列耗尽回落缺省
    expect(sender.captured.length).toBe(4)
    expect(sender.captured[0]?.content.kind).toBe('answer')
  })
})

describe('⑥ IM-01/16/17 结构断言：零业务依赖、不外呼、零凭据字段', () => {
  it('全包源码：无 @cadenza/* 业务依赖、无 HTTP 客户端/外呼、无 process.env 凭据读取', () => {
    const files = listSrcFiles(imSrcDir)
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      expect(
        src.match(/from\s+['"]@cadenza\/|require\(['"]@cadenza\/|node:http|node:https|\bfetch\s*\(|axios|process\.env/),
        `${file} 含越界依赖/外呼/凭据读取`,
      ).toBeNull()
    }
  })

  it('渠道适配器实例零凭据字段（仅 channelKind；IM-17：凭据只存服务端凭据配置）', () => {
    expect(Object.keys(new WecomImChannelAdapter())).toEqual(['channelKind'])
    expect(Object.keys(new FeishuImChannelAdapter())).toEqual(['channelKind'])
    expect(Object.keys(new MockImChannelAdapter())).toEqual(['channelKind'])
  })

  it('计数器快照含 IM-06 合同强制项 duplicate_dropped（缺省 0）', () => {
    const counters = new InMemoryImChannelEventCounters()
    counters.increment('duplicate_dropped')
    counters.increment('duplicate_dropped')
    const snapshot = counters.snapshot()
    expect(snapshot['duplicate_dropped']).toBe(2)
    expect(snapshot['group_intercepted']).toBe(0)
  })
})
