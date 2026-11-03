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
import type { CommandBus, VerifiedAuthContext } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { MAINTENANCE_COMMAND_BUS, MAINTENANCE_QUERY_SERVICE } from './maintenance.tokens'
// dist 相对导入桥接（L0 整合步改包名导入，同 composition 注释）
import type { MaintenanceQueryService } from '@cadenza/application'
import { MAINTENANCE_PERMISSIONS } from '@cadenza/domain'

/**
 * maintenance 端点（T19 设备维护）：
 * - 查询：工单列表/详情对齐（A10：工单＋停机＋备件＋状态流水＋能力事件链）、停机事件、
 *   能力变化事件读回（MT-10/15）、计划与超期提示（MT-12：提示不阻断）、执行轮次、开工记录；
 * - 命令（幂等+审计）：异常上报（MT-03/04）、工单闭环（建单/分派/处理/待复机/复机/取消
 *   ——MT-07~14）、计划版本与执行轮次（MT-12）、设备开工（MT-05/06）。
 * 挂全局守卫（AuthGuard/ScopeGuard）；查询按数据范围服务端过滤（OA-24/25）。
 */
@Controller('maintenance')
export class MaintenanceController {
  constructor(
    @Inject(MAINTENANCE_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(MAINTENANCE_QUERY_SERVICE) private readonly queries: MaintenanceQueryService,
  ) {}

  // ---------------- 查询：维修工单与停机 ----------------

  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_READ)
  @PlantParam('plantId')
  @Get('orders')
  listOrders(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('equipmentId') equipmentId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (
      status !== undefined &&
      !['reported', 'dispatched', 'in_progress', 'pending_restart', 'closed', 'cancelled'].includes(status)
    ) {
      throwBusinessRule('[MT-07] status 仅支持 reported/dispatched/in_progress/pending_restart/closed/cancelled')
    }
    return this.queries.listOrders(auth, {
      plantId,
      equipmentId,
      status,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  /** A10 对齐视图：工单＋停机＋备件消耗＋设备状态流水＋能力事件。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_READ)
  @Get('orders/:orderId')
  getOrderDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('orderId') orderId: string) {
    return this.queries.getOrderDetail(auth, orderId)
  }

  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_READ)
  @PlantParam('plantId')
  @Get('downtime-events')
  listDowntimeEvents(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('equipmentId') equipmentId?: string,
    @Query('openOnly') openOnly?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listDowntimeEvents(auth, {
      plantId,
      equipmentId,
      openOnly: openOnly === 'true' || openOnly === '1',
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  /** 能力变化事件读回（MT-10/15：复机后排程可见能力恢复——T09 消费前 outbox 证据）。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_READ)
  @PlantParam('plantId')
  @Get('capacity-events')
  listCapacityEvents(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('orderId') orderId?: string,
    @Query('equipmentId') equipmentId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.queries.listCapacityEvents(auth, {
      plantId,
      orderId,
      equipmentId,
      limit: toNumber(limit),
    })
  }

  // ---------------- 查询：点检/保养与开工 ----------------

  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_READ)
  @PlantParam('plantId')
  @Get('plans')
  listPlans(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('equipmentId') equipmentId?: string,
    @Query('kind') kind?: string,
  ) {
    if (kind !== undefined && kind !== 'inspection' && kind !== 'maintenance') {
      throwBusinessRule('[MT-12] kind 仅支持 inspection/maintenance（点检/保养）')
    }
    return this.queries.listPlans(auth, { plantId, equipmentId, kind })
  }

  /** 超期未执行提示（MT-12：提示口径，不自动阻断生产——默认口径，GAP-F19 待裁）。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_READ)
  @PlantParam('plantId')
  @Get('plans/overdue')
  listOverduePlans(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('equipmentId') equipmentId?: string,
    @Query('today') today?: string,
  ) {
    return this.queries.listOverduePlans(auth, { plantId, equipmentId, today })
  }

  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_READ)
  @PlantParam('plantId')
  @Get('rounds')
  listRounds(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('planKey') planKey?: string,
    @Query('equipmentId') equipmentId?: string,
    @Query('result') result?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (result !== undefined && result !== 'pass' && result !== 'fail') {
      throwBusinessRule('[MT-12] result 仅支持 pass/fail')
    }
    return this.queries.listRounds(auth, {
      planKey,
      equipmentId,
      result,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_READ)
  @PlantParam('plantId')
  @Get('start-records')
  listStartRecords(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('equipmentId') equipmentId?: string,
    @Query('businessDate') businessDate?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listStartRecords(auth, {
      equipmentId,
      businessDate,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  // ---------------- 维护命令（幂等+审计） ----------------

  /** MT-03/04：异常上报（PDA 扫码→改状态；置"维修"可关联建单）。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('equipment/anomaly-report')
  equipmentAnomalyReport(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand('maintenance.equipment.anomaly-report', body, auth, req)
  }

  /** MT-13/08/09：Web 手工报修建单（置"维修"＋开停机＋能力下降事件）。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('orders')
  orderCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand('maintenance.order.create', body, auth, req)
  }

  /** MT-13：分派（记录分派人与被派人）。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('orders/dispatch')
  orderDispatch(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand('maintenance.order.dispatch', body, auth, req)
  }

  /** MT-07：处理中。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('orders/start')
  orderStart(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand('maintenance.order.start', body, auth, req)
  }

  /** MT-07：维修完成待复机。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('orders/finish-repair')
  orderFinishRepair(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand('maintenance.order.finish-repair', body, auth, req)
  }

  /** MT-10/11：复机关闭（备件消耗同事务；置正常＋闭停机＋能力恢复事件）。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('orders/restart')
  orderRestart(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand('maintenance.order.restart', body, auth, req)
  }

  /** MT-14：取消（原因必填；停机事实保留）。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('orders/cancel')
  orderCancel(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand('maintenance.order.cancel', body, auth, req)
  }

  /** MT-12：计划版本注册（周期＋检查项模板；版本化）。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('plans/create-version')
  planCreateVersion(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand('maintenance.plan.create-version', body, auth, req)
  }

  /** MT-12：点检/保养执行记录（双存；fail 必填异常说明＋建议报修不自动建单）。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('rounds')
  inspectionRecordRound(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand('maintenance.inspection.record-round', body, auth, req)
  }

  /** MT-05/06：设备开工（状态=正常才可开工；(设备, 业务日) 幂等）。 */
  @RequirePermission(MAINTENANCE_PERMISSIONS.MAINTENANCE_POST)
  @HttpCode(HttpStatus.OK)
  @Post('equipment/start-work')
  equipmentStartWork(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.dispatchCommand('maintenance.equipment.start-work', body, auth, req)
  }

  /** 命令分发（幂等键 operationId 取 body/x-operation-id；载荷透传命令总线）。 */
  private async dispatchCommand(
    commandType: string,
    body: unknown,
    auth: VerifiedAuthContext,
    req: Request,
  ): Promise<unknown> {
    const payload: Record<string, unknown> =
      typeof body === 'object' && body !== null ? { ...(body as Record<string, unknown>) } : {}
    const operationId =
      typeof payload['operationId'] === 'string' && payload['operationId'] !== ''
        ? payload['operationId']
        : req.header('x-operation-id') ?? randomUUID()
    delete payload['operationId']
    const targetId =
      typeof payload['orderId'] === 'string'
        ? (payload['orderId'] as string)
        : typeof payload['equipmentId'] === 'string'
          ? (payload['equipmentId'] as string)
          : 'maintenance'
    const envelope: CommandEnvelope<Record<string, unknown>> = {
      operationId,
      commandType,
      targetId,
      expectedRevision: 0,
      payload,
    }
    const result = await this.bus.execute(envelope, {
      actorUserId: auth.user.id,
      actorLoginName: auth.user.loginName,
      enterpriseId: auth.user.enterpriseId,
      reason: typeof payload['reason'] === 'string' ? (payload['reason'] as string) : null,
    })
    // 错误码映射与其余域一致（O-2 修复，2026-10-29：原以 HTTP 200 + body.status=BUSINESS_REJECTION
    // 承载业务拒绝，接口口径与 rework/conversion/spc/ot/cost 不一致——改为同款映射）
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

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function throwBusinessRule(message: string): never {
  throw new HttpException(
    { code: ERROR_CODES.BUSINESS_RULE, message, details: {} },
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
}
