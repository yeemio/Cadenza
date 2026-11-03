/**
 * 渠道事件编排服务（IM-06/07/08/10/11/12/13 落地点，frozen/p4/im-channels.md §2~§4）。
 *
 * 单一入站处理序（每条消息）：
 *   适配器验签闸门（非 mock 渠道，IM-16 SITE_PENDING 桩拒绝）
 *   → 统一消息解析（IM-02）→ 去重受理（IM-06 键 = channelKind|enterpriseAppRef|platformMessageId，
 *     命中即幂等丢弃：可观测计数 + 复用同一记录推进 duplicate_dropped，不进问数/不回复）
 *   → 群目标一律拦截（IM-10/11：不创建问数轮，固定引导语，处理记录留拦截）
 *   → 消息路由：binding/unbind（用户主动显式动作，IM-03）｜text（问数流）
 *   → 问数流：身份解析（未绑定 → no_permission + 绑定引导，AQ-AUTH-05）
 *     → ai_session 登记（IM-12 四元划分键，A 线接缝）
 *     → requestId（AR-15：新轮 randomUUID；澄清续轮复用同一 requestId，AQ-AMB-04）
 *     → 问数轮（DS-23 接缝；DS-11 cancelled 不再发送）
 *     → 发送前再检（IM-08：目的地=提问者本人会话结构校验 + 权限实时重验接缝；
 *       拒发 → 不发送，sent_result_status='not_sent' 计审计，AQ-S2）
 *     → 发送端口（IM-04：unknown 不冒称送达、不自动补发）→ 发送结果回写审计（AQ-S2 接缝）。
 */
import { randomUUID } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import {
  AI_AUDIT_SEND_RESULT_PORT,
  AI_QUERY_SESSION_PORT,
  AI_QUERY_TURN_PORT,
  IM_ACCESS_RECHECK_PORT,
  IM_BINDING_VERIFICATION_PORT,
  IM_CHANNEL_ADAPTERS,
  IM_CHANNEL_EVENT_COUNTERS,
  IM_IDENTITY_BINDING_PORT,
  IM_PROCESSING_RECORD_STORE,
  IM_SEND_PORT,
} from './im.tokens'
import type {
  AiAuditSendResultPort,
  AiQuerySessionPort,
  AiQueryTurnPort,
  ImAccessRecheckPort,
  ImBindingVerificationPort,
  ImChannelAdapterPort,
  ImChannelEventCounter,
  ImChannelEventCountersPort,
  ImIdentityBindingPort,
  ImMessageKey,
  ImProcessingRecordStorePort,
  ImSendPort,
  InboundChannelMessage,
  OutboundChannelMessage,
} from './im.ports'

/** 回调端点应答（mock 平台契约：受理即 200，重复回调同样 200 以止推）。 */
export interface ImCallbackResult {
  received: true
  messageKey: string
  outcome:
    | 'duplicate_dropped'
    | 'group_intercepted'
    | 'binding_ok'
    | 'binding_rejected'
    | 'unbound_guidance'
    | 'unbind_done'
    | 'unbind_noop'
    | 'clarify'
    | 'answer'
    | 'unavailable'
    | 'cancelled'
    | 'turn_error'
}

/** IM-10 b) 固定引导语（群目标一律引导进个人会话）。 */
export const IM_GROUP_GUIDANCE_TEXT =
  '群会话暂不开放业务数据查询（群内提问不等于全群成员有权查看提问者可见的数据）。请点击我的头像发起个人会话（单聊）提问，我会在个人会话中答复。[IM-10-1]'

/** IM-03/AQ-AUTH-05：未绑定 → no_permission + 绑定引导文案。 */
export const IM_UNBOUND_GUIDANCE_TEXT =
  '当前平台身份未绑定 Cadence 账号，暂无问数权限（no_permission）。请在 Cadence 网页端「问数设置」生成绑定码，然后回到本会话发送该绑定码完成绑定。[IM-03-1]'

export const IM_BINDING_OK_TEXT =
  '绑定成功。绑定只完成平台身份与账号的对应，不等于授权——每次查询仍会按你的账号权限实时校验。'
export const IM_BINDING_REJECTED_TEXT =
  '绑定码无效或已过期，请在 Cadence 网页端重新生成后再发送。[IM-03-2]'
export const IM_UNBIND_DONE_TEXT = '已解除本平台身份与 Cadence 账号的绑定。'
export const IM_UNBIND_NOOP_TEXT = '当前平台身份未绑定账号，无需解绑。'

@Injectable()
export class ImChannelEventService {
  /** 澄清挂起状态（sessionKey → requestId）：澄清轮后续消息复用同一 requestId（AQ-AMB-04/DS-08）。 */
  private readonly pendingClarifications = new Map<string, { requestId: string }>()

