import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Param, Post } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ERROR_CODES } from '@cadenza/contracts'
import type { VerifiedAuthContext } from '@cadenza/application'
// L0 整合步（未执行前的 dist 相对导入桥接，同 aiquery.composition 注释）：domain aiquery 面未并入包名入口。
import { AIQUERY_PERMISSIONS } from '@cadenza/domain'
import type {
  AiAskCancelResponseDto,
  AiAskTurnResponseDto,
  AiClarifyOptionDto,
  AiQueryHealthResponseDto,
} from '@cadenza/contracts'
import { CurrentAuth, Public, RequirePermission } from '../auth/decorators'
import { AIQUERY_RUNTIME_CLIENT, AIQUERY_SERVICE, AIQUERY_TURN_CONTEXT } from './aiquery.tokens'
import type { AiQueryService } from '@cadenza/application'
import type { AiRuntimeClient } from './aiquery.runtime-client'
import type { AiTurnContext } from './aiquery.turn-context'

/**
 * 用户面问数轮端点（P4-A 补充任务新增；dsh-edge.md §5 DS-23/DS-24 经接入层透传）：
 *
 * - POST /aiquery/turns：鉴权（OA 会话 + aiquery.use）→ 会话归属校验 → 转发 apps/ai
 *   runTurn（DS-23 形状 + timeBasis Asia/Shanghai）→ outcome 四态映射（AR-12 转发超时上限内）；
 *   requestId 由接入层采纳/生成（UI 预生成仅为在途取消关联，回执为准，AQ-REG-06）；
 *   澄清答复轮（clarifyOptionId）由接入层本地解析——服务端绑定 confirm 精确参数后经本线
 *   execute 通道重执行（A 线不调用模型，AR-01），同一 requestId 延续（AQ-AMB-04）。
 * - POST /aiquery/turns/:requestId/cancel：鉴权 + 归属校验（轮次登记的会话属于该用户）→
 *   转发 apps/ai cancel（DS-11）。
 * - GET /aiquery/health：代理 apps/ai /ai-runtime/health（AR-03：终端不直连；AR-11 降级判定源；
 *   不可达返回明确 unavailable 形状而非 5xx 裸抛）。
 *
 * 用户面 wire 形状与 packages/ui/src/api/p4/types.ts（P4-UI 线冻结面）逐字段一致。
 * 模块不挂载 app.module.ts（AR-02），supertest 自组装取证，L0 整合步统一注册。
 */
@Controller()
export class AiQueryTurnsController {
  constructor(
    @Inject(AIQUERY_SERVICE) private readonly service: AiQueryService,
    @Inject(AIQUERY_TURN_CONTEXT) private readonly turnContext: AiTurnContext,
    @Inject(AIQUERY_RUNTIME_CLIENT) private readonly runtime: AiRuntimeClient,
  ) {}

  // ---------------- 健康探测（AR-11 降级判定源；不要求用户会话） ----------------

  @Public()
  @HttpCode(HttpStatus.OK)
  @Get('aiquery/health')
  async health(): Promise<AiQueryHealthResponseDto> {
    const result = await this.runtime.health()
    if (!result.ok) {
      return {
        status: 'unavailable',
        reason: 'unreachable',
        message: `AI 问数暂不可用（AI 运行服务不可达：${result.detail ?? '未知原因'}）[AR-11]`,
      }
    }
    return { status: 'ok', runtime: result.runtime ?? null }
  }

  // ---------------- 问数轮（DS-23 四态透传 + AQ-AMB-04 澄清轮） ----------------

