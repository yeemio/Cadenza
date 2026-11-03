import {
  Body,
  Controller,
  Get,
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
import { SCAN_BLOCK_PERMISSIONS } from '@cadenza/domain'
import type { CommandBus, CommandContext, ScanBlockQueryService, VerifiedAuthContext } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { SCAN_BLOCK_COMMAND_BUS, SCAN_BLOCK_QUERY_SERVICE } from './scan-block.tokens'

/**
 * E09 SCAN-BLOCK 专用 HTTP 面（WI-L1-E09-SCAN-BLOCK-API）：
 * - GET/POST /scan-block/events
 * ≠ 通用扫码 / 报工 / 条码解析。许可：scan_block.read / scan_block.post。
 */
@Controller('scan-block')
export class ScanBlockController {
  constructor(
    @Inject(SCAN_BLOCK_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(SCAN_BLOCK_QUERY_SERVICE) private readonly queries: ScanBlockQueryService,
  ) {}

  @RequirePermission(SCAN_BLOCK_PERMISSIONS.SCAN_BLOCK_READ)
  @PlantParam('plantId')
  @Get('events')
  listEvents(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('policyCode') policyCode?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.listEvents(auth, {
      plantId,
      policyCode,
      status,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  @RequirePermission(SCAN_BLOCK_PERMISSIONS.SCAN_BLOCK_POST)
  @Post('events')
  createEvent(
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    const payload = bodyAsRecord(body)
    const target =
      (typeof payload['eventNo'] === 'string' && payload['eventNo']) ||
      (typeof payload['scanCode'] === 'string' && payload['scanCode']) ||
      'scan-block-event'
    return this.run('scan-block.event.create', target, body, auth, req)
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
      (typeof payload['blockReason'] === 'string' && payload['blockReason']) ||
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