  constructor(
    @Inject(IM_CHANNEL_ADAPTERS) private readonly adapters: ImChannelAdapterPort[],
    @Inject(IM_SEND_PORT) private readonly sender: ImSendPort,
    @Inject(IM_IDENTITY_BINDING_PORT) private readonly bindings: ImIdentityBindingPort,
    @Inject(IM_PROCESSING_RECORD_STORE) private readonly records: ImProcessingRecordStorePort,
    @Inject(IM_CHANNEL_EVENT_COUNTERS) private readonly counters: ImChannelEventCountersPort,
    @Inject(AI_QUERY_SESSION_PORT) private readonly sessions: AiQuerySessionPort,
    @Inject(AI_QUERY_TURN_PORT) private readonly turns: AiQueryTurnPort,
    @Inject(AI_AUDIT_SEND_RESULT_PORT) private readonly audit: AiAuditSendResultPort,
    @Inject(IM_ACCESS_RECHECK_PORT) private readonly recheck: ImAccessRecheckPort,
    @Inject(IM_BINDING_VERIFICATION_PORT) private readonly verification: ImBindingVerificationPort,
  ) {}

  /** 渠道回调入口（controller 调用；验签闸门在 parse 之前，IM-16）。 */
  async handleChannelCallback(
    channelKind: string,
    payload: unknown,
  ): Promise<ImCallbackResult> {
    const adapter = this.adapters.find((a) => a.channelKind === channelKind)
    if (!adapter) {
      throw new UnknownImChannelError(channelKind)
    }
    adapter.verifyInboundAuthenticity(payload) // IM-16：非 mock 渠道 SITE_PENDING 桩在此抛出
    const message = adapter.parseInbound(payload)

    const key: ImMessageKey = {
      channelKind: message.channelKind,
      enterpriseAppRef: message.enterpriseAppRef,
      platformMessageId: message.platformMessageId,
    }
    const claim = await this.records.claim(key, message.receivedAt)
    if (claim.duplicate) {
      // IM-06：重复回调幂等丢弃（可观测计数），复用同一处理记录推进，不新建、不回复
      this.counters.increment('duplicate_dropped')
      await this.records.appendPhase(key, 'duplicate_dropped', nowIso(), 'IM-06-1 幂等丢弃')
      return { received: true, messageKey: claim.record.messageKey, outcome: 'duplicate_dropped' }
    }

    // IM-10/11：群目标一律拦截（提问与绑定/解绑动作均不放行），不创建问数轮
    if (message.conversationTarget.kind === 'group') {
      this.counters.increment('group_intercepted')
      await this.records.appendPhase(key, 'group_intercepted', nowIso(), 'IM-11-1 群目标不创建问数轮')
      await this.sendWithoutRecheck(message, {
        kind: 'guidance',
        text: IM_GROUP_GUIDANCE_TEXT,
        status: 'intercepted',
      })
      return { received: true, messageKey: claim.record.messageKey, outcome: 'group_intercepted' }
    }

    if (message.messageType === 'binding') return this.handleBinding(message, key)
    if (message.messageType === 'unbind') return this.handleUnbind(message, key)
    return this.handleQuestion(message, key)
  }

  stats(): Record<ImChannelEventCounter, number> {
    return this.counters.snapshot()
  }

  // ---------------- 绑定/解绑（IM-03：用户主动显式动作 + 验证） ----------------

  private async handleBinding(
    message: InboundChannelMessage,
    key: ImMessageKey,
  ): Promise<ImCallbackResult> {
    if (message.content.kind !== 'binding') {
      throw new Error('绑定路由收到非绑定消息 [IM-03-4]')
    }
    const verified = await this.verification.verifyBindingCode(message.content.verificationCode, {
      channelKind: message.channelKind,
      platformUserId: message.platformUserId,
    })
    const bindingKey = {
      channelKind: message.channelKind,
      enterpriseAppRef: message.enterpriseAppRef,
      platformUserId: message.platformUserId,
    }
    if (!verified) {
      this.counters.increment('binding_rejected')
      await this.records.appendPhase(key, 'binding_rejected', nowIso(), 'IM-03-2 绑定码无效')
      await this.sendWithoutRecheck(message, {
        kind: 'notice',
        text: IM_BINDING_REJECTED_TEXT,
        status: 'no_permission',
      })
      return { received: true, messageKey: keyString(key), outcome: 'binding_rejected' }
    }
    await this.bindings.bind(bindingKey, verified.userId, nowIso())
    this.counters.increment('binding_ok')
    await this.records.appendPhase(key, 'binding_verified', nowIso())
    await this.sendWithoutRecheck(message, { kind: 'notice', text: IM_BINDING_OK_TEXT })
    return { received: true, messageKey: keyString(key), outcome: 'binding_ok' }
  }

