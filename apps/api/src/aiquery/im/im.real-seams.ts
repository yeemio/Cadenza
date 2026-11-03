/**
 * im 接入子模块 A/B 线接缝的**真实实现**（P4 五内部接缝补齐轮 2026-10-30）。
 *
 * [五接缝真实承载] 以下五个类替换 im.mock-seams.ts 的首版 mock 承载（IM-15 形态），
 * 在 mock 外部渠道/模型下证明真实内部数据链（PM 增量单 2026-10-29 §4）：
 * - DbAiQuerySessionPort ← 接缝 1：ai_session 落库（AiQueryService.ensureImSession，
 *   IM-12 四元划分键；重启可查）+ 建行后向 apps/ai 同步登记运行时会话索引（DS-23，
 *   best-effort——B 不可达不阻断，轮次转发时按 unavailable 降级，AR-11 同 AiQueryController 先例）；
 * - ForwardingAiQueryTurnPort ← 接缝 4a：问数轮真实转发 apps/ai（DS-23 POST /ai-runtime/turns
 *   经 AiRuntimeClient；AR-12 超时上限；unreachable → unavailable 降级不伪装成功）；
 * - DbAiAuditSendResultPort ← 接缝 2：发送结果回写 ai_query_audit.sent_result_status（AQ-S2）；
 * - RecomputingImAccessRecheckPort ← 接缝 3：发送前按 SessionVerifier 同口径实时重验
 *   （AiQueryService.recheckUserAccess；AQ-AUTH-01/IM-08/IM-13——撤权后下一次即拒发）；
 * - DbBindingCodeVerifier ← 接缝 5：网页端签发的一次性绑定码核销（0030 ai_im_binding_code，
 *   一次性/有效期/撤销；IM-03 绑定由用户主动发起并经验证）。
 *
 * im.mock-seams.ts 保留为测试/演示承载（ImModule.register 缺省仍为 mock——测试自组装路径
 * 行为不变；挂载形态经 ImModule.registerDbBacked 以本文件真实实现覆盖）。
 */
import type { AiQueryService } from '@cadenza/application'
import type {
  AiAuditSendResultPort,
  AiQuerySessionPort,
  AiQueryTurnPort,
  ImAccessRecheckPort,
  ImBindingVerificationPort,
  ImChannelKind,
  InboundChannelMessage,
} from './im.ports'
import type { AiRuntimeClient } from '../aiquery.runtime-client'

/**
 * 接缝 1：ai_session 落库登记（同键复用同一行）+ 运行时会话索引同步（DS-23）。
 */
export class DbAiQuerySessionPort implements AiQuerySessionPort {
  constructor(
    private readonly service: AiQueryService,
    private readonly runtime: AiRuntimeClient,
  ) {}

  async ensureSession(input: {
    userId: string
    channel: ImChannelKind
    conversationRef: string
  }): Promise<{ sessionId: string; status: 'open' | 'closed' | 'expired' }> {
    const session = await this.service.ensureImSession({
      userId: input.userId,
      channel: input.channel,
      conversationRef: input.conversationRef,
    })
    // DS-23 运行时会话索引（best-effort；不赋权——权限每轮重验，AQ-AUTH-01）
    void this.runtime
      .registerSession({
        sessionId: session.id,
        enterpriseId: session.enterpriseId,
        userId: session.userId,
        channel: session.channel,
        conversationRef: session.conversationRef,
      })
      .catch(() => undefined)
    return { sessionId: session.id, status: session.status }
  }
}

/** 接缝 4a 轮次应答（DS-23 四态映射到 AiQueryTurnPort 形状；options 取 label 投影）。 */
export interface ForwardedTurnResult {
  outcome: 'answer' | 'clarify' | 'unavailable' | 'cancelled'
  message?: string
  options?: string[]
  answerRefs?: string[]
  statusDetail?: string
}

/** 接缝 4a：问数轮真实转发 apps/ai（DS-23；AR-12 转发超时上限内）。 */
export class ForwardingAiQueryTurnPort implements AiQueryTurnPort {
  constructor(
    private readonly runtime: AiRuntimeClient,
    /** ERR_AI_SESSION_NOT_FOUND 重试前的会话索引补登记（接缝 1 同口径；可选）。 */
    private readonly reregister?: (sessionId: string) => Promise<boolean>,
  ) {}

  async submitTurn(input: {
    requestId: string
    sessionId: string
    userMessage: string
    timeBasis: { timeZone: 'Asia/Shanghai' }
  }): Promise<ForwardedTurnResult> {
    let result = await this.runtime.runTurn({
      requestId: input.requestId,
      sessionId: input.sessionId,
      userMessage: input.userMessage,
    })
    // apps/ai 无该会话索引（如建行时 B 不可达）→ 补登记后重试一次（不放大重试，AR-12）
    if (!result.unreachable && result.response.statusDetail?.['code'] === 'ERR_AI_SESSION_NOT_FOUND') {
      const reregistered = this.reregister === undefined ? false : await this.reregister(input.sessionId)
      if (reregistered) {
        result = await this.runtime.runTurn({
          requestId: input.requestId,
          sessionId: input.sessionId,
          userMessage: input.userMessage,
        })
      }
    }
    if (result.unreachable) {
      return { outcome: 'unavailable', statusDetail: 'unreachable' }
    }
    const turn = result.response
    return {
      outcome: turn.outcome,
      message: turn.message,
      options: turn.options?.map((option) => option.label),
      answerRefs: turn.answerRefs?.map(
        (ref) => `${ref.capabilityId}#${ref.auditRef.requestId}/${String(ref.auditRef.toolCallSeq)}`,
      ),
      statusDetail: turn.statusDetail as unknown as string | undefined,
    }
  }
}

