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
// L0-整合标记：spc 域许可常量位于 domain spc 面（未并入包名入口），dist 相对桥接同 composition 注释。
import { SPC_PERMISSIONS } from '@cadenza/domain'
// L0-整合标记：查询服务位于 application spc 面（未并入包名入口），dist 相对桥接同 composition 注释。
import type { SpcQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { SPC_COMMAND_BUS, SPC_QUERY_SERVICE } from './spc.tokens'

/**
 * spc 端点（T23 工艺变更影响控制 / SPC / 计量校准 / 工具寿命）：
 * - 查询：变更单列表/详情（PE-06 三类影响清单）、规则集、受控项目、控制图（PE-14）、
 *   失控处置任务与处置链（PE-12）、器具详情+校准历史（PE-15）、失准圈定（PE-18 只读重建）、
 *   工具台账（PE-20/21）；
 * - 命令：变更单四步、规则集、受控项目、控制限重算、样本登记、失控处置/复控确认、
 *   器具登记、校准记录、失准处置、工具四命令——全部经命令总线（幂等+审计+事务），
 *   数量/测量值一律十进制字符串。
 * 挂全局守卫（AuthGuard/ScopeGuard；工艺工程师/质量/计量岗位共用 spc.read/post 许可面）；
 * 查询按数据范围服务端过滤（OA-24/25）。PE-13：本控制器无任何质量放行/隔离端点
 * （SPC 结论仅作质量证据输入；质量放行/隔离只能出自质量域 T12/T18）。
 */
@Controller('spc')
export class SpcController {
  constructor(
    @Inject(SPC_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(SPC_QUERY_SERVICE) private readonly queries: SpcQueryService,
  ) {}

  // ---------------- 查询 ----------------

  @RequirePermission(SPC_PERMISSIONS.SPC_READ)
  @PlantParam('plantId')
  @Get('changes')
  listChanges(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listChanges(auth, {
      plantId,
      statuses: statuses?.split(','),
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  /** PE-06 变更影响查询：版本对/审批人/生效时间 + ①受影响未执行 ②在制（含处置结论）③已完成/已发运（提示范围）。 */
  @RequirePermission(SPC_PERMISSIONS.SPC_READ)
  @Get('changes/:id')
  async changeDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.changeDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '变更单不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    const grouped = {
      unexecuted: detail.impacts.filter((i) => i.category === 'unexecuted'),
      inProcess: detail.impacts.filter((i) => i.category === 'in_process'),
      completed: detail.impacts.filter((i) => i.category === 'completed'),
    }
    return { ...detail, impacts: undefined, impactGroups: grouped }
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_READ)
  @PlantParam('plantId')
  @Get('rule-sets')
  listRuleSets(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listRuleSets(auth, {
      plantId,
      statuses: statuses?.split(','),
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_READ)
  @PlantParam('plantId')
  @Get('control-items')
  listControlItems(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listControlItems(auth, { plantId, page: toNumber(page), pageSize: toNumber(pageSize) })
  }

  /** 控制图视图（PE-10/14：控制限版本链 + 样本判定绑定判定时点版本）。 */
  @RequirePermission(SPC_PERMISSIONS.SPC_READ)
  @Get('control-items/:id/chart')
  async controlChart(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const chart = await this.queries.controlChart(auth, id)
    if (chart === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '受控项目不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return chart
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_READ)
  @PlantParam('plantId')
  @Get('ooc-tasks')
  listOocTasks(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listOocTasks(auth, {
      plantId,
      statuses: statuses?.split(','),
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  /** PE-12 处置链可查：任务 + 失控样本 + 判定（命中准则/判定时点版本）。 */
  @RequirePermission(SPC_PERMISSIONS.SPC_READ)
  @Get('ooc-tasks/:id')
  async oocTaskDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.oocTaskDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '失控处置任务不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  /** PE-15/16/17：器具详情 + 校准历史 + 检测类任务可排产判定（CS-05 硬约束③ 等价服务）。 */
  @RequirePermission(SPC_PERMISSIONS.SPC_READ)
  @Get('gauges/:id')
  async gaugeDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.gaugeDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '计量器具不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  /** PE-18 失准影响圈定（只读追溯清单：实测→结论/放行→批次/在制/库存/已发运）+ PE-19 处置进度。 */
  @RequirePermission(SPC_PERMISSIONS.SPC_READ)
  @Get('miscalibration/circle')
  async miscalibrationCircle(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('gaugeId') gaugeId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (gaugeId === undefined || gaugeId === '' || from === undefined || from === '' || to === undefined || to === '') {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 gaugeId/from/to 查询参数', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    const circle = await this.queries.miscalibrationCircle(auth, gaugeId, from, to)
    if (circle === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '计量器具不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return circle
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_READ)
  @PlantParam('plantId')
  @Get('tools')
  listTools(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listTools(auth, { plantId, page: toNumber(page), pageSize: toNumber(pageSize) })
  }

  /** PE-20/21：工具台账（配置版本链 + 消耗行 + 具名调整 + 有效寿命/状态/可排产判定）。 */
  @RequirePermission(SPC_PERMISSIONS.SPC_READ)
  @Get('tools/:id')
  async toolDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.toolDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '工具台账不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  // ---------------- 命令 ----------------

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @Post('change/create')
  changeCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.change.create', bodyKey(body, 'changeNo') ?? 'change', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @HttpCode(HttpStatus.OK)
  @Post('change/scan')
  changeScan(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.change.scan', bodyKey(body, 'changeId') ?? 'scan', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @HttpCode(HttpStatus.OK)
  @Post('change/disposition')
  changeDisposition(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.change.disposition', bodyKey(body, 'impactId') ?? 'disposition', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @HttpCode(HttpStatus.OK)
  @Post('change/publish')
  changePublish(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.change.publish', bodyKey(body, 'changeId') ?? 'publish', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @Post('rule-set/create')
  ruleSetCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.rule-set.create', bodyKey(body, 'name') ?? 'rule-set', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @HttpCode(HttpStatus.OK)
  @Post('rule-set/publish')
  ruleSetPublish(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.rule-set.publish', bodyKey(body, 'ruleSetId') ?? 'rule-set', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @Post('control-item/create')
  controlItemCreate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.control-item.create', bodyKey(body, 'itemNo') ?? 'item', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @HttpCode(HttpStatus.OK)
  @Post('control-limit/recalc')
  controlLimitRecalc(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.control-limit.recalc', bodyKey(body, 'controlItemId') ?? 'limit', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @Post('sample/record')
  sampleRecord(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.sample.record', bodyKey(body, 'controlItemId') ?? 'sample', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @HttpCode(HttpStatus.OK)
  @Post('ooc/dispose')
  oocDispose(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.ooc.dispose', bodyKey(body, 'oocTaskId') ?? 'ooc', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @HttpCode(HttpStatus.OK)
  @Post('ooc/confirm-recontrol')
  oocConfirmRecontrol(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.ooc.confirm-recontrol', bodyKey(body, 'oocTaskId') ?? 'ooc', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @Post('gauge/register')
  gaugeRegister(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.gauge.register', bodyKey(body, 'gaugeNo') ?? 'gauge', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @Post('calibration/record')
  calibrationRecord(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.calibration.record', bodyKey(body, 'gaugeId') ?? 'calibration', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @HttpCode(HttpStatus.OK)
  @Post('miscalibration/action')
  miscalibrationAction(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.miscalibration.action', bodyKey(body, 'gaugeId') ?? 'miscal', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @Post('tool/register')
  toolRegister(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.tool.register', bodyKey(body, 'toolNo') ?? 'tool', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @HttpCode(HttpStatus.OK)
  @Post('tool/config-revise')
  toolConfigRevise(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.tool.config-revise', bodyKey(body, 'toolId') ?? 'tool', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @HttpCode(HttpStatus.OK)
  @Post('tool/consume')
  toolConsume(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.tool.consume', bodyKey(body, 'toolId') ?? 'tool', body, auth, req)
  }

  @RequirePermission(SPC_PERMISSIONS.SPC_POST)
  @HttpCode(HttpStatus.OK)
  @Post('tool/adjust')
  toolAdjust(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('spc.tool.adjust', bodyKey(body, 'toolId') ?? 'tool', body, auth, req)
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
      expectedRevision: 0, // spc 域未启用乐观修订列（同 shipping 口径）
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
