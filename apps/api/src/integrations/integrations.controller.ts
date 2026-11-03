import {
  Body,
  Controller,
  Delete,
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
import { MASTERDATA_PERMISSIONS, SapSimRuleViolation } from '@cadenza/domain'
import type { CommandBus, CommandContext, SapSimEngineService, SapSimService, VerifiedAuthContext } from '@cadenza/application'
import { isSapSimRuleViolation } from '@cadenza/application'
import { CurrentAuth, RequirePermission } from '../auth/decorators'
import { INTEGRATION_MATERIAL_COMMAND_BUS, SAP_SIM_ENGINE_SERVICE, SAP_SIM_SERVICE } from './integrations.tokens'

/**
 * 集成 HTTP：
 * - POST /integrations/material-master/sync — IF-01 料品入站（U9_SIM/SAP_SIM 料品；≠ 本 SAP_SIM 适配面）
 * - GET  /integrations/sap-sim — SAP_SIM 适配可发现 + actual_connection=false
 * - POST /integrations/sap-sim/messages — 抽象信封投递 → outbox（同哈希 noop）
 * - POST /integrations/sap-sim/messages/subset — E08 可计数子集（≠56/65全量）
 * - GET  /integrations/sap-sim/messages/:id
 * - POST /integrations/sap-sim/execute — R1 模拟器执行业务事件（禁 expected_outcome）→ sim 事实 → 回执
 * - POST /integrations/sap-sim/dispatch/:outboxEventId — R1 outbox 行驱动模拟器（贯通链路）
 * - POST /integrations/sap-sim/query — R1 原事件键查询 sim_sap 事实（A1000/B1000 后端）
 * - GET  /integrations/sap-sim/facts/documents|stock|orders — sim 侧事实只读
 * - GET|POST|DELETE /integrations/sap-sim/faults — R1 故障注入场景配置（目录/自定义）
 * - POST /integrations/sap-sim/stock — 模拟侧开账库存补给（仅 sim_sap_stock）
 * - GET|POST /integrations/outbox — 平台出站列表/入队（含 EXTERNAL_UNKNOWN）
 * - POST /integrations/outbox/:eventId/fail — 模拟断网/失败（保留原键）
 * - POST /integrations/outbox/:eventId/replay — 失败后补传/重放（保留原键）
 * - POST /integrations/outbox/:eventId/timeout-unknown — A1000/B1000 TIMEOUT_UNKNOWN
 * - POST /integrations/outbox/:eventId/query-confirm — A1000 原键由 sim_sap 事实回答
 * - POST /integrations/outbox/:eventId/query-unavailable — B1000 UNKNOWN hold
 * - POST /integrations/outbox/:eventId/cancel — E08 原键撤销
 * - POST /integrations/outbox/:eventId/attempt — P5/P6 兼容端点（旧剧本标签；新链路走 execute/dispatch）
 * - GET|POST /integrations/inbox — 平台入站列表/入队（缺映射 QUARANTINED）
 *
 * 边界：≠ /shipping/{*}/inbound、/purchase/orders/sync、/conversion/order/sync-retry；
 * 不连真实 SAP；不关 56/65 全量；模拟器只写 sim_sap_* 事实与平台 outbox/inbox。
 */
@Controller('integrations')
export class IntegrationsController {
  constructor(
    @Inject(INTEGRATION_MATERIAL_COMMAND_BUS) private readonly bus: CommandBus,
    @Inject(SAP_SIM_SERVICE) private readonly sapSim: SapSimService,
    @Inject(SAP_SIM_ENGINE_SERVICE) private readonly simEngine: SapSimEngineService,
  ) {}

  // -------- IF-01 料品（既有） --------

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('material-master/sync')
  materialMasterSync(
    @Body() body: unknown,
    @CurrentAuth() auth: VerifiedAuthContext,
    @Req() req: Request,
  ) {
    const payload = bodyAsRecord(body)
    const target =
      (typeof payload['code'] === 'string' && payload['code']) ||
      (typeof payload['MaterialNumber'] === 'string' && payload['MaterialNumber']) ||
      'unknown'
    return this.run('integration.material-master.sync', target, body, auth, req)
  }

  // -------- SAP_SIM 适配（WI-L1-SAP-SIM-ADAPTER） --------

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @Get('sap-sim')
  sapSimStatus() {
    return this.sapSim.adapterStatus()
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('sap-sim/messages')
  async sapSimDeliver(@Body() body: unknown) {
    try {
      const result = await this.sapSim.deliverMessage(bodyAsRecord(body))
      return result
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  /** WI-L1-SAP-E08-MSG-DRILL-SUBSET：可计数抽象信封子集；≠ 56/65 全量。 */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('sap-sim/messages/subset')
  async sapSimDeliverSubset(@Body() body: unknown) {
    try {
      return await this.sapSim.deliverMessageSubset(bodyAsRecord(body))
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @Get('sap-sim/messages/:id')
  async sapSimMessage(@Param('id') id: string) {
    const row = await this.sapSim.getMessage(id)
    if (row === null) {
      throw new HttpException(
        { code: ERROR_CODES.NOT_FOUND, message: 'SAP_SIM 消息/outbox 行不存在', details: {} },
        HttpStatus.NOT_FOUND,
      )
    }
    return {
      ...row,
      actual_connection: false,
      source_system: 'SAP_SIM',
    }
  }

  // -------- R1 模拟 SAP 引擎（独立事实源 + 故障注入） --------

  /** R1：模拟器执行业务事件；输出由 sim_sap 事实推导；请求含 expected_outcome 族字段即 422。 */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('sap-sim/execute')
  async sapSimExecute(@Body() body: unknown) {
    try {
      return await this.simEngine.execute(bodyAsRecord(body))
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  /** R1：outbox 行驱动模拟器（MOM 命令→outbox→模拟器→sim 事实→回执→MOM 状态更新）。 */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('sap-sim/dispatch/:outboxEventId')
  async sapSimDispatch(@Param('outboxEventId') outboxEventId: string) {
    try {
      return await this.simEngine.dispatch(outboxEventId)
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  /** R1：按原事件键查询 sim_sap 事实（A1000 FOUND/NOT_FOUND；B1000 查询不可用）。 */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @Post('sap-sim/query')
  async sapSimQuery(@Body() body: unknown) {
    try {
      const payload = bodyAsRecord(body)
      const key = payload['event_key'] ?? payload['eventKey']
      if (typeof key !== 'string' || key.trim() === '') {
        throw new SapSimRuleViolation('SAP-SIMENG-13', '缺少 event_key')
      }
      return await this.simEngine.queryByEventKey(key)
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @Get('sap-sim/facts/documents')
  async sapSimFactDocuments(
    @Query('plantCode') plantCode?: string,
    @Query('docType') docType?: string,
  ) {
    return {
      actual_connection: false,
      items: await this.simEngine.listDocuments({ plantCode, docType }),
    }
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @Get('sap-sim/facts/stock')
  async sapSimFactStock(@Query('organizationCode') organizationCode?: string) {
    return {
      actual_connection: false,
      items: await this.simEngine.listStock(organizationCode),
    }
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @Get('sap-sim/facts/orders')
  async sapSimFactOrders(@Query('organizationCode') organizationCode?: string) {
    return {
      actual_connection: false,
      items: await this.simEngine.listOrders(organizationCode),
    }
  }

  /** R1：模拟侧开账库存补给（仅 sim_sap_stock；SIM_ASSUMPTION 主数据口径）。 */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('sap-sim/stock')
  async sapSimProvisionStock(@Body() body: unknown) {
    try {
      return await this.simEngine.provisionOpeningStock(bodyAsRecord(body))
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  /** R1：故障注入场景（按号激活目录场景，或提交自定义配置）；输入是条件，输出由事实推导。 */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('sap-sim/faults')
  async sapSimActivateFault(@Body() body: unknown) {
    try {
      return await this.simEngine.activateFault(bodyAsRecord(body))
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @Get('sap-sim/faults')
  async sapSimListFaults() {
    return { actual_connection: false, items: await this.simEngine.listFaults() }
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Delete('sap-sim/faults/:scenarioNo')
  async sapSimDeactivateFault(@Param('scenarioNo') scenarioNo: string) {
    try {
      return await this.simEngine.deactivateFault(scenarioNo)
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  // -------- outbox / inbox HTTP（WI-L1-SAP-OUTBOX-INBOX-HTTP） --------

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @Get('outbox')
  listOutbox(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('taskKind') taskKind?: string,
    @Query('aggregateType') aggregateType?: string,
  ) {
    return this.sapSim.listOutbox({
      page: toNumber(page),
      pageSize: toNumber(pageSize),
      status,
      taskKind,
      aggregateType,
    })
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('outbox')
  async enqueueOutbox(@Body() body: unknown) {
    try {
      return await this.sapSim.enqueueOutbox(bodyAsRecord(body))
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  /** WI-L1-SAP-OFFLINE-REPLAY：模拟断网/投递失败；保留 event_id / request_digest / external_ref。 */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('outbox/:eventId/fail')
  async failOutbox(@Param('eventId') eventId: string, @Body() body: unknown) {
    try {
      const payload = bodyAsRecord(body)
      const lastError =
        typeof payload['lastError'] === 'string'
          ? payload['lastError']
          : typeof payload['last_error'] === 'string'
            ? payload['last_error']
            : undefined
      return await this.sapSim.markOutboxFailed(eventId, { lastError })
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  /** WI-L1-SAP-OFFLINE-REPLAY：失败后补传；原事件键不变；actual_connection=false。 */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('outbox/:eventId/replay')
  async replayOutbox(@Param('eventId') eventId: string) {
    try {
      return await this.sapSim.replayOutbox(eventId)
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  /** WI-L1-SAP-A1000 / B1000：TIMEOUT_UNKNOWN；保留原键。 */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('outbox/:eventId/timeout-unknown')
  async timeoutUnknown(@Param('eventId') eventId: string) {
    try {
      return await this.sapSim.markTimeoutUnknown(eventId)
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  /** WI-L1-SAP-A1000：按原事件键查询证实 → FOUND_COMMITTED / CONFIRMED_BY_QUERY。 */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('outbox/:eventId/query-confirm')
  async queryConfirm(@Param('eventId') eventId: string, @Body() body: unknown) {
    try {
      return await this.sapSim.queryConfirm(eventId, bodyAsRecord(body))
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  /** WI-L1-SAP-B1000：QUERY_UNAVAILABLE → OUTCOME_UNKNOWN hold；禁当 0 / 换键。 */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('outbox/:eventId/query-unavailable')
  async queryUnavailable(@Param('eventId') eventId: string, @Body() body: unknown) {
    try {
      return await this.sapSim.markQueryUnavailable(eventId, bodyAsRecord(body))
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  /** WI-L1-SAP-E08-DUP-REORDER-CANCEL：按原键撤销 → NOOP_NEEDED/CANCELLED。 */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('outbox/:eventId/cancel')
  async cancelOutbox(@Param('eventId') eventId: string, @Body() body: unknown) {
    try {
      return await this.sapSim.cancelOutbox(eventId, bodyAsRecord(body))
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  /**
   * P5/P6 E08 加深：RECEIVED_NOT_APPLIED / REJECT_* / STALE / WAIT_PARENT / 物流·返工 ack /
   * APPLIED_AFTER_PARENT（版本门控附带；≠ 重开 REJECT-STALE 号）/
   * APPLIED_ONCE / LINES_CONFIRMED（happy-path；≠ 全量 APPLIED）。
   * ≠ 重开 A1000/B1000；≠ disposition 全盘；≠ 21 对象 RECON；≠ 56/65 全量。
   */
  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('outbox/:eventId/attempt')
  async attemptOutbox(@Param('eventId') eventId: string, @Body() body: unknown) {
    try {
      return await this.sapSim.applyAttemptOutcome(eventId, bodyAsRecord(body))
    } catch (error) {
      throw sapSimHttpError(error)
    }
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_READ)
  @Get('inbox')
  listInbox(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('sourceSystem') sourceSystem?: string,
    @Query('organizationCode') organizationCode?: string,
  ) {
    return this.sapSim.listInbox({
      page: toNumber(page),
      pageSize: toNumber(pageSize),
      status,
      sourceSystem,
      organizationCode,
    })
  }

  @RequirePermission(MASTERDATA_PERMISSIONS.MASTERDATA_ADMIN)
  @Post('inbox')
  async enqueueInbox(@Body() body: unknown) {
    try {
      return await this.sapSim.enqueueInbox(bodyAsRecord(body))
    } catch (error) {
      throw sapSimHttpError(error)
    }
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

function sapSimHttpError(error: unknown): HttpException {
  if (isSapSimRuleViolation(error)) {
    const notFoundRules = new Set([
      'SAP-OFFLINE-2',
      'SAP-A1000-2',
      'SAP-B1000-2',
      'SAP-E08-C2',
      'SAP-E08-P5-5',
      'SAP-SIMENG-9',
    ])
    const status = notFoundRules.has(error.rule) ? HttpStatus.NOT_FOUND : HttpStatus.UNPROCESSABLE_ENTITY
    return new HttpException(
      {
        code: notFoundRules.has(error.rule) ? ERROR_CODES.NOT_FOUND : ERROR_CODES.BUSINESS_RULE,
        message: `[${error.rule}] ${error.message}`,
        details: { rule: error.rule, actual_connection: false },
      },
      status,
    )
  }
  throw error
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
