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
// [L0-整合标记] conversion 域许可常量位于 domain conversionform 面（未并入包名入口，
// dist 相对桥接同 composition 注释）；L0 整合后改包名导入。
import { CONVERSION_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, VerifiedAuthContext } from '@cadenza/application'
// [L0-整合标记] ConversionQueryService 位于 application conversion 面（未并入共享 index.ts，
// dist 相对导入桥接同 reporting.controller 先例）；L0 整合后改包名导入。
import type { ConversionQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { CONVERSION_COMMAND_BUS, CONVERSION_QUERY_SERVICE } from './conversion.tokens'

/**
 * conversionform 端点（T16 两种形态转换——FC-01 两协议分立）：
 * - 协议A（订单式，Web 建单 + PDA 扫码共用同命令）：查询 orders(/:id)；命令 order/create、
 *   update、delete、scan、scan-delete、complete、sync-retry；
 * - 协议B（库存式，仅 Web）：查询 stock-orders(/:id)、stock/candidates（FC-17 左侧源）；
 *   命令 stock/create、push、push-result、local-apply、reconvert、resync。
 * 挂全局守卫（AuthGuard/ScopeGuard；conversion.read/post 许可面）；查询按数据范围服务端
 * 过滤（OA-24/25）；数量/段长一律十进制字符串。
 */
@Controller('conversion')
export class ConversionController {
  constructor(
    @Inject(CONVERSION_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(CONVERSION_QUERY_SERVICE) private readonly queries: ConversionQueryService,
  ) {}

  // ---------------- 查询：协议A ----------------

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_READ)
  @PlantParam('plantId')
  @Get('orders')
  listOrderConversions(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('syncStatuses') syncStatuses?: string,
    @Query('conversionNoLike') conversionNoLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listOrderConversions(auth, {
      plantId,
      statuses: statuses?.split(','),
      syncStatuses: syncStatuses?.split(','),
      conversionNoLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_READ)
  @Get('orders/:id')
  async orderConversionDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.orderConversionDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '转换单不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  // ---------------- 查询：协议B ----------------

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_READ)
  @PlantParam('plantId')
  @Get('stock-orders')
  listStockConversions(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('displayStatuses') displayStatuses?: string,
    @Query('materialCodeLike') materialCodeLike?: string,
    @Query('targetSalesOrderNoLike') targetSalesOrderNoLike?: string,
    @Query('targetProjectNoLike') targetProjectNoLike?: string,
    @Query('conversionNoLike') conversionNoLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listStockConversions(auth, {
      plantId,
      displayStatuses: displayStatuses?.split(','),
      materialCodeLike,
      targetSalesOrderNoLike,
      targetProjectNoLike,
      conversionNoLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_READ)
  @Get('stock-orders/:id')
  async stockConversionDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.stockConversionDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '库存转换单不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_READ)
  @PlantParam('plantId')
  @Get('stock/candidates')
  listStockCandidates(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('materialId') materialId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('unitNoLike') unitNoLike?: string,
    @Query('palletCodeLike') palletCodeLike?: string,
  ) {
    if (plantId === undefined || materialId === undefined) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 plantId 或 materialId 查询参数', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    return this.queries.listStockCandidates(auth, { plantId, materialId, warehouseId, unitNoLike, palletCodeLike })
  }

  // ---------------- 命令：协议A ----------------

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @Post('order/create')
  orderCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.order.create', 'order', body, auth, req)
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('order/update')
  orderUpdate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.order.update', bodyKey(body, 'conversionOrderId') ?? 'order', body, auth, req)
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('order/delete')
  orderDelete(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.order.delete', bodyKey(body, 'conversionOrderId') ?? 'order', body, auth, req)
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('order/scan')
  orderScan(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.order.scan', bodyKey(body, 'unitNo') ?? 'scan', body, auth, req)
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('order/scan-delete')
  orderScanDelete(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.order.scan-delete', bodyKey(body, 'scanId') ?? 'scan', body, auth, req)
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('order/complete')
  orderComplete(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.order.complete', bodyKey(body, 'conversionOrderId') ?? 'order', body, auth, req)
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('order/sync-retry')
  orderSyncRetry(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.order.sync-retry', bodyKey(body, 'conversionOrderId') ?? 'sync', body, auth, req)
  }

  // ---------------- 命令：协议B ----------------

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @Post('stock/create')
  stockCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.stock.create', 'stock', body, auth, req)
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('stock/push')
  stockPush(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.stock.push', bodyKey(body, 'conversionStockOrderId') ?? 'stock', body, auth, req)
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('stock/push-result')
  stockPushResult(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.stock.push-result', bodyKey(body, 'conversionStockOrderId') ?? 'stock', body, auth, req)
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('stock/local-apply')
  stockLocalApply(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.stock.local-apply', bodyKey(body, 'conversionStockOrderId') ?? 'stock', body, auth, req)
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('stock/reconvert')
  stockReconvert(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.stock.reconvert', bodyKey(body, 'conversionStockOrderId') ?? 'stock', body, auth, req)
  }

  @RequirePermission(CONVERSION_PERMISSIONS.CONVERSION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('stock/resync')
  stockResync(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('conversion.stock.resync', bodyKey(body, 'conversionStockOrderId') ?? 'stock', body, auth, req)
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
      expectedRevision: 0, // conversionform 域未启用乐观修订列（同 org/inventory/shipping 口径）
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
