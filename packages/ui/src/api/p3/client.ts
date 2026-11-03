/**
 * P3 域 API 客户端（P3-UI 线新增；联调点集中层）。
 *
 * 架构口径（先例 p4 client）：
 * - 只消费接入层 apps/api（默认 http://127.0.0.1:3001）的 HTTP 合同；
 * - 鉴权 Authorization: Bearer <token>（OA 同源）；401（除探测类）触发 onUnauthorized；
 * - 错误非 2xx 统一体 {code,message,details} → ApiError（规则码中文映射见 ./errorMessages）；
 * - 命令带 x-operation-id（自动生成，可覆盖）头；OA-29 留痕 reason 统一并入请求体
 *   body.reason（中文 reason 不进头——浏览器 fetch 头仅收 ISO-8859-1，控制器优先读 body）；
 * - A/B/C 三域（ot/spc/csw）端点形状按已落地控制器逐一对齐；D 域（cost）后端已落盘
 *   （apps/api/src/cost/，2026-10-28）——本层同样按落盘控制器对齐——[L0-整合标记]
 *   P3 模块注册后统一复核，字段漂移视为对账项（交付记录登记）。
 */

import { ApiError, type ApiMode } from '../client'
import { MockError } from '../mock'
import { mockP3Routes } from './mock'
import type {
  CswOutsourcingCreatePayload,
  CswOutsourcingDetailResponse,
  CswOutsourcingErpExportResponse,
  CswOutsourcingInspectPayload,
  CswOutsourcingReceivePayload,
  CswOutsourcingSendPayload,
  CswOutsourcingSubmitPayload,
  CswOutsourcingTaskIdPayload,
  CswOutsourcingTaskPage,
  CostAcquisitionRecalcPayload,
  CostAcquisitionRunPayload,
  CostAllocationVersionPage,
  CostEnergyIntensityResponse,
  CostLaborCheckAcknowledgePayload,
  CostLaborCheckPage,
  CostLaborCheckRunPayload,
  CostMeterPage,
  CostOeeResponse,
  CostOrderSummaryResponse,
  CostPriceVersionPage,
  CostReconItemPage,
  CostReconResolvePayload,
  CostRunDetailResponse,
  CostRunPage,
  OtAggregatePage,
  OtAggregateRebuildPayload,
  OtDeviceBindPayload,
  OtDevicePage,
  OtFactPage,
  OtGatewayMonitorPayload,
  OtGatewayPage,
  OtMappingConfirmPayload,
  OtMappingEvaluatePayload,
  OtMappingPage,
  OtMonitorOverview,
  OtPointView,
  OtSamplePage,
  OtSessionLinkPayload,
  OtStatsPage,
  OtGatewayEventView,
  SpcCalibrationRecordPayload,
  SpcChangeCreatePayload,
  SpcChangeDetailResponse,
  SpcChangeDispositionPayload,
  SpcChangeListPage,
  SpcChangePublishPayload,
  SpcChangeScanPayload,
  SpcControlItemPage,
  SpcControlChartResponse,
  SpcGaugeDetailResponse,
  SpcMiscalibrationActionPayload,
  SpcMiscalibrationCircleResponse,
  SpcOocConfirmRecontrolPayload,
  SpcOocDisposePayload,
  SpcOocTaskDetailResponse,
  SpcOocTaskPage,
  SpcRuleSetPage,
  SpcSampleRecordPayload,
  SpcToolAdjustPayload,
  SpcToolConsumePayload,
  SpcToolDetailResponse,
  SpcToolListPage,
} from './types'

export * from './types'
export { formatP3Error, p3RuleCodeOf, P3_RULE_MESSAGES_ZH } from './errorMessages'
export { mockP3Routes, resetMockP3State } from './mock'

export interface P3ClientOptions {
  baseURL?: string
  mode?: ApiMode
  mockLatencyMs?: number
  getToken?: () => string | null
  /** 401 回调：应用侧清会话并跳登录 */
  onUnauthorized?: () => void
  timeoutMs?: number
}

export interface CommandOk {
  operationId: string
  status: string
  data: unknown
}

