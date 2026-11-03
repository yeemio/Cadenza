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
import { MASTERDATA_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, VerifiedAuthContext } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { MASTERDATA_COMMAND_BUS, MASTERDATA_QUERIES } from './masterdata.tokens'
import type { MasterDataQueriesPort } from './masterdata.queries-port'

/**
 * 工厂主数据端点（T04 主数据块）：
 * - 料品只读（MD-01：本系统无新增/删除入口；仅换算行可编）；
 * - 换算行 create/update/new-version/retire（MD-04/05）；
 * - 设备（含状态切换 MD-14）/仓库/库位/货架/工作中心 CRUD + retire（逻辑删除，MD-36）；
 * - 全部变更经命令总线（幂等 + 审计 + 事务 = UoW）；查询按数据范围服务端过滤（OA-24/25）；
 * - 全局 AuthGuard + ScopeGuard（AuthModule 注册）覆盖本控制器所有路由。
 */
@Controller('masterdata')
export class MasterDataController {
  constructor(
    @Inject(MASTERDATA_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(MASTERDATA_QUERIES) private readonly queries: MasterDataQueriesPort,
  ) {}

  // ---------------- 料品（只读，MD-01/02） ----------------

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @Get('materials')
  listMaterials(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('nameLike') nameLike?: string,
    @Query('codeLike') codeLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listMaterials(auth, {
      nameLike,
      codeLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @Get('materials/:id/conversions')
  listConversions(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Param('id') id: string,
  ) {
    return this.queries.listConversions(auth, id)
  }

  // ---------------- 换算行（MD-04/05） ----------------

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('conversions')
  createConversion(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('masterdata.conversion.create', 'new', body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Patch('conversions/:id')
  updateConversion(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.conversion.update', id, body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('conversions/:id/new-version')
  newConversionVersion(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.conversion.newVersion', id, body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Delete('conversions/:id')
  retireConversion(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.conversion.retire', id, body, auth, req)
  }

  // ---------------- 设备（MD-09～16） ----------------

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @PlantParam('plantId')
  @Get('equipment')
  listEquipment(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('nameLike') nameLike?: string,
    @Query('codeLike') codeLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listEquipment(auth, {
      plantId,
      nameLike,
      codeLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @Get('equipment/:id/status-logs')
  listEquipmentStatusLogs(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Param('id') id: string,
  ) {
    return this.queries.listEquipmentStatusLogs(auth, id)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('equipment')
  createEquipment(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('masterdata.equipment.create', 'new', body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Patch('equipment/:id')
  updateEquipment(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.equipment.update', id, body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('equipment/:id/change-status')
  changeEquipmentStatus(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.equipment.changeStatus', id, body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Delete('equipment/:id')
  retireEquipment(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.equipment.retire', id, body, auth, req)
  }

  // ---------------- 仓库（MD-22～27） ----------------

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @PlantParam('plantId')
  @Get('warehouses')
  listWarehouses(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('nameLike') nameLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listWarehouses(auth, {
      plantId,
      nameLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('warehouses')
  createWarehouse(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('masterdata.warehouse.create', 'new', body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Patch('warehouses/:id')
  updateWarehouse(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.warehouse.update', id, body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Delete('warehouses/:id')
  retireWarehouse(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.warehouse.retire', id, body, auth, req)
  }

  // ---------------- 普通库位（MD-28/29） ----------------

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @PlantParam('plantId')
  @Get('locations')
  listLocations(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('codeLike') codeLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listLocations(auth, {
      plantId,
      warehouseId,
      codeLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('locations')
  createLocation(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('masterdata.location.create', 'new', body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Patch('locations/:id')
  updateLocation(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.location.update', id, body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Delete('locations/:id')
  retireLocation(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.location.retire', id, body, auth, req)
  }

  // ---------------- 货架（MD-30/31/33） ----------------

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @PlantParam('plantId')
  @Get('racks')
  listRacks(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('codeLike') codeLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listRacks(auth, {
      plantId,
      warehouseId,
      codeLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('racks')
  createRack(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('masterdata.rack.create', 'new', body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Patch('racks/:id')
  updateRack(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.rack.update', id, body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Delete('racks/:id')
  retireRack(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.rack.retire', id, body, auth, req)
  }

  // ---------------- 工作中心（MD-17/18） ----------------

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @PlantParam('plantId')
  @Get('work-centers')
  listWorkCenters(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('codeLike') codeLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listWorkCenters(auth, {
      plantId,
      codeLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('work-centers')
  createWorkCenter(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('masterdata.workcenter.create', 'new', body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Patch('work-centers/:id')
  updateWorkCenter(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.workcenter.update', id, body, auth, req)
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Delete('work-centers/:id')
  retireWorkCenter(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('masterdata.workcenter.retire', id, body, auth, req)
  }

  // ---------------- 命令执行 ----------------

  /**
   * 变更端点统一经命令总线（与 org 控制器同一模式）：
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
      expectedRevision: 0, // 主数据 P1 未启用乐观并发修订列，保留合同信封形状
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
