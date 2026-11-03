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
import type { CommandBus, CommandContext, VerifiedAuthContext } from '@cadenza/application'
// L0-整合标记：reverse 许可常量位于 domain reverse 面（未并入包名入口，dist 相对桥接同 composition 注释）
import { REVERSE_PERMISSIONS } from '@cadenza/domain'
import type { ReverseQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { REVERSE_COMMAND_BUS, REVERSE_QUERY_SERVICE } from './reverse.tokens'

/**
 * reverse 端点（T17 仓储异常与逆向——Web/PDA 双入口共用同命令，PI S16 裁定精神随行）：
 * - 查询：移库台账/扫码信息（只读不锁定 WR-01）/移入库位范围、调拨出入库单、
 *   盘点/差异调整、采购批次纠正、码已收汇总（再扫确认弹窗数据源 WR-18）、
 *   载具借还/本厂可用载具、所有权三分视图（WR-26/A07）；
 * - 命令：移库提交、调拨出库七命令、调拨入库三命令、采购批次纠正六命令、
 *   盘点三命令＋差异调整、所有权变更、载具借还——全部经命令总线（幂等+审计+事务），
 *   数量字段一律十进制字符串。
 * 挂全局守卫（AuthGuard/ScopeGuard）；查询按数据范围服务端过滤（OA-24/25）。
 */
@Controller('reverse')
export class ReverseController {
  constructor(
    @Inject(REVERSE_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(REVERSE_QUERY_SERVICE) private readonly queries: ReverseQueryService,
  ) {}

  // ---------------- 查询：移库（WR-01～05） ----------------

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @PlantParam('plantId')
  @Get('move-records')
  listMoveRecords(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('unitNoLike') unitNoLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listMoveRecords(auth, {
      plantId,
      unitNoLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @Get('move-records/:id')
  async moveRecordDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.moveRecordDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '移库记录不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  /** WR-01：扫码只查询、校验并返回码信息（不改位置、不锁定）。 */
  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @Get('move/scan-info')
  moveScanInfo(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('unitNo') unitNo?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('toLocationId') toLocationId?: string,
  ) {
    if (plantId === undefined || unitNo === undefined || warehouseId === undefined) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 plantId/unitNo/warehouseId 查询参数', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    return this.queries.moveScanInfo(auth, { plantId, unitNo, warehouseId, toLocationId })
  }

  /** WR-03：移入库位范围——登录人部门下、已启用、仓库类型（不含线边仓）。 */
  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @PlantParam('plantId')
  @Get('move/target-warehouses')
  listMoveTargetWarehouses(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('deptId') deptId?: string,
  ) {
    if (plantId === undefined) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 plantId 查询参数', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    return this.queries.listMoveTargetWarehouses(auth, { plantId, deptId })
  }

  // ---------------- 查询：调拨出入库（WR-05/07/13/14） ----------------

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @PlantParam('plantId')
  @Get('transfer-outbound')
  listTransferOutbound(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('includeTasklessInProgress') includeTasklessInProgress?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listTransferOutbound(auth, {
      plantId,
      statuses: statuses?.split(','),
      includeTasklessInProgress: includeTasklessInProgress === 'true',
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @Get('transfer-outbound/:id')
  async transferOutboundDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.transferOutboundDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '调拨出库单不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @PlantParam('plantId')
  @Get('transfer-inbound')
  listTransferInbound(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listTransferInbound(auth, {
      plantId,
      statuses: statuses?.split(','),
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @Get('transfer-inbound/:id')
  async transferInboundDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.transferInboundDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '调拨入库单不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  // ---------------- 查询：盘点与差异调整（WR-24/25） ----------------

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @PlantParam('plantId')
  @Get('stocktakes')
  listStocktakes(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listStocktakes(auth, {
      plantId,
      statuses: statuses?.split(','),
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @Get('stocktakes/:id')
  async stocktakeDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.stocktakeDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '盘单不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @PlantParam('plantId')
  @Get('stock-adjustments')
  listAdjustments(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listAdjustments(auth, {
      plantId,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @Get('stock-adjustments/:id')
  async adjustmentDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.adjustmentDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '差异调整单不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  // ---------------- 查询：采购批次纠正与码已收汇总（WR-18～23） ----------------

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @PlantParam('plantId')
  @Get('receipt-corrections')
  listCorrections(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('correctionKinds') correctionKinds?: string,
    @Query('batchNoLike') batchNoLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listCorrections(auth, {
      plantId,
      correctionKinds: correctionKinds?.split(','),
      batchNoLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @Get('receipt-corrections/:id')
  async correctionDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.correctionDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '纠正单不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  /** WR-18：已收货的码再扫确认弹窗数据源（系统已记数量）。 */
  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @Get('receipt/code-received-summary')
  codeReceivedSummary(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('barcodeValue') barcodeValue?: string,
  ) {
    if (plantId === undefined || barcodeValue === undefined) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 plantId/barcodeValue 查询参数', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    return this.queries.codeReceivedSummary(auth, { plantId, barcodeValue })
  }

  // ---------------- 查询：载具借还与所有权三分（WR-26/27） ----------------

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @PlantParam('plantId')
  @Get('carrier-loans')
  listCarrierLoans(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('eventKinds') eventKinds?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listCarrierLoans(auth, {
      plantId,
      eventKinds: eventKinds?.split(','),
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  /** WR-27：本厂可用载具（借出/损坏/报废不计入）。 */
  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @PlantParam('plantId')
  @Get('carriers/available')
  availableCarriers(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
  ) {
    if (plantId === undefined) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 plantId 查询参数', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    return this.queries.availableCarriers(auth, { plantId })
  }

  /** WR-26/A07：数量、位置、所有权三者分别可核对。 */
  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_READ)
  @PlantParam('plantId')
  @Get('ownership-balances')
  ownershipBalances(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('unitNo') unitNo?: string,
  ) {
    return this.queries.ownershipBalances(auth, { plantId, unitNo })
  }

  // ---------------- 命令：移库（WR-01～05） ----------------

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('move/submit')
  moveSubmit(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.move.submit', bodyKey(body, 'warehouseId') ?? 'move', body, auth, req)
  }

  // ---------------- 命令：调拨出库（WR-06～13） ----------------

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @Post('transfer-outbound')
  transferOutCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.transfer-outbound.create', bodyKey(body, 'fromWarehouseId') ?? 'transfer-out', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfer-outbound/update')
  transferOutUpdate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.transfer-outbound.update', bodyKey(body, 'orderId') ?? 'transfer-out', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfer-outbound/delete')
  transferOutDelete(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.transfer-outbound.delete', bodyKey(body, 'orderId') ?? 'transfer-out', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfer-outbound/scan')
  transferOutScan(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.transfer-outbound.scan', bodyKey(body, 'unitNo') ?? 'scan', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfer-outbound/remove-scan')
  transferOutRemoveScan(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.transfer-outbound.remove-scan', bodyKey(body, 'unitNo') ?? 'scan', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfer-outbound/complete')
  transferOutComplete(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.transfer-outbound.complete', bodyKey(body, 'orderId') ?? 'transfer-out', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfer-outbound/auto-generate')
  transferOutAutoGenerate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.transfer-outbound.auto-generate', bodyKey(body, 'unitNo') ?? 'auto', body, auth, req)
  }

  // ---------------- 命令：调拨入库与跨厂签收（WR-14～17） ----------------

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfer-inbound/scan-putaway')
  transferInScanPutaway(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.transfer-inbound.scan-putaway', bodyKey(body, 'unitNo') ?? 'scan', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfer-inbound/remove-scan')
  transferInRemoveScan(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.transfer-inbound.remove-scan', bodyKey(body, 'unitNo') ?? 'scan', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('transfer-inbound/complete')
  transferInComplete(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.transfer-inbound.complete', bodyKey(body, 'orderId') ?? 'transfer-in', body, auth, req)
  }

  // ---------------- 命令：采购批次纠正（WR-18～23） ----------------

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('receipt/receive-lines')
  receiptReceiveLines(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.receipt.receive-lines', bodyKey(body, 'batchId') ?? 'receipt', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('receipt/modify')
  receiptModify(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.receipt.modify', bodyKey(body, 'batchId') ?? 'receipt', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('receipt/return')
  receiptReturn(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.receipt.return', bodyKey(body, 'batchId') ?? 'receipt', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('receipt/void')
  receiptVoid(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.receipt.void', bodyKey(body, 'batchId') ?? 'receipt', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('receipt/reverse')
  receiptReverse(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.receipt.reverse', bodyKey(body, 'batchId') ?? 'receipt', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('receipt/return-sync/retry')
  receiptReturnSyncRetry(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.receipt.return-sync.retry', bodyKey(body, 'batchId') ?? 'sync', body, auth, req)
  }

  // ---------------- 命令：盘点与差异调整（WR-24/25） ----------------

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('stocktake/open')
  stocktakeOpen(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.stocktake.open', bodyKey(body, 'warehouseId') ?? 'stocktake', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('stocktake/record-count')
  stocktakeRecordCount(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.stocktake.record-count', bodyKey(body, 'unitNo') ?? 'count', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('stocktake/close')
  stocktakeClose(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.stocktake.close', bodyKey(body, 'orderId') ?? 'stocktake', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('stock-adjustment/execute')
  stockAdjustmentExecute(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.stock-adjustment.execute', bodyKey(body, 'stocktakeOrderId') ?? 'adjust', body, auth, req)
  }

  // ---------------- 命令：所有权三分与载具借还（WR-26/27） ----------------

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('ownership/transfer')
  ownershipTransfer(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.ownership.transfer', bodyKey(body, 'unitNo') ?? 'ownership', body, auth, req)
  }

  @RequirePermission(REVERSE_PERMISSIONS.REVERSE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('carrier/loan')
  carrierLoan(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('reverse.carrier.loan', bodyKey(body, 'carrierCode') ?? bodyKey(body, 'carrierId') ?? 'carrier', body, auth, req)
  }

  // ---------------- 命令执行（同 inventory/purchase/shipping.controller 口径） ----------------

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
      expectedRevision: 0, // reverse 域未启用乐观修订列（同 org/inventory/shipping 口径）
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