export interface P3Client {
  readonly mode: ApiMode
  readonly baseURL: string
  // ---------------- ot（T21 已落地） ----------------
  otListGateways(query?: { plantId?: string; status?: string; page?: number; pageSize?: number }): Promise<OtGatewayPage>
  otGatewayEvents(gatewayCode: string): Promise<OtGatewayEventView[]>
  otListDevices(query?: { plantId?: string; gatewayCode?: string; page?: number; pageSize?: number }): Promise<OtDevicePage>
  otListPoints(deviceSerial: string): Promise<OtPointView[]>
  /** OT-25：deviceSerial 必填（页面不扫高频原始点位） */
  otListSamples(query: {
    deviceSerial: string
    pointCode?: string
    qualityLevel?: string
    isBad?: boolean
    isClockSkew?: boolean
    isLate?: boolean
    isQuarantined?: boolean
    from?: string
    to?: string
    page?: number
    pageSize?: number
  }): Promise<OtSamplePage>
  otListAggregates(query?: {
    plantId?: string
    deviceSerial?: string
    pointCode?: string
    granularity?: string
    from?: string
    to?: string
    page?: number
    pageSize?: number
  }): Promise<OtAggregatePage>
  otListMappings(query?: { plantId?: string; deviceSerial?: string; page?: number; pageSize?: number }): Promise<OtMappingPage>
  otListFacts(query?: { plantId?: string; mappingId?: string; status?: string; page?: number; pageSize?: number }): Promise<OtFactPage>
  otListStats(query?: { statDate?: string; gatewayCode?: string; page?: number; pageSize?: number }): Promise<OtStatsPage>
  otMonitorOverview(query?: { plantId?: string; dedupAlertThreshold?: number }): Promise<OtMonitorOverview>
  otDeviceBind(payload: OtDeviceBindPayload): Promise<CommandOk>
  otSessionLink(payload: OtSessionLinkPayload): Promise<CommandOk>
  otGatewayMonitor(payload: OtGatewayMonitorPayload): Promise<CommandOk>
  otMappingEvaluate(payload: OtMappingEvaluatePayload): Promise<CommandOk>
  otMappingConfirm(payload: OtMappingConfirmPayload): Promise<CommandOk>
  otAggregateRebuild(payload: OtAggregateRebuildPayload): Promise<CommandOk>
  // ---------------- spc（T23 已落地） ----------------
  spcListChanges(query?: { plantId?: string; statuses?: string; page?: number; pageSize?: number }): Promise<SpcChangeListPage>
  spcChangeDetail(changeId: string): Promise<SpcChangeDetailResponse>
  spcListRuleSets(query?: { plantId?: string; statuses?: string; page?: number; pageSize?: number }): Promise<SpcRuleSetPage>
  spcListControlItems(query?: { plantId?: string; page?: number; pageSize?: number }): Promise<SpcControlItemPage>
  spcControlChart(controlItemId: string): Promise<SpcControlChartResponse>
  spcListOocTasks(query?: { plantId?: string; statuses?: string; page?: number; pageSize?: number }): Promise<SpcOocTaskPage>
  spcOocTaskDetail(oocTaskId: string): Promise<SpcOocTaskDetailResponse>
  spcGaugeDetail(gaugeId: string): Promise<SpcGaugeDetailResponse>
  spcMiscalibrationCircle(query: { gaugeId: string; from: string; to: string }): Promise<SpcMiscalibrationCircleResponse>
  spcListTools(query?: { plantId?: string; page?: number; pageSize?: number }): Promise<SpcToolListPage>
  spcToolDetail(toolId: string): Promise<SpcToolDetailResponse>
  spcChangeCreate(payload: SpcChangeCreatePayload): Promise<CommandOk>
  spcChangeScan(payload: SpcChangeScanPayload): Promise<CommandOk>
  spcChangeDisposition(payload: SpcChangeDispositionPayload): Promise<CommandOk>
  spcChangePublish(payload: SpcChangePublishPayload): Promise<CommandOk>
  spcSampleRecord(payload: SpcSampleRecordPayload): Promise<CommandOk>
  spcOocDispose(payload: SpcOocDisposePayload): Promise<CommandOk>
  spcOocConfirmRecontrol(payload: SpcOocConfirmRecontrolPayload): Promise<CommandOk>
  spcCalibrationRecord(payload: SpcCalibrationRecordPayload): Promise<CommandOk>
  spcMiscalibrationAction(payload: SpcMiscalibrationActionPayload): Promise<CommandOk>
  spcToolConsume(payload: SpcToolConsumePayload): Promise<CommandOk>
  spcToolAdjust(payload: SpcToolAdjustPayload): Promise<CommandOk>
  // ---------------- csw 外协（T22 并行实施中：形状按当前控制器，L0 整合对账） ----------------
  cswListOutsourcingTasks(query?: {
    plantId?: string
    status?: string
    orderOperationId?: string
    taskNoLike?: string
    page?: number
    pageSize?: number
  }): Promise<CswOutsourcingTaskPage>
  cswOutsourcingDetail(taskId: string): Promise<CswOutsourcingDetailResponse>
  cswOutsourcingErpExport(query?: { plantId?: string }): Promise<CswOutsourcingErpExportResponse>
  cswOutsourcingCreate(payload: CswOutsourcingCreatePayload): Promise<CommandOk>
  cswOutsourcingSubmit(payload: CswOutsourcingSubmitPayload): Promise<CommandOk>
  cswOutsourcingSend(payload: CswOutsourcingSendPayload): Promise<CommandOk>
  cswOutsourcingReceive(payload: CswOutsourcingReceivePayload): Promise<CommandOk>
  cswOutsourcingInspect(payload: CswOutsourcingInspectPayload): Promise<CommandOk>
  cswOutsourcingClose(payload: CswOutsourcingTaskIdPayload): Promise<CommandOk>
  cswOutsourcingRecall(payload: CswOutsourcingTaskIdPayload): Promise<CommandOk>
  cswOutsourcingDispose(payload: CswOutsourcingTaskIdPayload): Promise<CommandOk>
  // ---------------- cost（T24 已落盘：端点按 apps/api/src/cost/cost.controller.ts） ----------------
  costListRuns(query?: { plantId?: string; orderId?: string; shiftDate?: string; page?: number; pageSize?: number }): Promise<CostRunPage>
  costRunDetail(runId: string): Promise<CostRunDetailResponse>
  costOrderSummary(orderId: string): Promise<CostOrderSummaryResponse>
  costEnergyIntensity(query?: { plantId?: string; shiftDate?: string; page?: number; pageSize?: number }): Promise<CostEnergyIntensityResponse>
  costOee(query: { plantId: string; equipmentCode: string; windowStart: string; windowEnd: string }): Promise<CostOeeResponse>
  costListMeters(query?: { plantId?: string; statuses?: string; energyTypes?: string; page?: number; pageSize?: number }): Promise<CostMeterPage>
  costListAllocationVersions(query?: { plantId?: string; statuses?: string; page?: number; pageSize?: number }): Promise<CostAllocationVersionPage>
  costListPriceVersions(query?: { plantId?: string; statuses?: string; page?: number; pageSize?: number }): Promise<CostPriceVersionPage>
  costListReconItems(query?: {
    plantId?: string
    runId?: string
    kinds?: string
    statuses?: string
    page?: number
    pageSize?: number
  }): Promise<CostReconItemPage>
  costListLaborChecks(query?: { plantId?: string; orderId?: string; statuses?: string; page?: number; pageSize?: number }): Promise<CostLaborCheckPage>
  costAcquisitionRun(payload: CostAcquisitionRunPayload): Promise<CommandOk>
  costAcquisitionRecalc(payload: CostAcquisitionRecalcPayload): Promise<CommandOk>
  costReconResolve(payload: CostReconResolvePayload): Promise<CommandOk>
  costLaborCheckRun(payload: CostLaborCheckRunPayload): Promise<CommandOk>
  costLaborCheckAcknowledge(payload: CostLaborCheckAcknowledgePayload): Promise<CommandOk>
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:3001'

function newOperationId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

interface RawErrorBody {
  code?: unknown
  message?: unknown
  details?: unknown
}

function toApiError(status: number, body: RawErrorBody | null, requestId?: string): ApiError {
  return new ApiError({
    code: typeof body?.code === 'string' ? body.code : 'ERR_UNKNOWN',
    message:
      typeof body?.message === 'string' && body.message
        ? body.message
        : `请求失败（HTTP ${status}）`,
    details: body?.details,
    httpStatus: status,
    requestId,
  })
}

function boolParam(v: boolean | undefined): string | undefined {
  return v === undefined ? undefined : v ? 'true' : 'false'
}

function abortSignalOf(ms: number): AbortSignal | null {
  const c = globalThis.AbortSignal
  if (c && typeof c.timeout === 'function') return c.timeout(ms)
  return null
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const s = search.toString()
  return s === '' ? '' : `?${s}`
}

export function createP3Client(options: P3ClientOptions = {}): P3Client {
  const mode: ApiMode = options.mode ?? 'live'
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const mockLatency = options.mockLatencyMs ?? 60
  const timeoutMs = options.timeoutMs ?? 20_000

  async function requestJson(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; onUnauthorized?: boolean } = {},
  ): Promise<unknown> {
    const token = options.getToken?.() ?? null

    if (mode === 'mock') {
      await new Promise((r) => setTimeout(r, mockLatency))
      const handler = mockP3Routes(method, path)
      if (!handler) {
        throw new ApiError({ code: 'ERR_NOT_FOUND', message: `mock 未定义路由：${method} ${path}`, httpStatus: 404 })
      }
      try {
        return await handler({ token, body: opts.body })
      } catch (err) {
        if (err instanceof MockError) {
          if (err.httpStatus === 401 && (opts.onUnauthorized ?? true)) options.onUnauthorized?.()
          throw new ApiError({ code: err.code, message: err.message, details: err.details, httpStatus: err.httpStatus })
        }
        throw err
      }
    }

    let url: string
    try {
      url = new URL(`${baseURL}${path}`).toString()
    } catch {
      url = `${baseURL}${path}`
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    if (method === 'POST') {
      headers['x-operation-id'] = newOperationId()
    }
    let res: Response
    const requestOptions = {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }
    const timeoutSignal = abortSignalOf(timeoutMs)
    try {
      res = await fetch(url, timeoutSignal !== null ? { ...requestOptions, signal: timeoutSignal } : requestOptions)
    } catch (cause) {
      // realm 兼容自愈（L0 整合轮 2026-10-29）：jsdom 测试域的 AbortSignal 与 Node undici fetch
      // 跨域混用会被拒（TypeError: Expected signal … to be an instance of AbortSignal）——
      // 退化为无客户端超时重发一次（服务端超时上限仍在）；真实浏览器域两者同域无此路径，
      // 超时行为不变。
      if (timeoutSignal !== null && cause instanceof TypeError && /signal/i.test(cause.message)) {
        res = await fetch(url, requestOptions)
      } else {
        const aborted = cause instanceof DOMException && cause.name === 'TimeoutError'
        throw new ApiError({
          code: aborted ? 'ERR_TIMEOUT' : 'ERR_NETWORK',
          message: aborted ? '请求超时：P3 域接口未在时限内返回' : cause instanceof Error ? `网络请求失败：${cause.message}` : '网络请求失败',
        })
      }
    }
    const requestId = res.headers.get('x-request-id') ?? undefined
    if (res.status === 401 && (opts.onUnauthorized ?? true)) {
      options.onUnauthorized?.()
    }
    if (res.status === 204) return null
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    if (!(res.status >= 200 && res.status < 300)) {
      throw toApiError(res.status, body as RawErrorBody | null, requestId)
    }
    return body
  }

  function command(path: string, payload: object): Promise<CommandOk> {
    const record = payload as Record<string, unknown>
    const { operationId, reason, ...rest } = record
    // OA-29 留痕 reason 统一走 body（与真实控制器提取一致：payload.reason || header || null）；
    // 不再发 x-reason 头——浏览器 fetch 头仅收 ISO-8859-1，中文 reason 会直接抛错
    return requestJson('POST', path, {
      body: {
        ...rest,
        ...(typeof reason === 'string' ? { reason } : {}),
        ...(operationId !== undefined ? { operationId } : {}),
      },
    }) as Promise<CommandOk>
  }

  return {
    mode,
    baseURL,
    // ---------------- ot ----------------
    otListGateways: (query = {}) =>
      requestJson('GET', `/ot/gateways${buildQuery({ ...query })}`) as Promise<OtGatewayPage>,
    otGatewayEvents: (gatewayCode) =>
      requestJson('GET', `/ot/gateways/${encodeURIComponent(gatewayCode)}/events`) as Promise<OtGatewayEventView[]>,
    otListDevices: (query = {}) =>
      requestJson('GET', `/ot/devices${buildQuery({ ...query })}`) as Promise<OtDevicePage>,
    otListPoints: (deviceSerial) =>
      requestJson('GET', `/ot/points${buildQuery({ deviceSerial })}`) as Promise<OtPointView[]>,
    otListSamples: (query) =>
      requestJson(
        'GET',
        `/ot/samples${buildQuery({ ...query, isBad: boolParam(query.isBad), isClockSkew: boolParam(query.isClockSkew), isLate: boolParam(query.isLate), isQuarantined: boolParam(query.isQuarantined) })}`,
      ) as Promise<OtSamplePage>,
    otListAggregates: (query = {}) =>
      requestJson('GET', `/ot/aggregates${buildQuery({ ...query })}`) as Promise<OtAggregatePage>,
    otListMappings: (query = {}) =>
      requestJson('GET', `/ot/mappings${buildQuery({ ...query })}`) as Promise<OtMappingPage>,
    otListFacts: (query = {}) =>
      requestJson('GET', `/ot/facts${buildQuery({ ...query })}`) as Promise<OtFactPage>,
    otListStats: (query = {}) =>
      requestJson('GET', `/ot/stats${buildQuery({ ...query })}`) as Promise<OtStatsPage>,
    otMonitorOverview: (query = {}) =>
      requestJson('GET', `/ot/monitor${buildQuery({ ...query })}`) as Promise<OtMonitorOverview>,
    otDeviceBind: (payload) => command('/ot/device/bind', payload),
    otSessionLink: (payload) => command('/ot/session/link', payload),
    otGatewayMonitor: (payload) => command('/ot/gateway/monitor', payload),
    otMappingEvaluate: (payload) => command('/ot/mapping/evaluate', payload),
    otMappingConfirm: (payload) => command('/ot/mapping/confirm', payload),
    otAggregateRebuild: (payload) => command('/ot/aggregate/rebuild', payload),
    // ---------------- spc ----------------
    spcListChanges: (query = {}) =>
      requestJson('GET', `/spc/changes${buildQuery({ ...query })}`) as Promise<SpcChangeListPage>,
    spcChangeDetail: (changeId) =>
      requestJson('GET', `/spc/changes/${encodeURIComponent(changeId)}`) as Promise<SpcChangeDetailResponse>,
    spcListRuleSets: (query = {}) =>
      requestJson('GET', `/spc/rule-sets${buildQuery({ ...query })}`) as Promise<SpcRuleSetPage>,
    spcListControlItems: (query = {}) =>
      requestJson('GET', `/spc/control-items${buildQuery({ ...query })}`) as Promise<SpcControlItemPage>,
    spcControlChart: (controlItemId) =>
      requestJson('GET', `/spc/control-items/${encodeURIComponent(controlItemId)}/chart`) as Promise<SpcControlChartResponse>,
    spcListOocTasks: (query = {}) =>
      requestJson('GET', `/spc/ooc-tasks${buildQuery({ ...query })}`) as Promise<SpcOocTaskPage>,
    spcOocTaskDetail: (oocTaskId) =>
      requestJson('GET', `/spc/ooc-tasks/${encodeURIComponent(oocTaskId)}`) as Promise<SpcOocTaskDetailResponse>,
    spcGaugeDetail: (gaugeId) =>
      requestJson('GET', `/spc/gauges/${encodeURIComponent(gaugeId)}`) as Promise<SpcGaugeDetailResponse>,
    spcMiscalibrationCircle: (query) =>
      requestJson('GET', `/spc/miscalibration/circle${buildQuery({ ...query })}`) as Promise<SpcMiscalibrationCircleResponse>,
    spcListTools: (query = {}) =>
      requestJson('GET', `/spc/tools${buildQuery({ ...query })}`) as Promise<SpcToolListPage>,
    spcToolDetail: (toolId) =>
      requestJson('GET', `/spc/tools/${encodeURIComponent(toolId)}`) as Promise<SpcToolDetailResponse>,
    spcChangeCreate: (payload) => command('/spc/change/create', payload),
    spcChangeScan: (payload) => command('/spc/change/scan', payload),
    spcChangeDisposition: (payload) => command('/spc/change/disposition', payload),
    spcChangePublish: (payload) => command('/spc/change/publish', payload),
    spcSampleRecord: (payload) => command('/spc/sample/record', payload),
    spcOocDispose: (payload) => command('/spc/ooc/dispose', payload),
    spcOocConfirmRecontrol: (payload) => command('/spc/ooc/confirm-recontrol', payload),
    spcCalibrationRecord: (payload) => command('/spc/calibration/record', payload),
    spcMiscalibrationAction: (payload) => command('/spc/miscalibration/action', payload),
    spcToolConsume: (payload) => command('/spc/tool/consume', payload),
    spcToolAdjust: (payload) => command('/spc/tool/adjust', payload),
    // ---------------- csw ----------------
    cswListOutsourcingTasks: (query = {}) =>
      requestJson('GET', `/csw/outsourcing-tasks${buildQuery({ ...query })}`) as Promise<CswOutsourcingTaskPage>,
    cswOutsourcingDetail: (taskId) =>
      requestJson('GET', `/csw/outsourcing-tasks/${encodeURIComponent(taskId)}`) as Promise<CswOutsourcingDetailResponse>,
    cswOutsourcingErpExport: (query = {}) =>
      requestJson('GET', `/csw/outsourcing-erp-export${buildQuery({ ...query })}`) as Promise<CswOutsourcingErpExportResponse>,
    cswOutsourcingCreate: (payload) => command('/csw/outsourcing/create', payload),
    cswOutsourcingSubmit: (payload) => command('/csw/outsourcing/submit', payload),
    cswOutsourcingSend: (payload) => command('/csw/outsourcing/send', payload),
    cswOutsourcingReceive: (payload) => command('/csw/outsourcing/receive', payload),
    cswOutsourcingInspect: (payload) => command('/csw/outsourcing/inspect', payload),
    cswOutsourcingClose: (payload) => command('/csw/outsourcing/close', payload),
    cswOutsourcingRecall: (payload) => command('/csw/outsourcing/recall', payload),
    cswOutsourcingDispose: (payload) => command('/csw/outsourcing/dispose', payload),
    // ---------------- cost ----------------
    costListRuns: (query = {}) =>
      requestJson('GET', `/cost/runs${buildQuery({ ...query })}`) as Promise<CostRunPage>,
    costRunDetail: (runId) =>
      requestJson('GET', `/cost/runs/${encodeURIComponent(runId)}`) as Promise<CostRunDetailResponse>,
    costOrderSummary: (orderId) =>
      requestJson('GET', `/cost/orders/${encodeURIComponent(orderId)}/summary`) as Promise<CostOrderSummaryResponse>,
    costEnergyIntensity: (query = {}) =>
      requestJson('GET', `/cost/energy-intensity${buildQuery({ ...query })}`) as Promise<CostEnergyIntensityResponse>,
    costOee: (query) =>
      requestJson('GET', `/cost/oee${buildQuery({ ...query })}`) as Promise<CostOeeResponse>,
    costListMeters: (query = {}) =>
      requestJson('GET', `/cost/meters${buildQuery({ ...query })}`) as Promise<CostMeterPage>,
    costListAllocationVersions: (query = {}) =>
      requestJson('GET', `/cost/allocation-versions${buildQuery({ ...query })}`) as Promise<CostAllocationVersionPage>,
    costListPriceVersions: (query = {}) =>
      requestJson('GET', `/cost/price-versions${buildQuery({ ...query })}`) as Promise<CostPriceVersionPage>,
    costListReconItems: (query = {}) =>
      requestJson('GET', `/cost/recon-items${buildQuery({ ...query })}`) as Promise<CostReconItemPage>,
    costListLaborChecks: (query = {}) =>
      requestJson('GET', `/cost/labor-checks${buildQuery({ ...query })}`) as Promise<CostLaborCheckPage>,
    costAcquisitionRun: (payload) => command('/cost/acquisition/run', payload),
    costAcquisitionRecalc: (payload) => command('/cost/acquisition/recalc', payload),
    costReconResolve: (payload) => command('/cost/recon/resolve', payload),
    costLaborCheckRun: (payload) => command('/cost/labor-check/run', payload),
    costLaborCheckAcknowledge: (payload) => command('/cost/labor-check/acknowledge', payload),
  }
}
