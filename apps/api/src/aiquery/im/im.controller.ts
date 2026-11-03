/**
 * im 渠道端点（L0 整合轮 2026-10-29 起随 ImModule 挂载 app.module.ts）。
 *
 * - POST /aiquery/im/channels/:channelKind/callback：渠道回调（mock 全流程；企微/飞书在
 *   验签闸门被 SITE_PENDING 桩拒绝 → 503，IM-16）。渠道回调为平台→服务端调用，
 *   不挂 OA 会话守卫（身份由消息→绑定解析，IM-03）——@Public 跳过用户会话守卫；
 *   通道鉴权由挂载层中间件承载（apps/api/src/aiquery/im/im.callback-guard.ts，env
 *   IM_CALLBACK_TOKEN；P4-C 交付记录 §2-7/§6-1 登记的 L0 挂载动作），测试自组装路径
 *   （无全局守卫/无挂载中间件）行为不变。
 * - GET /aiquery/im/stats：渠道事件可观测计数（IM-06 幂等丢弃可观测为合同强制项）。
 *
 * 错误形状对齐全局 AllExceptionsFilter { code, message, details }（先例）；
 * 挂载后走全局过滤器，控制器内映射保留（测试自组装路径同口径）。
 */
import { Body, Controller, Get, HttpException, HttpStatus, Inject, Param, Post } from '@nestjs/common'
import { Public } from '../../auth/decorators'
import { IM_CHANNEL_EVENT_COUNTERS } from './im.tokens'
import { ImChannelEventService } from './im.channel-event.service'
import type { ImChannelEventCounter, ImChannelEventCountersPort } from './im.ports'

@Controller('aiquery/im')
export class ImController {
  constructor(
    // 显式类令牌注入：vitest/esbuild 不发射 design:paramtypes，裸类型注入在测试自组装下不可解析
    //（A 线 AiQueryController 同型全显式 @Inject 先例）
    @Inject(ImChannelEventService)
    private readonly events: ImChannelEventService,
    @Inject(IM_CHANNEL_EVENT_COUNTERS)
    private readonly countersService: ImChannelEventCountersPort,
  ) {}

  @Public()
  @Post('channels/:channelKind/callback')
  async channelCallback(
    @Param('channelKind') channelKind: string,
    @Body() payload: unknown,
  ): Promise<unknown> {
    try {
      return await this.events.handleChannelCallback(channelKind, payload)
    } catch (error) {
      throw mapImError(error)
    }
  }

  @Get('stats')
  stats(): Record<ImChannelEventCounter, number> {
    return this.countersService.snapshot()
  }
}

interface ImErrorLike {
  name?: string
  message?: string
}

/** 错误映射：SITE_PENDING→503、形状→422、未知渠道→400、其余→500（不泄露堆栈）。 */
function mapImError(error: unknown): HttpException {
  const like = error as ImErrorLike
  const message = like?.message ?? '未知错误'
  if (like?.name === 'SitePendingImError') {
    return new HttpException(
      { code: 'ERR_IM_SITE_PENDING', message, details: {} },
      HttpStatus.SERVICE_UNAVAILABLE,
    )
  }
  if (like?.name === 'ImMessageShapeError') {
    return new HttpException(
      { code: 'ERR_IM_MESSAGE_SHAPE', message, details: {} },
      HttpStatus.UNPROCESSABLE_ENTITY,
    )
  }
  if (like?.name === 'UnknownImChannelError') {
    return new HttpException(
      { code: 'ERR_IM_UNKNOWN_CHANNEL', message, details: {} },
      HttpStatus.BAD_REQUEST,
    )
  }
  console.error('[aiquery/im] 未处理回调异常', error)
  return new HttpException(
    { code: 'ERR_INTERNAL', message: '服务器内部错误', details: {} },
    HttpStatus.INTERNAL_SERVER_ERROR,
  )
}
