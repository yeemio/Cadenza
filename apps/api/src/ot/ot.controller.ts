import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import type { Request } from 'express'
import { randomUUID } from 'node:crypto'
import {
  CommandResultStatus,
  ERROR_CODES,
  type CommandEnvelope,
  type CommandResult,
} from '@cadenza/contracts'
// [L0-整合标记] ot 许可常量位于 domain ot 面（未并入包名入口，dist 相对桥接同 composition 注释）
import { OT_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, VerifiedAuthContext } from '@cadenza/application'
import type { OtQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { OT_COMMAND_BUS, OT_QUERY_SERVICE } from './ot.tokens'

/**
 * ot 端点（T21 设备与仪器采集）：
 * - 查询（ot.read）：网关/网关事件/设备/点位/样本明细（OT-25：必须按设备收敛）/
 *   汇总投影（带更新时间与延迟标注）/映射/事实/统计/监控总览（OT-29）；
 * - 命令（ot.post）：网关注册/心跳/巡检、设备绑定、点位字典、质量码映射、单位换算、
 *   样本批量入池（遥测通道只读 OT-03）、会话人工关联、汇总显式重建、
 *   业务映射登记/评估/人工确认（OT-26 走正常命令链路）。
 * 无任何控制指令下发端点（OT-01）；采集值不冒充质量放行（OT-02）。
 */
@Controller('ot')
export class OtController {
  constructor(
    @Inject(OT_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(OT_QUERY_SERVICE) private readonly queries: OtQueryService,
  ) {}

  // ---------------- 查询 ----------------

  @RequirePermission(OT_PERMISSIONS.OT_READ)
  @PlantParam('plantId')
  @Get('gateways')
  listGateways(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listGateways(auth, { plantId, status, page: toNumber(page), pageSize: toNumber(pageSize) })
  }

  @RequirePermission(OT_PERMISSIONS.OT_READ)
  @Get('gateways/:code/events')
  gatewayEvents(@CurrentAuth() auth: VerifiedAuthContext, @Param('code') code: string) {
    return this.queries.gatewayEvents(auth, code)
  }

  @RequirePermission(OT_PERMISSIONS.OT_READ)
  @PlantParam('plantId')
  @Get('devices')
  listDevices(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('gatewayCode') gatewayCode?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listDevices(auth, { plantId, gatewayCode, page: toNumber(page), pageSize: toNumber(pageSize) })
  }

  @RequirePermission(OT_PERMISSIONS.OT_READ)
  @Get('points')
  async listPoints(@CurrentAuth() auth: VerifiedAuthContext, @Query('deviceSerial') deviceSerial?: string) {
    if (deviceSerial === undefined || deviceSerial === '') {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 deviceSerial 查询参数', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    return this.queries.listPoints(auth, deviceSerial)
  }

  /** OT-25：样本明细按设备收敛（页面不扫高频原始点位）；OT-22：坏点/偏差可查带原因。 */
  @RequirePermission(OT_PERMISSIONS.OT_READ)
  @Get('samples')
  async listSamples(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('deviceSerial') deviceSerial?: string,
    @Query('pointCode') pointCode?: string,
    @Query('qualityLevel') qualityLevel?: string,
    @Query('isBad') isBad?: string,
    @Query('isClockSkew') isClockSkew?: string,
    @Query('isLate') isLate?: string,
    @Query('isQuarantined') isQuarantined?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (deviceSerial === undefined || deviceSerial === '') {
      throw new HttpException(
        {
          code: ERROR_CODES.BUSINESS_RULE,
          message: '[OT-25] 样本明细查询必须按设备收敛（deviceSerial 必填）——页面不扫高频原始点位',
          details: {},
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    try {
      return await this.queries.listSamples(auth, {
        deviceSerial,
        pointCode,
        qualityLevel,
        isBad: toBool(isBad),
        isClockSkew: toBool(isClockSkew),
        isLate: toBool(isLate),
        isQuarantined: toBool(isQuarantined),
        from,
        to,
        page: toNumber(page),
        pageSize: toNumber(pageSize),
      })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[OT-25]')) {
        throw new HttpException(
          { code: ERROR_CODES.BUSINESS_RULE, message: error.message, details: {} },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }
      throw error
    }
  }

  @RequirePermission(OT_PERMISSIONS.OT_READ)
  @PlantParam('plantId')
  @Get('aggregates')
  listAggregates(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('deviceSerial') deviceSerial?: string,
    @Query('pointCode') pointCode?: string,
    @Query('granularity') granularity?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listAggregates(auth, {
      plantId,
      deviceSerial,
      pointCode,
      granularity,
      from,
      to,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(OT_PERMISSIONS.OT_READ)
  @PlantParam('plantId')
  @Get('mappings')
  listMappings(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('deviceSerial') deviceSerial?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listMappings(auth, { plantId, deviceSerial, page: toNumber(page), pageSize: toNumber(pageSize) })
  }

  @RequirePermission(OT_PERMISSIONS.OT_READ)
  @PlantParam('plantId')
  @Get('facts')
  listFacts(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('mappingId') mappingId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listFacts(auth, { plantId, mappingId, status, page: toNumber(page), pageSize: toNumber(pageSize) })
  }

  @RequirePermission(OT_PERMISSIONS.OT_READ)
  @Get('stats')
  listStats(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('statDate') statDate?: string,
    @Query('gatewayCode') gatewayCode?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listStats(auth, { statDate, gatewayCode, page: toNumber(page), pageSize: toNumber(pageSize) })
  }

  /** OT-29 必监项总览（边缘离线/采集延迟含缺项 OT-28/积压溢出/去重异常）。 */
  @RequirePermission(OT_PERMISSIONS.OT_READ)
  @PlantParam('plantId')
  @Get('monitor')
  monitorOverview(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('dedupAlertThreshold') dedupAlertThreshold?: string,
  ) {
    return this.queries.monitorOverview(auth, {
      plantId,
      dedupAlertThreshold: toNumber(dedupAlertThreshold),
    })
  }

  // ---------------- 命令 ----------------

  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('gateway/register')
  gatewayRegister(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.gateway.register', bodyKey(body, 'gatewayCode') ?? 'gateway', body, auth, req)
  }

  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('gateway/heartbeat')
  gatewayHeartbeat(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.gateway.heartbeat', bodyKey(body, 'gatewayCode') ?? 'gateway', body, auth, req)
  }

  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('gateway/monitor')
  gatewayMonitor(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.gateway.monitor', 'gateway', body, auth, req)
  }

  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('device/bind')
  deviceBind(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.device.bind', bodyKey(body, 'deviceSerial') ?? 'device', body, auth, req)
  }

  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('point/upsert')
  pointUpsert(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.point.upsert', bodyKey(body, 'deviceSerial') ?? 'point', body, auth, req)
  }

  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('quality-map/upsert')
  qualityMapUpsert(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.quality-map.upsert', bodyKey(body, 'deviceSerial') ?? 'quality-map', body, auth, req)
  }

  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('conversion/upsert')
  conversionUpsert(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.conversion.upsert', 'conversion', body, auth, req)
  }

  /** 遥测批量入池（OT-03 遥测通道只读：不承载业务命令；OT-24 不写业务事件表）。 */
  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('samples/ingest')
  samplesIngest(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.samples.ingest', bodyKey(body, 'gatewayCode') ?? 'samples', body, auth, req)
  }

  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('session/link')
  sessionLink(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.session.link', bodyKey(body, 'sampleId') ?? 'session', body, auth, req)
  }

  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('aggregate/rebuild')
  aggregateRebuild(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.aggregate.rebuild', 'aggregate', body, auth, req)
  }

  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('mapping/upsert')
  mappingUpsert(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.mapping.upsert', bodyKey(body, 'pointCode') ?? 'mapping', body, auth, req)
  }

  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('mapping/evaluate')
  mappingEvaluate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.mapping.evaluate', bodyKey(body, 'mappingId') ?? 'mapping', body, auth, req)
  }

  @RequirePermission(OT_PERMISSIONS.OT_POST)
  @HttpCode(HttpStatus.OK)
  @Post('mapping/confirm')
  mappingConfirm(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('ot.mapping.confirm', bodyKey(body, 'factId') ?? 'mapping', body, auth, req)
  }

  // ---------------- 命令执行（同 shipping.controller 口径） ----------------

  private async run(
    commandType: string,
    targetId: string,
    body: unknown,
    auth: VerifiedAuthContext,
    req: Request,
  ): Promise<unknown> {
    const payload = (body ?? {}) as Record<string, unknown>
    const headerOperationId = req.headers['x-operation-id']
    const operationId =
      (typeof payload['operationId'] === 'string' && payload['operationId']) ||
      (typeof headerOperationId === 'string' && headerOperationId) ||
      randomUUID()
    const headerReason = req.headers['x-reason']
    const reason =
      (typeof payload['reason'] === 'string' && payload['reason']) ||
      (typeof headerReason === 'string' && headerReason) ||
      null

    const envelope: CommandEnvelope = {
      operationId,
      commandType,
      targetId,
      expectedRevision: 0, // ot 域未启用乐观修订列（同 org/inventory/shipping 口径）
      payload,
    }
    const context: CommandContext = {
      actorUserId: auth.user.id,
      actorLoginName: auth.user.loginName,
      enterpriseId: auth.user.enterpriseId,
      reason,
    }
    const result: CommandResult = await this.bus.execute(envelope, context)
    switch (result.status) {
      case CommandResultStatus.COMMITTED:
      case CommandResultStatus.DRAFT_SAVED:
        return { operationId: result.operationId, status: result.status, data: result.data ?? null }
      case CommandResultStatus.VERSION_CONFLICT:
        throw commandError(HttpStatus.CONFLICT, result)
      default:
        if (result.errorCode === ERROR_CODES.FORBIDDEN_SCOPE) {
          throw commandError(HttpStatus.FORBIDDEN, result)
        }
        if (result.errorCode === ERROR_CODES.NOT_FOUND) {
          throw commandError(HttpStatus.NOT_FOUND, result)
        }
        throw commandError(HttpStatus.UNPROCESSABLE_ENTITY, result)
    }
  }
}

function commandError(status: number, result: CommandResult): HttpException {
  return new HttpException(
    {
      code: result.errorCode ?? ERROR_CODES.BUSINESS_RULE,
      message: result.errorMessage ?? '业务规则拒绝',
      details: { operationId: result.operationId },
    },
    status,
  )
}

function bodyKey(body: unknown, key: string): string | undefined {
  const v = ((body ?? {}) as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : undefined
}

function toBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return undefined
}
