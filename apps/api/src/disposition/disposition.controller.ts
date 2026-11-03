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
// L0-整合标记：disposition 许可常量位于 domain disposition 面（未并入包名入口，dist 相对桥接同 composition 注释）
import { DISPOSITION_PERMISSIONS } from '@cadenza/domain'
import type { DispositionQueryService } from '@cadenza/application'
import { CurrentAuth, PlantParam, RequirePermission } from '../auth/decorators'
import { DISPOSITION_COMMAND_BUS, DISPOSITION_QUERY_SERVICE } from './disposition.tokens'

/**
 * disposition 端点（T18 质量处置——Web/PDA 双入口共用同命令，PI S16 裁定精神随行）：
 * - 查询：存疑扫码预检（QD-01 只查询）/存疑与处置链并存（QD-S1/S3）/成品异常列表与码异常状态
 *   （QD-10 投影）/批次质检视图（QD-12/13/15 版本链+生效指针+重算状态）/影响圈定（QD-16/IT-35）；
 * - 命令：存疑标记/恢复（QD-01~03）、成品异常提交/审核（QD-05~09）、采购质检 Web 写入/PDA
 *   版本化/判定/复检（QD-11~14/17/18）、处置返工/报废/让步/放行（QD-19~23）——全部经命令总线
 *   （幂等+审计+事务），数量字段一律十进制字符串。
 * 证书/客诉/召回端点随 GAP-F16 裁定，裁定前不建（QD-24/25/QD-S5）。
 * 挂全局守卫（AuthGuard/ScopeGuard）；查询按数据范围服务端过滤（OA-24/25）。
 */
