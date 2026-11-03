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
// L0 整合步（Wave5）：domain/application index 已导出 quality 面；改包名导入。
import { QUALITY_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, VerifiedAuthContext, QualityQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { QUALITY_COMMAND_BUS, QUALITY_QUERY_SERVICE } from './quality.tokens'

/**
 * quality 端点（T12 质量放行）：
 * - 查询：检验任务分页/详情（结论版本链+处置记录）、隔离/存疑记录分页；
 * - 命令：检验任务生成（消费执行块事件）、实测提交（版本化追加）、放行/让步、
 *   存疑登记/恢复——全部经命令总线（幂等+审计+事务）。
 * 挂全局守卫（AuthGuard/ScopeGuard）；查询按数据范围服务端过滤（OA-24/25）。
 */
@Controller('quality')
export class QualityController {
  constructor(
    @Inject(QUALITY_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(QUALITY_QUERY_SERVICE) private readonly queries: QualityQueryService,
  ) {}

  // ---------------- 查询 ----------------

  @RequirePermission(QUALITY_PERMISSIONS.QUALITY_READ)
  @PlantParam('plantId')
  @Get('inspections')
  listInspections(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('stages') stages?: string,
    @Query('orderNoLike') orderNoLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listInspectionOrders(auth, {
      plantId,
      statuses: statuses?.split(','),
      stages: stages?.split(','),
      orderNoLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(QUALITY_PERMISSIONS.QUALITY_READ)
  @Get('inspections/:id')
  async inspectionDetail(@CurrentAuth() auth: VerifiedAuthContext, @Param('id') id: string) {
    const detail = await this.queries.inspectionDetail(auth, id)
    if (detail === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: '检验单不存在或不在授权数据范围内', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  @RequirePermission(QUALITY_PERMISSIONS.QUALITY_READ)
  @PlantParam('plantId')
  @Get('holds')
  listHolds(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('statuses') statuses?: string,
    @Query('holdKinds') holdKinds?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listHolds(auth, {
      plantId,
      statuses: statuses?.split(','),
      holdKinds: holdKinds?.split(','),
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  // ---------------- 命令 ----------------

  @RequirePermission(QUALITY_PERMISSIONS.QUALITY_POST)
  @Post('inspections/generate')
  inspectionGenerate(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('quality.inspection.generate', bodyAsRecord(body)['plantId'] as string ?? 'plant', body, auth, req)
  }

  @RequirePermission(QUALITY_PERMISSIONS.QUALITY_POST)
  @Post('test-results')
  testResultSubmit(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'quality.test-result.submit',
      (bodyAsRecord(body)['inspectionOrderId'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  @RequirePermission(QUALITY_PERMISSIONS.QUALITY_POST)
  @HttpCode(HttpStatus.OK)
  @Post('dispositions/release')
  dispositionRelease(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'quality.disposition.release',
      (bodyAsRecord(body)['inspectionOrderId'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  @RequirePermission(QUALITY_PERMISSIONS.QUALITY_POST)
  @HttpCode(HttpStatus.OK)
  @Post('dispositions/concession')
  dispositionConcession(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'quality.disposition.concession',
      (bodyAsRecord(body)['inspectionOrderId'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  @RequirePermission(QUALITY_PERMISSIONS.QUALITY_POST)
  @Post('suspects')
  suspectRegister(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'quality.suspect.register',
      (bodyAsRecord(body)['unitNo'] as string) ?? (bodyAsRecord(body)['unitId'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  @RequirePermission(QUALITY_PERMISSIONS.QUALITY_POST)
  @HttpCode(HttpStatus.OK)
  @Post('suspects/review')
  suspectReview(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('quality.suspect.review', (bodyAsRecord(body)['holdId'] as string) ?? 'unknown', body, auth, req)
  }

  @RequirePermission(QUALITY_PERMISSIONS.QUALITY_POST)
  @HttpCode(HttpStatus.OK)
  @Post('suspects/restore')
  suspectRestore(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run(
      'quality.suspect.restore',
      (bodyAsRecord(body)['holdId'] as string) ?? (bodyAsRecord(body)['unitId'] as string) ?? 'unknown',
      body,
      auth,
      req,
    )
  }

  // ---------------- 命令执行（同 inventory/purchase.controller 口径） ----------------

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
      expectedRevision: 0, // quality 域未启用乐观修订列（同 org/inventory/purchase 口径）
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

function bodyAsRecord(body: unknown): Record<string, unknown> {
  return (body ?? {}) as Record<string, unknown>
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : undefined
}
