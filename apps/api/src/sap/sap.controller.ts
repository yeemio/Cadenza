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
import { SAP_RECON_PERMISSIONS } from '@cadenza/domain'
import { SapReconDerivationError } from '@cadenza/application'
import type {
  CommandBus,
  CommandContext,
  SapReconDerivationQueryService,
  SapReconQueryService,
  VerifiedAuthContext,
} from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { SAP_RECON_COMMAND_BUS, SAP_RECON_DERIVATION_SERVICE, SAP_RECON_QUERY_SERVICE } from './sap.tokens'

/**
 * SAP 双账/对账 HTTP（WI-L1-SAP-RECON-API）：
 * - GET/POST /sap/reconciliation
 * - GET /sap/reconciliation/derive — R4 两端独立推导（只读；数量/分类不经请求传入）
 * ≠ GET /cost/recon-items；≠ fixture；actual_connection=false；全量分类加深（G-B02）。
 */
@Controller('sap')
export class SapController {
  constructor(
    @Inject(SAP_RECON_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(SAP_RECON_QUERY_SERVICE) private readonly queries: SapReconQueryService,
    @Inject(SAP_RECON_DERIVATION_SERVICE) private readonly derivation: SapReconDerivationQueryService,
  ) {}

  @RequirePermission(SAP_RECON_PERMISSIONS.SAP_RECON_READ)
  @PlantParam('plantId')
  @Get('reconciliation')
  list(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('matchStatus') matchStatus?: string,
    @Query('classification') classification?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.list(auth, {
      plantId,
      matchStatus,
      classification,
      page: toNumber(page),
      pageSize: toNumber(pageSize),
    })
  }

  /**
   * R4：21 对象两端独立推导（只读）。输入仅为对象身份（对象名/料品 code/组织/单位），
   * 数量与状态全部由 MOM 业务表与 sim_sap_* 事实表现场推导；不得以 POST 预期分类替代。
   */
  @RequirePermission(SAP_RECON_PERMISSIONS.SAP_RECON_READ)
  @PlantParam('plantId')
  @Get('reconciliation/derive')
  async derive(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('momUnitNo') momUnitNo?: string,
    @Query('momLotNo') momLotNo?: string,
    @Query('objectId') objectId?: string,
    @Query('objectFullKey') objectFullKey?: string,
    @Query('momMaterialCode') momMaterialCode?: string,
    @Query('simMaterialKey') simMaterialKey?: string,
    @Query('ownerEntityCode') ownerEntityCode?: string,
    @Query('plantCode') plantCode?: string,
    @Query('unit') unit?: string,
    @Query('basis') basis?: string,
  ) {
    if (objectId === undefined || objectId.trim() === '') {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 objectId', details: {} },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    try {
      return await this.derivation.derive(auth, {
        plantId, momUnitNo, momLotNo, objectId, objectFullKey, momMaterialCode,
        simMaterialKey, ownerEntityCode, plantCode, unit, basis,
      })
    } catch (error) {
      if (error instanceof SapReconDerivationError) {
        throw new HttpException(
          {
            code: error.code === 'FORBIDDEN_SCOPE' ? ERROR_CODES.FORBIDDEN_SCOPE : ERROR_CODES.BUSINESS_RULE,
            message: error.message, details: {},
          },
          error.code === 'FORBIDDEN_SCOPE' ? HttpStatus.FORBIDDEN : HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }
      throw error
    }
  }

  @RequirePermission(SAP_RECON_PERMISSIONS.SAP_RECON_POST)
  @Post('reconciliation')
  create(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    const payload = (body ?? {}) as Record<string, unknown>
    const target =
      (typeof payload['reconNo'] === 'string' && payload['reconNo']) ||
      (typeof payload['objectCode'] === 'string' && payload['objectCode']) ||
      'sap-reconciliation'
    return this.run('sap.reconciliation.create', target, body, auth, req)
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
        if (result.errorCode === ERROR_CODES.FORBIDDEN_SCOPE) throw commandError(HttpStatus.FORBIDDEN, result)
        if (result.errorCode === ERROR_CODES.NOT_FOUND) throw commandError(HttpStatus.NOT_FOUND, result)
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

function toNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
