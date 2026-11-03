/**
 * A/B 线接缝的首版 mock 承载（IM-15：mock 双向通道承载全部合同行为）。
 *
 * [L0-整合标记] 以下五个类是 im.ports.ts「A/B 线接缝端口」的 mock 实现：
 * - MockAiQuerySessionPort ← A 线 ai_session 登记流（AQ-S3；IM-12 四元划分键在此承载）；
 * - MockAiQueryTurnPort ← 接入层问数轮（转发 apps/ai，DS-23 turns 形状）；
 * - MockAiAuditSendResultPort ← A 线 ai_query_audit 发送结果回写（AQ-S2）；
 * - MockImAccessRecheckPort ← A 线权限实时重验（AQ-AUTH-01 口径，IM-08 发送前再检）；
 * - MockBindingCodeVerifier ← 网页端绑定码签发/校验（IM-03 验证）。
 * L0 整合时以真实实现替换（ai_session 落库、内部 HTTP 转发 apps/ai、审计 UPDATE、
 * SessionVerifier 重算、网页端发码）；本文件保留为测试/演示承载。全部不访问网络、不依赖 DB。
 */
import { randomUUID } from 'node:crypto'
import type {
  AiAuditSendResultPort,
  AiQuerySessionPort,
  AiQueryTurnPort,
  ImAccessRecheckPort,
  ImBindingVerificationPort,
} from './im.ports'

/**
 * ai_session 首版承载（AQ-S3 形状）：会话按 租户/用户/渠道/会话目标 四元划分（IM-12）——
 * mock 以 userId|channel|conversationRef 为键（userId 隐含租户维度，A 线落库时补 enterprise_id）；
 * 同键复用同一 sessionId（last_active 语义由 A 线承载），不同键绝不共享会话。
 */
export class MockAiQuerySessionPort implements AiQuerySessionPort {
  private readonly sessions = new Map<string, { sessionId: string; status: 'open' }>()

  static sessionKey(userId: string, channel: string, conversationRef: string): string {
    return `${userId}|${channel}|${conversationRef}`
  }

  async ensureSession(input: {
    userId: string
    channel: 'wecom' | 'feishu' | 'mock'
    conversationRef: string
  }): Promise<{ sessionId: string; status: 'open' }> {
    const key = MockAiQuerySessionPort.sessionKey(input.userId, input.channel, input.conversationRef)
    const existing = this.sessions.get(key)
    if (existing) return { sessionId: existing.sessionId, status: existing.status }
    const created = { sessionId: randomUUID(), status: 'open' as const }
    this.sessions.set(key, created)
    return { sessionId: created.sessionId, status: created.status }
  }

  /** 观测用：当前会话键清单（测试断言四元划分）。 */
  sessionKeys(): string[] {
    return [...this.sessions.keys()]
  }
}

/** DS-23 turns 首版承载：确定性脚本——新 requestId 首次提交返回 clarify，同 requestId 续轮返回 answer；可脚本强制 unavailable/cancelled/异常。 */
export class MockAiQueryTurnPort implements AiQueryTurnPort {
  /** 强制脚本：按提交顺序消费；元素为终态 outcome 或 Error（抛出）。 */
  private readonly script: Array<'answer' | 'clarify' | 'unavailable' | 'cancelled' | Error> = []
  private readonly seenRequestIds = new Set<string>()

  scriptOutcome(...outcomes: Array<'answer' | 'clarify' | 'unavailable' | 'cancelled' | Error>): void {
    this.script.push(...outcomes)
  }

  async submitTurn(input: {
    requestId: string
    sessionId: string
    userMessage: string
    timeBasis: { timeZone: 'Asia/Shanghai' }
  }): Promise<{
    outcome: 'answer' | 'clarify' | 'unavailable' | 'cancelled'
    message?: string
    options?: string[]
    answerRefs?: string[]
    statusDetail?: string
  }> {
    const forced = this.script.shift()
    if (forced instanceof Error) throw forced
    if (forced === 'unavailable') {
      return { outcome: 'unavailable', statusDetail: 'unreachable' }
    }
    if (forced === 'cancelled') return { outcome: 'cancelled' }
    if (forced === 'answer' || forced === 'clarify') {
      return forced === 'answer' ? mockAnswer() : mockClarify()
    }
    // 默认确定性脚本：澄清轮（AQ-AMB-01 候选清单语义）→ 续轮回答（AQ-AMB-04 同 requestId 延续）
    if (this.seenRequestIds.has(input.requestId)) return mockAnswer()
    this.seenRequestIds.add(input.requestId)
    return mockClarify()
  }
}

function mockClarify(): {
  outcome: 'clarify'
  message: string
  options: string[]
} {
  return {
    outcome: 'clarify',
    message: '找到多张可能相关的生产订单，请确认要查询哪一张：',
    options: ['PO-2026-0001（苏州厂·进行中）', 'PO-2026-0002（合肥厂·已下达）'],
  }
}

function mockAnswer(): { outcome: 'answer'; message: string; answerRefs: string[] } {
  return {
    outcome: 'answer',
    message:
      '【mock 首版承载】生产订单 PO-2026-0001 当前状态：进行中。数字、来源、时间范围与完整性标注由接入层受控查询结果信封（AQ-REG-07）提供；本回答文本为 mock 承载示例。',
    answerRefs: ['aq.order-progress#mock'],
  }
}

/** AQ-S2 回写首版承载：捕获回写调用供断言（sent/send_unknown/failed/not_sent）。 */
export class MockAiAuditSendResultPort implements AiAuditSendResultPort {
  readonly recorded: Array<{
    requestId: string
    sentResultStatus: 'sent' | 'send_unknown' | 'failed' | 'not_sent'
    detail?: string
  }> = []

  async recordSendResult(input: {
    requestId: string
    sentResultStatus: 'sent' | 'send_unknown' | 'failed' | 'not_sent'
    detail?: string
  }): Promise<void> {
    this.recorded.push({ ...input })
  }
}

/** IM-08 再检首版承载：按 userId 脚本化 allow/deny（撤权证据用）。缺省恒 allow。 */
export class MockImAccessRecheckPort implements ImAccessRecheckPort {
  private readonly deniedUsers = new Map<string, string>()

  deny(userId: string, reason: string): void {
    this.deniedUsers.set(userId, reason)
  }

  allow(userId: string): void {
    this.deniedUsers.delete(userId)
  }

  async recheck(input: {
    userId: string
    channelKind: 'wecom' | 'feishu' | 'mock'
    conversationTarget: { kind: 'direct' | 'group'; ref: string }
  }): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const reason = this.deniedUsers.get(input.userId)
    return reason ? { allowed: false, reason } : { allowed: true }
  }
}

/** IM-03 绑定码首版承载：测试/演示签发（真实承载=im.real-seams.ts DbBindingCodeVerifier）。 */
export class MockBindingCodeVerifier implements ImBindingVerificationPort {
  private readonly codes = new Map<string, string>()

  issue(code: string, userId: string): void {
    this.codes.set(code, userId)
  }

  async verifyBindingCode(code: string): Promise<{ userId: string } | null> {
    const userId = this.codes.get(code)
    return userId ? { userId } : null
  }
}
