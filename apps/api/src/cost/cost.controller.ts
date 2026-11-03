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
// [L0-整合标记] cost 域许可常量位于 domain cost 面（未并入包名入口，dist 相对桥接同 composition 注释；
// L0 整合后改包名导入）
import { COST_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, VerifiedAuthContext } from '@cadenza/application'
import type { CostQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { COST_COMMAND_BUS, COST_QUERY_SERVICE } from './cost.tokens'

/**
 * cost 端点（P3-D / T24 能源与制造成本归集——只读业务事实的重建投影，CE-02）：
 * - 查询：订单成本汇总（估算/实测两列）、归集产出/明细（源事实回算）、能源单耗与覆盖率、
 *   OEE（缺项展示）、表计/读数/版本清单、对账差异清单、工时核对提示；
 * - 命令：表计登记、人工抄表、分摊/价格版本、归集首跑、显式重算、ERP 对账导入/处置、
 *   工时核对生成/确认——全部经命令总线（幂等+审计+事务），数量/金额字段十进制字符串。
 * 挂全局守卫（AuthGuard/ScopeGuard）；查询按数据范围服务端过滤（OA-24/25）。
 */
@Controller('cost')
export class CostController {
  constructor(
    @Inject(COST_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(COST_QUERY_SERVICE) private readonly queries: CostQueryService,
  ) {}

  // ---------------- 查询 ----------------

  @RequirePermission(COST_PERMISSIONS.COST_READ)
  @PlantParam('plantId')
  @Get('meters')
  listMeters(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('energyTypes') energyTypes?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return withPageKeys(
      this.queries.listMeters(auth, {
        plantId,
        statuses: statuses?.split(','),
        energyTypes: energyTypes?.split(','),
        page: toNumber(page),
        pageSize: toNumber(pageSize),
      }),
      toNumber(page),
      toNumber(pageSize),
    )
  }

  @RequirePermission(COST_PERMISSIONS.COST_READ)
  @PlantParam('plantId')
  @Get('readings')
  listReadings(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('meterId') meterId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listReadings(auth, { plantId, meterId, page: toNumber(page), pageSize: toNumber(pageSize) })
  }

  @RequirePermission(COST_PERMISSIONS.COST_READ)
  @PlantParam('plantId')
  @Get('allocation-versions')
  listAllocationVersions(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return withPageKeys(
      this.queries.listAllocationVersions(auth, { plantId, statuses: statuses?.split(','), page: toNumber(page), pageSize: toNumber(pageSize) }),
      toNumber(page),
      toNumber(pageSize),
    )
  }

  @RequirePermission(COST_PERMISSIONS.COST_READ)
  @PlantParam('plantId')
  @Get('price-versions')
  listPriceVersions(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return withPageKeys(
      this.queries.listPriceVersions(auth, { plantId, statuses: statuses?.split(','), page: toNumber(page), pageSize: toNumber(pageSize) }),
      toNumber(page),
      toNumber(pageSize),
    )
  }

  @RequirePermission(COST_PERMISSIONS.COST_READ)
  @PlantParam('plantId')
  @Get('runs')
  listRuns(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('orderId') orderId?: string,
    @Query('shiftDate') shiftDate?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return withPageKeys(
      this.queries.listRuns(auth, { plantId, orderId, shiftDate, page: toNumber(page), pageSize: toNumber(pageSize) }),
      toNumber(page),
      toNumber(pageSize),
    )
  }

  @RequirePermission(COST_PERMISSIONS.COST_READ)
  @Get('runs/:id')
  async acquisitionDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.acquisitionDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '归集产出不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  @RequirePermission(COST_PERMISSIONS.COST_READ)
  @Get('orders/:orderId/summary')
  async orderCostSummary(@CurrentAuth() auth: VerifiedAuthContext, @Param('orderId') orderId: string) {
    const summary = await this.queries.orderCostSummary(auth, orderId)
    if (summary === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '生产订单不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return summary
  }

  @RequirePermission(COST_PERMISSIONS.COST_READ)
  @PlantParam('plantId')
  @Get('energy-intensity')
  energyIntensity(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('shiftDate') shiftDate?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.energyIntensity(auth, { plantId, shiftDate, page: toNumber(page), pageSize: toNumber(pageSize) })
  }

  @RequirePermission(COST_PERMISSIONS.COST_READ)
  @Get('oee')
  async oee(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId: string,
    @Query('equipmentCode') equipmentCode: string,
    @Query('windowStart') windowStart: string,
    @Query('windowEnd') windowEnd: string,
  ) {
    if (plantId === undefined || equipmentCode === undefined || windowStart === undefined || windowEnd === undefined) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 plantId/equipmentCode/windowStart/windowEnd 查询参数', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    const result = await this.queries.oee(auth, { plantId, equipmentCode, windowStart, windowEnd })
    if (result === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '设备不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return result
  }

  @RequirePermission(COST_PERMISSIONS.COST_READ)
  @PlantParam('plantId')
  @Get('recon-items')
  listReconItems(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('runId') runId?: string,
    @Query('kinds') kinds?: string,
    @Query('statuses') statuses?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return withPageKeys(
      this.queries.listReconItems(auth, {
        plantId,
        runId,
        kinds: kinds?.split(','),
        statuses: statuses?.split(','),
        page: toNumber(page),
        pageSize: toNumber(pageSize),
      }),
      toNumber(page),
      toNumber(pageSize),
    )
  }

  @RequirePermission(COST_PERMISSIONS.COST_READ)
  @PlantParam('plantId')
  @Get('labor-checks')
  listLaborChecks(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('orderId') orderId?: string,
    @Query('statuses') statuses?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return withPageKeys(
      this.queries.listLaborChecks(auth, { plantId, orderId, statuses: statuses?.split(','), page: toNumber(page), pageSize: toNumber(pageSize) }),
      toNumber(page),
      toNumber(pageSize),
    )
  }

  // ---------------- 命令 ----------------

  @RequirePermission(COST_PERMISSIONS.COST_POST)
  @Post('meters')
  meterRegister(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('cost.meter.register', bodyKey(body, 'meterCode') ?? 'meter', body, auth, req)
  }

  @RequirePermission(COST_PERMISSIONS.COST_POST)
  @HttpCode(HttpStatus.OK)
  @Post('meters/readings')
  meterReadingRecord(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('cost.meter.reading.record', bodyKey(body, 'meterId') ?? 'reading', body, auth, req)
  }

  @RequirePermission(COST_PERMISSIONS.COST_POST)
  @Post('allocation-versions')
  allocationVersionCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('cost.allocation-version.create', bodyKey(body, 'versionNo') ? String((body as Record<string, unknown>)['versionNo']) : 'alloc', body, auth, req)
  }

  @RequirePermission(COST_PERMISSIONS.COST_POST)
  @Post('price-versions')
  priceVersionCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('cost.price-version.create', bodyKey(body, 'versionNo') ? String((body as Record<string, unknown>)['versionNo']) : 'price', body, auth, req)
  }

  @RequirePermission(COST_PERMISSIONS.COST_POST)
  @HttpCode(HttpStatus.OK)
  @Post('acquisition/run')
  acquisitionRun(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('cost.acquisition.run', bodyKey(body, 'orderId') ?? 'run', body, auth, req)
  }

  @RequirePermission(COST_PERMISSIONS.COST_POST)
  @HttpCode(HttpStatus.OK)
  @Post('acquisition/recalc')
  acquisitionRecalc(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('cost.acquisition.recalc', bodyKey(body, 'orderId') ?? 'recalc', body, auth, req)
  }

  @RequirePermission(COST_PERMISSIONS.COST_POST)
  @HttpCode(HttpStatus.OK)
  @Post('recon/erp-import')
  reconErpImport(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('cost.recon.erp-import', bodyKey(body, 'runId') ?? 'recon', body, auth, req)
  }

  @RequirePermission(COST_PERMISSIONS.COST_POST)
  @HttpCode(HttpStatus.OK)
  @Post('recon/resolve')
  reconResolve(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('cost.recon.resolve', bodyKey(body, 'itemId') ?? 'recon', body, auth, req)
  }

  @RequirePermission(COST_PERMISSIONS.COST_POST)
  @HttpCode(HttpStatus.OK)
  @Post('labor-check/run')
  laborCheckRun(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('cost.labor-check.run', bodyKey(body, 'orderId') ?? 'check', body, auth, req)
  }

  @RequirePermission(COST_PERMISSIONS.COST_POST)
  @HttpCode(HttpStatus.OK)
  @Post('labor-check/acknowledge')
  laborCheckAcknowledge(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('cost.labor-check.acknowledge', bodyKey(body, 'checkId') ?? 'check', body, auth, req)
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
      expectedRevision: 0, // cost 域未启用乐观修订列（同 shipping 口径）
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

/** 分页四元组回显（L0 整合轮 2026-10-29，P3-UI 交付记录 §5-2 对账闭合）：仓储分页返回
 * {items,total}，控制器按应用层缺省（page 1 / pageSize 20，cost-queries.ts 同值）补齐
 * PageResult 四元组，与 ot/csw/spc 域列表口径一致（PC-16 服务端分页）；域测试仅断言
 * items/total，不受影响。 */
async function withPageKeys<T extends { items: unknown[]; total: number }>(
  resultOrPromise: T | Promise<T>,
  page: number | undefined,
  pageSize: number | undefined,
): Promise<T & { page: number; pageSize: number }> {
  const resolved = await resultOrPromise
  return { ...resolved, page: page ?? 1, pageSize: pageSize ?? 20 }
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : undefined
}
