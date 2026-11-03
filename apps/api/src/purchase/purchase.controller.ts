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
// purchase 域许可常量位于 domain purchase 面（未并入包名入口，dist 相对桥接同 composition 注释）
import { PURCHASE_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, VerifiedAuthContext } from '@cadenza/application'
import type { PurchaseQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { PURCHASE_COMMAND_BUS, PURCHASE_QUERY_SERVICE } from './purchase.tokens'

/**
 * purchase 端点（T08 采购主链）：
 * - 查询：订单行分页（IF-08 行维度）、批次分页、批次详情（明细+质检历史+价格复核投影）；
 * - 命令：模拟入站订单同步、确认收货（扫码明细提交）、质检结论、撤销质检、发起复检、
 *   退货、价格复核标记——全部经命令总线（幂等+审计+事务），数量字段一律十进制字符串。
 * 挂全局守卫（AuthGuard/ScopeGuard）；查询按数据范围服务端过滤（OA-24/25）。
 */
@Controller('purchase')
export class PurchaseController {
  constructor(
    @Inject(PURCHASE_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(PURCHASE_QUERY_SERVICE) private readonly queries: PurchaseQueryService,
  ) {}

  // ---------------- 查询 ----------------

  @RequirePermission(PURCHASE_PERMISSIONS.PURCHASE_READ)
  @PlantParam('plantId')
  @Get('order-lines')
  listOrderLines(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('orderNoLike') orderNoLike?: string,
    @Query('materialCode') materialCode?: string,
    @Query('statuses') statuses?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listOrderLines(auth, {
      plantId,
      orderNoLike,
      materialCode,
      statuses: statuses?.split(','),
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(PURCHASE_PERMISSIONS.PURCHASE_READ)
  @PlantParam('plantId')
  @Get('batches')
  listBatches(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('batchNoLike') batchNoLike?: string,
    @Query('orderNoLike') orderNoLike?: string,
    @Query('inspectionStatuses') inspectionStatuses?: string,
    @Query('storageStatuses') storageStatuses?: string,
    @Query('reviewStatuses') reviewStatuses?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listBatches(auth, {
      plantId,
      batchNoLike,
      orderNoLike,
      inspectionStatuses: inspectionStatuses?.split(','),
      storageStatuses: storageStatuses?.split(','),
      reviewStatuses: reviewStatuses?.split(','),
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(PURCHASE_PERMISSIONS.PURCHASE_READ)
  @Get('batches/:id')
  async batchDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.batchDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '采购批次不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  // ---------------- 命令 ----------------

  @RequirePermission(PURCHASE_PERMISSIONS.PURCHASE_POST)
  @Post('orders/sync')
  orderSync(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('purchase.order-sync', (bodyAsRecord(body)['orderNo'] as string) ?? 'unknown', body, auth, req)
  }

  @RequirePermission(PURCHASE_PERMISSIONS.PURCHASE_POST)
  @Post('receive')
  receiveConfirm(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'purchase.receive-confirm',
      (bodyAsRecord(body)['orderLineId'] as string) ?? (bodyAsRecord(body)['orderNo'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  @RequirePermission(PURCHASE_PERMISSIONS.PURCHASE_POST)
  @Post('inspections')
  inspectionConclude(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'purchase.inspection.conclude',
      (bodyAsRecord(body)['batchId'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  @RequirePermission(PURCHASE_PERMISSIONS.PURCHASE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('inspections/revoke')
  inspectionRevoke(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'purchase.inspection.revoke',
      (bodyAsRecord(body)['detailId'] as string) ?? (bodyAsRecord(body)['batchId'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  @RequirePermission(PURCHASE_PERMISSIONS.PURCHASE_POST)
  @Post('inspections/re-inspection')
  reinspectionStart(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('purchase.inspection.start-reinspection', 're-inspection', body, auth, req)
  }

  @RequirePermission(PURCHASE_PERMISSIONS.PURCHASE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('returns')
  returnBatch(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('purchase.return', (bodyAsRecord(body)['batchId'] as string) ?? 'unknown', body, auth, req)
  }

  @RequirePermission(PURCHASE_PERMISSIONS.PURCHASE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('price-review')
  priceReview(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('purchase.price-review.confirm', (bodyAsRecord(body)['batchId'] as string) ?? 'unknown', body, auth, req)
  }

  // ---------------- 命令执行（同 inventory.controller 口径） ----------------

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
      expectedRevision: 0, // 采购域未启用乐观修订列（同 org/inventory 口径，合同信封形状保留）
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
