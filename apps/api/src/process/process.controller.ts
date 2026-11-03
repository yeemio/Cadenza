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
import { PROCESS_COMMAND_BUS, PROCESS_QUERIES } from './process.tokens'
import type { ProcessQueriesPort } from './process.queries-port'

/**
 * 工艺与生产订单端点（T05）：
 * - 工艺术数据：产品族/BOM/路线/参数规范/工序主数据 CRUD+发布+失效（[底稿 A2-2] 版本冻结）；
 * - 生产订单：接收（模拟 U9 入站）/放行/开工（[底稿 A1-1] 前置）/挂起/解除挂起/作废 + 查询；
 * - 全部变更经命令总线（幂等 + 审计 + 事务 = UoW）；查询按数据范围服务端过滤（OA-24/25）；
 * - 全局 AuthGuard + ScopeGuard（AuthModule 注册）覆盖本控制器所有路由。
 *
 * 许可常量：domain/src/process/permissions.ts 定义 process.read / process.admin；
 * 该文件经 domain 包 index 导出前，此处以字面量消费（L0 整合标记：domain index 导出
 * './process' 后改为 `PROCESS_PERMISSIONS` 导入，字符串值不变）。
 */

/** [L0-整合标记] 镜像 domain/src/process/permissions.ts（PROCESS_PERMISSIONS）。 */
const PROCESS_READ = 'process.read'
const PROCESS_ADMIN = 'process.admin'

@Controller('process')
export class ProcessController {
  constructor(
    @Inject(PROCESS_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(PROCESS_QUERIES) private readonly queries: ProcessQueriesPort,
  ) {}

  // ---------------- 工艺术数据：产品族 ----------------

  @RequirePermission(PROCESS_READ)
  @PlantParam('plantId')
  @Get('families')
  listFamilies(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('nameLike') nameLike?: string,
    @Query('codeLike') codeLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listFamilies(auth, {
      plantId,
      nameLike,
      codeLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(PROCESS_ADMIN)
  @Post('families')
  createFamily(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('process.family.create', 'new', body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @Patch('families/:id')
  updateFamily(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.family.update', id, body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @Delete('families/:id')
  retireFamily(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.family.retire', id, body, auth, req)
  }

  // ---------------- 工艺术数据：BOM / 路线 / 参数规范（版本冻结） ----------------

  @RequirePermission(PROCESS_READ)
  @PlantParam('plantId')
  @Get('boms')
  listBoms(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('productFamilyId') productFamilyId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listBoms(auth, {
      plantId,
      productFamilyId,
      status,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(PROCESS_ADMIN)
  @Post('boms')
  createBom(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('process.bom.create', 'new', body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @Patch('boms/:id')
  updateBom(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.bom.update', id, body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('boms/:id/publish')
  publishBom(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.bom.publish', id, body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @Delete('boms/:id')
  retireBom(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.bom.retire', id, body, auth, req)
  }

  @RequirePermission(PROCESS_READ)
  @PlantParam('plantId')
  @Get('routes')
  listRoutes(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('productFamilyId') productFamilyId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listRoutes(auth, {
      plantId,
      productFamilyId,
      status,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(PROCESS_ADMIN)
  @Post('routes')
  createRoute(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('process.route.create', 'new', body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @Patch('routes/:id')
  updateRoute(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.route.update', id, body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('routes/:id/publish')
  publishRoute(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.route.publish', id, body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @Delete('routes/:id')
  retireRoute(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.route.retire', id, body, auth, req)
  }

  @RequirePermission(PROCESS_READ)
  @PlantParam('plantId')
  @Get('parameters')
  listParameters(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('productFamilyId') productFamilyId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listParameters(auth, {
      plantId,
      productFamilyId,
      status,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(PROCESS_ADMIN)
  @Post('parameters')
  createParameter(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('process.parameter.create', 'new', body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @Patch('parameters/:id')
  updateParameter(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.parameter.update', id, body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('parameters/:id/publish')
  publishParameter(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.parameter.publish', id, body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @Delete('parameters/:id')
  retireParameter(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.parameter.retire', id, body, auth, req)
  }

  // ---------------- 工艺术数据：工序主数据 ----------------

  @RequirePermission(PROCESS_READ)
  @PlantParam('plantId')
  @Get('operations')
  listOperations(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('nameLike') nameLike?: string,
    @Query('codeLike') codeLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listOperations(auth, {
      plantId,
      nameLike,
      codeLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(PROCESS_ADMIN)
  @Post('operations')
  createOperation(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('process.operation.create', 'new', body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @Patch('operations/:id')
  updateOperation(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.operation.update', id, body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @Delete('operations/:id')
  retireOperation(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.operation.retire', id, body, auth, req)
  }

  // ---------------- 生产订单 ----------------

  @RequirePermission(PROCESS_READ)
  @PlantParam('plantId')
  @Get('orders')
  listOrders(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('orderNoLike') orderNoLike?: string,
    @Query('statuses') statuses?: string,
    @Query('suspended') suspended?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listOrders(auth, {
      plantId,
      orderNoLike,
      statuses,
      suspended: suspended === undefined ? undefined : suspended === 'true',
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(PROCESS_READ)
  @PlantParam('plantId')
  @Get('orders/:id')
  getOrderDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    return this.queries.getOrderDetail(auth, id)
  }

  @RequirePermission(PROCESS_ADMIN)
  @Post('orders/receive')
  receiveOrder(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('process.order.receive', 'new', body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('orders/:id/release')
  releaseOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.order.release', id, body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('orders/:id/start')
  startOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.order.start', id, body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('orders/:id/suspend')
  suspendOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.order.suspend', id, body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('orders/:id/resume')
  resumeOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.order.resume', id, body, auth, req)
  }

  @RequirePermission(PROCESS_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('orders/:id/void')
  voidOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('process.order.void', id, body, auth, req)
  }

  // ---------------- 命令执行 ----------------

  /**
   * 变更端点统一经命令总线（与 org/masterdata 控制器同一模式）：
   * - operationId 取 body.operationId 或 x-operation-id 头（幂等键）；
   * - reason 取 body.reason 或 x-reason 头；
   * - FORBIDDEN_SCOPE→403、NOT_FOUND→404、其余业务拒绝→422、版本冲突→409。
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

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : undefined
}
