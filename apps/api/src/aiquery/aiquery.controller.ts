import { Body, Controller, HttpCode, HttpException, HttpStatus, Inject, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { ERROR_CODES } from '@cadenza/contracts'
import type { VerifiedAuthContext } from '@cadenza/application'
// L0 整合步（未执行前的 dist 相对导入桥接，同 composition 注释）：domain aiquery 面未并入包名入口。
import { AIQUERY_PERMISSIONS } from '@cadenza/domain'
import { CurrentAuth, Public, RequirePermission } from '../auth/decorators'
import { AIQUERY_INTERNAL_TOKEN, AIQUERY_RUNTIME_CLIENT, AIQUERY_SERVICE, AIQUERY_TURN_CONTEXT } from './aiquery.tokens'
import type { AiQueryService } from '@cadenza/application'
import type { AiRuntimeClient } from './aiquery.runtime-client'
import type { AiTurnContext } from './aiquery.turn-context'

/**
 * aiquery 接入层端点（P4-A；dsh-edge.md §4 DS-18/DS-19 + AR-01 会话归属）：
 *
 * - POST /aiquery/sessions：会话登记（用户令牌 + aiquery.use；AQ-S3 身份绑定与审计锚点）；
 * - POST /internal/aiquery/capabilities：能力枚举（内部服务令牌；AQ-REG-05 许可预检 +
 *   §8 未就绪问法族清单；会话不存在/失效 → 404 ERR_AI_SESSION_NOT_FOUND）；
 * - POST /internal/aiquery/execute：受控查询执行（内部服务令牌；七状态信封 AQ-REG-07；
 *   请求体 tenant/user/scope 字段忽略并记审计 AQ-REG-06；服务令牌不构成权限来源——
 *   权限按会话绑定用户实时重算 AQ-AUTH-01）。
 *
 * 内部端点以 @Public 跳过用户会话守卫，改由部署配置的内部服务令牌认证（DS-18/19）；
 * 模块不挂载 app.module.ts（AR-02），运行时证据由测试自组装取证，L0 整合步统一注册。
 */
@Controller()
export class AiQueryController {
  constructor(
    @Inject(AIQUERY_SERVICE) private readonly service: AiQueryService,
    @Inject(AIQUERY_INTERNAL_TOKEN) private readonly internalToken: string,
    @Inject(AIQUERY_TURN_CONTEXT) private readonly turnContext: AiTurnContext,
    @Inject(AIQUERY_RUNTIME_CLIENT) private readonly runtime: AiRuntimeClient,
  ) {}

  // ---------------- 会话登记（用户令牌；AR-01 接入层会话归属） ----------------

  @RequirePermission(AIQUERY_PERMISSIONS.USE)
  @Post('aiquery/sessions')
  async openSession(@CurrentAuth() auth: VerifiedAuthContext, @Body() body: unknown) {
    const record = (body ?? {}) as Record<string, unknown>
    const channel = record['channel']
    const ALLOWED_CHANNELS = ['web', 'pda', 'wecom', 'feishu', 'mock'] as const
    if (typeof channel !== 'string' || !ALLOWED_CHANNELS.includes(channel as (typeof ALLOWED_CHANNELS)[number])) {
      throw new HttpException(
        {
          code: ERROR_CODES.BUSINESS_RULE,
          message: `channel 非法：${String(channel)}（须为 ${ALLOWED_CHANNELS.join('/')} 之一）`,
          details: {},
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    const conversationRefRaw = record['conversationRef']
    const conversationRef =
      typeof conversationRefRaw === 'string' && conversationRefRaw.length > 0 ? conversationRefRaw : null
    // enterpriseId/userId 一律由会话绑定派生（AQ-AUTH-04）；请求体同名参数不采纳
    const session = await this.service.openSession({
      enterpriseId: auth.user.enterpriseId,
      userId: auth.user.id,
      channel: channel as (typeof ALLOWED_CHANNELS)[number],
      conversationRef,
    })
    // DS-23：建 ai_session 后向 apps/ai 同步登记运行时会话索引（best-effort——B 不可达不阻断
    // 会话建立；此处仅索引不赋权，轮次转发时若仍不可达按 unavailable 降级，AR-11）
    void this.runtime
      .registerSession({
        sessionId: session.id,
        enterpriseId: session.enterpriseId,
        userId: session.userId,
        channel: session.channel,
        conversationRef: session.conversationRef,
      })
      .catch(() => undefined)
    return {
      sessionId: session.id,
      enterpriseId: session.enterpriseId,
      userId: session.userId,
      channel: session.channel,
      status: session.status,
    }
  }

  // ---------------- 内部端点（部署内部服务令牌；DS-18/DS-19） ----------------

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('internal/aiquery/capabilities')
  async capabilities(@Req() req: Request, @Body() body: unknown) {
    this.assertInternalToken(req)
    const record = (body ?? {}) as Record<string, unknown>
    const sessionId = record['sessionId']
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: 'sessionId 缺失（DS-18 请求体 { sessionId }）', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    try {
      return await this.service.listCapabilities(sessionId)
    } catch (error) {
      throw this.mapServiceError(error)
    }
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('internal/aiquery/execute')
  async execute(@Req() req: Request, @Body() body: unknown) {
    this.assertInternalToken(req)
    const record = (body ?? {}) as Record<string, unknown>
    const requestId = record['requestId']
    const toolCallSeq = record['toolCallSeq']
    const sessionId = record['sessionId']
    const capabilityId = record['capabilityId']
    const capabilityVersion = record['capabilityVersion']
    if (typeof requestId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(requestId)) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: 'requestId 缺失或非 UUID（DS-19 请求体）', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    if (typeof toolCallSeq !== 'number' || !Number.isInteger(toolCallSeq) || toolCallSeq < 1) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: 'toolCallSeq 须为 ≥1 整数（DS-19 请求体）', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: 'sessionId 缺失（DS-19 请求体）', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    if (typeof capabilityId !== 'string' || capabilityId.length === 0) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: 'capabilityId 缺失（DS-19 请求体）', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    if (typeof capabilityVersion !== 'number' || !Number.isInteger(capabilityVersion) || capabilityVersion < 1) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: 'capabilityVersion 须为 ≥1 整数（DS-19 请求体）', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    const paramsRaw = record['params']
    const params = typeof paramsRaw === 'object' && paramsRaw !== null ? (paramsRaw as Record<string, unknown>) : {}

    // AQ-REG-06：请求体携带的 tenant/user/scope 等执行上下文字段一律以服务端绑定为准，
    // 发现即忽略并记审计（不可由模型替换）
    const ignoredRequestFields = IGNORED_BODY_FIELDS.filter((key) => record[key] !== undefined)

    try {
      const envelope = await this.service.execute({
        requestId,
        toolCallSeq,
        sessionId,
        capabilityId,
        capabilityVersion,
        params,
        ignoredRequestFields,
      })
      // 轮次信封登记（answerRefs 不含完整 data：轮次应答按 auditRef 取回组装给 UI，DS-23/AR-15）
      this.turnContext.registerEnvelope(requestId, toolCallSeq, envelope)
      return envelope
    } catch (error) {
      throw this.mapServiceError(error)
    }
  }

  // ---------------- 内部工具 ----------------

  /** 内部服务令牌校验（部署配置 env AIQUERY_INTERNAL_TOKEN；令牌不构成权限来源，AR-10/DS-18）。 */
  private assertInternalToken(req: Request): void {
    const header = req.headers['authorization']
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new HttpException(
        {
          code: ERROR_CODES.AUTH_REQUIRED,
          message: '未提供内部服务凭据（Authorization: Bearer <internal-token>，部署配置 AIQUERY_INTERNAL_TOKEN）',
          details: {},
        },
        HttpStatus.UNAUTHORIZED,
      )
    }
    const token = header.slice('Bearer '.length).trim()
    if (this.internalToken === '' || token !== this.internalToken) {
      throw new HttpException(
        {
          code: ERROR_CODES.AUTH_REQUIRED,
          message: '内部服务令牌无效（服务令牌仅作内部调用认证，不构成权限来源——权限按会话绑定用户实时重算）',
          details: {},
        },
        HttpStatus.UNAUTHORIZED,
      )
    }
  }

  private mapServiceError(error: unknown): HttpException {
    if (error instanceof Error && error.name === 'AiSessionNotFoundError') {
      return new HttpException(
        { code: 'ERR_AI_SESSION_NOT_FOUND', message: 'AI 会话不存在或已失效', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    if (error instanceof HttpException) return error
    return new HttpException(
      { code: 'ERR_INTERNAL', message: '服务器内部错误', details: {} },
      HttpStatus.INTERNAL_SERVER_ERROR,
    )
  }
}

/** DS-19 声明字段之外的执行上下文字段（出现即忽略并记审计，AQ-REG-06）。 */
const IGNORED_BODY_FIELDS: readonly string[] = [
  'tenantId',
  'tenant',
  'enterpriseId',
  'userId',
  'user',
  'scope',
  'dataScope',
  'channel',
  'permissions',
  'conversationRef',
]