  private async handleUnbind(
    message: InboundChannelMessage,
    key: ImMessageKey,
  ): Promise<ImCallbackResult> {
    const removed = await this.bindings.unbind({
      channelKind: message.channelKind,
      enterpriseAppRef: message.enterpriseAppRef,
      platformUserId: message.platformUserId,
    })
    this.counters.increment('unbind')
    await this.records.appendPhase(key, removed ? 'unbind_done' : 'unbind_noop', nowIso())
    await this.sendWithoutRecheck(message, {
      kind: 'notice',
      text: removed ? IM_UNBIND_DONE_TEXT : IM_UNBIND_NOOP_TEXT,
    })
    return { received: true, messageKey: keyString(key), outcome: removed ? 'unbind_done' : 'unbind_noop' }
  }

  // ---------------- 问数流（IM-08/12/13；AR-15） ----------------

  private async handleQuestion(
    message: InboundChannelMessage,
    key: ImMessageKey,
  ): Promise<ImCallbackResult> {
    if (message.content.kind !== 'text') {
      throw new Error('问数路由收到非文本消息 [IM-02-3]')
    }
    const bindingKey = {
      channelKind: message.channelKind,
      enterpriseAppRef: message.enterpriseAppRef,
      platformUserId: message.platformUserId,
    }
    const resolved = await this.bindings.resolve(bindingKey)
    if (!resolved) {
      // IM-03/AQ-AUTH-05：未绑定 → no_permission + 引导绑定（不创建会话/问数轮）
      this.counters.increment('unbound_guidance')
      await this.records.appendPhase(key, 'identity_unresolved', nowIso(), 'IM-03-1 未绑定')
      await this.sendWithoutRecheck(message, {
        kind: 'guidance',
        text: IM_UNBOUND_GUIDANCE_TEXT,
        status: 'no_permission',
      })
      return { received: true, messageKey: keyString(key), outcome: 'unbound_guidance' }
    }
    const { userId } = resolved

    // IM-12：会话按 租户/用户/渠道/会话目标 四元划分（A 线接缝承载；不同渠道不自动拼接历史）
    const session = await this.sessions.ensureSession({
      userId,
      channel: message.channelKind,
      conversationRef: message.conversationTarget.ref,
    })

    // AR-15/AQ-AMB-04：澄清挂起时复用同一 requestId 延续本轮
    const sessionKey = `${userId}|${message.channelKind}|${message.conversationTarget.ref}`
    const pending = this.pendingClarifications.get(sessionKey)
    const requestId = pending?.requestId ?? randomUUID()
    await this.records.setRequestId(key, requestId)
    await this.records.appendPhase(key, 'turn_started', nowIso(), requestId)

    let turn
    try {
      turn = await this.turns.submitTurn({
        requestId,
        sessionId: session.sessionId,
        userMessage: message.content.text,
        timeBasis: { timeZone: 'Asia/Shanghai' },
      })
    } catch (error) {
      // AR-12：转发失败按可理解状态回（不重试放大、不伪装成功）
      this.pendingClarifications.delete(sessionKey)
      this.counters.increment('turn_error')
      await this.records.appendPhase(key, 'turn_error', nowIso(), describeError(error))
      await this.sendTurnResultWithRecheck(message, key, requestId, userId, {
        kind: 'notice',
        text: `AI 问数暂时无法完成本轮处理，请稍后重试。[IM-07-2]（${describeError(error)}）`,
        status: 'unavailable',
      })
      return { received: true, messageKey: keyString(key), outcome: 'turn_error' }
    }

    switch (turn.outcome) {
      case 'clarify': {
        this.counters.increment('turn_clarify')
        this.pendingClarifications.set(sessionKey, { requestId })
        await this.sendTurnResultWithRecheck(message, key, requestId, userId, {
          kind: 'clarify',
          text: turn.message ?? '请补充确认：',
          options: turn.options ?? [],
        })
        await this.records.appendPhase(key, 'clarify_sent', nowIso())
        return { received: true, messageKey: keyString(key), outcome: 'clarify' }
      }
      case 'answer': {
        this.pendingClarifications.delete(sessionKey)
        this.counters.increment('turn_answer')
        await this.sendTurnResultWithRecheck(message, key, requestId, userId, {
          kind: 'answer',
          text: turn.message ?? '',
        })
        return { received: true, messageKey: keyString(key), outcome: 'answer' }
      }
      case 'unavailable': {
        this.pendingClarifications.delete(sessionKey)
        this.counters.increment('turn_unavailable')
        await this.sendTurnResultWithRecheck(message, key, requestId, userId, {
          kind: 'notice',
          text: `AI 问数暂不可用（原因：${turn.statusDetail ?? 'unreachable'}），请稍后重试。[IM-07-2]`,
          status: 'unavailable',
        })
        return { received: true, messageKey: keyString(key), outcome: 'unavailable' }
      }
      case 'cancelled': {
        // DS-11：取消后不得再产生发送动作
        this.pendingClarifications.delete(sessionKey)
        this.counters.increment('turn_cancelled')
        await this.records.appendPhase(key, 'cancelled', nowIso())
        return { received: true, messageKey: keyString(key), outcome: 'cancelled' }
      }
    }
  }