@Controller('disposition')
export class DispositionController {
  constructor(
    @Inject(DISPOSITION_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(DISPOSITION_QUERY_SERVICE) private readonly queries: DispositionQueryService,
  ) {}

  // ---------------- 查询：存疑（QD-01/S1/S3） ----------------

  /** QD-01：存疑扫码预检（只查询不改数据）。 */
  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_READ)
  @PlantParam('plantId')
  @Get('suspect/scan-check')
  suspectScanCheck(
    @CurrentAuth() _auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('unitNo') unitNo?: string,
    @Query('barcodeKind') barcodeKind?: string,
  ) {
    if (plantId === undefined || unitNo === undefined) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 plantId/unitNo', details: {} },
        HttpStatus.BAD_REQUEST,
      )
    }
    return this.queries.suspectScanCheck(plantId, unitNo, barcodeKind ?? 'unit')
  }

  /** 存疑记录＋处置链并存可查（QD-S1/QD-03）。 */
  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_READ)
  @PlantParam('plantId')
  @Get('suspect/history')
  suspectHistory(
    @CurrentAuth() _auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('unitNo') unitNo?: string,
  ) {
    if (plantId === undefined || unitNo === undefined) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 plantId/unitNo', details: {} },
        HttpStatus.BAD_REQUEST,
      )
    }
    return this.queries.suspectHistory(plantId, unitNo)
  }

  // ---------------- 查询：成品异常（QD-10） ----------------

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_READ)
  @Get('defects')
  defectList(
    @CurrentAuth() auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('unitNoLike') unitNoLike?: string,
    @Query('reviewStatus') reviewStatus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.queries.defectList({
      enterpriseId: auth.user.enterpriseId,
      plantIds: auth.dataScope.enterpriseWide ? null : auth.dataScope.plantIds,
      plantId,
      unitNoLike,
      reviewStatus,
      page: toNumber(page) ?? 1,
      pageSize: toNumber(pageSize) ?? 20,
    })
  }

  /** QD-10：码异常状态投影（无异常/异常未处理）。 */
  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_READ)
  @PlantParam('plantId')
  @Get('defects/unit-state')
  async defectUnitState(
    @CurrentAuth() _auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('unitNo') unitNo?: string,
    @Query('materialId') materialId?: string,
  ) {
    if (plantId === undefined || unitNo === undefined || materialId === undefined) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 plantId/unitNo/materialId', details: {} },
        HttpStatus.BAD_REQUEST,
      )
    }
    const unitDefectState = await this.queries.unitDefectState(plantId, unitNo, materialId)
    return { unitNo, unitDefectState }
  }

  // ---------------- 查询：采购质检（QD-12/13/15/16） ----------------

  /** 批次质检视图（码结论版本链＋判定版本链＋重算批次状态）。 */
  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_READ)
  @Get('qc/batches/:batchNo')
  async batchInspectionView(@Param('batchNo') batchNo: string) {
    const view = await this.queries.batchInspectionView(batchNo)
    if (view === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: `批次不存在（${batchNo}）`, details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return view
  }

  /** QD-16：影响圈定（正向追溯 IT-35：批次→已流转产品）。 */
  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_READ)
  @Get('qc/batches/:batchNo/forward-impact')
  async forwardImpact(@Param('batchNo') batchNo: string) {
    const impact = await this.queries.forwardImpact(batchNo)
    if (impact === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: `批次不存在（${batchNo}）`, details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return { batchNo, impacted: impact }
  }

  /** 处置记录列表（QD-20）。 */
  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_READ)
  @PlantParam('plantId')
  @Get('dispositions')
  dispositionList(
    @CurrentAuth() _auth: VerifiedAuthContext,
    @Query('plantId') plantId?: string,
    @Query('unitNo') unitNo?: string,
  ) {
    if (plantId === undefined || unitNo === undefined) {
      throw new HttpException(
        { code: ERROR_CODES.BUSINESS_RULE, message: '缺少 plantId/unitNo', details: {} },
        HttpStatus.BAD_REQUEST,
      )
    }
    return this.queries.dispositionList(plantId, unitNo)
  }

  // ---------------- 命令：存疑（QD-01~03） ----------------

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('suspect/mark')
  suspectMark(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('disposition.suspect.mark', bodyKey(body, 'unitNo') ?? 'suspect', body, auth, req)
  }

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('suspect/release')
  suspectRelease(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('disposition.suspect.release', bodyKey(body, 'unitNo') ?? 'suspect', body, auth, req)
  }

  // ---------------- 命令：成品异常（QD-05~09） ----------------

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('defects/submit')
  defectSubmit(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('disposition.defect.submit', bodyKey(body, 'unitNo') ?? 'defect', body, auth, req)
  }

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('defects/review')
  defectReview(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('disposition.defect.review', bodyKey(body, 'defectNo') ?? 'defect', body, auth, req)
  }

  // ---------------- 命令：采购质检（QD-11~14） ----------------

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('qc/write-web')
  qcWriteWeb(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('disposition.qc.write-web', bodyKey(body, 'batchNo') ?? 'qc', body, auth, req)
  }

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('qc/submit-pda')
  qcSubmitPda(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('disposition.qc.submit-pda', bodyKey(body, 'unitNo') ?? bodyKey(body, 'batchNo') ?? 'qc', body, auth, req)
  }

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('qc/judge')
  qcJudge(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('disposition.qc.judge', bodyKey(body, 'batchNo') ?? 'qc', body, auth, req)
  }

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('qc/re-inspect')
  qcReInspect(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('disposition.qc.re-inspect', bodyKey(body, 'batchNo') ?? 'qc', body, auth, req)
  }

  // ---------------- 命令：处置四类（QD-19~23） ----------------

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('dispositions/rework')
  dispositionRework(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('disposition.disposition.rework', bodyKey(body, 'unitNo') ?? 'disp', body, auth, req)
  }

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('dispositions/scrap')
  dispositionScrap(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('disposition.disposition.scrap', bodyKey(body, 'unitNo') ?? 'disp', body, auth, req)
  }

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('dispositions/concession')
  dispositionConcession(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('disposition.disposition.concession', bodyKey(body, 'unitNo') ?? 'disp', body, auth, req)
  }

  @RequirePermission(DISPOSITION_PERMISSIONS.DISPOSITION_POST)
  @HttpCode(HttpStatus.OK)
  @Post('dispositions/release')
  dispositionRelease(@Body() body: unknown, @CurrentAuth() auth: VerifiedAuthContext, @Req() req: Request) {
    return this.run('disposition.disposition.release', bodyKey(body, 'unitNo') ?? 'disp', body, auth, req)
  }

  // ---------------- 命令执行（同 reverse 口径：operationId 幂等＋reason 头） ----------------

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
      expectedRevision: 0, // disposition 域未启用乐观修订列（同 reverse 口径）
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
