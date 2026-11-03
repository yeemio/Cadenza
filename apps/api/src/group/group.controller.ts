import {
  Body,
  Controller,
  Get,
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
import { GROUP_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, GroupQueryService, VerifiedAuthContext } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { GROUP_COMMAND_BUS, GROUP_QUERY_SERVICE } from './group.tokens'

/**
 * G 场景专用 HTTP 面（WI-L1-G-ALLOC-REV-API / WI-L1-G-SHORTAGE-KIT-API）：
 * - GET/POST /group/allocation-revisions（≠ /cost/allocation-versions）
 * - GET /group/allocation-revisions/:id
 * - GET /group/shortage-kitting
 * - POST /group/shortage-kitting/check
 * - GET/POST /group/recalls（成品/批次召回；≠ CSW 外协 recall）
 * - GET /group/recalls/:id
 * - GET/POST /group/vendor-risks（≠ 外协任务）
 * - GET/POST /group/rework、/group/scrap（返工/报废写入口；≠ disposition；≠ 召回）
 * 许可：group.read / group.post。
 */
@Controller('group')
export class GroupController {
  constructor(
    @Inject(GROUP_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(GROUP_QUERY_SERVICE) private readonly queries: GroupQueryService,
  ) {}

  // -------- 集团分配修订 --------

  @RequirePermission(GROUP_PERMISSIONS.GROUP_READ)
  @PlantParam('plantId')
  @Get('allocation-revisions')
  listAllocationRevisions(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listAllocationRevisions(auth, {
      plantId,
      status,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(GROUP_PERMISSIONS.GROUP_READ)
  @Get('allocation-revisions/:id')
  async allocationRevisionDetail(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Param('id') id: string,
  ) {
    const detail = await this.queries.getAllocationRevision(auth, id)
    if (detail === null) {
      throw new HttpException(
        {
          code: ERROR_CODES.NOT_FOUND,
          message: '分配修订不存在或不在授权数据范围内',
          details: {},
        },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  @RequirePermission(GROUP_PERMISSIONS.GROUP_POST)
  @Post('allocation-revisions')
  createAllocationRevision(
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    const payload = bodyAsRecord(body)
    const target =
      (typeof payload['revisionNo'] === 'string' && payload['revisionNo']) ||
      (typeof payload['title'] === 'string' && payload['title']) ||
      'allocation-revision'
    return this.run('group.allocation-revision.create', target, body, auth, req)
  }

  // -------- 缺料/齐套 --------

  @RequirePermission(GROUP_PERMISSIONS.GROUP_READ)
  @PlantParam('plantId')
  @Get('shortage-kitting')
  listShortageKitting(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('orderNoLike') orderNoLike?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listShortageKitting(auth, {
      plantId,
      orderNoLike,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(GROUP_PERMISSIONS.GROUP_POST)
  @Post('shortage-kitting/check')
  shortageKittingCheck(
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    const payload = bodyAsRecord(body)
    const target =
      (typeof payload['orderNo'] === 'string' && payload['orderNo']) || 'shortage-check'
    return this.run('group.shortage-kitting.check', target, body, auth, req)
  }


  // -------- 成品/批次召回 --------

  @RequirePermission(GROUP_PERMISSIONS.GROUP_READ)
  @PlantParam('plantId')
  @Get('recalls')
  listProductRecalls(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listProductRecalls(auth, {
      plantId,
      status,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(GROUP_PERMISSIONS.GROUP_READ)
  @Get('recalls/:id')
  async productRecallDetail(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Param('id') id: string,
  ) {
    const detail = await this.queries.getProductRecall(auth, id)
    if (detail === null) {
      throw new HttpException(
        {
          code: ERROR_CODES.NOT_FOUND,
          message: '成品/批次召回不存在或不在授权数据范围内',
          details: {},
        },
        HttpStatus.NOT_FOUND,
      )
    }
    return detail
  }

  @RequirePermission(GROUP_PERMISSIONS.GROUP_POST)
  @Post('recalls')
  createProductRecall(
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    const payload = bodyAsRecord(body)
    const target =
      (typeof payload['recallNo'] === 'string' && payload['recallNo']) ||
      (typeof payload['title'] === 'string' && payload['title']) ||
      'product-recall'
    return this.run('group.product-recall.create', target, body, auth, req)
  }

  @RequirePermission(GROUP_PERMISSIONS.GROUP_POST)
  @Post('recalls/:id/confirm')
  confirmProductRecall(@Param('id') id: string, @Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('group.product-recall.confirm', id, body, auth, req)
  }

  @RequirePermission(GROUP_PERMISSIONS.GROUP_POST)
  @Post('recalls/:id/return-request')
  requestProductRecallReturn(@Param('id') id: string, @Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('group.product-recall.return-request', id, body, auth, req)
  }

  // -------- 供应商风险 --------

  @RequirePermission(GROUP_PERMISSIONS.GROUP_READ)
  @PlantParam('plantId')
  @Get('vendor-risks')
  listVendorRisks(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('vendorCodeLike') vendorCodeLike?: string,
    @Query('riskLevel') riskLevel?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listVendorRisks(auth, {
      plantId,
      vendorCodeLike,
      riskLevel,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(GROUP_PERMISSIONS.GROUP_POST)
  @Post('vendor-risks')
  createVendorRisk(
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    const payload = bodyAsRecord(body)
    const target =
      (typeof payload['riskNo'] === 'string' && payload['riskNo']) ||
      (typeof payload['vendorCode'] === 'string' && payload['vendorCode']) ||
      'vendor-risk'
    return this.run('group.vendor-risk.create', target, body, auth, req)
  }


  // -------- 返工/报废写命令入口（WI-L1-REWORK-SCRAP-WRITE；≠ disposition；≠ 召回） --------

  @RequirePermission(GROUP_PERMISSIONS.GROUP_READ)
  @PlantParam('plantId')
  @Get('rework')
  listRework(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listReworkWrites(auth, {
      plantId,
      status,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(GROUP_PERMISSIONS.GROUP_POST)
  @Post('rework')
  createRework(
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    const payload = bodyAsRecord(body)
    const target =
      (typeof payload['reworkNo'] === 'string' && payload['reworkNo']) ||
      (typeof payload['title'] === 'string' && payload['title']) ||
      'rework-write'
    return this.run('group.rework.create', target, body, auth, req)
  }

  @RequirePermission(GROUP_PERMISSIONS.GROUP_READ)
  @PlantParam('plantId')
  @Get('scrap')
  listScrap(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listScrapWrites(auth, {
      plantId,
      status,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(GROUP_PERMISSIONS.GROUP_POST)
  @Post('scrap')
  createScrap(
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    const payload = bodyAsRecord(body)
    const target =
      (typeof payload['scrapNo'] === 'string' && payload['scrapNo']) ||
      (typeof payload['title'] === 'string' && payload['title']) ||
      'scrap-write'
    return this.run('group.scrap.create', target, body, auth, req)
  }

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

function bodyAsRecord(body: unknown): Record<string, unknown> {
  return (body ?? {}) as Record<string, unknown>
}

function toNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
