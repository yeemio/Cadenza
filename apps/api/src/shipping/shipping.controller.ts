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
// shipping 域许可常量位于 domain shipping 面（未并入包名入口，dist 相对桥接同 composition 注释）
import { SHIPPING_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, VerifiedAuthContext } from '@cadenza/application'
import type { ShippingQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { SHIPPING_COMMAND_BUS, SHIPPING_QUERY_SERVICE } from './shipping.tokens'

/**
 * shipping 端点（T14 分段装箱/发运——Web/PDA 双入口共用同命令，PI S16 裁定）：
 * - 查询：PL 分页/详情（三类行+扫码+打包+附件+回传双状态列）、打包看板、出库状态、
 *   DC 分段/组成数据（缺组成标记）；
 * - 命令：DC 组成模拟入站、PL 模拟入站、打包创建/绑定托码、扫码装入/删码/补码、
 *   确认出库、两条回传重试、装箱图附件元数据——全部经命令总线（幂等+审计+事务），
 *   数量/段长字段一律十进制字符串。
 * 挂全局守卫（AuthGuard/ScopeGuard；仓管/出库岗位共用 shipping.read/post 许可面）；
 * 查询按数据范围服务端过滤（OA-24/25）。
 */
@Controller('shipping')
export class ShippingController {
  constructor(
    @Inject(SHIPPING_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(SHIPPING_QUERY_SERVICE) private readonly queries: ShippingQueryService,
  ) {}

  // ---------------- 查询 ----------------

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_READ)
  @PlantParam('plantId')
  @Get('shipment-orders')
  listShipmentOrders(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('plNoLike') plNoLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listShipmentOrders(auth, {
      plantId,
      statuses: statuses?.split(','),
      plNoLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_READ)
  @Get('shipment-orders/:id')
  async shipmentDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.shipmentDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '发货单不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_READ)
  @PlantParam('plantId')
  @Get('packing-board')
  packingBoard(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('palletCodeLike') palletCodeLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.packingBoard(auth, {
      plantId,
      statuses: statuses?.split(','),
      palletCodeLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_READ)
  @PlantParam('plantId')
  @Get('outbound-status')
  outboundStatus(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.outboundStatus(auth, { plantId, page: toNumber(page), pageSize: toNumber(pageSize) })
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_READ)
  @Get('dc-compositions')
  listCompositions(@CurrentAuth() auth: VerifiedAuthContext, @Query('salesOrderNo') salesOrderNo?: string) {
    if (salesOrderNo === undefined || salesOrderNo === '') {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 salesOrderNo 查询参数', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    return this.queries.listCompositions(auth, { salesOrderNo })
  }

  // ---------------- 命令 ----------------

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('dc-composition/inbound')
  dcCompositionInbound(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('shipping.dc-composition.inbound', bodyKey(body, 'dcId') ?? 'dc', body, auth, req)
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('pl/inbound')
  plInbound(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('shipping.pl.inbound', bodyKey(body, 'plNo') ?? 'pl', body, auth, req)
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_POST)
  @Post('packing')
  packingCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('shipping.packing.create', bodyKey(body, 'shipmentOrderId') ?? 'packing', body, auth, req)
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('packing/bind')
  packingBind(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('shipping.packing.bind', bodyKey(body, 'packingOrderId') ?? 'packing', body, auth, req)
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('scan/load')
  scanLoad(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('shipping.scan.load', bodyKey(body, 'unitNo') ?? 'scan', body, auth, req)
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('scan/delete')
  scanDelete(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('shipping.scan.delete', bodyKey(body, 'scanId') ?? 'scan', body, auth, req)
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('scan/supplement')
  scanSupplement(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('shipping.scan.supplement', bodyKey(body, 'unitNo') ?? 'supplement', body, auth, req)
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('ship/confirm')
  shipConfirm(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('shipping.ship.confirm', bodyKey(body, 'shipmentOrderId') ?? 'ship', body, auth, req)
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('sync/actual-axis/retry')
  syncActualAxisRetry(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('shipping.sync.actual-axis.retry', bodyKey(body, 'shipmentOrderId') ?? 'sync', body, auth, req)
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('sync/status/retry')
  syncStatusRetry(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('shipping.sync.status.retry', bodyKey(body, 'shipmentOrderId') ?? 'sync', body, auth, req)
  }

  @RequirePermission(SHIPPING_PERMISSIONS.SHIPPING_POST)
  @Post('photos')
  photoAttach(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('shipping.photo.attach', bodyKey(body, 'shipmentOrderId') ?? 'photo', body, auth, req)
  }

  // ---------------- 命令执行（同 inventory/purchase/quality/warehousing.controller 口径） ----------------

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
      expectedRevision: 0, // shipping 域未启用乐观修订列（同 org/inventory/quality/warehousing 口径）
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
