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
import { INVENTORY_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, VerifiedAuthContext } from '@cadenza/application'
import type { InventoryQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { INVENTORY_COMMAND_BUS, INVENTORY_QUERY_SERVICE } from './inventory.tokens'

/**
 * inventory 端点：查询（余额分页/按码解析候选/单元详情）+ 命令（收货/发料/移位/调拨两段/
 * 分盘/预留 acquire 与 release——dev 与上层模块共用的命令入口）。
 * 变更全部经命令总线（幂等 + 审计 + 事务，IT-19/21/22）；查询按数据范围服务端过滤（OA-24/25）。
 */
@Controller('inventory')
export class InventoryController {
  constructor(
    @Inject(INVENTORY_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(INVENTORY_QUERY_SERVICE) private readonly queries: InventoryQueryService,
  ) {}

  // ---------------- 查询 ----------------

  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_READ)
  @PlantParam('plantId')
  @Get('balances')
  listBalances(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('unitNoLike') unitNoLike?: string,
    @Query('materialCode') materialCode?: string,
    @Query('includeClosed') includeClosed?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listBalances(auth, {
      plantId,
      unitNoLike,
      materialCode,
      includeClosed: includeClosed === 'true',
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_READ)
  @Get('barcode/:value/resolve')
  resolveBarcode(@CurrentAuth() auth: VerifiedAuthContext, @Param('value') value: string) {
    return this.queries.resolveBarcode(auth, value)
  }

  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_READ)
  @Get('units')
  async unitDetail(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('unitId') unitId?: string,
    @Query('unitNo') unitNo?: string,
  ) {
    const detail = await this.queries.unitDetail(auth, { unitId, unitNo })
    if (detail === null) {
      // 查无此单元或不在授权数据范围（不可见语义统一 404，OA-24/25）
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '库存单元不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  // ---------------- 命令（数量字段一律十进制字符串，IT-07） ----------------

  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_POST)
  @Post('business-holds')
  establishBusinessHold(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('inventory.business-hold.establish','new',body,auth,req)
  }


  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_POST)
  @Post('receive')
  receive(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('inventory.receive-goods', 'new', body, auth, req)
  }

  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_POST)
  @Post('issue')
  issue(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('inventory.issue-material', (bodyAsRecord(body)['unitId'] as string) ?? 'unknown', body, auth, req)
  }

  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_POST)
  @Post('return')
  returnMaterial(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    // T11 原料退料：领用/投料后未用余料退回仓库（movement_kind='reverse' 反向行，防超退守恒）
    return this.run('inventory.return-material', (bodyAsRecord(body)['unitId'] as string) ?? 'unknown', body, auth, req)
  }

  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_POST)
  @Post('move')
  move(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('inventory.move-stock', (bodyAsRecord(body)['unitId'] as string) ?? 'unknown', body, auth, req)
  }

  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_POST)
  @Post('transfer/out')
  transferOut(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('inventory.transfer.out', (bodyAsRecord(body)['unitId'] as string) ?? 'unknown', body, auth, req)
  }

  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_POST)
  @Post('transfer/in')
  transferIn(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('inventory.transfer.in', (bodyAsRecord(body)['unitId'] as string) ?? 'unknown', body, auth, req)
  }

  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_POST)
  @Post('split')
  split(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('inventory.split', (bodyAsRecord(body)['sourceUnitId'] as string) ?? 'unknown', body, auth, req)
  }

  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_RESERVE)
  @Post('reservations')
  acquireReservation(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('inventory.reservation.acquire', (bodyAsRecord(body)['unitId'] as string) ?? 'unknown', body, auth, req)
  }

  @RequirePermission(INVENTORY_PERMISSIONS.INVENTORY_RESERVE)
  @HttpCode(HttpStatus.OK)
  @Post('reservations/release')
  releaseReservation(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('inventory.reservation.release', (bodyAsRecord(body)['reservationId'] as string) ?? 'unknown', body, auth, req)
  }

  // ---------------- 命令执行（同 org.controller 口径） ----------------

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
      expectedRevision: 0, // 内核域未启用乐观修订列（同 org 域口径，合同信封形状保留）
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
        if (result.errorCode === ERROR_CODES.INSUFFICIENT_STOCK) {
          // 余量竞争的可解释拒绝（IT-30-①：无负库存；重试换新 operationId 重新校验）
          throw commandError(HttpStatus.CONFLICT, result)
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