/** 接缝 2：发送结果回写 ai_query_audit（AQ-S2 四值；detail 由处理记录承载，库内不落正文）。 */
export class DbAiAuditSendResultPort implements AiAuditSendResultPort {
  constructor(private readonly service: AiQueryService) {}

  async recordSendResult(input: {
    requestId: string
    sentResultStatus: 'sent' | 'send_unknown' | 'failed' | 'not_sent'
    detail?: string
  }): Promise<void> {
    // 该 requestId 无审计行（轮次未产生任何受控查询，如 turn_error/unavailable）时为 0 行 no-op
    await this.service.recordSendResult(input.requestId, input.sentResultStatus)
  }
}

/** 接缝 3：发送前实时重验（SessionVerifier 同口径重算；IM-08 拒发 → not_sent 审计由调用方落）。 */
export class RecomputingImAccessRecheckPort implements ImAccessRecheckPort {
  constructor(private readonly service: AiQueryService) {}

  async recheck(input: {
    requestId: string
    userId: string
    channelKind: ImChannelKind
    conversationTarget: InboundChannelMessage['conversationTarget']
  }): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    return this.service.recheckUserAccess(input.userId, input.requestId)
  }
}

/** dev 预置绑定码（IM_MOCK_BINDING_CODES 兼容承载：值为 userId 或 login_name）。 */
export interface ImPresetBindingCode {
  code: string
  userIdOrLoginName: string
}

export function parsePresetBindingCodes(raw: string | undefined): ImPresetBindingCode[] {
  if (raw === undefined || raw.length === 0) return []
  return raw
    .split(',')
    .map((entry) => entry.split(':'))
    .filter((parts) => parts.length === 2 && parts[0].length > 0 && parts[1].length > 0)
    .map(([code, userIdOrLoginName]) => ({ code, userIdOrLoginName }))
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * 接缝 5：一次性绑定码核销（0030 表；sha-256 摘要命中 + issued 未过期 → 原子翻转 used，
 * 记录消费渠道与平台身份）。dev 预置码（IM_MOCK_BINDING_CODES）仅在挂载组合注入时生效，
 * 测试组合不注入 → 纯 DB 链路（预置值非 UUID 时按 login_name 解析真实用户）。
 */
export class DbBindingCodeVerifier implements ImBindingVerificationPort {
  constructor(
    private readonly service: AiQueryService,
    private readonly presets: readonly ImPresetBindingCode[] = [],
  ) {}

  async verifyBindingCode(
    code: string,
    context?: { channelKind: ImChannelKind; platformUserId: string },
  ): Promise<{ userId: string } | null> {
    const claimed = await this.service.claimImBindingCode(
      code,
      context?.channelKind ?? null,
      context?.platformUserId ?? null,
    )
    if (claimed !== null) return { userId: claimed.userId }
    // dev 预置码兼容（不落 DB、每次可用）
    const normalized = code.trim().toUpperCase()
    const preset = this.presets.find((p) => p.code === normalized)
    if (preset === undefined) return null
    if (UUID_PATTERN.test(preset.userIdOrLoginName)) return { userId: preset.userIdOrLoginName }
    const user = await this.service.findUserByLoginName(preset.userIdOrLoginName)
    return user === null ? null : { userId: user.id }
  }
}

/** 五接缝真实实现的组合工厂（ImModule.registerDbBacked 挂载与测试组合共用）。 */
export interface ImRealSeamDeps {
  service: AiQueryService
  runtime: AiRuntimeClient
  presets?: readonly ImPresetBindingCode[]
}

export function buildImRealSeams(deps: ImRealSeamDeps): {
  session: AiQuerySessionPort
  turn: AiQueryTurnPort
  audit: AiAuditSendResultPort
  recheck: ImAccessRecheckPort
  verification: ImBindingVerificationPort
} {
  const { service, runtime } = deps
  /** ERR_AI_SESSION_NOT_FOUND 补登记：ai_session 行仍在 → 重放 DS-23 索引登记。 */
  const reregister = async (sessionId: string): Promise<boolean> => {
    const session = await service
      .findOpenSession(sessionId)
      .then((row) => row)
      .catch(() => null)
    if (session === null) return false
    return runtime.registerSession({
      sessionId: session.id,
      enterpriseId: session.enterpriseId,
      userId: session.userId,
      channel: session.channel,
      conversationRef: session.conversationRef,
    })
  }
  return {
    session: new DbAiQuerySessionPort(service, runtime),
    turn: new ForwardingAiQueryTurnPort(runtime, reregister),
    audit: new DbAiAuditSendResultPort(service),
    recheck: new RecomputingImAccessRecheckPort(service),
    verification: new DbBindingCodeVerifier(service, deps.presets),
  }
}
