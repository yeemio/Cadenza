import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common'
import type { Request } from 'express'
import { randomUUID } from 'node:crypto'
import {
  ERROR_CODES,
  CommandResultStatus,
  type CommandEnvelope,
  type CommandResult,
} from '@cadenza/contracts'
import type { CommandBus, CommandContext, VerifiedAuthContext } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { EXECUTION_COMMAND_BUS, EXECUTION_QUERIES } from './execution.tokens'
import type { ExecutionQueriesPort } from './execution.queries-port'

/**
 * 报工/投料执行域端点（T10 三入口报工 + T11 投料）。
 *
 * 三入口（[底稿 A6-1]，同工序规则不分叉——服务端共用单一命令路径）：
 * - POST /execution/orders/:orderId/reports（实绩录入，来源 order）；
 * - POST /execution/workbench/reports（工作台，来源 workbench，工序固定）；
 * - POST /execution/scan/reports（扫码报工，来源 scan，扫设备码上下文经排程端口）。
 *
 * 守卫（[底稿 A6/D4]）：操作工仅自己（查询/草稿按本人过滤，服务端口径）；班组长车间范围
 * （execution.review + 厂范围授权放开到授权厂）；许可常量镜像 domain
 * （L0 整合标记：domain index 导出 './execution' 后改 EXECUTION_PERMISSIONS 导入）。
 */

/** [L0-整合标记] 镜像 domain/src/execution/permissions.ts（EXECUTION_PERMISSIONS）。 */
const EXECUTION_READ = 'execution.read'
const EXECUTION_REPORT = 'execution.report'
const EXECUTION_REVIEW = 'execution.review'
const EXECUTION_FEED = 'execution.feed'
const EXECUTION_LABOR = 'execution.labor'

@Controller('execution')
export class ExecutionController {
  constructor(
    @Inject(EXECUTION_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(EXECUTION_QUERIES) private readonly queries: ExecutionQueriesPort,
  ) {}

  // ---------------- 扫码上下文（扫设备码→按班次日期带任务单） ----------------

  @RequirePermission(EXECUTION_READ)
  @PlantParam('plantId')
  @Get('scan/context')
  scanContext(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('equipmentId') equipmentId?: string,
    @Query('shiftDate') shiftDate?: string,
  ) {
    if (plantId === undefined || equipmentId === undefined) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '需要 plantId/equipmentId（扫设备码上下文）' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    const date = shiftDate ?? new Date().toISOString().slice(0, 10)
    return this.queries.scanContext(auth, { plantId, equipmentId, shiftDate: date })
  }

  // ---------------- 三入口报工（同规则：仅 source 与默认工序解析不同） ----------------

  @RequirePermission(EXECUTION_REPORT)
  @Post('orders/:orderId/reports')
  reportViaOrder(
    @Param('orderId') orderId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.runEntry('order', orderId, body, auth, req)
  }

  @RequirePermission(EXECUTION_REPORT)
  @Post('workbench/reports')
  reportViaWorkbench(
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    const payload = (body ?? {}) as Record<string, unknown>
    return this.runEntry('workbench', typeof payload['orderId'] === 'string' ? payload['orderId'] : 'new', body, auth, req)
  }

  @RequirePermission(EXECUTION_REPORT)
  @Post('scan/reports')
  reportViaScan(
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    const payload = (body ?? {}) as Record<string, unknown>
    return this.runEntry('scan', typeof payload['orderId'] === 'string' ? payload['orderId'] : 'new', body, auth, req)
  }

  // ---------------- 草稿列表 / 续作 / 报工单详情 ----------------

  @RequirePermission(EXECUTION_READ)
  @Get('reports/drafts')
  listDrafts(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('orderId') orderId?: string,
    @Query('source') source?: string,
    @Query('operatorUserId') operatorUserId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listDrafts(auth, {
      orderId,
      source,
      operatorUserId,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(EXECUTION_READ)
  @Get('reports/:id')
  async getReport(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.getReport(auth, id)
    if (detail === null || detail === undefined) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '报工单不存在或不在授权数据范围内' },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  @RequirePermission(EXECUTION_REPORT)
  @HttpCode(HttpStatus.OK)
  @Post('reports/:id/submit')
  submitReport(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('execution.report.submit', id, body, auth, req)
  }

  // ---------------- 审核 / 取消审核 / 编辑 / 删除 ----------------

  @RequirePermission(EXECUTION_REVIEW)
  @HttpCode(HttpStatus.OK)
  @Post('reports/:id/review')
  reviewReport(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('execution.report.review', id, body, auth, req)
  }

  @RequirePermission(EXECUTION_REVIEW)
  @HttpCode(HttpStatus.OK)
  @Post('reports/:id/review-cancel')
  cancelReview(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('execution.report.review.cancel', id, body, auth, req)
  }

  @RequirePermission(EXECUTION_REPORT)
  @Patch('reports/:id')
  updateReport(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('execution.report.update', id, body, auth, req)
  }

  @RequirePermission(EXECUTION_REPORT)
  @Delete('reports/:id')
  deleteReport(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('execution.report.delete', id, body, auth, req)
  }

  // ---------------- 单独投料 / 工时 / 五量查询 ----------------

  @RequirePermission(EXECUTION_FEED)
  @Post('feeds')
  submitFeed(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('execution.feed.submit', 'new', body, auth, req)
  }

  @RequirePermission(EXECUTION_LABOR)
  @Post('labor-records')
  recordLabor(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('execution.labor.record', 'new', body, auth, req)
  }

  @RequirePermission(EXECUTION_READ)
  @Get('orders/:id/quantities')
  orderQuantities(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    return this.queries.orderQuantities(auth, id)
  }

  @RequirePermission(EXECUTION_READ)
  @Get('orders/:id/labor-records')
  listLabor(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    return this.queries.listLaborByOrder(auth, id)
  }

  // ---------------- 命令执行 ----------------

  /**
   * 三入口统一入口：载荷注入 source/orderId（服务端权威，不信客户端自报来源）；
   * body.action='submit'（或缺省）→ 直接提交；'draft' → 仅保存草稿。
   */
  private async runEntry(
    source: 'order' | 'workbench' | 'scan',
    orderId: string,
    body: unknown,
    auth: VerifiedAuthContext,
    req: Request,
  ): Promise<unknown> {
    const payload = (body ?? {}) as Record<string, unknown>
    if (orderId !== 'new') payload['orderId'] = orderId
    payload['source'] = source
    const commandType =
      payload['action'] === 'draft' ? 'execution.session.save' : 'execution.report.submit'
    return this.run(commandType, 'new', payload, auth, req)
  }

  /** 变更端点统一经命令总线（operationId 取 body/x-operation-id；FORBIDDEN→403、NOT_FOUND→404、其余→422）。 */
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
      expectedRevision: 0,
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

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : undefined
}
