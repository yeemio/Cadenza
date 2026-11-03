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
import { ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandBus, VerifiedAuthContext } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { REPORTING_COMMAND_BUS, REPORTING_QUERY_SERVICE } from './reporting.tokens'
// dist 相对导入桥接（L0 整合步改包名导入，同 composition 注释）
import type { ReportingQueryService } from '@cadenza/application'
import { REPORTING_PERMISSIONS } from '@cadenza/domain'

/**
 * reporting 端点（T20 全量业务查询、班次报表与核心指标——只读投影域）：
 * - 查询：库存统计（列表/勾选汇总/导出=同规则+审计行）、轴查询、报工口径分层汇总、
 *   Web 汇总行、PDA 累计、指标定义、班次快照（含缺失分母标记读回）、正反向追溯；
 * - 维护命令（幂等+审计，只写投影表）：stock-stat 重建、shift-snapshot 重算、
 *   metric-definition 注册——数量/比率字段一律十进制字符串。
 * 挂全局守卫（AuthGuard/ScopeGuard）；查询按数据范围服务端过滤（OA-24/25）。
 */
@Controller('reporting')
export class ReportingController {
  constructor(
    @Inject(REPORTING_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(REPORTING_QUERY_SERVICE) private readonly queries: ReportingQueryService,
  ) {}

  // ---------------- 查询：库存统计（RP-01~RP-07） ----------------

  @RequirePermission(REPORTING_PERMISSIONS.REPORTING_READ)
  @PlantParam('plantId')
  @Get('stock-stats')
  listStockStats(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('unitNoLike') unitNoLike?: string,
    @Query('customerAxisLike') customerAxisLike?: string,
    @Query('stockStatus') stockStatus?: string,
    @Query('finishedEntryStatus') finishedEntryStatus?: string,
    @Query('export') exportFlag?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (finishedEntryStatus !== undefined && finishedEntryStatus !== 'entered_warehouse' && finishedEntryStatus !== 'not_entered') {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '[RP-04] finishedEntryStatus 仅支持 entered_warehouse / not_entered', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    return this.queries.listStockStats(auth, {
      plantId,
      unitNoLike,
      customerAxisLike,
      stockStatus,
      finishedEntryStatus,
      export: exportFlag === '1' || exportFlag === 'true',
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  /** RP-05 勾选汇总（POST：勾选 id 集合可能超出 URL 长度；服务端全量聚合）。 */
  @RequirePermission(REPORTING_PERMISSIONS.REPORTING_READ)
  @HttpCode(HttpStatus.OK)
  @Post('stock-stats/summary')
  stockStatSelectionSummary(@CurrentAuth() auth: VerifiedAuthContext, @Body() body: unknown) {
    const ids = parseIdArray(body)
    return this.queries.selectionSummary(auth, ids)
  }

  // ---------------- 查询：轴查询（RP-08~RP-11） ----------------

  @RequirePermission(REPORTING_PERMISSIONS.REPORTING_READ)
  @PlantParam('plantId')
  @Get('axis-query')
  listAxisQuery(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('unitNoLike') unitNoLike?: string,
    @Query('warehouseName') warehouseName?: string,
    @Query('carrierLike') carrierLike?: string,
    @Query('inboundStatus') inboundStatus?: string,
    @Query('qcStatus') qcStatus?: string,
    @Query('saleStatus') saleStatus?: string,
    @Query('salesOrderNoLike') salesOrderNoLike?: string,
    @Query('orderNoLike') orderNoLike?: string,
    @Query('reporterLike') reporterLike?: string,
    @Query('customerAxisLike') customerAxisLike?: string,
    @Query('reportStatus') reportStatus?: string,
    @Query('reportedFrom') reportedFrom?: string,
    @Query('reportedTo') reportedTo?: string,
    @Query('workshopName') workshopName?: string,
    @Query('export') exportFlag?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (reportStatus !== undefined && reportStatus === 'not_applicable') {
      // RP-09：采购来源轴报工状态固定 `-`，按报工状态筛选不包含采购来源轴——`-` 不是筛选值
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '[RP-09] 报工状态筛选不含采购来源轴（`-` 不可作为筛选值）', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    return this.queries.listAxisQuery(auth, {
      plantId,
      unitNoLike,
      warehouseName,
      carrierLike,
      inboundStatus,
      qcStatus,
      saleStatus,
      salesOrderNoLike,
      orderNoLike,
      reporterLike,
      customerAxisLike,
      reportStatus,
      reportedFrom,
      reportedTo,
      workshopName,
      export: exportFlag === '1' || exportFlag === 'true',
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  // ---------------- 查询：报工汇总（RP-12~RP-17） ----------------

  @RequirePermission(REPORTING_PERMISSIONS.REPORTING_READ)
  @PlantParam('plantId')
  @Get('report-summary/by-caliber')
  reportSummaryByCaliber(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('orderNoLike') orderNoLike?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.queries.reportSummaryByCaliber(auth, { plantId, orderNoLike, dateFrom, dateTo })
  }

  /** RP-12 Web 汇总行（勾选报工单 id 集合；POST 同 RP-05 缘由）。 */
  @RequirePermission(REPORTING_PERMISSIONS.REPORTING_READ)
  @HttpCode(HttpStatus.OK)
  @Post('report-summary/selection')
  reportSelectionSummary(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Body() body: unknown,
    @Query('plantId') plantId?: string,
    @Query('orderNoLike') orderNoLike?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const ids = parseIdArray(body)
    return this.queries.reportSelectionSummary(auth, ids, { plantId, orderNoLike, dateFrom, dateTo })
  }

  /** RP-13 PDA 累计报工（口径分开/排除历史导入/部门含下级/操作工只算自己）。 */
  @RequirePermission(REPORTING_PERMISSIONS.REPORTING_READ)
  @PlantParam('plantId')
  @Get('pda/cumulative')
  pdaCumulative(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('deptId') deptId?: string,
    @Query('operatorOnly') operatorOnly?: string,
  ) {
    return this.queries.pdaCumulative(auth, {
      plantId,
      deptId,
      operatorOnly: operatorOnly === '1' || operatorOnly === 'true',
    })
  }

  // ---------------- 查询：指标与快照（RP-18~RP-21 读侧） ----------------

  @RequirePermission(REPORTING_PERMISSIONS.REPORTING_READ)
  @Get('metrics/definitions')
  listMetricDefinitions() {
    return this.queries.listMetricDefinitions()
  }

  @RequirePermission(REPORTING_PERMISSIONS.REPORTING_READ)
  @PlantParam('plantId')
  @Get('shift-snapshots')
  listShiftSnapshots(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('shiftDateFrom') shiftDateFrom?: string,
    @Query('shiftDateTo') shiftDateTo?: string,
    @Query('metricKeys') metricKeys?: string,
    @Query('statuses') statuses?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listShiftSnapshots(auth, {
      plantId,
      shiftDateFrom,
      shiftDateTo,
      metricKeys: metricKeys?.split(','),
      statuses: statuses?.split(','),
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  // ---------------- 查询：追溯（RP-22 / IT-35） ----------------

  @RequirePermission(REPORTING_PERMISSIONS.REPORTING_READ)
  @Get('trace/:unitNo')
  trace(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Param('unitNo') unitNo: string,
    @Query('direction') direction?: string,
  ) {
    const dir = direction === 'backward' ? 'backward' : 'forward'
    return this.queries.trace(auth, { unitNo, direction: dir })
  }

  // ---------------- 维护命令（只写投影表；幂等+审计） ----------------

  @RequirePermission(REPORTING_PERMISSIONS.REPORTING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('stock-stat/rebuild')
  stockStatRebuild(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand(
      'reporting.stock-stat.rebuild',
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {},
      auth,
      req,
    )
  }

  @RequirePermission(REPORTING_PERMISSIONS.REPORTING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('shift-snapshot/rebuild')
  shiftSnapshotRebuild(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand(
      'reporting.shift-snapshot.rebuild',
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {},
      auth,
      req,
    )
  }

  @RequirePermission(REPORTING_PERMISSIONS.REPORTING_POST)
  @HttpCode(HttpStatus.OK)
  @Post('metric-definition/register')
  metricDefinitionRegister(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand(
      'reporting.metric-definition.register',
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {},
      auth,
      req,
    )
  }

  /** 命令分发（幂等键 operationId 取 body/x-operation-id；载荷透传命令总线）。 */
  private async dispatchCommand(
    commandType: string,
    payload: Record<string, unknown>,
    auth: VerifiedAuthContext,
    req: Request,
  ): Promise<CommandResult> {
    const operationId =
      typeof payload['operationId'] === 'string' && payload['operationId'] !== ''
        ? payload['operationId']
        : req.header('x-operation-id') ?? randomUUID()
    const rest: Record<string, unknown> = { ...payload }
    delete rest['operationId']
    const envelope: CommandEnvelope<Record<string, unknown>> = {
      operationId,
      commandType,
      targetId: typeof rest['plantId'] === 'string' ? (rest['plantId'] as string) : 'reporting',
      expectedRevision: 0,
      payload: rest,
    }
    return this.bus.execute(envelope, {
      actorUserId: auth.user.id,
      actorLoginName: auth.user.loginName,
      enterpriseId: auth.user.enterpriseId,
      reason: typeof rest['reason'] === 'string' ? (rest['reason'] as string) : null,
    })
  }
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseIdArray(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return []
  const raw = (body as Record<string, unknown>)['ids']
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
}
