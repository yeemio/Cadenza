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
// L0 整合步（Wave5）：domain/application index 已导出 warehousing 面；改包名导入。
import { WAREHOUSING_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, VerifiedAuthContext, WarehousingQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { WAREHOUSING_COMMAND_BUS, WAREHOUSING_QUERY_SERVICE } from './warehousing.tokens'

/**
 * warehousing 端点（T13 入库/移库/调拨）：
 * - 查询：待入库任务分页（台账只读）、移库记录分页、调拨单分页/详情（两段事实行）；
 * - 命令：入库任务刷新（端口重跑）、组单确认入库、移库、调拨创建/提交/出库/在途/接收
 *   ——全部经命令总线（幂等+审计+事务），数量字段一律十进制字符串。
 * 挂全局守卫（AuthGuard/ScopeGuard）；查询按数据范围服务端过滤（OA-24/25）。
 */
@Controller('warehousing')
export class WarehousingController {
  constructor(
    @Inject(WAREHOUSING_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(WAREHOUSING_QUERY_SERVICE) private readonly queries: WarehousingQueryService,
  ) {}

  // ---------------- 查询 ----------------

  @RequirePermission(WAREHOUSING_PERMISSIONS.WAREHOUSING_READ)
  @PlantParam('plantId')
  @Get('putaway-tasks')
  listPutawayTasks(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('sourceTypes') sourceTypes?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listPutawayTasks(auth, {
      plantId,
      statuses: statuses?.split(','),
      sourceTypes: sourceTypes?.split(','),
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(WAREHOUSING_PERMISSIONS.WAREHOUSING_READ)
  @PlantParam('plantId')
  @Get('moves')
  listMoves(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('unitNoLike') unitNoLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listMoves(auth, { plantId, unitNoLike, page: toNumber(page), pageSize: toNumber(pageSize) })
  }

  @RequirePermission(WAREHOUSING_PERMISSIONS.WAREHOUSING_READ)
  @PlantParam('plantId')
  @Get('transfers')
  listTransfers(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('orderNoLike') orderNoLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listTransferOrders(auth, {
      plantId,
      statuses: statuses?.split(','),
      orderNoLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(WAREHOUSING_PERMISSIONS.WAREHOUSING_READ)
  @Get('transfers/:id')
  async transferDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.transferDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '调拨单不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  // ---------------- 命令 ----------------

  @RequirePermission(WAREHOUSING_PERMISSIONS.WAREHOUSING_POST)
  @Post('putaway/refresh')
  putawayRefresh(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('warehousing.putaway.refresh', bodyAsRecord(body)['plantId'] as string ?? 'plant', body, auth, req)
  }

  @RequirePermission(WAREHOUSING_PERMISSIONS.WAREHOUSING_POST)
  @Post('putaway/confirm')
  putawayConfirm(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'warehousing.putaway.confirm',
      (bodyAsRecord(body)['palletCode'] as string) ?? (bodyAsRecord(body)['toLocationCode'] as string) ?? 'putaway',
      body,
      auth,
      req,
    )
  }

  @RequirePermission(WAREHOUSING_PERMISSIONS.WAREHOUSING_POST)
  @Post('moves')
  moveExecute(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'warehousing.move.execute',
      (bodyAsRecord(body)['unitId'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  @RequirePermission(WAREHOUSING_PERMISSIONS.WAREHOUSING_POST)
  @Post('transfers')
  transferCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('warehousing.transfer.create', 'transfer', body, auth, req)
  }

  @RequirePermission(WAREHOUSING_PERMISSIONS.WAREHOUSING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfers/submit')
  transferSubmit(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'warehousing.transfer.submit',
      (bodyAsRecord(body)['transferOrderId'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  @RequirePermission(WAREHOUSING_PERMISSIONS.WAREHOUSING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfers/ship')
  transferShip(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'warehousing.transfer.ship',
      (bodyAsRecord(body)['lineId'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  @RequirePermission(WAREHOUSING_PERMISSIONS.WAREHOUSING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfers/transit')
  transferTransit(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'warehousing.transfer.transit',
      (bodyAsRecord(body)['transferOrderId'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  @RequirePermission(WAREHOUSING_PERMISSIONS.WAREHOUSING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfers/receive')
  transferReceive(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'warehousing.transfer.receive',
      (bodyAsRecord(body)['lineId'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  // ---------------- 命令执行（同 inventory/purchase/quality.controller 口径） ----------------

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
      expectedRevision: 0, // warehousing 域未启用乐观修订列（同 org/inventory/purchase 口径）
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

function bodyAsRecord(body: unknown): Record<string, unknown> {
  return (body ?? {}) as Record<string, unknown>
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : undefined
}