  @RequirePermission(AIQUERY_PERMISSIONS.USE)
  @HttpCode(HttpStatus.OK)
  @Post('aiquery/turns')
  async askTurn(@CurrentAuth() auth: VerifiedAuthContext, @Body() body: unknown): Promise<AiAskTurnResponseDto> {
    const record = (body ?? {}) as Record<string, unknown>
    const sessionId = record['sessionId']
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: 'sessionId 缺失', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    // requestId：采纳 UI 预生成 UUID（在途取消关联，DS-11）；缺失/非法由接入层生成（AR-15；回执为准）
    const requestIdRaw = record['requestId']
    const requestId =
      typeof requestIdRaw === 'string' && /^[0-9a-fA-F-]{36}$/.test(requestIdRaw) ? requestIdRaw : randomUUID()
    const userMessage = typeof record['userMessage'] === 'string' ? record['userMessage'] : ''
    const clarifyOptionId =
      typeof record['clarifyOptionId'] === 'string' && record['clarifyOptionId'] !== '' ? record['clarifyOptionId'] : null
    if (userMessage.length === 0 && clarifyOptionId === null) {
      throw new HttpException(
        {
          code: ERROR_CODES.BUSINESS_RULE,
          message: 'userMessage 与 clarifyOptionId 至少提供一项（澄清答复轮由 clarifyOptionId 承载选择）',
          details: {},
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    // 会话归属（可信身份：会话须属于当前用户且 open；DS-18 404 语义）
    const session = await this.service.findOpenSession(sessionId).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AiSessionNotFoundError') return null
      throw error
    })
    if (session === null) {
      throw new HttpException(
        { code: 'ERR_AI_SESSION_NOT_FOUND', message: 'AI 会话不存在或已失效', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    if (session.userId !== auth.user.id) {
      throw new HttpException(
        { code: ERROR_CODES.FORBIDDEN_SCOPE, message: '该 AI 会话不属于当前用户', details: {} },
        HttpStatus.FORBIDDEN,
      )
    }

    // ---- 澄清答复轮（AQ-AMB-01/04）：接入层本地解析选项 → confirm 精确参数 → 本线 execute 重执行 ----
    if (clarifyOptionId !== null) {
      const option = this.turnContext.consumeClarifyOption(requestId, clarifyOptionId)
      if (option === null) {
        throw new HttpException(
          {
            code: ERROR_CODES.BUSINESS_RULE,
            message: '澄清选项不存在或已过期（同一轮 requestId 的选项在确认后失效），请重新提问',
            details: { clarifyOptionId },
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }
      const capabilityVersion = await this.service.findEnabledVersion(session.enterpriseId, option.capabilityId)
      if (capabilityVersion === null) {
        return {
          requestId,
          outcome: 'unavailable',
          message: `[AQ-REG-01] 该问数能力未注册或已停用：${option.capabilityId}（澄清选项引用的能力不可用，请重新提问）`,
          envelope: null,
          options: null,
          unavailableReason: null,
          statusDetail: { resolvedBy: 'clarify_confirm', capabilityId: option.capabilityId },
        }
      }
      const toolCallSeq = (await this.service.maxToolCallSeq(requestId)) + 1
      const envelope = await this.service.execute({
        requestId,
        toolCallSeq,
        sessionId,
        capabilityId: option.capabilityId,
        capabilityVersion,
        params: option.params,
      })
      this.turnContext.registerEnvelope(requestId, toolCallSeq, envelope)
      return {
        requestId,
        outcome: 'answer',
        message: envelope.message,
        envelope,
        options: null,
        unavailableReason: null,
        statusDetail: { resolvedBy: 'clarify_confirm', capabilityId: option.capabilityId, toolCallSeq },
      }
    }

    // ---- 常规轮：转发 apps/ai（DS-23 形状 + timeBasis Asia/Shanghai；AR-12 超时上限） ----
    this.turnContext.registerTurn(requestId, {
      sessionId,
      userId: auth.user.id,
      enterpriseId: session.enterpriseId,
    })
    const forwarded = await this.runtime.runTurn({ requestId, sessionId, userMessage })
    if (forwarded.unreachable) {
      return {
        requestId,
        outcome: 'unavailable',
        message: 'AI 问数暂不可用（AI 运行服务不可达）[AR-11/DS-24]',
        envelope: null,
        options: null,
        unavailableReason: 'unreachable',
        statusDetail: { reason: 'unreachable', detail: forwarded.detail },
      }
    }
    const turn = forwarded.response

    if (turn.outcome === 'unavailable') {
      const status = (turn.statusDetail as { status?: unknown })?.['status']
      const reason = status === 'over_limit' || status === 'starting' ? status : null
      return {
        requestId,
        outcome: 'unavailable',
        message: turn.message ?? 'AI 问数暂不可用 [AR-11]',
        envelope: null,
        options: null,
        unavailableReason: reason,
        statusDetail: turn.statusDetail ?? null,
      }
    }
    if (turn.outcome === 'clarify') {
      const options: AiClarifyOptionDto[] = (turn.options ?? []).map((o) => ({
        id: o.id,
        label: o.label,
        detail: (o.detail ?? null) as Record<string, string> | null,
        confirm: o.confirm ?? null,
      }))
      this.turnContext.registerClarifyOptions(requestId, options)
      return {
        requestId,
        outcome: 'clarify',
        message: turn.message ?? '需要澄清：请从选项中选择',
        envelope: null,
        options,
        unavailableReason: null,
        statusDetail: turn.statusDetail ?? null,
      }
    }
    if (turn.outcome === 'cancelled') {
      return {
        requestId,
        outcome: 'cancelled',
        message: turn.message ?? '该轮已取消',
        envelope: null,
        options: null,
        unavailableReason: null,
        statusDetail: turn.statusDetail ?? null,
      }
    }

    // outcome=answer：answerRefs 不含完整 data——按 auditRef 取回穿透时登记的六段信封（末个引用优先）
    const answerRefs = turn.answerRefs ?? []
    const lastRef = answerRefs[answerRefs.length - 1]
    const envelope =
      (lastRef !== undefined ? this.turnContext.envelopeOf(lastRef.auditRef.requestId, lastRef.auditRef.toolCallSeq) : null) ??
      this.turnContext.lastEnvelopeOf(requestId)
    return {
      requestId,
      outcome: 'answer',
      message: turn.message ?? (envelope !== null ? envelope.message : '已回答'),
      envelope,
      options: null,
      unavailableReason: null,
      statusDetail: turn.statusDetail ?? null,
    }
  }

  // ---------------- 取消在途轮次（DS-11） ----------------

  @RequirePermission(AIQUERY_PERMISSIONS.USE)
  @HttpCode(HttpStatus.OK)
  @Post('aiquery/turns/:requestId/cancel')
  async cancelTurn(@CurrentAuth() auth: VerifiedAuthContext, @Param('requestId') requestId: string): Promise<AiAskCancelResponseDto> {
    const turn = this.turnContext.turnOf(requestId)
    if (turn === null) {
      // 接入层未受理过该轮（apps/ai 亦不会有——全部轮次经接入层进入，AR-03）
      return { status: 'cancelled', decision: 'unknown_request' }
    }
    if (turn.userId !== auth.user.id) {
      throw new HttpException(
        { code: ERROR_CODES.FORBIDDEN_SCOPE, message: '该问数轮不属于当前用户', details: {} },
        HttpStatus.FORBIDDEN,
      )
    }
    const result = await this.runtime.cancelTurn(requestId)
    if (!result.ok) {
      // apps/ai 不可达：无法确认运行侧取消——如实标注（不伪装已确认）
      return { status: 'cancelled', decision: 'runtime_unreachable' }
    }
    return { status: 'cancelled', decision: result.decision }
  }
}
