import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
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
import { SCHEDULING_COMMAND_BUS, SCHEDULING_QUERIES } from './scheduling.tokens'
import type { SchedulingQueriesPort } from './scheduling.queries-port'

/**
 * 生产排程端点（T09，规则来源：底稿 03-production-chain-rules A3/A4 节）：
 * - 命令：槽位保存（改 0 删槽 / 同键替换；confirm 标志区分硬拒与弱提醒——[A3-2] 硬校验
 *   一律 422，[A3-2w] 超产能 confirm=false 拒（错误文案即二次确认提示）、confirm=true 可提交
 *   且 data.warnings 携带提醒）、批量矩阵保存、设备日产能配置/清除、班次参数；
 * - 查询：订单视图与设备视图两套投影读同一 slot 表（[A3] 同一排产事实双投影）、
 *   PDA 排产计划只读（[A3-7]）、班次日期双轨（[A4-2]）；
 * - 全部变更经命令总线（幂等 + 审计 + 事务 = UoW）；查询按数据范围服务端过滤（OA-24/25）；
 * - 全局 AuthGuard + ScopeGuard（AuthModule 注册）覆盖本控制器所有路由。
 *
 * 许可常量：domain/src/scheduling/permissions.ts 定义 scheduling.read / scheduling.admin；
 * 该文件经 domain 包 index 导出前，此处以字面量消费（L0 整合标记：domain index 导出
 * './scheduling' 后改为 `SCHEDULING_PERMISSIONS` 导入，字符串值不变）。
 */

/** [L0-整合标记] 镜像 domain/src/scheduling/permissions.ts（SCHEDULING_PERMISSIONS）。 */
const SCHEDULING_READ = 'scheduling.read'
const SCHEDULING_ADMIN = 'scheduling.admin'

@Controller('scheduling')
export class SchedulingController {
  constructor(
    @Inject(SCHEDULING_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(SCHEDULING_QUERIES) private readonly queries: SchedulingQueriesPort,
  ) {}

  // ---------------- 查询：订单视图（订单排程详情投影） ----------------

  @RequirePermission(SCHEDULING_READ)
  @PlantParam('plantId')
  @Get('order-view/:orderId')
  async getOrderView(@CurrentAuth() auth: VerifiedAuthContext, @Param('orderId') orderId: string) {
    const view = await this.queries.orderView(auth, orderId)
    if (view === null) throw new NotFoundException('生产订单不存在或不属于本企业')
    return view
  }

  // ---------------- 查询：设备视图（设备排程看板投影） ----------------

  @RequirePermission(SCHEDULING_READ)
  @PlantParam('plantId')
  @Get('device-view')
  async getDeviceView(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('workCenterId') workCenterId?: string,
    @Query('equipmentId') equipmentId?: string,
  ) {
    const view = await this.queries.deviceBoard(auth, { plantId, workCenterId, equipmentId })
    if (view === null) throw new NotFoundException('目标工厂不存在或不属于本企业')
    return view
  }

  // ---------------- 查询：PDA 排产计划（只读） ----------------

  @RequirePermission(SCHEDULING_READ)
  @Get('pda/plan')
  async getPdaPlan(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('workCenterId') workCenterId?: string,
    @Query('orderNoLike') orderNoLike?: string,
    @Query('equipmentId') equipmentId?: string,
    @Query('date') date?: string,
  ) {
    if (workCenterId === undefined || workCenterId === '') {
      throw new BadRequestException('workCenterId 必填（PDA 排产计划按工作中心查询）')
    }
    const view = await this.queries.pdaPlan(auth, { workCenterId, orderNoLike, equipmentId, date })
    if (view === null) throw new NotFoundException('工作中心不存在或不属于本企业')
    return view
  }

  // ---------------- 查询：班次信息与双轨时间 ----------------

  @RequirePermission(SCHEDULING_READ)
  @PlantParam('plantId')
  @Get('shift-date')
  async getShiftDate(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('at') at?: string,
  ) {
    if (plantId === undefined || plantId === '') {
      throw new BadRequestException('plantId 必填（班次参数为工厂级）')
    }
    const info = await this.queries.shiftInfo(auth, { plantId, at })
    if (info === null) throw new NotFoundException('目标工厂不存在或不属于本企业')
    return info
  }

  // ---------------- 命令：槽位保存（单条 / 批量） ----------------

  @RequirePermission(SCHEDULING_ADMIN)
  @Post('slots')
  saveSlot(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('scheduling.slot.save', 'new', body, auth, req)
  }

  @RequirePermission(SCHEDULING_ADMIN)
  @Post('slots/batch')
  saveSlotsBatch(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('scheduling.slot.saveBatch', 'new', body, auth, req)
  }

  // ---------------- 命令：设备日产能 ----------------

  @RequirePermission(SCHEDULING_ADMIN)
  @Post('capacity')
  setCapacity(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('scheduling.capacity.set', 'new', body, auth, req)
  }

  @RequirePermission(SCHEDULING_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Delete('capacity')
  clearCapacity(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('scheduling.capacity.clear', 'new', body, auth, req)
  }

  // ---------------- 命令：班次参数 ----------------

  @RequirePermission(SCHEDULING_ADMIN)
  @Post('shift')
  setShift(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('scheduling.shift.set', 'new', body, auth, req)
  }

  // ---------------- 命令执行 ----------------

  /**
   * 变更端点统一经命令总线（与 org/masterdata/process 控制器同一模式）：
   * - operationId 取 body.operationId 或 x-operation-id 头（幂等键）；
   * - reason 取 body.reason 或 x-reason 头；
   * - FORBIDDEN_SCOPE→403、NOT_FOUND→404、其余业务拒绝→422、版本冲突→409。
   * 弱提醒语义（[A3-2w]）：confirm=false 的拒绝与硬校验拒绝同映射 422，
   * 以错误文案前缀 [A3-2w]（可确认重试）与 [A3-2]（强拒）区分。
   */
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
      expectedRevision: 0, // P1 未启用乐观并发修订列，保留合同信封形状
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
