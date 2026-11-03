import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
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
import type { ReworkQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { REWORK_COMMAND_BUS, REWORK_QUERY_SERVICE } from './rework.tokens'

/** rework 域许可点（RS-30 占用核权/RS-32 回撤权限点定义 → GAP-F4；读取/提交两级）。 */
export const REWORK_PERMISSIONS = {
  REWORK_READ: 'rework.read',
  REWORK_POST: 'rework.post',
} as const

/**
 * rework 端点（T15 倒轴/分托解绑/轴号修正/轴码退役——Web/PDA 双入口共用同命令）：
 * - 查询：倒出轴扫码（RS-03 只读）、倒轴记录（RS-08 Web 只读）、分托进行中带出（RS-14）、
 *   已完成分托记录、分托导出（RS-24 导出那一刻取数）、轴号修正扫码（RS-25/26）、
 *   修正记录（RS-S5）、清空记录（RS-35）；
 * - 命令：倒轴执行/冲销（RS-01～12）、分托六命令（RS-13～23）、修正提交/回撤
 *   （RS-25～33）、轴码退役（RS-34～37）——全部经命令总线（幂等+审计+事务），
 *   数量字段一律十进制字符串。
 * 挂全局守卫（AuthGuard/ScopeGuard）；查询按数据范围服务端过滤（OA-24/25）。
 */
@Controller('rework')
export class ReworkController {
  constructor(
    @Inject(REWORK_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(REWORK_QUERY_SERVICE) private readonly queries: ReworkQueryService,
  ) {}

  // ---------------- 查询：倒轴（RS-03/04/08） ----------------

  /** RS-03/04/06：倒出轴扫码查询（只读，会话模型不落进行中单据）。 */
  @RequirePermission(REWORK_PERMISSIONS.REWORK_READ)
  @PlantParam('plantId')
  @Get('reel-split/scan')
  reelSplitScan(
    @Query('plantId') plantId?: string,
    @Query('unitNo') unitNo?: string,
  ) {
    if (plantId === undefined || unitNo === undefined) {
      throw http422('缺少 plantId/unitNo 查询参数')
    }
    return this.queries.reelSplitSourceScan(plantId, unitNo)
  }

  /** RS-08：Web 倒轴记录（主表＋明细展开只读；无新增/编辑/删除入口）。 */
  @RequirePermission(REWORK_PERMISSIONS.REWORK_READ)
  @Get('reel-split/records')
  reelSplitRecords(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.reelSplitRecords(auth, toNumber(page) ?? 1, toNumber(pageSize) ?? 20)
  }

  // ---------------- 查询：分托/解绑（RS-14/S3/24） ----------------

  /** RS-14：再次进入自动带出进行中单据（PDA 侧）。 */
  @RequirePermission(REWORK_PERMISSIONS.REWORK_READ)
  @Get('pallet/current')
  async palletCurrent(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('taskType') taskType?: string,
  ) {
    const type = taskType === 'unbind_pallet' ? 'unbind_pallet' : 'split_pallet'
    try {
      return await this.queries.palletCurrentTask(auth.user.loginName, type)
    } catch (error) {
      if ((error as { rule?: string }).rule === 'RS-14') {
        throw new HttpException(
          { code: ERROR_CODES.NOT_FOUND, message: (error as Error).message, details: {} },
          HttpStatus.NOT_FOUND,
        )
      }
      throw error
    }
  }

  /** RS-S3/RS-20：Web 只展示已完成记录（进行中的不展示）。 */
  @RequirePermission(REWORK_PERMISSIONS.REWORK_READ)
  @Get('pallet/records')
  palletRecords(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('taskType') taskType?: string,
    @Query('operator') operator?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.palletCompletedRecords(auth, {
      taskType: taskType === 'unbind_pallet' ? 'unbind_pallet' : taskType === 'split_pallet' ? 'split_pallet' : undefined,
      operator,
      page: toNumber(page) ?? 1,
      pageSize: toNumber(pageSize) ?? 20,
    })
  }

  /** RS-24：分托导出（导出那一刻绑定取数；同托码同轴号同料品合并）。 */
  @RequirePermission(REWORK_PERMISSIONS.REWORK_READ)
  @PlantParam('plantId')
  @Get('pallet/export')
  palletExport(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('taskType') taskType?: string,
    @Query('operator') operator?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (plantId === undefined) throw http422('缺少 plantId 查询参数')
    return this.queries.palletExport(auth, plantId, {
      taskType: taskType === 'unbind_pallet' ? 'unbind_pallet' : 'split_pallet',
      operator,
      page: toNumber(page) ?? 1,
      pageSize: toNumber(pageSize) ?? 20,
    })
  }

  // ---------------- 查询：轴号修正（RS-25/26/S5） ----------------

  /** RS-25/26：轴号修正扫码查询（只查询不改数据；返回可选新轴号列表）。 */
  @RequirePermission(REWORK_PERMISSIONS.REWORK_READ)
  @PlantParam('plantId')
  @Get('axis-correction/scan')
  correctionScan(
    @Query('plantId') plantId?: string,
    @Query('unitNo') unitNo?: string,
  ) {
    if (plantId === undefined || unitNo === undefined) throw http422('缺少 plantId/unitNo 查询参数')
    return this.queries.correctionScan(plantId, unitNo)
  }

  /** RS-S5/RS-32：修正记录列表（含已撤销）。 */
  @RequirePermission(REWORK_PERMISSIONS.REWORK_READ)
  @Get('axis-correction/records')
  correctionRecords(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.correctionRecords(auth, toNumber(page) ?? 1, toNumber(pageSize) ?? 20)
  }

  // ---------------- 查询：轴码退役（RS-35） ----------------

  /** RS-35：Web 清空记录可查（退役档案保留）。 */
  @RequirePermission(REWORK_PERMISSIONS.REWORK_READ)
  @Get('axis-retire/records')
  retireRecords(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.retireRecords(auth, toNumber(page) ?? 1, toNumber(pageSize) ?? 20)
  }

  // ---------------- 命令：倒轴（RS-01～12） ----------------

  @RequirePermission(REWORK_PERMISSIONS.REWORK_POST)
  @Post('reel-split/execute')
  reelSplitExecute(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('rework.reel-split.execute', bodyKey(body, 'sourceUnitNo') ?? 'reel-split', body, auth, req)
  }

  @RequirePermission(REWORK_PERMISSIONS.REWORK_POST)
  @HttpCode(HttpStatus.OK)
  @Post('reel-split/reverse')
  reelSplitReverse(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('rework.reel-split.reverse', bodyKey(body, 'sourceOrderId') ?? 'reel-split', body, auth, req)
  }

  // ---------------- 命令：分托/解绑（RS-13～24） ----------------

  @RequirePermission(REWORK_PERMISSIONS.REWORK_POST)
  @HttpCode(HttpStatus.OK)
  @Post('pallet/scan-target')
  palletScanTarget(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('rework.pallet.scan-target', bodyKey(body, 'carrierCode') ?? 'pallet', body, auth, req)
  }

  @RequirePermission(REWORK_PERMISSIONS.REWORK_POST)
  @HttpCode(HttpStatus.OK)
  @Post('pallet/scan-item')
  palletScanItem(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('rework.pallet.scan-item', bodyKey(body, 'unitNo') ?? 'pallet', body, auth, req)
  }

  @RequirePermission(REWORK_PERMISSIONS.REWORK_POST)
  @HttpCode(HttpStatus.OK)
  @Post('pallet/set-location')
  palletSetLocation(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('rework.pallet.set-location', bodyKey(body, 'locationId') ?? 'pallet', body, auth, req)
  }

  @RequirePermission(REWORK_PERMISSIONS.REWORK_POST)
  @HttpCode(HttpStatus.OK)
  @Post('pallet/remove-item')
  palletRemoveItem(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('rework.pallet.remove-item', bodyKey(body, 'unitNo') ?? 'pallet', body, auth, req)
  }

  @RequirePermission(REWORK_PERMISSIONS.REWORK_POST)
  @HttpCode(HttpStatus.OK)
  @Post('pallet/confirm')
  palletConfirm(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('rework.pallet.confirm', bodyKey(body, 'taskType') ?? 'pallet', body, auth, req)
  }

  @RequirePermission(REWORK_PERMISSIONS.REWORK_POST)
  @HttpCode(HttpStatus.OK)
  @Post('pallet/leave')
  palletLeave(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('rework.pallet.leave', bodyKey(body, 'taskType') ?? 'pallet', body, auth, req)
  }

  // ---------------- 命令：轴号修正（RS-25～33） ----------------

  @RequirePermission(REWORK_PERMISSIONS.REWORK_POST)
  @HttpCode(HttpStatus.OK)
  @Post('axis-register')
  axisRegister(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('rework.axis-register', bodyKey(body, 'unitNo') ?? 'axis-register', body, auth, req)
  }

  @RequirePermission(REWORK_PERMISSIONS.REWORK_POST)
  @HttpCode(HttpStatus.OK)
  @Post('axis-correction/submit')
  correctionSubmit(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('rework.axis-correction.submit', bodyKey(body, 'unitNo') ?? 'axis-correction', body, auth, req)
  }

  @RequirePermission(REWORK_PERMISSIONS.REWORK_POST)
  @HttpCode(HttpStatus.OK)
  @Post('axis-correction/withdraw')
  correctionWithdraw(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('rework.axis-correction.withdraw', bodyKey(body, 'correctionId') ?? 'axis-correction', body, auth, req)
  }

  // ---------------- 命令：轴码退役（RS-34～37） ----------------

  @RequirePermission(REWORK_PERMISSIONS.REWORK_POST)
  @HttpCode(HttpStatus.OK)
  @Post('axis-retire/execute')
  axisRetireExecute(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('rework.axis-retire.execute', 'axis-retire', body, auth, req)
  }

  // ---------------- 命令执行（同 reverse.controller 口径） ----------------

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
      expectedRevision: 0, // rework 域未启用乐观修订列（同 reverse 口径）
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

function http422(message: string): HttpException {
  return new HttpException({ code: ERROR_CODES.BUSINESS_RULE, message, details: {} }, HttpStatus.UNPROCESSABLE_ENTITY)
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