  // ---------------- 发送路径 ----------------

  /**
   * 问数轮结果发送（IM-08 发送前再检）：目的地结构校验（提问者本人会话）+ 权限实时重验；
   * 未通过 → 不发送，sent_result_status='not_sent' 回写审计；通过 → 发送端口 + 结果回写
   * （sent→'sent'，unknown→'send_unknown' 不冒称，failed→'failed'）。
   */
  private async sendTurnResultWithRecheck(
    asker: InboundChannelMessage,
    key: ImMessageKey,
    requestId: string,
    userId: string,
    content: OutboundChannelMessage['content'],
  ): Promise<void> {
    const outbound: OutboundChannelMessage = {
      channelKind: asker.channelKind,
      conversationTarget: asker.conversationTarget,
      content,
    }
    const sameDestination =
      outbound.conversationTarget.kind === asker.conversationTarget.kind &&
      outbound.conversationTarget.ref === asker.conversationTarget.ref
    if (!sameDestination) {
      await this.notSent(key, requestId, '发送目的地与提问者本人会话不一致 [IM-08-2]')
      return
    }
    const permission = await this.recheck.recheck({
      requestId,
      userId,
      channelKind: asker.channelKind,
      conversationTarget: asker.conversationTarget,
    })
    if (!permission.allowed) {
      await this.notSent(key, requestId, `发送前权限再检未通过：${permission.reason} [IM-08-1]`)
      return
    }
    await this.sendAndRecord(key, requestId, outbound)
  }

  /** 引导/提示发送（无问数轮、无 userId 或不含业务数据）：不经再检，仅记录发送结果。 */
  private async sendWithoutRecheck(
    asker: InboundChannelMessage,
    content: OutboundChannelMessage['content'],
  ): Promise<void> {
    await this.sender.send({
      channelKind: asker.channelKind,
      conversationTarget: asker.conversationTarget,
      content,
    })
  }

  private async notSent(key: ImMessageKey, requestId: string, reason: string): Promise<void> {
    // IM-08/IM-13：撤权等再检未通过 → 不发送，审计 not_sent（AQ-S2 值域）
    this.counters.increment('not_sent')
    await this.records.appendPhase(key, 'not_sent', nowIso(), reason)
    await this.audit.recordSendResult({ requestId, sentResultStatus: 'not_sent', detail: reason })
  }

  private async sendAndRecord(
    key: ImMessageKey,
    requestId: string,
    outbound: OutboundChannelMessage,
  ): Promise<void> {
    const result = await this.sender.send(outbound)
    await this.records.recordSendResult(key, result)
    if (result.status === 'sent') {
      this.counters.increment('sent')
      await this.records.appendPhase(key, 'sent', nowIso())
      await this.audit.recordSendResult({ requestId, sentResultStatus: 'sent' })
      return
    }
    if (result.status === 'unknown') {
      // IM-04：unknown 不冒称严格送达、不自动补发——保持 unknown 落记录与审计，供人工核对
      this.counters.increment('send_unknown')
      await this.records.appendPhase(
        key,
        'send_unknown',
        nowIso(),
        result.detail ?? 'IM-04-1 发送结果未知（不自动补发）',
      )
      await this.audit.recordSendResult({
        requestId,
        sentResultStatus: 'send_unknown',
        detail: result.detail ?? 'IM-04-1 发送结果未知（不自动补发）',
      })
      return
    }
    this.counters.increment('send_failed')
    await this.records.appendPhase(key, 'send_failed', nowIso(), result.detail)
    await this.audit.recordSendResult({
      requestId,
      sentResultStatus: 'failed',
      detail: result.detail,
    })
  }
}

/** 未知渠道类型（controller 映射 400 [IM-02-2]）。 */
export class UnknownImChannelError extends Error {
  constructor(readonly channelKind: string) {
    super(`未知渠道类型“${channelKind}”（期望 wecom/feishu/mock）[IM-02-2]`)
    this.name = 'UnknownImChannelError'
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function keyString(key: ImMessageKey): string {
  return `${key.channelKind}|${key.enterpriseAppRef}|${key.platformMessageId}`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
