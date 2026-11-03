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
// csw 域许可常量位于 domain csw 面（未并入包名入口；apps 无包边界限制，dist 相对导入直接可用——
// [L0-整合标记] L0 整合后在 domain index 追加 `export * from './csw'` 并改包名导入）。
import { CSW_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, VerifiedAuthContext } from '@cadenza/application'
import type { CswQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { CSW_COMMAND_BUS, CSW_QUERY_SERVICE } from './csw.tokens'

/**
 * csw 端点（T22 受约束排程与外协）：
 * - 查询：冻结记录/换型矩阵/排程版本（详情 + 并排回放比较 CS-13）/覆盖审计/停机与影响提示/
 *   校准标记槽位（CS-10）/外协任务/ERP 加工数量事实导出（CS-24）/就绪评估（CS-07）；
 * - 命令：冻结创建/解冻（csw.unfreeze 具名权限，CS-11）、换型矩阵发布、校准状态、
 *   停机登记/关闭、重排建议/提交、外协全生命周期——全部经命令总线（幂等+审计+事务）。
 * 挂全局守卫（AuthGuard/ScopeGuard）；查询按数据范围服务端过滤（OA-24/25）。
 */
@Controller('csw')
export class CswController {
  constructor(
    @Inject(CSW_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(CSW_QUERY_SERVICE) private readonly queries: CswQueryService,
  ) {}

  // ---------------- 查询 ----------------

  @RequirePermission(CSW_PERMISSIONS.CSW_READ)
  @PlantParam('plantId')
  @Get('freeze-records')
  listFreezes(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('equipmentId') equipmentId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listFreezeRecords(auth, {
      plantId,
      equipmentId,
      status: status === 'active' || status === 'ended' ? status : undefined,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_READ)
  @PlantParam('plantId')
  @Get('changeover-matrices')
  listMatrices(@CurrentAuth() auth: VerifiedAuthContext, @Query('plantId') plantId?: string) {
    return this.queries.listChangeoverMatrices(auth, { plantId })
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_READ)
  @PlantParam('plantId')
  @Get('versions')
  listVersions(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listVersions(auth, {
      plantId,
      status:
        status === 'proposed' || status === 'committed' || status === 'superseded' ? status : undefined,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_READ)
  @Get('versions/:id')
  async versionDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.versionDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '排程版本不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_READ)
  @Get('versions/:id/compare')
  async versionCompare(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const compare = await this.queries.versionCompare(auth, id)
    if (compare === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '排程版本不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return compare
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_READ)
  @PlantParam('plantId')
  @Get('override-audit')
  listOverrideAudit(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('overrideType') overrideType?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const known = ['soft_constraint_confirm', 'unfreeze', 'weight_change', 'manual_over_suggestion'] as const
    return this.queries.listOverrideAudit(auth, {
      plantId,
      overrideType: known.includes(overrideType as (typeof known)[number])
        ? (overrideType as (typeof known)[number])
        : undefined,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_READ)
  @PlantParam('plantId')
  @Get('downtimes')
  listDowntimes(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('equipmentId') equipmentId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listDowntimes(auth, {
      plantId,
      equipmentId,
      status: status === 'active' || status === 'closed' ? status : undefined,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_READ)
  @PlantParam('plantId')
  @Get('calibration-states')
  listCalibrationStates(@CurrentAuth() auth: VerifiedAuthContext, @Query('plantId') plantId?: string) {
    return this.queries.listCalibrationStates(auth, { plantId })
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_READ)
  @PlantParam('plantId')
  @Get('outsourcing-tasks')
  listOutsourcingTasks(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('status') status?: string,
    @Query('orderOperationId') orderOperationId?: string,
    @Query('taskNoLike') taskNoLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const known = [
      'draft',
      'pending_send',
      'sent',
      'return_received',
      'inspecting',
      'closed',
      'recalled',
      'return_disposed',
    ] as const
    return this.queries.listOutsourcingTasks(auth, {
      plantId,
      status: known.includes(status as (typeof known)[number]) ? (status as (typeof known)[number]) : undefined,
      orderOperationId,
      taskNoLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_READ)
  @Get('outsourcing-tasks/:id')
  async outsourcingDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.outsourcingDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '外协任务不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  /** [CS-24] 加工数量事实导出（供 ERP 结算核对；本系统不记应付/加工费/发票）。 */
  @RequirePermission(CSW_PERMISSIONS.CSW_READ)
  @PlantParam('plantId')
  @Get('outsourcing-erp-export')
  outsourcingErpExport(@CurrentAuth() auth: VerifiedAuthContext, @Query('plantId') plantId?: string) {
    return this.queries.outsourcingErpExport(auth, { plantId })
  }

  /** [CS-07/CS-08] 就绪评估（四条件；开工闸门等价服务——收编请求见交付记录）。 */
  @RequirePermission(CSW_PERMISSIONS.CSW_READ)
  @Get('readiness')
  async readiness(@CurrentAuth() auth: VerifiedAuthContext, @Query('orderOperationId') orderOperationId?: string) {
    if (orderOperationId === undefined || orderOperationId === '') {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 orderOperationId 查询参数', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    const view = await this.queries.evaluateReadiness(auth, { orderOperationId })
    if (view === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '订单工序不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return view
  }

  // ---------------- 命令 ----------------

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('freeze/create')
  freezeCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.freeze.create', bodyKey(body, 'equipmentId') ?? 'freeze', body, auth, req)
  }

  /** [CS-11] 解冻：具名权限 csw.unfreeze（守卫首检 + 处理器二道防线）＋理由留痕。 */
  @RequirePermission(CSW_PERMISSIONS.CSW_UNFREEZE)
  @HttpCode(HttpStatus.OK)
  @Post('freeze/release')
  freezeRelease(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.freeze.release', bodyKey(body, 'freezeId') ?? 'freeze', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('changeover/publish')
  changeoverPublish(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.changeover.publish', bodyKey(body, 'plantId') ?? 'matrix', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('calibration/state')
  calibrationState(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.calibration.state.set', bodyKey(body, 'equipmentId') ?? 'cal', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('downtime/register')
  downtimeRegister(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.downtime.register', bodyKey(body, 'equipmentId') ?? 'downtime', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('downtime/close')
  downtimeClose(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.downtime.close', bodyKey(body, 'downtimeId') ?? 'downtime', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('reschedule/propose')
  reschedulePropose(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.reschedule.propose', bodyKey(body, 'plantId') ?? 'propose', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('reschedule/commit')
  rescheduleCommit(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.reschedule.commit', bodyKey(body, 'versionId') ?? 'commit', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('outsourcing/create')
  outsourcingCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.outsourcing.create', bodyKey(body, 'orderOperationId') ?? 'owt', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('outsourcing/submit')
  outsourcingSubmit(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.outsourcing.submit', bodyKey(body, 'taskId') ?? 'owt', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('outsourcing/send')
  outsourcingSend(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.outsourcing.send', bodyKey(body, 'taskId') ?? 'owt', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('outsourcing/receive')
  outsourcingReceive(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.outsourcing.receive', bodyKey(body, 'taskId') ?? 'owt', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('outsourcing/inspect')
  outsourcingInspect(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.outsourcing.inspect', bodyKey(body, 'taskId') ?? 'owt', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('outsourcing/close')
  outsourcingClose(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.outsourcing.close', bodyKey(body, 'taskId') ?? 'owt', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('outsourcing/recall')
  outsourcingRecall(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.outsourcing.recall', bodyKey(body, 'taskId') ?? 'owt', body, auth, req)
  }

  @RequirePermission(CSW_PERMISSIONS.CSW_POST)
  @HttpCode(HttpStatus.OK)
  @Post('outsourcing/dispose')
  outsourcingDispose(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('csw.outsourcing.dispose', bodyKey(body, 'taskId') ?? 'owt', body, auth, req)
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

function bodyKey(body: unknown, key: string): string | null {
  const payload = (body ?? {}) as Record<string, unknown>
  const v = payload[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function toNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 ? n : undefined
}
