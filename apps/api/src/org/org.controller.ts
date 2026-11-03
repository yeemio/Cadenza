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
import { ORG_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, OrgQueryService, VerifiedAuthContext } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { ORG_COMMAND_BUS, ORG_QUERY_SERVICE } from './org.tokens'

/**
 * org 管理端点：机构/用户/角色/授权 CRUD（分页）。
 * 变更全部经命令总线（幂等 + 审计 + 事务）；查询按数据范围服务端过滤（OA-24/25/26）。
 */
@Controller('org')
export class OrgController {
  constructor(
    @Inject(ORG_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(ORG_QUERY_SERVICE) private readonly queries: OrgQueryService,
  ) {}

  // ---------------- 机构 ----------------

  @RequirePermission(ORG_PERMISSIONS.ORG_READ)
  @PlantParam('plantId')
  @Get('nodes')
  listNodes(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('kind') kind?: string,
    @Query('plantId') plantId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listNodes(auth, {
      kind,
      plantId,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @Post('nodes')
  createNode(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('org.node.create', 'new', body, auth, req)
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @Patch('nodes/:id')
  updateNode(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('org.node.update', id, body, auth, req)
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @Delete('nodes/:id')
  retireNode(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('org.node.retire', id, body, auth, req)
  }

  // ---------------- 用户 ----------------

  @RequirePermission(ORG_PERMISSIONS.ORG_READ)
  @PlantParam('plantId')
  @Get('users')
  listUsers(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('loginNameLike') loginNameLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listUsers(auth, {
      plantId,
      loginNameLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @Post('users')
  createUser(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('org.user.create', 'new', body, auth, req)
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @Patch('users/:id')
  updateUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('org.user.update', id, body, auth, req)
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @Delete('users/:id')
  retireUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('org.user.retire', id, body, auth, req)
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('users/:id/reset-password')
  resetPassword(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('org.user.resetPassword', id, body, auth, req)
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('users/:id/unlock')
  unlockUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('org.user.unlock', id, body, auth, req)
  }

  // ---------------- 角色 ----------------

  @RequirePermission(ORG_PERMISSIONS.ORG_READ)
  @Get('roles')
  listRoles(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('includeRetired') includeRetired?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listRoles(auth, {
      includeRetired: includeRetired === 'true',
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @Post('roles')
  createRole(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('org.role.create', 'new', body, auth, req)
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @Patch('roles/:id')
  updateRole(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('org.role.update', id, body, auth, req)
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @Delete('roles/:id')
  retireRole(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    return this.run('org.role.retire', id, body, auth, req)
  }

  // ---------------- 授权 ----------------

  @RequirePermission(ORG_PERMISSIONS.ORG_READ)
  @Get('grants')
  listGrants(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('principalType') principalType?: string,
    @Query('principalId') principalId?: string,
    @Query('includeRetired') includeRetired?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listGrants(auth, {
      principalType,
      principalId,
      includeRetired: includeRetired === 'true',
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @Post('grants')
  grant(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('org.grant.grant', 'new', body, auth, req)
  }

  @RequirePermission(ORG_PERMISSIONS.ORG_ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('grants/revoke')
  revokeGrant(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('org.grant.revoke', 'new', body, auth, req)
  }

  // ---------------- 命令执行 ----------------

  /**
   * 变更端点统一经命令总线：
   * - operationId 取 body.operationId 或 x-operation-id 头（幂等键，客户端可原键重放）；
   * - reason 取 body.reason 或 x-reason 头（高影响操作必填，OA-29）；
   * - ERR_FORBIDDEN_SCOPE 业务拒绝映射 403，NOT_FOUND 映射 404，其余业务拒绝 422，版本冲突 409。
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

    // expectedRevision：org 域 P1 未启用乐观并发修订列，保留合同信封形状（0）
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
