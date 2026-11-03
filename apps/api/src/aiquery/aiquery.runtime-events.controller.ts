import { Controller, Get, HttpCode, HttpStatus, Inject, Post, Query, Req, Body } from '@nestjs/common'
import type { Request } from 'express'
import { ERROR_CODES } from '@cadenza/contracts'
import { HttpException } from '@nestjs/common'
import { Public } from '../auth/decorators'
import { AIQUERY_INTERNAL_TOKEN, AIQUERY_SERVICE } from './aiquery.tokens'
import type { AiQueryService, AiRuntimeEventRecord } from '@cadenza/application'

/** Internal audit-anchor endpoint. Full user/model/tool records stay in apps/ai's data directory. */
const RUNTIME_EVENT_KINDS: readonly string[] = [
  'user_message',
  'model_turn',
  'tool_call',
  'clarify',
  'turn_outcome',
  'cancel',
  'session_lifecycle',
]

@Controller('internal/aiquery/runtime-events')
export class AiRuntimeEventController {
  constructor(
    @Inject(AIQUERY_SERVICE) private readonly service: AiQueryService,
    @Inject(AIQUERY_INTERNAL_TOKEN) private readonly internalToken: string,
  ) {}

  @Public()
  @HttpCode(HttpStatus.CREATED)
  @Post()
  async append(@Req() req: Request, @Body() body: unknown): Promise<unknown> {
    this.assertInternalToken(req)
    const record = (body ?? {}) as Record<string, unknown>
    const sessionId = record['sessionId']
    const event = record['event']
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: 'sessionId 缺失或非法（1~128 字符）', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: 'event 缺失或非对象（SessionEventRecord）', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    const eventRecord = event as Record<string, unknown>
    const kind = eventRecord['kind']
    const at = eventRecord['at']
    if (typeof kind !== 'string' || !RUNTIME_EVENT_KINDS.includes(kind)) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: `event.kind 非法：${String(kind)}`, details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: 'event.at 缺失或非 ISO-8601 时刻', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    const requestIdRaw = eventRecord['requestId']
    const requestId =
      typeof requestIdRaw === 'string' && /^[0-9a-fA-F-]{36}$/.test(requestIdRaw) ? requestIdRaw : null
    const stored = await this.service.appendRuntimeEvent({
      sessionId,
      kind: kind as AiRuntimeEventRecord['kind'],
      eventAt: new Date(at).toISOString(),
      requestId,
      event: eventRecord,
    })
    return { archived: true, contentStored: false, seq: stored.seq, id: stored.id }
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Get()
  async list(@Req() req: Request, @Query('sessionId') sessionId: string | undefined): Promise<unknown> {
    this.assertInternalToken(req)
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: 'sessionId 查询参数缺失', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    const rows = await this.service.listRuntimeEvents(sessionId)
    return {
      sessionId,
      total: rows.length,
      items: rows.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        at: row.eventAt,
        requestId: row.requestId,
        enterpriseId: row.enterpriseId,
        userId: row.userId,
        event: row.event,
      })),
    }
  }

  /** 内部服务令牌校验（同 execute 端点口径；令牌不构成权限来源，AR-10/DS-18）。 */
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
        { code: ERROR_CODES.AUTH_REQUIRED, message: '内部服务令牌无效', details: {} },
        HttpStatus.UNAUTHORIZED,
      )
    }
  }
}
