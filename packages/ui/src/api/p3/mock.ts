/**
 * P3 域 mock 路由（P3-UI 线新增；演示数据与真实 DTO 同形——先例：api/mock.ts / api/p4/mock.ts）。
 *
 * 承载合同行为（mock 适配器承载合同行为，与真实服务端同口径拒绝）：
 * - ot：OT-25 样本按设备收敛（缺 deviceSerial → 422）、OT-26 事实确认状态机（重复确认拒绝）、
 *   OT-07 隔离态设备、OT-28 无样本缺项、OT-29 监控总览（离线/积压/去重异常/溢出）；
 * - spc：PE-04 在制未处置禁止发布、PE-11 坏点样本准入拒绝（记录保留）、PE-12 失控处置闭环
 *   （未处置不得复控确认）、PE-15 校准追加式、PE-21 具名调整理由必填、失控样本自动生成处置任务；
 * - csw：CS-19 外协状态机（非法迁移拒绝）、CS-21 发送须带单元行、CS-24 加工数量事实导出；
 * - cost：CE-11 首跑/显式重算守卫与新旧对照、CE-S5 对账处置状态机、CA-12 工时核对、
 *   CE-03/09/10/14/17/18 缺项与实测估算分列演示（形状对齐落盘 API）。
 *
 * 模块级状态：演示定位（刷新即重置）；测试用 resetMockP3State 清场（先例 resetMockLoginState）。
 */

import { MockError } from '../mock'
import type {
  OtAggregateView,
  OtDeviceView,
  OtFactView,
  OtGatewayView,
  OtMappingView,
  OtMonitorOverview,
  OtPointView,
  OtSampleView,
  OtStatsView,
  SpcCalibrationRecordView,
  SpcChangeImpactView,
  SpcControlChartResponse,
  SpcControlItemView,
  SpcOocTaskView,
  SpcSampleView,
  SpcToolDetailResponse,
  SpcToolListItem,
  CswOutsourcingTaskView,
  CswOutsourcingUnitView,
  CostLaborCheckView,
  CostMeterView,
  CostOeeResponse,
  CostRunView,
  CostLineView,
  CostOrderSummaryResponse,
  CostAllocationVersionView,
  CostPriceVersionView,
  CostReconItemView,
} from './types'

export interface MockP3Context {
  token: string | null
  body?: unknown
}

interface CommandOk {
  operationId: string
  status: 'COMMITTED'
  data: unknown
}

function ok(data: unknown = null, operationId = 'op-mock-p3'): CommandOk {
  return { operationId, status: 'COMMITTED', data }
}

function rejectRule(message: string, httpStatus = 422): never {
  throw new MockError({ httpStatus, code: 'ERR_BUSINESS_RULE', message, details: {} })
}

function rejectNotFound(message: string): never {
  throw new MockError({ httpStatus: 404, code: 'ERR_NOT_FOUND', message, details: {} })
}

function bodyOf(ctx: MockP3Context): Record<string, unknown> {
  return (ctx.body ?? {}) as Record<string, unknown>
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}


function pageOf<T>(items: T[], page: number, pageSize: number) {
  const start = (page - 1) * pageSize
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize }
}

const NOW = '2026-10-28T09:30:00+08:00'

// ---------------------------------------------------------------------------
// ot 演示数据
// ---------------------------------------------------------------------------

const otGateways: OtGatewayView[] = [
  {
    gatewayId: 'gw-001', gatewayCode: 'GW-DRAW-01', plantId: 'n-plant',
    protocolConfig: { kind: 'opcua', endpoint: 'opc.tcp://192.168.10.21:4840' },
    sampleRateHz: 1, bufferCapacity: 50000, heartbeatTimeoutSeconds: 60,
    status: 'online', statusLabel: '在线', lastHeartbeatAt: NOW, checkpointSeq: 1042,
    lastBacklogCount: 0, deviceCount: 2,
  },
  {
    gatewayId: 'gw-002', gatewayCode: 'GW-EXTR-02', plantId: 'n-plant',
    protocolConfig: { kind: 'modbus-tcp', endpoint: '192.168.20.34:502' },
    sampleRateHz: 1, bufferCapacity: 20000, heartbeatTimeoutSeconds: 60,
    status: 'offline', statusLabel: '离线', lastHeartbeatAt: '2026-10-28T08:41:00+08:00', checkpointSeq: 867,
    lastBacklogCount: 1280, deviceCount: 1,
  },
]

const otGatewayEvents: Array<Record<string, unknown>> = [
  { eventId: 'ge-001', gatewayCode: 'GW-EXTR-02', eventKind: 'registered', eventKindLabel: '网关注册', detail: { protocol: 'modbus-tcp' }, occurredAt: '2026-10-20T08:00:00+08:00', createdBy: 'admin' },
  { eventId: 'ge-002', gatewayCode: 'GW-EXTR-02', eventKind: 'heartbeat_restored', eventKindLabel: '心跳恢复', detail: { offlineSeconds: 310 }, occurredAt: '2026-10-25T14:02:00+08:00', createdBy: null },
  { eventId: 'ge-003', gatewayCode: 'GW-EXTR-02', eventKind: 'offline', eventKindLabel: '网关离线', detail: { staleSeconds: 2940, alarm: 'edge_offline' }, occurredAt: '2026-10-28T08:42:00+08:00', createdBy: null },
  { eventId: 'ge-004', gatewayCode: 'GW-EXTR-02', eventKind: 'overflow', eventKindLabel: '缓冲溢出', detail: { dropped: 5, firstAt: '2026-10-28T08:50:00+08:00', lastAt: '2026-10-28T09:10:00+08:00', deviceSerials: ['SN-EXTR-009'] }, occurredAt: '2026-10-28T09:10:00+08:00', createdBy: null },
]

const otDevices: OtDeviceView[] = [
  {
    deviceSerial: 'SN-DRAW-001', plantId: 'n-plant', gatewayCode: 'GW-DRAW-01',
    equipmentId: 'eq-0001', equipmentCode: 'EQU-0001', boundBy: 'admin', boundAt: '2026-10-20T08:05:00+08:00',
    clockSkewThresholdSeconds: 120, lastSampleAt: NOW, lastSampleAgeSeconds: 5, quarantinedSampleCount: 0,
  },
  {
    deviceSerial: 'SN-DRAW-002', plantId: 'n-plant', gatewayCode: 'GW-DRAW-01',
    equipmentId: 'eq-0002', equipmentCode: 'EQU-0002', boundBy: 'admin', boundAt: '2026-10-20T08:06:00+08:00',
    clockSkewThresholdSeconds: 120, lastSampleAt: null, lastSampleAgeSeconds: null, quarantinedSampleCount: 0,
  },
  {
    deviceSerial: 'SN-EXTR-009', plantId: 'n-plant', gatewayCode: 'GW-EXTR-02',
    equipmentId: null, equipmentCode: null, boundBy: null, boundAt: null,
    clockSkewThresholdSeconds: 120, lastSampleAt: '2026-10-28T08:39:00+08:00', lastSampleAgeSeconds: 3060,
    quarantinedSampleCount: 3,
  },
]

const otPoints: OtPointView[] = [
  { pointId: 'pt-001', plantId: 'n-plant', deviceSerial: 'SN-DRAW-001', pointCode: 'P-LEN', semantic: 'meter_length', semanticLabel: '计长', uomId: 'uom-m', uomCode: 'M', sampleRateSeconds: 1, rangeMin: '0', rangeMax: '100000', participatesInBusiness: true, calibrationRecordNo: null, calibrationValidUntil: null, version: 2 },
  { pointId: 'pt-002', plantId: 'n-plant', deviceSerial: 'SN-DRAW-001', pointCode: 'P-SPD', semantic: 'speed', semanticLabel: '速度', uomId: null, uomCode: 'm/min', sampleRateSeconds: 1, rangeMin: '0', rangeMax: '2000', participatesInBusiness: false, calibrationRecordNo: null, calibrationValidUntil: null, version: 1 },
  { pointId: 'pt-003', plantId: 'n-plant', deviceSerial: 'SN-EXTR-009', pointCode: 'P-DIA', semantic: 'inspection_result', semanticLabel: '检测结果', uomId: null, uomCode: 'mm', sampleRateSeconds: 2, rangeMin: '0', rangeMax: '120', participatesInBusiness: true, calibrationRecordNo: 'CAL-2026-041', calibrationValidUntil: '2026-09-30', version: 1 },
]

const otSamples: OtSampleView[] = [
  {
    sampleId: 'smp-001', deviceSerial: 'SN-DRAW-001', pointCode: 'P-LEN', eventId: 'SN-DRAW-001#1042', gatewaySeq: 1042,
    eventTime: NOW, receivedAt: NOW, gatewayCode: 'GW-DRAW-01', rawValue: '125.3', rawUnit: 'M',
    normalizedValue: '125.3000', conversionRevision: 3, conversionMissing: false, qualityLevel: 'good',
    qualityLabel: '良好', deviceQualityCode: '192', isBad: false, badReasons: [], isClockSkew: false,
    clockSkewKind: null, clockSkewLabel: null, isLate: false, calibrationSuspect: false,
    sessionId: 'exec-20261028-a', sessionLinkStatus: 'auto_bound', sessionLinkStatusLabel: '自动绑定',
    isQuarantined: false, quarantineReason: null,
  },
  {
    sampleId: 'smp-002', deviceSerial: 'SN-DRAW-001', pointCode: 'P-LEN', eventId: 'SN-DRAW-001#1031', gatewaySeq: 1031,
    eventTime: '2026-10-28T09:12:00+08:00', receivedAt: '2026-10-28T09:12:01+08:00', gatewayCode: 'GW-DRAW-01',
    rawValue: '182060.0', rawUnit: 'M', normalizedValue: null, conversionRevision: null, conversionMissing: true,
    qualityLevel: 'bad', qualityLabel: '坏点', deviceQualityCode: '0', isBad: true,
    badReasons: [
      { code: 'range_out', label: '量程越界' },
      { code: 'quality_bad', label: '质量码 bad' },
    ],
    isClockSkew: false, clockSkewKind: null, clockSkewLabel: null, isLate: false, calibrationSuspect: false,
    sessionId: null, sessionLinkStatus: 'unlinked', sessionLinkStatusLabel: '未关联',
    isQuarantined: false, quarantineReason: null,
  },
  {
    sampleId: 'smp-003', deviceSerial: 'SN-DRAW-001', pointCode: 'P-SPD', eventId: 'SN-DRAW-001#1015', gatewaySeq: 1015,
    eventTime: '2026-10-28T09:00:00+08:00', receivedAt: '2026-10-28T09:05:12+08:00', gatewayCode: 'GW-DRAW-01',
    rawValue: '860.0', rawUnit: 'm/min', normalizedValue: '860.0', conversionRevision: 1, conversionMissing: false,
    qualityLevel: 'uncertain', qualityLabel: '不确定', deviceQualityCode: '64', isBad: false, badReasons: [],
    isClockSkew: true, clockSkewKind: 'offset', clockSkewLabel: '偏差超阈值', isLate: false,
    calibrationSuspect: false, sessionId: null, sessionLinkStatus: 'pending_confirm',
    sessionLinkStatusLabel: '待确认', isQuarantined: false, quarantineReason: null,
  },
  {
    sampleId: 'smp-004', deviceSerial: 'SN-DRAW-001', pointCode: 'P-LEN', eventId: 'SN-DRAW-001#0990', gatewaySeq: 990,
    eventTime: '2026-10-28T08:20:00+08:00', receivedAt: '2026-10-28T08:31:40+08:00', gatewayCode: 'GW-DRAW-01',
    rawValue: '640.2', rawUnit: 'M', normalizedValue: '640.2000', conversionRevision: 3, conversionMissing: false,
    qualityLevel: 'good', qualityLabel: '良好', deviceQualityCode: '192', isBad: false, badReasons: [],
    isClockSkew: false, clockSkewKind: null, clockSkewLabel: null, isLate: true, calibrationSuspect: false,
    sessionId: null, sessionLinkStatus: 'unlinked', sessionLinkStatusLabel: '未关联',
    isQuarantined: false, quarantineReason: null,
  },
  {
    sampleId: 'smp-005', deviceSerial: 'SN-EXTR-009', pointCode: 'P-DIA', eventId: 'SN-EXTR-009#0867', gatewaySeq: 867,
    eventTime: '2026-10-28T08:39:00+08:00', receivedAt: '2026-10-28T08:39:02+08:00', gatewayCode: 'GW-EXTR-02',
    rawValue: '12.427', rawUnit: 'mm', normalizedValue: null, conversionRevision: null, conversionMissing: false,
    qualityLevel: 'good', qualityLabel: '良好', deviceQualityCode: '192', isBad: false, badReasons: [],
    isClockSkew: false, clockSkewKind: null, clockSkewLabel: null, isLate: false, calibrationSuspect: true,
    sessionId: null, sessionLinkStatus: 'unlinked', sessionLinkStatusLabel: '未关联',
    isQuarantined: true, quarantineReason: '设备未映射主档（OT-07 隔离态，待人工补绑）',
  },
]

const otAggregates: OtAggregateView[] = [
  {
    aggregateId: 'agg-001', deviceSerial: 'SN-DRAW-001', pointCode: 'P-LEN', granularity: 'minute',
    windowStart: '2026-10-28T09:12:00+08:00', sampleCount: 59, goodCount: 58, badCount: 1, skewCount: 0,
    sumValue: '7325.4000', minValue: '115.2', maxValue: '133.8', firstEventTime: '2026-10-28T09:12:00+08:00',
    lastEventTime: NOW, updatedAt: NOW, dataLagSeconds: 42, badRate: 0.0169,
  },
  {
    aggregateId: 'agg-002', deviceSerial: 'SN-DRAW-001', pointCode: 'P-LEN', granularity: 'shift',
    windowStart: '2026-10-28T08:00:00+08:00', sampleCount: 4820, goodCount: 4790, badCount: 22, skewCount: 8,
    sumValue: '594320.5000', minValue: '602.4', maxValue: '1330.9', firstEventTime: '2026-10-28T08:00:00+08:00',
    lastEventTime: NOW, updatedAt: NOW, dataLagSeconds: 42, badRate: 0.0046,
  },
]

const otMappings: OtMappingView[] = [
  {
    mappingId: 'map-001', plantId: 'n-plant', deviceSerial: 'SN-DRAW-001', pointCode: 'P-LEN',
    factKind: 'meter_to_quantity', factKindLabel: '计长 → 报工数量', confirmMode: 'manual',
    confirmModeLabel: '须人工确认', params: { uom: 'M', perUnit: '2500' }, version: 2,
  },
  {
    mappingId: 'map-002', plantId: 'n-plant', deviceSerial: 'SN-DRAW-001', pointCode: 'P-STOP',
    factKind: 'stop_to_downtime', factKindLabel: '停机信号 → 停机事实', confirmMode: 'auto',
    confirmModeLabel: '自动入账', params: { minSeconds: 120 }, version: 1,
  },
]

const otFacts: OtFactView[] = [
  {
    factId: 'fact-001', mappingId: 'map-001', mappingVersion: 2, factKind: 'meter_to_quantity',
    factKindLabel: '计长 → 报工数量', deviceSerial: 'SN-DRAW-001', pointCode: 'P-LEN',
    windowStart: '2026-10-28T08:00:00+08:00', windowEnd: '2026-10-28T09:00:00+08:00',
    value: '2.5200', payload: { meters: '6300', perUnit: '2500' }, status: 'pending_confirm',
    statusLabel: '待确认', confirmedBy: null, confirmedAt: null, outboxEventId: null,
  },
  {
    factId: 'fact-002', mappingId: 'map-002', mappingVersion: 1, factKind: 'stop_to_downtime',
    factKindLabel: '停机信号 → 停机事实', deviceSerial: 'SN-DRAW-001', pointCode: 'P-STOP',
    windowStart: '2026-10-28T07:10:00+08:00', windowEnd: '2026-10-28T07:16:00+08:00',
    value: '360', payload: { seconds: 360 }, status: 'dispatched', statusLabel: '已派发',
    confirmedBy: null, confirmedAt: '2026-10-28T07:20:00+08:00', outboxEventId: 'oevt-20261028-0091',
  },
]

const otStats: OtStatsView[] = [
  { statDate: '2026-10-28', gatewayCode: 'GW-DRAW-01', deviceSerial: 'SN-DRAW-001', dedupCount: 12, overflowCount: 0, overflowFirstAt: null, overflowLastAt: null },
  { statDate: '2026-10-28', gatewayCode: 'GW-EXTR-02', deviceSerial: 'SN-EXTR-009', dedupCount: 128, overflowCount: 5, overflowFirstAt: '2026-10-28T08:50:00+08:00', overflowLastAt: '2026-10-28T09:10:00+08:00' },
]

// ---------------------------------------------------------------------------
// spc 演示数据
// ---------------------------------------------------------------------------

interface MockSpcChange {
  id: string
  changeNo: string
  status: 'draft' | 'published'
  plantId: string
  oldSpecRevisionId: string
  newSpecRevisionId: string
  approver: string
  effectiveAt: string
  publishedAt: string | null
  publishedBy: string | null
  oldSpecLabel: string
  newSpecLabel: string
  impacts: SpcChangeImpactView[]
  adjustments: Array<Record<string, unknown>>
}

const spcChanges: MockSpcChange[] = [
  {
    id: 'chg-001', changeNo: 'CHG-2026-1028-001', status: 'draft', plantId: 'n-plant',
    oldSpecRevisionId: 'psr-1001', newSpecRevisionId: 'psr-1002', approver: '王工（工艺）',
    effectiveAt: '2026-10-30T08:00:00+08:00', publishedAt: null, publishedBy: null,
    oldSpecLabel: '绞合工艺规范 v3（published）', newSpecLabel: '绞合工艺规范 v4（published）',
    impacts: [
      { id: 'imp-001', changeId: 'chg-001', category: 'unexecuted', productionOrderId: 'po-1027-003', orderNo: 'MO-2026-1027-003', orderStatus: 'approved', orderOperationId: 'opo-003-2', operationSeq: 2, operationName: '拉丝', scheduled: true, disposition: null, followsVersion: null, plannedQty: '48.0000', recomputedPlannedQty: null, dispositionBy: null, dispositionAt: null, enterpriseId: 'n-ent', createdAt: NOW, createdBy: 'admin', updatedAt: NOW, updatedBy: null },
      { id: 'imp-002', changeId: 'chg-001', category: 'in_process', productionOrderId: 'po-1027-001', orderNo: 'MO-2026-1027-001', orderStatus: 'in_progress', orderOperationId: 'opo-001-3', operationSeq: 3, operationName: '绞制', scheduled: false, disposition: null, followsVersion: null, plannedQty: '96.0000', recomputedPlannedQty: '100.8000', dispositionBy: null, dispositionAt: null, enterpriseId: 'n-ent', createdAt: NOW, createdBy: 'admin', updatedAt: NOW, updatedBy: null },
      { id: 'imp-003', changeId: 'chg-001', category: 'completed', productionOrderId: 'po-1026-008', orderNo: 'MO-2026-1026-008', orderStatus: 'closed', orderOperationId: 'opo-008-4', operationSeq: 4, operationName: '挤塑', scheduled: false, disposition: null, followsVersion: null, plannedQty: '120.0000', recomputedPlannedQty: null, dispositionBy: null, dispositionAt: null, enterpriseId: 'n-ent', createdAt: NOW, createdBy: 'admin', updatedAt: NOW, updatedBy: null },
    ],
    adjustments: [],
  },
]

const spcControlItems: SpcControlItemView[] = [
  { id: 'ci-001', specCode: 'SPEC-JZ-001', specVersion: 3, itemNo: 'OD-01', itemName: '绞合外径', pointRef: 'SN-EXTR-009/P-DIA', ruleSetId: null, status: 'active', plantId: 'n-plant', enterpriseId: 'n-ent', createdAt: '2026-10-01T08:00:00+08:00', createdBy: 'admin', updatedAt: NOW, updatedBy: null },
  { id: 'ci-002', specCode: 'SPEC-LS-002', specVersion: 2, itemNo: 'DIA-01', itemName: '拉丝线径', pointRef: null, ruleSetId: null, status: 'active', plantId: 'n-plant', enterpriseId: 'n-ent', createdAt: '2026-10-05T08:00:00+08:00', createdBy: 'admin', updatedAt: NOW, updatedBy: null },
]

const spcSamples: SpcSampleView[] = [
  { id: 'ss-001', controlItemId: 'ci-001', source: 'manual_inspection', testResultId: 'tr-0101', measuredValue: '0.5268', sampledAt: '2026-10-28T08:10:00+08:00', productionOrderId: 'po-1027-001', orderOperationId: 'opo-001-3', operationSeq: 3, equipmentId: 'eq-0003', equipmentCode: 'EQU-0003', shiftDate: '2026-10-28', gaugeId: 'g-001', calibrationStatus: 'valid', admission: 'admitted', rejectReason: null, commandReceiptId: null, plantId: 'n-plant', enterpriseId: 'n-ent', businessTime: '2026-10-28T08:10:00+08:00', createdAt: '2026-10-28T08:10:00+08:00', createdBy: '质检-陈工', judgement: { id: 'jd-001', sampleId: 'ss-001', controlItemId: 'ci-001', pointNo: 1, verdict: 'in_control', violatedCodes: [], ruleSetId: 'rs-default', ruleSetVersion: 1, controlLimitId: 'cl-002', controlLimitVersion: 2, judgedAt: '2026-10-28T08:10:05+08:00', enterpriseId: 'n-ent', createdAt: '2026-10-28T08:10:05+08:00', createdBy: null } },
  { id: 'ss-002', controlItemId: 'ci-001', source: 'manual_inspection', testResultId: 'tr-0102', measuredValue: '0.5274', sampledAt: '2026-10-28T08:40:00+08:00', productionOrderId: 'po-1027-001', orderOperationId: 'opo-001-3', operationSeq: 3, equipmentId: 'eq-0003', equipmentCode: 'EQU-0003', shiftDate: '2026-10-28', gaugeId: 'g-001', calibrationStatus: 'valid', admission: 'admitted', rejectReason: null, commandReceiptId: null, plantId: 'n-plant', enterpriseId: 'n-ent', businessTime: '2026-10-28T08:40:00+08:00', createdAt: '2026-10-28T08:40:00+08:00', createdBy: '质检-陈工', judgement: { id: 'jd-002', sampleId: 'ss-002', controlItemId: 'ci-001', pointNo: 2, verdict: 'in_control', violatedCodes: [], ruleSetId: 'rs-default', ruleSetVersion: 1, controlLimitId: 'cl-002', controlLimitVersion: 2, judgedAt: '2026-10-28T08:40:05+08:00', enterpriseId: 'n-ent', createdAt: '2026-10-28T08:40:05+08:00', createdBy: null } },
  { id: 'ss-003', controlItemId: 'ci-001', source: 'manual_inspection', testResultId: 'tr-0103', measuredValue: '0.5412', sampledAt: '2026-10-28T09:05:00+08:00', productionOrderId: 'po-1027-001', orderOperationId: 'opo-001-3', operationSeq: 3, equipmentId: 'eq-0003', equipmentCode: 'EQU-0003', shiftDate: '2026-10-28', gaugeId: 'g-001', calibrationStatus: 'valid', admission: 'admitted', rejectReason: null, commandReceiptId: null, plantId: 'n-plant', enterpriseId: 'n-ent', businessTime: '2026-10-28T09:05:00+08:00', createdAt: '2026-10-28T09:05:00+08:00', createdBy: '质检-陈工', judgement: { id: 'jd-003', sampleId: 'ss-003', controlItemId: 'ci-001', pointNo: 3, verdict: 'out_of_control', violatedCodes: ['point_beyond_limits'], ruleSetId: 'rs-default', ruleSetVersion: 1, controlLimitId: 'cl-002', controlLimitVersion: 2, judgedAt: '2026-10-28T09:05:05+08:00', enterpriseId: 'n-ent', createdAt: '2026-10-28T09:05:05+08:00', createdBy: null } },
]

const spcOocTasks: SpcOocTaskView[] = [
  {
    id: 'ooc-001', taskNo: 'OOC-2026-1028-001', status: 'open', controlItemId: 'ci-001', sampleId: 'ss-003',
    notifyRoles: ['quality', 'process_engineer', 'shift_leader'], causeCategory: null, correctiveAction: null,
    isolationSuggestion: null, qualityDoubtHint: true, raisedAt: '2026-10-28T09:05:06+08:00', raisedBy: 'system',
    disposedBy: null, disposedAt: null, recontrolConfirmedBy: null, recontrolConfirmedAt: null,
    commandReceiptId: null, plantId: 'n-plant', enterpriseId: 'n-ent', businessTime: '2026-10-28T09:05:06+08:00',
    createdAt: '2026-10-28T09:05:06+08:00', createdBy: null,
  },
]

const spcGauges: Array<{
  id: string
  gaugeNo: string
  name: string
  gaugeKind: string | null
  plantId: string
  history: SpcCalibrationRecordView[]
}> = [
  {
    id: 'g-001', gaugeNo: 'G-MIC-001', name: '数显千分尺', gaugeKind: '千分尺', plantId: 'n-plant',
    history: [
      { id: 'cal-001', gaugeId: 'g-001', calibratedAt: '2026-04-26T00:00:00+08:00', result: 'qualified', certificateNo: 'JJG21-2026-041', validUntil: '2026-10-26', basis: 'JJG 21-2008 千分尺检定规程', recordedBy: '计量-李工', commandReceiptId: null, plantId: 'n-plant', enterpriseId: 'n-ent', businessTime: '2026-04-26T00:00:00+08:00', createdAt: '2026-04-26T00:00:00+08:00', createdBy: null },
      { id: 'cal-002', gaugeId: 'g-001', calibratedAt: '2026-10-27T00:00:00+08:00', result: 'qualified', certificateNo: 'JJG21-2026-118', validUntil: '2027-04-27', basis: 'JJG 21-2008 千分尺检定规程', recordedBy: '计量-李工', commandReceiptId: null, plantId: 'n-plant', enterpriseId: 'n-ent', businessTime: '2026-10-27T00:00:00+08:00', createdAt: '2026-10-27T00:00:00+08:00', createdBy: null },
    ],
  },
  {
    id: 'g-002', gaugeNo: 'G-DIA-002', name: '激光测径仪', gaugeKind: '测径仪', plantId: 'n-plant',
    history: [
      { id: 'cal-003', gaugeId: 'g-002', calibratedAt: '2026-03-30T00:00:00+08:00', result: 'failed', certificateNo: 'JJG-laser-2026-021', validUntil: '2026-09-30', basis: '企业校准规范 Q/CZ-JZ-03', recordedBy: '计量-李工', commandReceiptId: null, plantId: 'n-plant', enterpriseId: 'n-ent', businessTime: '2026-03-30T00:00:00+08:00', createdAt: '2026-03-30T00:00:00+08:00', createdBy: null },
    ],
  },
]

/** 校准状态按最新记录时点快照（与真实服务端口径一致：PE-16）。 */
function gaugeStatusOf(gauge: (typeof spcGauges)[number]): string {
  const latest = gauge.history[gauge.history.length - 1]
  if (latest === undefined) return 'unknown'
  if (latest.validUntil < '2026-10-28') return latest.result === 'qualified' ? 'expired' : 'invalid'
  if (latest.result === 'failed') return 'invalid'
  if (latest.result === 'limited') return 'limited'
  return 'valid'
}

const spcMiscalActions: Array<Record<string, unknown>> = []

const spcTools: SpcToolListItem[] = [
  { id: 't-001', toolNo: 'TL-DIE-014', name: '挤塑模具 90mm', toolKind: '模具', configVersion: 2, lifeUom: 'meters', ratedLife: '500000.0000', warningThreshold: '450000.0000', expirePolicy: 'block', accumulatedLife: '468200.0000', plantId: 'n-plant', enterpriseId: 'n-ent', createdAt: '2026-08-01T08:00:00+08:00', createdBy: 'admin', updatedAt: NOW, updatedBy: null, adjustmentSum: '0.0000', effectiveLife: '468200.0000', status: 'warning', schedulableForScheduling: true },
  { id: 't-002', toolNo: 'TL-DRUM-03', name: '拉丝鼓轮 LT-450', toolKind: '鼓轮', configVersion: 1, lifeUom: 'count', ratedLife: '2000000.0000', warningThreshold: '1800000.0000', expirePolicy: 'degrade', accumulatedLife: '32100.0000', plantId: 'n-plant', enterpriseId: 'n-ent', createdAt: '2026-08-01T08:00:00+08:00', createdBy: 'admin', updatedAt: NOW, updatedBy: null, adjustmentSum: '0.0000', effectiveLife: '32100.0000', status: 'normal', schedulableForScheduling: true },
]

const spcToolDetails: Record<string, SpcToolDetailResponse> = {
  't-001': {
    tool: spcTools[0]!,
    adjustmentSum: '0.0000', effectiveLife: '468200.0000', status: 'warning', schedulableForScheduling: true,
    configHistory: [
      { id: 'tcfg-001', toolId: 't-001', version: 1, lifeUom: 'meters', ratedLife: '500000.0000', warningThreshold: '450000.0000', expirePolicy: 'block', effectiveAt: '2026-08-01T08:00:00+08:00', enterpriseId: 'n-ent', createdAt: '2026-08-01T08:00:00+08:00', createdBy: 'admin' },
      { id: 'tcfg-002', toolId: 't-001', version: 2, lifeUom: 'meters', ratedLife: '500000.0000', warningThreshold: '460000.0000', expirePolicy: 'block', effectiveAt: '2026-10-10T08:00:00+08:00', enterpriseId: 'n-ent', createdAt: '2026-10-10T08:00:00+08:00', createdBy: 'admin' },
    ],
    usage: [
      { id: 'tu-001', toolId: 't-001', source: 'work_report_output', quantity: '52000.0000', refType: 'work_report', refId: 'rp-20261027-0044', commandReceiptId: null, plantId: 'n-plant', enterpriseId: 'n-ent', businessTime: '2026-10-27T16:00:00+08:00', createdAt: '2026-10-27T16:00:00+08:00', createdBy: 'admin' },
      { id: 'tu-002', toolId: 't-001', source: 'collected_sample', quantity: '31600.0000', refType: 'ot_fact', refId: 'fact-20261027-0110', commandReceiptId: null, plantId: 'n-plant', enterpriseId: 'n-ent', businessTime: '2026-10-27T22:00:00+08:00', createdAt: '2026-10-27T22:00:00+08:00', createdBy: 'admin' },
    ],
    adjustments: [],
  },
  't-002': {
    tool: spcTools[1]!,
    adjustmentSum: '0.0000', effectiveLife: '32100.0000', status: 'normal', schedulableForScheduling: true,
    configHistory: [
      { id: 'tcfg-003', toolId: 't-002', version: 1, lifeUom: 'count', ratedLife: '2000000.0000', warningThreshold: '1800000.0000', expirePolicy: 'degrade', effectiveAt: '2026-08-01T08:00:00+08:00', enterpriseId: 'n-ent', createdAt: '2026-08-01T08:00:00+08:00', createdBy: 'admin' },
    ],
    usage: [],
    adjustments: [],
  },
}

function recomputeToolStatus(tool: SpcToolListItem): void {
  const effective = Number(tool.accumulatedLife) + Number(tool.adjustmentSum)
  tool.effectiveLife = effective.toFixed(4)
  if (effective >= Number(tool.ratedLife)) tool.status = 'expired'
  else if (effective >= Number(tool.warningThreshold)) tool.status = 'warning'
  else tool.status = 'normal'
  tool.schedulableForScheduling = !(tool.status === 'expired' && tool.expirePolicy === 'block')
}

// ---------------------------------------------------------------------------
// csw 外协演示数据
// ---------------------------------------------------------------------------

const cswTasks: CswOutsourcingTaskView[] = [
  {
    id: 'owt-001', taskNo: 'OWT-2026-1028-001', enterpriseId: 'n-ent', plantId: 'n-plant', orderId: 'po-1027-003',
    orderOperationId: 'opo-003-2', orderNo: 'MO-2026-1027-003', operationName: '拉丝', supplierCode: 'SUP-051',
    supplierName: '杭州精密拉丝厂', qty: '48.0000', uom: '盘', transitLocationId: 'loc-owt-01', transitLocationCode: 'OWT-TRANS-01',
    returnLocationId: 'loc-01030001', returnLocationCode: '01030001', status: 'draft', statusLabel: '草稿',
    inspectionResult: null, occupationActive: false, sentQty: '0.0000', returnedQty: '0.0000',
    sentBy: null, sentAt: null, receivedBy: null, receivedAt: null, inspectedBy: null, inspectedAt: null,
    closedBy: null, closedAt: null, recallReason: null, recalledBy: null, recalledAt: null,
    disposeReason: null, disposedBy: null, disposedAt: null, createdBy: 'plan-周工', createdAt: NOW, updatedAt: NOW, updatedBy: null,
  },
  {
    id: 'owt-002', taskNo: 'OWT-2026-1028-002', enterpriseId: 'n-ent', plantId: 'n-plant', orderId: 'po-1027-005',
    orderOperationId: 'opo-005-3', orderNo: 'MO-2026-1027-005', operationName: '绞制', supplierCode: 'SUP-033',
    supplierName: '宁波联合绞合中心', qty: '60.0000', uom: '盘', transitLocationId: 'loc-owt-01', transitLocationCode: 'OWT-TRANS-01',
    returnLocationId: null, returnLocationCode: null, status: 'pending_send', statusLabel: '待发送',
    inspectionResult: null, occupationActive: false, sentQty: '0.0000', returnedQty: '0.0000',
    sentBy: null, sentAt: null, receivedBy: null, receivedAt: null, inspectedBy: null, inspectedAt: null,
    closedBy: null, closedAt: null, recallReason: null, recalledBy: null, recalledAt: null,
    disposeReason: null, disposedBy: null, disposedAt: null, createdBy: 'plan-周工', createdAt: NOW, updatedAt: NOW, updatedBy: null,
  },
  {
    id: 'owt-003', taskNo: 'OWT-2026-1028-003', enterpriseId: 'n-ent', plantId: 'n-plant', orderId: 'po-1027-002',
    orderOperationId: 'opo-002-4', orderNo: 'MO-2026-1027-002', operationName: '挤塑', supplierCode: 'SUP-047',
    supplierName: '苏州恒晟挤塑加工', qty: '96.0000', uom: '盘', transitLocationId: 'loc-owt-01', transitLocationCode: 'OWT-TRANS-01',
    returnLocationId: 'loc-01030001', returnLocationCode: '01030001', status: 'sent', statusLabel: '已发送（在外加工）',
    inspectionResult: null, occupationActive: true, sentQty: '96.0000', returnedQty: '0.0000',
    sentBy: 'wh-老赵', sentAt: '2026-10-27T10:00:00+08:00', receivedBy: null, receivedAt: null, inspectedBy: null, inspectedAt: null,
    closedBy: null, closedAt: null, recallReason: null, recalledBy: null, recalledAt: null,
    disposeReason: null, disposedBy: null, disposedAt: null, createdBy: 'plan-周工', createdAt: '2026-10-27T09:00:00+08:00', updatedAt: '2026-10-27T10:00:00+08:00', updatedBy: null,
  },
  {
    id: 'owt-004', taskNo: 'OWT-2026-1027-006', enterpriseId: 'n-ent', plantId: 'n-plant', orderId: 'po-1027-001',
    orderOperationId: 'opo-001-2', orderNo: 'MO-2026-1027-001', operationName: '拉丝', supplierCode: 'SUP-051',
    supplierName: '杭州精密拉丝厂', qty: '96.0000', uom: '盘', transitLocationId: 'loc-owt-01', transitLocationCode: 'OWT-TRANS-01',
    returnLocationId: 'loc-01030001', returnLocationCode: '01030001', status: 'return_received', statusLabel: '回厂接收（待检）',
    inspectionResult: 'pending', occupationActive: true, sentQty: '96.0000', returnedQty: '94.5000',
    sentBy: 'wh-老赵', sentAt: '2026-10-24T10:00:00+08:00', receivedBy: 'wh-老赵', receivedAt: '2026-10-27T15:30:00+08:00',
    inspectedBy: null, inspectedAt: null, closedBy: null, closedAt: null, recallReason: null, recalledBy: null, recalledAt: null,
    disposeReason: null, disposedBy: null, disposedAt: null, createdBy: 'plan-周工', createdAt: '2026-10-24T09:00:00+08:00', updatedAt: '2026-10-27T15:30:00+08:00', updatedBy: null,
  },
  {
    id: 'owt-005', taskNo: 'OWT-2026-1027-005', enterpriseId: 'n-ent', plantId: 'n-plant', orderId: 'po-1027-001',
    orderOperationId: 'opo-001-2', orderNo: 'MO-2026-1027-001', operationName: '拉丝', supplierCode: 'SUP-051',
    supplierName: '杭州精密拉丝厂', qty: '48.0000', uom: '盘', transitLocationId: 'loc-owt-01', transitLocationCode: 'OWT-TRANS-01',
    returnLocationId: 'loc-01030001', returnLocationCode: '01030001', status: 'inspecting', statusLabel: '检验中',
    inspectionResult: 'pending', occupationActive: true, sentQty: '48.0000', returnedQty: '47.0000',
    sentBy: 'wh-老赵', sentAt: '2026-10-20T10:00:00+08:00', receivedBy: 'wh-老赵', receivedAt: '2026-10-23T14:00:00+08:00',
    inspectedBy: null, inspectedAt: null, closedBy: null, closedAt: null, recallReason: null, recalledBy: null, recalledAt: null,
    disposeReason: null, disposedBy: null, disposedAt: null, createdBy: 'plan-周工', createdAt: '2026-10-20T09:00:00+08:00', updatedAt: '2026-10-23T14:00:00+08:00', updatedBy: null,
  },
  {
    id: 'owt-006', taskNo: 'OWT-2026-1026-004', enterpriseId: 'n-ent', plantId: 'n-plant', orderId: 'po-1026-008',
    orderOperationId: 'opo-008-4', orderNo: 'MO-2026-1026-008', operationName: '挤塑', supplierCode: 'SUP-047',
    supplierName: '苏州恒晟挤塑加工', qty: '120.0000', uom: '盘', transitLocationId: 'loc-owt-01', transitLocationCode: 'OWT-TRANS-01',
    returnLocationId: 'loc-01030001', returnLocationCode: '01030001', status: 'closed', statusLabel: '已关闭',
    inspectionResult: 'passed', occupationActive: false, sentQty: '120.0000', returnedQty: '119.0000',
    sentBy: 'wh-老赵', sentAt: '2026-10-15T10:00:00+08:00', receivedBy: 'wh-老赵', receivedAt: '2026-10-18T15:00:00+08:00',
    inspectedBy: 'qc-陈工', inspectedAt: '2026-10-19T09:00:00+08:00', closedBy: 'plan-周工', closedAt: '2026-10-19T10:00:00+08:00',
    recallReason: null, recalledBy: null, recalledAt: null, disposeReason: null, disposedBy: null, disposedAt: null,
    createdBy: 'plan-周工', createdAt: '2026-10-15T09:00:00+08:00', updatedAt: '2026-10-19T10:00:00+08:00', updatedBy: null,
  },
]

const cswUnits: CswOutsourcingUnitView[] = [
  { id: 'uow-001', taskId: 'owt-003', unitId: 'unit-1005-0001', unitNo: 'U-2026-1005-0001', sendLotId: 'lot-0517', sentQty: '48.0000', returnedQty: '0.0000', returnLotId: null, status: 'sent', createdAt: '2026-10-27T10:00:00+08:00', updatedAt: '2026-10-27T10:00:00+08:00' },
  { id: 'uow-002', taskId: 'owt-003', unitId: 'unit-1005-0002', unitNo: 'U-2026-1005-0002', sendLotId: 'lot-0517', sentQty: '48.0000', returnedQty: '0.0000', returnLotId: null, status: 'sent', createdAt: '2026-10-27T10:00:00+08:00', updatedAt: '2026-10-27T10:00:00+08:00' },
  { id: 'uow-003', taskId: 'owt-004', unitId: 'unit-1001-0003', unitNo: 'U-2026-1001-0003', sendLotId: 'lot-0502', sentQty: '96.0000', returnedQty: '94.5000', returnLotId: 'lot-0531', status: 'returned', createdAt: '2026-10-24T10:00:00+08:00', updatedAt: '2026-10-27T15:30:00+08:00' },
]

const CSW_STATUS_LABELS: Record<string, string> = {
  draft: '草稿', pending_send: '待发送', sent: '已发送（在外加工）', return_received: '回厂接收（待检）',
  inspecting: '检验中', closed: '已关闭', recalled: '已收回', return_disposed: '已退回处置',
}

function setTaskStatus(task: CswOutsourcingTaskView, status: CswOutsourcingTaskView['status']): void {
  task.status = status
  task.statusLabel = CSW_STATUS_LABELS[status] ?? status
  task.occupationActive = status === 'sent' || status === 'return_received' || status === 'inspecting'
  task.updatedAt = NOW
}

function requireCswTask(taskId: string): CswOutsourcingTaskView {
  const task = cswTasks.find((t) => t.id === taskId)
  if (task === undefined) rejectNotFound('外协任务不存在或不在授权数据范围内')
  return task
}

function requireCswTransition(task: CswOutsourcingTaskView, from: Array<CswOutsourcingTaskView['status']>, action: string): void {
  if (!from.includes(task.status)) {
    rejectRule(`[CS-19] 当前状态「${task.statusLabel}」不允许执行「${action}」：外协状态由具名命令驱动（发送后取消走收回，回厂后取消走退回处置）`)
  }
}

// ---------------------------------------------------------------------------
// cost 演示数据（形状对齐落盘 API：contracts/cost.ts + cost-queries/cost-repositories
// + apps/api/src/cost/cost.controller.ts——P3-D 2026-10-28 落盘形态）
// ---------------------------------------------------------------------------

const COST_LABOR_SOURCE = 'labor_record（报工工时主源，CA-12 PROPOSED 默认）'
const COST_EQUIPMENT_CALIBER = '机时＋备件消耗（不含折旧——CA-13 PROPOSED 默认：ERP 未提供折旧值，列示并标注）'

const costRuns: CostRunView[] = [
  {
    id: 'run-001', runNo: 'CR-2026-1027-001', orderId: 'po-1027-001',
    allocationVersionId: 'av-001', priceVersionId: 'pv-001', shiftDate: '2026-10-27',
    shiftCalendarId: 'cal-day-a', dataCutoffAt: '2026-10-28T08:00:00+08:00', shiftSnapshotAnchor: { shift: '白班' },
    estimateAmount: '130680.0000', actualAmount: '141605.5000', estimatePossible: true, estimateMissingReason: null,
    energyMeteredUsage: '18400.0000', energyEstimatedUsage: '4800.0000', energyCoverageRatio: '0.7931',
    energyUomCode: 'KWH', machineHours: '86.5000', laborSource: COST_LABOR_SOURCE,
    equipmentCostCaliber: COST_EQUIPMENT_CALIBER, recalcOf: null, oldNewComparison: null,
    plantId: 'n-plant', createdAt: '2026-10-28T08:05:00+08:00',
  },
  {
    id: 'run-002', runNo: 'CR-2026-1027-002', orderId: 'po-1027-002',
    allocationVersionId: 'av-001', priceVersionId: 'pv-001', shiftDate: '2026-10-27',
    shiftCalendarId: 'cal-day-a', dataCutoffAt: '2026-10-28T08:00:00+08:00', shiftSnapshotAnchor: { shift: '白班' },
    estimateAmount: '88210.0000', actualAmount: null, estimatePossible: true,
    estimateMissingReason: '存在缺价行（数量列示+缺价标注，不填默认价 CE-14）——实测金额列缺项',
    energyMeteredUsage: '9600.0000', energyEstimatedUsage: '0.0000', energyCoverageRatio: '1.0000',
    energyUomCode: 'KWH', machineHours: '52.0000', laborSource: COST_LABOR_SOURCE,
    equipmentCostCaliber: COST_EQUIPMENT_CALIBER, recalcOf: null, oldNewComparison: null,
    plantId: 'n-plant', createdAt: '2026-10-28T08:06:00+08:00',
  },
  {
    id: 'run-003', runNo: 'CR-2026-1026-101', orderId: 'po-1026-008',
    allocationVersionId: 'av-001', priceVersionId: 'pv-001', shiftDate: '2026-10-26',
    shiftCalendarId: 'cal-day-a', dataCutoffAt: '2026-10-27T08:00:00+08:00', shiftSnapshotAnchor: { shift: '白班' },
    estimateAmount: null, actualAmount: '10410.0000', estimatePossible: false,
    estimateMissingReason: '无已发布 BOM 版本（估算缺项，CE-17/CE-03）',
    energyMeteredUsage: '0.0000', energyEstimatedUsage: '4200.0000', energyCoverageRatio: '0.0000',
    energyUomCode: 'KWH', machineHours: '21.0000', laborSource: COST_LABOR_SOURCE,
    equipmentCostCaliber: COST_EQUIPMENT_CALIBER, recalcOf: null, oldNewComparison: null,
    plantId: 'n-plant', createdAt: '2026-10-27T08:04:00+08:00',
  },
]

const costRunLines: Record<string, CostLineView[]> = {
  'run-001': [
    { lineId: 'cl-0011', lineNo: 1, sourceKind: 'material', sourceTable: 'material_consumption', sourceFactId: 'mc-20261027-0012', valueFlag: 'measured', orderOperationId: 'opo-001-2', productFamilyId: 'pf-yjv', quantity: '18600.0000', uomCode: 'KG', theoreticalQuantity: '18000.0000', varianceQuantity: '600.0000', destinationBreakdownMissing: false, unitPrice: '5.5000', priceMissing: false, amount: '102300.0000', facts: { source: 'T11 消耗流水（实耗）' } },
    { lineId: 'cl-0012', lineNo: 2, sourceKind: 'material', sourceTable: 'material_consumption(自动倒冲)', sourceFactId: 'mc-20261027-0019', valueFlag: 'estimated', orderOperationId: 'opo-001-2', productFamilyId: 'pf-yjv', quantity: '620.0000', uomCode: 'KG', theoreticalQuantity: '620.0000', varianceQuantity: '0.0000', destinationBreakdownMissing: false, unitPrice: '5.5000', priceMissing: false, amount: '3410.0000', facts: { source: '自动倒冲（工艺允许，CE-08：标明估算，差异由盘点/结料调整）' } },
    { lineId: 'cl-0013', lineNo: 3, sourceKind: 'labor', sourceTable: 'labor_record', sourceFactId: 'lr-20261027-0031', valueFlag: 'measured', orderOperationId: 'opo-001-2', productFamilyId: null, quantity: '128.5000', uomCode: 'H', theoreticalQuantity: null, varianceQuantity: null, destinationBreakdownMissing: false, unitPrice: '120.0000', priceMissing: false, amount: '15420.0000', facts: { source: '报工工时（主源）' } },
    { lineId: 'cl-0014', lineNo: 4, sourceKind: 'scrap', sourceTable: 'work_report_scrap', sourceFactId: 'wr-20261027-0110', valueFlag: 'measured', orderOperationId: 'opo-001-2', productFamilyId: 'pf-yjv', quantity: '45.6000', uomCode: 'KG', theoreticalQuantity: null, varianceQuantity: null, destinationBreakdownMissing: false, unitPrice: '55.0000', priceMissing: false, amount: '2508.0000', facts: { source: '报工损耗记录' } },
    { lineId: 'cl-0015', lineNo: 5, sourceKind: 'equipment_runtime', sourceTable: 'equipment_runtime', sourceFactId: 'dt-20261027-0022', valueFlag: 'measured', orderOperationId: 'opo-001-2', productFamilyId: null, quantity: '16.5000', uomCode: 'H', theoreticalQuantity: null, varianceQuantity: null, destinationBreakdownMissing: false, unitPrice: '175.0000', priceMissing: false, amount: '2887.5000', facts: { source: 'OT 运行与 T19 停机事实' } },
    { lineId: 'cl-0016', lineNo: 6, sourceKind: 'energy', sourceTable: 'meter_reading', sourceFactId: 'mr-20261027-0088', valueFlag: 'measured', orderOperationId: null, productFamilyId: 'pf-yjv', quantity: '18400.0000', uomCode: 'KWH', theoreticalQuantity: null, varianceQuantity: null, destinationBreakdownMissing: false, unitPrice: '0.6500', priceMissing: false, amount: '11960.0000', facts: { source: '表计读数（实测覆盖）' } },
    { lineId: 'cl-0017', lineNo: 7, sourceKind: 'energy', sourceTable: 'meter_reading(覆盖不足估算)', sourceFactId: 'mr-20261027-0089', valueFlag: 'estimated', orderOperationId: null, productFamilyId: 'pf-yjv', quantity: '4800.0000', uomCode: 'KWH', theoreticalQuantity: null, varianceQuantity: null, destinationBreakdownMissing: false, unitPrice: '0.6500', priceMissing: false, amount: '3120.0000', facts: { source: '覆盖不足部分按机时占比估算并显著标注（CE-09）' } },
  ],
  'run-002': [
    { lineId: 'cl-0021', lineNo: 1, sourceKind: 'material', sourceTable: 'material_consumption', sourceFactId: 'mc-20261027-0026', valueFlag: 'measured', orderOperationId: 'opo-002-4', productFamilyId: 'pf-kvvp', quantity: '5400.0000', uomCode: 'KG', theoreticalQuantity: '5300.0000', varianceQuantity: '100.0000', destinationBreakdownMissing: false, unitPrice: null, priceMissing: true, amount: null, facts: { source: 'T11 消耗流水（实耗）——价格版本未含该料（ERP 采购实际价未提供，CE-14）' } },
    { lineId: 'cl-0022', lineNo: 2, sourceKind: 'labor', sourceTable: 'labor_record', sourceFactId: 'lr-20261027-0040', valueFlag: 'measured', orderOperationId: 'opo-002-4', productFamilyId: null, quantity: '76.0000', uomCode: 'H', theoreticalQuantity: null, varianceQuantity: null, destinationBreakdownMissing: false, unitPrice: '120.0000', priceMissing: false, amount: '9120.0000', facts: { source: '报工工时（主源）' } },
  ],
  'run-003': [
    { lineId: 'cl-0031', lineNo: 1, sourceKind: 'labor', sourceTable: 'labor_record', sourceFactId: 'lr-20261026-0077', valueFlag: 'measured', orderOperationId: 'opo-008-4', productFamilyId: null, quantity: '64.0000', uomCode: 'H', theoreticalQuantity: null, varianceQuantity: null, destinationBreakdownMissing: false, unitPrice: '120.0000', priceMissing: false, amount: '7680.0000', facts: { source: '报工工时（主源）' } },
    { lineId: 'cl-0032', lineNo: 2, sourceKind: 'energy', sourceTable: 'meter_reading(表计未装估算)', sourceFactId: 'mr-20261026-0031', valueFlag: 'estimated', orderOperationId: null, productFamilyId: 'pf-bv', quantity: '4200.0000', uomCode: 'KWH', theoreticalQuantity: null, varianceQuantity: null, destinationBreakdownMissing: false, unitPrice: '0.6500', priceMissing: false, amount: '2730.0000', facts: { source: '表计未装：全估算并显著标注（CE-09 覆盖率 0）' } },
  ],
}

/** 归集首跑演示模板（按订单；orderId 未知 → 404 同真实口径）。 */
const costRunFactTemplates: Record<string, { orderNo: string; shiftDateFallback: string; lines: CostLineView[]; estimateAmount: string | null; estimatePossible: boolean; estimateMissingReason: string | null }> = {
  'po-1027-001': {
    orderNo: 'MO-2026-1027-001', shiftDateFallback: '2026-10-27',
    lines: costRunLines['run-001']!.map((l) => ({ ...l, lineId: `cl-n1-${l.lineNo}` })),
    estimateAmount: '130680.0000', estimatePossible: true, estimateMissingReason: null,
  },
  'po-1027-002': {
    orderNo: 'MO-2026-1027-002', shiftDateFallback: '2026-10-27',
    lines: costRunLines['run-002']!.map((l) => ({ ...l, lineId: `cl-n2-${l.lineNo}` })),
    estimateAmount: '88210.0000', estimatePossible: true, estimateMissingReason: '存在缺价行（数量列示+缺价标注，不填默认价 CE-14）——实测金额列缺项',
  },
  'po-1026-008': {
    orderNo: 'MO-2026-1026-008', shiftDateFallback: '2026-10-26',
    lines: costRunLines['run-003']!.map((l) => ({ ...l, lineId: `cl-n3-${l.lineNo}` })),
    estimateAmount: null, estimatePossible: false, estimateMissingReason: '无已发布 BOM 版本（估算缺项，CE-17/CE-03）',
  },
}

/** GET /cost/orders/:orderId/summary（orderCostSummary 组装形状）。 */
const costOrderSummaries: Record<string, CostOrderSummaryResponse> = {
  'po-1027-001': {
    orderId: 'po-1027-001', orderNo: 'MO-2026-1027-001', orderStatus: 'in_progress', plannedQty: '12.0000',
    estimate: {
      possible: true, missingReason: null, amount: '130680.0000',
      lines: [{ materialCode: 'CU-95', theoreticalQty: '23760.0000', unitPrice: '5.5000', uomCode: 'KG', amount: '130680.0000', priceMissing: false }],
    },
    actual: {
      runId: 'run-001', runNo: 'CR-2026-1027-001', shiftDate: '2026-10-27', dataCutoffAt: '2026-10-28T08:00:00+08:00',
      amount: '141605.5000', estimateAmount: '130680.0000', anyPriceMissing: false,
      laborSource: COST_LABOR_SOURCE, equipmentCostCaliber: COST_EQUIPMENT_CALIBER,
    },
    wipByOperation: [
      { orderOperationId: 'opo-001-2', operationSeq: 2, materialQty: '19220.0000', materialAmount: '105710.0000', laborHours: '128.5000' },
    ],
  },
  'po-1027-002': {
    orderId: 'po-1027-002', orderNo: 'MO-2026-1027-002', orderStatus: 'in_progress', plannedQty: '8.0000',
    estimate: {
      possible: true, missingReason: '存在缺价行（数量列示+缺价标注，不填默认价 CE-14）', amount: null,
      lines: [{ materialCode: 'CU-XLPE-01', theoreticalQty: '5400.0000', unitPrice: null, uomCode: 'KG', amount: null, priceMissing: true }],
    },
    actual: {
      runId: 'run-002', runNo: 'CR-2026-1027-002', shiftDate: '2026-10-27', dataCutoffAt: '2026-10-28T08:00:00+08:00',
      amount: null, estimateAmount: '88210.0000', anyPriceMissing: true,
      laborSource: COST_LABOR_SOURCE, equipmentCostCaliber: COST_EQUIPMENT_CALIBER,
    },
    wipByOperation: [
      { orderOperationId: 'opo-002-4', operationSeq: 4, materialQty: '5400.0000', materialAmount: null, laborHours: '76.0000' },
    ],
  },
  'po-1026-008': {
    orderId: 'po-1026-008', orderNo: 'MO-2026-1026-008', orderStatus: 'closed', plannedQty: '30.0000',
    estimate: { possible: false, missingReason: '无已发布 BOM 版本（估算缺项，CE-17/CE-03）', amount: null, lines: [] },
    actual: {
      runId: 'run-003', runNo: 'CR-2026-1026-101', shiftDate: '2026-10-26', dataCutoffAt: '2026-10-27T08:00:00+08:00',
      amount: '10410.0000', estimateAmount: null, anyPriceMissing: false,
      laborSource: COST_LABOR_SOURCE, equipmentCostCaliber: COST_EQUIPMENT_CALIBER,
    },
    wipByOperation: [],
  },
}

const costMeters: CostMeterView[] = [
  { id: 'm-001', meterCode: 'EM-F01-MAIN', meterName: 'F01 车间总电表', energyType: 'electric', coverageKind: 'workshop', equipmentId: null, workCenterId: 'wc-f01', sampleSource: 'ot', otPointId: 'pt-090', uomCode: 'KWH', status: 'active', plantId: 'n-plant' },
  { id: 'm-002', meterCode: 'EM-EXTR-07', meterName: '挤塑五线电表', energyType: 'electric', coverageKind: 'equipment', equipmentId: 'eq-0007', workCenterId: null, sampleSource: 'ot', otPointId: 'pt-091', uomCode: 'KWH', status: 'active', plantId: 'n-plant' },
  { id: 'm-003', meterCode: 'WM-DRAW-01', meterName: '拉丝区水表（人工抄表）', energyType: 'water', coverageKind: 'equipment', equipmentId: 'eq-0001', workCenterId: null, sampleSource: 'manual', otPointId: null, uomCode: 'M3', status: 'active', plantId: 'n-plant' },
]

const costAllocationVersions: CostAllocationVersionView[] = [
  { id: 'av-001', versionNo: 3, formula: 'machine_hours', params: { basis: '工序机时占比（CE-12 默认口径，GAP-E21 待裁）' }, overheadCaliber: '制造费用＝机时分摊', status: 'active', referencedByRuns: 3, plantId: 'n-plant', createdAt: '2026-10-01T08:00:00+08:00' },
  { id: 'av-002', versionNo: 2, formula: 'machine_hours', params: { basis: '工序机时占比（旧参数）' }, overheadCaliber: '制造费用＝机时分摊', status: 'retired', referencedByRuns: 0, plantId: 'n-plant', createdAt: '2026-09-01T08:00:00+08:00' },
]

const costPriceVersions: CostPriceVersionView[] = [
  {
    id: 'pv-001', versionNo: 2026, priceSource: 'standard_cost', status: 'active', remark: '标准成本 2026（价格主权归上游，本系统只引用并标版本 CE-14）', plantId: 'n-plant', createdAt: '2026-10-01T08:00:00+08:00',
    items: [
      { materialCode: 'CU-95', materialId: 'mat-095', unitPrice: '5.5000', uomCode: 'KG' },
      { materialCode: 'LABOR-H', materialId: null, unitPrice: '120.0000', uomCode: 'H' },
      { materialCode: 'ELEC-KWH', materialId: null, unitPrice: '0.6500', uomCode: 'KWH' },
    ],
  },
]

const costReconItems: CostReconItemView[] = [
  { id: 'rec-001', reconKey: 'run-001|material|CU-95', runId: 'run-001', kind: 'material', localQuantity: '18600.0000', erpQuantity: '18520.0000', diffQuantity: '80.0000', uomCode: 'KG', materialCode: 'CU-95', orderNo: 'MO-2026-1027-001', erpDocumentRef: 'ERP-MV-202610-0451', dispositionStatus: 'open', disposedBy: null, disposedAt: null, dispositionReason: null, plantId: 'n-plant' },
  { id: 'rec-002', reconKey: 'run-001|labor', runId: 'run-001', kind: 'labor', localQuantity: '128.5000', erpQuantity: '130.0000', diffQuantity: '-1.5000', uomCode: 'H', materialCode: null, orderNo: 'MO-2026-1027-001', erpDocumentRef: 'ERP-LB-202610-0033', dispositionStatus: 'open', disposedBy: null, disposedAt: null, dispositionReason: null, plantId: 'n-plant' },
  { id: 'rec-003', reconKey: 'run-002|energy', runId: 'run-002', kind: 'energy', localQuantity: '9600.0000', erpQuantity: '9600.0000', diffQuantity: '0.0000', uomCode: 'KWH', materialCode: null, orderNo: 'MO-2026-1027-002', erpDocumentRef: 'ERP-EN-202610-0012', dispositionStatus: 'confirmed', disposedBy: 'fin-王会计', disposedAt: '2026-10-28T09:00:00+08:00', dispositionReason: '双侧一致，确认关闭', plantId: 'n-plant' },
]

const costLaborChecks: CostLaborCheckView[] = [
  { id: 'lc-001', orderId: 'po-1027-001', operationKey: '拉丝', orderOperationId: 'opo-001-2', shiftDate: '2026-10-27', laborHours: '128.5000', otRuntimeHours: '141.2000', deviationRatio: '0.0988', thresholdRatio: '0.1000', status: 'open', missingSide: null, acknowledgedBy: null, acknowledgedAt: null, reason: null, plantId: 'n-plant' },
  { id: 'lc-002', orderId: 'po-1027-002', operationKey: '挤塑', orderOperationId: 'opo-002-4', shiftDate: '2026-10-27', laborHours: '76.0000', otRuntimeHours: null, deviationRatio: null, thresholdRatio: '0.1000', status: 'open', missingSide: 'ot', acknowledgedBy: null, acknowledgedAt: null, reason: null, plantId: 'n-plant' },
]

/** OEE 演示（按 equipmentCode；窗口回显查询值；CE-10 缺项不出假百分比）。 */
const costOeeByEquipment: Record<string, Omit<CostOeeResponse, 'windowStart' | 'windowEnd'>> = {
  'EQU-0001': {
    equipmentId: 'eq-0001', equipmentCode: 'EQU-0001',
    plannedMinutes: '1440.0000', downtimeMinutes: '115.2000',
    standardSpeedPerHour: '11520.0000', stdRateText: '11520',
    actualOutputQty: '1484.0000', qualifiedQty: '1462.0000',
    availability: '0.9200', performance: '0.8800', qualityRate: '0.9850', oee: '0.7974', missing: [],
  },
  'EQU-0002': {
    equipmentId: 'eq-0002', equipmentCode: 'EQU-0002',
    plannedMinutes: '1440.0000', downtimeMinutes: '201.6000',
    standardSpeedPerHour: '9600.0000', stdRateText: '9600',
    actualOutputQty: '1069.0000', qualifiedQty: '1059.0000',
    availability: '0.8600', performance: '0.8100', qualityRate: '0.9910', oee: '0.6900', missing: [],
  },
  'EQU-0007': {
    equipmentId: 'eq-0007', equipmentCode: 'EQU-0007',
    plannedMinutes: '1440.0000', downtimeMinutes: null,
    standardSpeedPerHour: null, stdRateText: '约200米/分',
    actualOutputQty: null, qualifiedQty: null,
    availability: null, performance: null, qualityRate: null, oee: null,
    missing: ['标准速率未数值化（std_rate_text="约200米/分"，GAP-S1）：性能分母缺项', '采集未接入：停机分钟与产出量缺项——可用率/质量率不计算（CE-10）'],
  },
}

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------

interface RouteRule {
  method: 'GET' | 'POST'
  /** 形如 ot/samples 或 ot/gateways/:code/events（不含前导斜杠；query 已剥离） */
  pattern: string
  handler: (ctx: MockP3Context, params: Record<string, string>, query: URLSearchParams) => unknown | Promise<unknown>
}

function queryPage(query: URLSearchParams): { page: number; pageSize: number } {
  const page = Number(query.get('page') ?? '1')
  const pageSize = Number(query.get('pageSize') ?? '20')
  return { page: Number.isInteger(page) && page >= 1 ? page : 1, pageSize: Number.isInteger(pageSize) && pageSize >= 1 ? Math.min(pageSize, 100) : 20 }
}

function otMonitorOverview(): OtMonitorOverview {
  return {
    gateways: otGateways.map((g) => ({
      gatewayCode: g.gatewayCode, plantId: g.plantId, status: g.status, statusLabel: g.statusLabel,
      lastHeartbeatAt: g.lastHeartbeatAt,
      staleSeconds: g.status === 'offline' ? 2940 : 0,
      backlogCount: g.lastBacklogCount,
    })),
    deviceLatency: otDevices.map((d) => ({
      deviceSerial: d.deviceSerial, equipmentCode: d.equipmentCode, lastSampleAt: d.lastSampleAt,
      latencySeconds: d.lastSampleAgeSeconds, noData: d.lastSampleAt === null,
    })),
    dedup: otStats.map((s) => ({ statDate: s.statDate, gatewayCode: s.gatewayCode, deviceSerial: s.deviceSerial, dedupCount: s.dedupCount, dedupAnomaly: s.dedupCount > 100 })),
    overflow: otStats.filter((s) => s.overflowCount > 0).map((s) => ({ statDate: s.statDate, gatewayCode: s.gatewayCode, deviceSerial: s.deviceSerial, overflowCount: s.overflowCount })),
  }
}

function spcChartOf(controlItemId: string): SpcControlChartResponse {
  const item = spcControlItems.find((c) => c.id === controlItemId)
  if (item === undefined) rejectNotFound('受控项目不存在或不在授权数据范围内')
  const samples = spcSamples.filter((s) => s.controlItemId === controlItemId && s.admission === 'admitted')
  return {
    controlItem: item!,
    ruleSet: {
      ruleSetId: 'rs-default', name: '默认规则集（单点越限＋连续 6 点同侧）', version: 1,
      chartType: 'i_mr', criteria: ['point_beyond_limits', 'run_same_side_6'], isDefault: true,
    },
    limitVersions: [
      { id: 'cl-001', controlItemId, version: 1, method: 'mean_pm_3sigma' as const, baselineGroupCount: 25, cl: null, ucl: null, lcl: null, status: 'building' as const, triggerKind: 'initial' as const, triggerRef: null, ruleSetId: 'rs-default', createdAt: '2026-10-01T08:00:00+08:00', createdBy: null },
      { id: 'cl-002', controlItemId, version: 2, method: 'mean_pm_3sigma' as const, baselineGroupCount: 25, cl: '0.5270', ucl: '0.5334', lcl: '0.5206', status: 'active' as const, triggerKind: 'initial' as const, triggerRef: null, ruleSetId: 'rs-default', createdAt: '2026-10-10T08:00:00+08:00', createdBy: null },
    ],
    samples: samples.map((s) => ({ ...s })),
  }
}

/** PE-12：失控样本自动生成处置任务（mock 与真实服务端同口径）。 */
function raiseOocIfNeeded(sample: SpcSampleView): void {
  const judgement = sample.judgement
  if (judgement === null || judgement.verdict !== 'out_of_control') return
  if (spcOocTasks.some((t) => t.sampleId === sample.id)) return
  spcOocTasks.unshift({
    id: `ooc-${sample.id}`, taskNo: `OOC-2026-1028-${String(spcOocTasks.length + 1).padStart(3, '0')}`,
    status: 'open', controlItemId: sample.controlItemId, sampleId: sample.id,
    notifyRoles: ['quality', 'process_engineer', 'shift_leader'], causeCategory: null, correctiveAction: null,
    isolationSuggestion: null, qualityDoubtHint: true, raisedAt: NOW, raisedBy: 'system',
    disposedBy: null, disposedAt: null, recontrolConfirmedBy: null, recontrolConfirmedAt: null,
    commandReceiptId: null, plantId: 'n-plant', enterpriseId: 'n-ent', businessTime: NOW, createdAt: NOW, createdBy: null,
  })
}

const ROUTES: RouteRule[] = [
  // ---------------- ot 查询 ----------------
  {
    method: 'GET', pattern: 'ot/gateways',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const status = query.get('status')
      const items = otGateways.filter((g) => status === null || g.status === status)
      return pageOf(items, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'ot/gateways/:code/events',
    handler: (_ctx, params) => {
      const code = params['code'] ?? ''
      if (!otGateways.some((g) => g.gatewayCode === code)) return []
      return otGatewayEvents.filter((e) => e['gatewayCode'] === code)
    },
  },
  {
    method: 'GET', pattern: 'ot/devices',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const gatewayCode = query.get('gatewayCode')
      const items = otDevices.filter((d) => gatewayCode === null || d.gatewayCode === gatewayCode)
      return pageOf(items, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'ot/points',
    handler: (_ctx, _params, query) => {
      const deviceSerial = query.get('deviceSerial')
      if (deviceSerial === null || deviceSerial === '') {
        rejectRule('[OT-25] 点位查询必须按设备收敛（deviceSerial 必填）', 422)
      }
      return otPoints.filter((p) => p.deviceSerial === deviceSerial)
    },
  },
  {
    method: 'GET', pattern: 'ot/samples',
    handler: (_ctx, _params, query) => {
      const deviceSerial = query.get('deviceSerial')
      if (deviceSerial === null || deviceSerial === '') {
        rejectRule('[OT-25] 样本明细查询必须按设备收敛（deviceSerial 必填）——页面不扫高频原始点位', 422)
      }
      const { page, pageSize } = queryPage(query)
      const pointCode = query.get('pointCode')
      const qualityLevel = query.get('qualityLevel')
      const isBad = query.get('isBad')
      const isClockSkew = query.get('isClockSkew')
      const isLate = query.get('isLate')
      const isQuarantined = query.get('isQuarantined')
      const items = otSamples.filter((s) => {
        if (s.deviceSerial !== deviceSerial) return false
        if (pointCode !== null && s.pointCode !== pointCode) return false
        if (qualityLevel !== null && s.qualityLevel !== qualityLevel) return false
        if (isBad === 'true' && !s.isBad) return false
        if (isClockSkew === 'true' && !s.isClockSkew) return false
        if (isLate === 'true' && !s.isLate) return false
        if (isQuarantined === 'true' && !s.isQuarantined) return false
        return true
      })
      return pageOf(items, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'ot/aggregates',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const deviceSerial = query.get('deviceSerial')
      const granularity = query.get('granularity')
      const items = otAggregates.filter((a) => {
        if (deviceSerial !== null && a.deviceSerial !== deviceSerial) return false
        if (granularity !== null && a.granularity !== granularity) return false
        return true
      })
      return pageOf(items, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'ot/mappings',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      return pageOf(otMappings, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'ot/facts',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const status = query.get('status')
      const mappingId = query.get('mappingId')
      const items = otFacts.filter((f) => {
        if (status !== null && f.status !== status) return false
        if (mappingId !== null && f.mappingId !== mappingId) return false
        return true
      })
      return pageOf(items, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'ot/stats',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const gatewayCode = query.get('gatewayCode')
      const items = otStats.filter((s) => gatewayCode === null || s.gatewayCode === gatewayCode)
      return pageOf(items, page, pageSize)
    },
  },
  { method: 'GET', pattern: 'ot/monitor', handler: () => otMonitorOverview() },

  // ---------------- ot 命令 ----------------
  {
    method: 'POST', pattern: 'ot/device/bind',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const device = otDevices.find((d) => d.deviceSerial === str(body['deviceSerial']))
      if (device === undefined) rejectNotFound('采集设备不存在或不在授权数据范围内')
      device.equipmentId = (body['equipmentId'] as string | null) ?? null
      device.equipmentCode = device.equipmentId === null ? null : `EQU-${device.equipmentId.slice(-4)}`
      device.boundBy = 'admin'
      device.boundAt = NOW
      device.quarantinedSampleCount = 0
      return ok({ deviceSerial: device.deviceSerial, equipmentId: device.equipmentId })
    },
  },
  {
    method: 'POST', pattern: 'ot/session/link',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const sample = otSamples.find((s) => s.sampleId === str(body['sampleId']))
      if (sample === undefined) rejectNotFound('样本不存在或不在授权数据范围内')
      const sessionId = (body['sessionId'] as string | null) ?? null
      sample.sessionId = sessionId
      sample.sessionLinkStatus = sessionId === null ? 'unlinked' : 'manual_bound'
      sample.sessionLinkStatusLabel = sessionId === null ? '未关联' : '人工绑定'
      return ok({ sampleId: sample.sampleId, sessionLinkStatus: sample.sessionLinkStatus })
    },
  },
  {
    method: 'POST', pattern: 'ot/gateway/monitor',
    handler: () => {
      // OT-29 巡检：离线网关补一条留痕事件（恢复入口在网关心跳）
      otGatewayEvents.unshift({
        eventId: `ge-${String(otGatewayEvents.length + 1).padStart(3, '0')}`,
        gatewayCode: 'GW-EXTR-02', eventKind: 'offline', eventKindLabel: '网关离线',
        detail: { patrol: true, backlogCount: 1280, alarm: 'edge_offline' }, occurredAt: NOW, createdBy: 'admin',
      })
      return ok({ checked: otGateways.length, offline: otGateways.filter((g) => g.status === 'offline').length })
    },
  },
  {
    method: 'POST', pattern: 'ot/mapping/evaluate',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const mapping = otMappings.find((m) => m.mappingId === str(body['mappingId']))
      if (mapping === undefined) rejectNotFound('映射配置不存在或不在授权数据范围内')
      const factId = `fact-${String(otFacts.length + 1).padStart(3, '0')}`
      const fact: OtFactView = {
        factId, mappingId: mapping.mappingId, mappingVersion: mapping.version,
        factKind: mapping.factKind, factKindLabel: mapping.factKindLabel,
        deviceSerial: mapping.deviceSerial, pointCode: mapping.pointCode,
        windowStart: str(body['from'], '2026-10-28T08:00:00+08:00'),
        windowEnd: str(body['to'], NOW),
        value: mapping.factKind === 'meter_to_quantity' ? '1.8600' : '240',
        payload: { generatedBy: 'mock-evaluate' },
        status: 'pending_confirm', statusLabel: '待确认',
        confirmedBy: null, confirmedAt: null, outboxEventId: null,
      }
      otFacts.unshift(fact)
      return ok({ factId, status: fact.status })
    },
  },
  {
    method: 'POST', pattern: 'ot/mapping/confirm',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const fact = otFacts.find((f) => f.factId === str(body['factId']))
      if (fact === undefined) rejectNotFound('业务事实候选不存在或不在授权数据范围内')
      if (fact.status === 'dispatched') {
        rejectRule('[OT-26] 该事实候选已确认派发（outbox 已入列），请勿重复确认')
      }
      fact.status = 'dispatched'
      fact.statusLabel = '已派发'
      fact.confirmedBy = 'admin'
      fact.confirmedAt = NOW
      fact.outboxEventId = `oevt-${Date.now().toString(36)}`
      return ok({ factId: fact.factId, status: fact.status, outboxEventId: fact.outboxEventId })
    },
  },
  {
    method: 'POST', pattern: 'ot/aggregate/rebuild',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      return ok({ granularity: str(body['granularity'], 'shift'), rebuilt: otAggregates.length, note: '从原始层重建（OT-S4）：不触发外部调用与二次扣账' })
    },
  },

  // ---------------- spc 查询 ----------------
  {
    method: 'GET', pattern: 'spc/changes',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const items = spcChanges.map((c) => ({
        ...stripChange(c),
        impactSummary: {
          unexecuted: c.impacts.filter((i) => i.category === 'unexecuted').length,
          inProcess: c.impacts.filter((i) => i.category === 'in_process').length,
          completed: c.impacts.filter((i) => i.category === 'completed').length,
        },
      }))
      return pageOf(items, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'spc/changes/:id',
    handler: (_ctx, params) => {
      const change = spcChanges.find((c) => c.id === params['id'])
      if (change === undefined) rejectNotFound('变更单不存在或不在授权数据范围内')
      return {
        change: stripChange(change!),
        oldSpecLabel: change!.oldSpecLabel,
        newSpecLabel: change!.newSpecLabel,
        impactGroups: {
          unexecuted: change!.impacts.filter((i) => i.category === 'unexecuted'),
          inProcess: change!.impacts.filter((i) => i.category === 'in_process'),
          completed: change!.impacts.filter((i) => i.category === 'completed'),
        },
        adjustments: change!.adjustments,
      }
    },
  },
  {
    method: 'GET', pattern: 'spc/rule-sets',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      return pageOf([
        { id: 'rs-default', name: '默认规则集（单点越限＋连续 6 点同侧）', version: 1, chartType: 'i_mr', criteria: ['point_beyond_limits', 'run_same_side_6'], status: 'published', isDefault: true, publishedAt: '2026-10-01T08:00:00+08:00', publishedBy: 'admin', plantId: 'n-plant', enterpriseId: 'n-ent', createdAt: '2026-10-01T08:00:00+08:00', createdBy: 'admin', updatedAt: NOW, updatedBy: null },
        { id: 'rs-002', name: '绞合外径判异（草稿）', version: 1, chartType: 'xbar_r', criteria: ['point_beyond_limits'], status: 'draft', isDefault: false, publishedAt: null, publishedBy: null, plantId: 'n-plant', enterpriseId: 'n-ent', createdAt: NOW, createdBy: 'admin', updatedAt: NOW, updatedBy: null },
      ], page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'spc/control-items',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      return pageOf(spcControlItems, page, pageSize)
    },
  },
  { method: 'GET', pattern: 'spc/control-items/:id/chart', handler: (_ctx, params) => spcChartOf(params['id'] ?? '') },
  {
    method: 'GET', pattern: 'spc/ooc-tasks',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const statuses = query.get('statuses')
      const items = spcOocTasks.filter((t) => statuses === null || statuses.split(',').includes(t.status))
      return pageOf(items, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'spc/ooc-tasks/:id',
    handler: (_ctx, params) => {
      const task = spcOocTasks.find((t) => t.id === params['id'])
      if (task === undefined) rejectNotFound('失控处置任务不存在或不在授权数据范围内')
      const sample = spcSamples.find((s) => s.id === task!.sampleId) ?? null
      return { task: task!, sample, judgement: sample?.judgement ?? null }
    },
  },
  {
    method: 'GET', pattern: 'spc/gauges/:id',
    handler: (_ctx, params) => {
      const gauge = spcGauges.find((g) => g.id === params['id'] || g.gaugeNo === params['id'])
      if (gauge === undefined) rejectNotFound('计量器具不存在或不在授权数据范围内')
      const status = gaugeStatusOf(gauge!)
      return {
        gauge: { id: gauge!.id, gaugeNo: gauge!.gaugeNo, name: gauge!.name, gaugeKind: gauge!.gaugeKind, plantId: gauge!.plantId },
        calibrationStatus: status,
        schedulableForInspection: status === 'valid' || status === 'limited',
        calibrationHistory: [...gauge!.history].reverse(),
      }
    },
  },
  {
    method: 'GET', pattern: 'spc/miscalibration/circle',
    handler: (_ctx, _params, query) => {
      const gaugeId = query.get('gaugeId') ?? ''
      if (query.get('gaugeId') === null || query.get('from') === null || query.get('to') === null) {
        rejectRule('缺少 gaugeId/from/to 查询参数', 422)
      }
      const gauge = spcGauges.find((g) => g.id === gaugeId || g.gaugeNo === gaugeId)
      if (gauge === undefined) rejectNotFound('计量器具不存在或不在授权数据范围内')
      const actions = spcMiscalActions.filter((a) => a['gaugeId'] === gauge!.id)
      const totalItems = 3 + 2 + 1 + 2 + 1 + 2 + 1
      const actedRefs = new Set(actions.map((a) => String(a['itemRef'])))
      return {
        gauge: { id: gauge!.id, gaugeNo: gauge!.gaugeNo, name: gauge!.name },
        circle: {
          measurements: [
            { sampleId: 'ss-1001', source: 'manual_inspection', sampledAt: '2026-09-12T09:00:00+08:00', measuredValue: '12.4180', admission: 'admitted', testResultId: 'tr-0901', productionOrderNo: 'MO-2026-0910-003', operationSeq: 4, inventoryUnitId: null, unitNo: 'U-2026-0912-0001', lotNo: 'LOT-0901' },
            { sampleId: 'ss-1002', source: 'manual_inspection', sampledAt: '2026-09-25T14:30:00+08:00', measuredValue: '12.4020', admission: 'admitted', testResultId: 'tr-0902', productionOrderNo: 'MO-2026-0925-001', operationSeq: 4, inventoryUnitId: null, unitNo: 'U-2026-0925-0002', lotNo: 'LOT-0904' },
            { sampleId: 'ss-1003', source: 'collection', sampledAt: '2026-10-08T10:00:00+08:00', measuredValue: '12.4405', admission: 'rejected', testResultId: null, productionOrderNo: null, operationSeq: null, inventoryUnitId: null, unitNo: null, lotNo: null },
          ],
          inspectionConclusions: [
            { testResultId: 'tr-0901', conclusion: 'qualified', inspectedAt: '2026-09-12T10:00:00+08:00', inspector: 'qc-陈工', inspectionOrderNo: 'QI-2026-0912-002', inspectionOrderStatus: 'concluded', productionOrderNo: 'MO-2026-0910-003', productionOrderStatus: 'closed', inventoryUnitId: 'unit-0912-0001', unitNo: 'U-2026-0912-0001', lotNo: 'LOT-0901', lotId: 'lot-0901', materialCode: 'CZ-YJV-3X95', releasedBy: 'qc-陈工', releasedAt: '2026-09-12T11:00:00+08:00', releaseKind: 'release' },
            { testResultId: 'tr-0902', conclusion: 'qualified', inspectedAt: '2026-09-25T15:00:00+08:00', inspector: 'qc-陈工', inspectionOrderNo: 'QI-2026-0925-001', inspectionOrderStatus: 'concluded', productionOrderNo: 'MO-2026-0925-001', productionOrderStatus: 'in_progress', inventoryUnitId: 'unit-0925-0002', unitNo: 'U-2026-0925-0002', lotNo: 'LOT-0904', lotId: 'lot-0904', materialCode: 'CZ-YJV-3X95', releasedBy: null, releasedAt: null, releaseKind: null },
          ],
          releases: [{ testResultId: 'tr-0901', releasedBy: 'qc-陈工', releasedAt: '2026-09-12T11:00:00+08:00', releaseKind: 'release' }],
          lots: [
            { lotNo: 'LOT-0901', unitNo: 'U-2026-0912-0001', materialCode: 'CZ-YJV-3X95' },
            { lotNo: 'LOT-0904', unitNo: 'U-2026-0925-0002', materialCode: 'CZ-YJV-3X95' },
          ],
          wipOrders: ['MO-2026-0925-001'],
          stockUnits: [
            { inventoryUnitId: 'unit-0925-0002', unitNo: 'U-2026-0925-0002', status: 'in_stock', lotNo: 'LOT-0904', materialCode: 'CZ-YJV-3X95', productionOrderNo: 'MO-2026-0925-001', productionOrderStatus: 'in_progress' },
            { inventoryUnitId: 'unit-0912-0001', unitNo: 'U-2026-0912-0001', status: 'in_stock', lotNo: 'LOT-0901', materialCode: 'CZ-YJV-3X95', productionOrderNo: 'MO-2026-0910-003', productionOrderStatus: 'closed' },
          ],
          shippedUnits: [{ inventoryUnitId: 'unit-0910-0005', unitNo: 'U-2026-0910-0005', status: 'shipped', lotNo: 'LOT-0901', materialCode: 'CZ-YJV-3X95', productionOrderNo: 'MO-2026-0910-003', productionOrderStatus: 'closed' }],
          customerComplaintHints: [{ unitNo: 'U-2026-0910-0005', productionOrderNo: 'MO-2026-0910-003' }],
        },
        actions,
        dispositionProgress: { acted: actedRefs.size, pending: Math.max(0, totalItems - actedRefs.size) },
      }
    },
  },
  {
    method: 'GET', pattern: 'spc/tools',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      return pageOf(spcTools, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'spc/tools/:id',
    handler: (_ctx, params) => {
      const detail = spcToolDetails[params['id'] ?? '']
      if (detail === undefined) rejectNotFound('工具台账不存在或不在授权数据范围内')
      return detail
    },
  },

  // ---------------- spc 命令 ----------------
  {
    method: 'POST', pattern: 'spc/change/create',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      if (!str(body['oldSpecRevisionId']) || !str(body['newSpecRevisionId'])) {
        rejectRule('[PE-05] 变更单必须含版本对（旧→新）、审批人与生效时间')
      }
      const id = `chg-${String(spcChanges.length + 1).padStart(3, '0')}`
      spcChanges.push({
        id, changeNo: str(body['changeNo']) || `CHG-2026-1029-${String(spcChanges.length + 1).padStart(3, '0')}`,
        status: 'draft', plantId: str(body['plantId'], 'n-plant'),
        oldSpecRevisionId: str(body['oldSpecRevisionId']), newSpecRevisionId: str(body['newSpecRevisionId']),
        approver: str(body['approver'], 'admin'), effectiveAt: str(body['effectiveAt'], NOW),
        publishedAt: null, publishedBy: null,
        oldSpecLabel: `规范 ${str(body['oldSpecRevisionId'])} v3（published）`,
        newSpecLabel: `规范 ${str(body['newSpecRevisionId'])} v4（published）`,
        impacts: [], adjustments: [],
      })
      return ok({ changeId: id, changeNo: spcChanges[spcChanges.length - 1]!.changeNo, status: 'draft' })
    },
  },
  {
    method: 'POST', pattern: 'spc/change/scan',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const change = spcChanges.find((c) => c.id === str(body['changeId']))
      if (change === undefined) rejectNotFound('变更单不存在或不在授权数据范围内')
      return ok({ changeId: change!.id, impacts: change!.impacts.length })
    },
  },
  {
    method: 'POST', pattern: 'spc/change/disposition',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const change = spcChanges.find((c) => c.id === str(body['changeId']))
      if (change === undefined) rejectNotFound('变更单不存在或不在授权数据范围内')
      const impact = change!.impacts.find((i) => i.id === str(body['impactId']))
      if (impact === undefined) rejectNotFound('影响任务不存在或不在授权数据范围内')
      if (impact!.category !== 'in_process') {
        rejectRule('[PE-04] 仅「已开工未完成」的在制任务需要逐单处置；未执行任务随变更自动重算，已完成不可变更')
      }
      const disposition = str(body['disposition']) as SpcChangeImpactView['disposition']
      impact!.disposition = disposition
      impact!.followsVersion = disposition === 'switch_new' ? 'new' : 'old'
      impact!.dispositionBy = 'admin'
      impact!.dispositionAt = NOW
      if (disposition === 'switch_new') {
        change!.adjustments.push({
          id: `adj-${change!.adjustments.length + 1}`, changeId: change!.id,
          orderOperationId: impact!.orderOperationId, orderNo: impact!.orderNo, operationSeq: impact!.operationSeq,
          oldPlannedQty: impact!.plannedQty, newPlannedQty: impact!.recomputedPlannedQty ?? impact!.plannedQty,
          basis: { kind: 'switch_new', factor: 1.05 }, createdAt: NOW, createdBy: 'admin',
        })
      }
      return ok({ impactId: impact!.id, disposition: impact!.disposition, followsVersion: impact!.followsVersion })
    },
  },
  {
    method: 'POST', pattern: 'spc/change/publish',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const change = spcChanges.find((c) => c.id === str(body['changeId']))
      if (change === undefined) rejectNotFound('变更单不存在或不在授权数据范围内')
      if (change!.status === 'published') {
        rejectRule('[PE-02] 变更单已发布：新版本只影响获准的未执行任务，历史实绩保留旧参数不重算')
      }
      const undisposed = change!.impacts.filter((i) => i.category === 'in_process' && i.disposition === null)
      if (undisposed.length > 0) {
        rejectRule(`[PE-04] 存在 ${undisposed.length} 个未处置的在制任务（${undisposed.map((i) => i.orderNo).join('、')}）：变更发布前须逐单选择处置（继续旧版/转新版/隔离评审），不允许不选择即发布`)
      }
      change!.status = 'published'
      change!.publishedAt = NOW
      change!.publishedBy = 'admin'
      return ok({ changeId: change!.id, status: 'published', publishedAt: change!.publishedAt })
    },
  },
  {
    method: 'POST', pattern: 'spc/sample/record',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const controlItemId = str(body['controlItemId'])
      if (!spcControlItems.some((c) => c.id === controlItemId)) {
        rejectNotFound('受控项目不存在或不在授权数据范围内')
      }
      const measuredValue = str(body['measuredValue'])
      if (measuredValue === '') {
        rejectRule('[PE-11] 样本登记必须携带测量值（十进制字符串）')
      }
      const id = `ss-${String(spcSamples.length + 1).padStart(3, '0')}`
      const sample: SpcSampleView = {
        id, controlItemId, source: (str(body['source'], 'manual_inspection') as SpcSampleView['source']),
        testResultId: (body['testResultId'] as string | undefined) ?? null,
        measuredValue, sampledAt: str(body['sampledAt'], NOW),
        productionOrderId: (body['productionOrderId'] as string | undefined) ?? null,
        orderOperationId: (body['orderOperationId'] as string | undefined) ?? null,
        operationSeq: (body['operationSeq'] as number | undefined) ?? null,
        equipmentId: (body['equipmentId'] as string | undefined) ?? null,
        equipmentCode: (body['equipmentCode'] as string | undefined) ?? null,
        shiftDate: (body['shiftDate'] as string | undefined) ?? null,
        gaugeId: (body['gaugeId'] as string | undefined) ?? null,
        calibrationStatus: 'valid', admission: 'admitted', rejectReason: null, commandReceiptId: null,
        plantId: str(body['plantId'], 'n-plant'), enterpriseId: 'n-ent', businessTime: NOW, createdAt: NOW,
        createdBy: 'admin', judgement: null,
      }
      // PE-11 准入判定：坏点/时钟偏差/校准状态可疑 → 记录保留但拒绝准入
      const badPoint = body['badPoint'] === true
      const clockDeviation = body['clockDeviation'] === true
      const gaugeId = sample.gaugeId
      const gauge = gaugeId === null ? undefined : spcGauges.find((g) => g.id === gaugeId)
      const calibrationSuspect = gauge !== undefined && (gaugeStatusOf(gauge) === 'invalid' || gaugeStatusOf(gauge) === 'expired')
      if (badPoint || clockDeviation || calibrationSuspect) {
        sample.admission = 'rejected'
        sample.rejectReason = badPoint ? 'bad_point' : clockDeviation ? 'clock_deviation' : 'calibration_suspect'
        spcSamples.push(sample)
        const rule = badPoint ? '坏点' : clockDeviation ? '时钟偏差样本' : '校准状态可疑样本（OT-12）'
        return ok({ sampleId: id, admission: 'rejected', rejectReason: sample.rejectReason, note: `[PE-11] ${rule}不得入 SPC：记录保留可查，不入控制图与判定` })
      }
      // 判定：对照当前 active 控制限（PE-10 判定时点版本）
      const chart = spcChartOf(controlItemId)
      const active = [...chart.limitVersions].reverse().find((v) => v.status === 'active') ?? null
      const pointNo = spcSamples.filter((s) => s.controlItemId === controlItemId && s.admission === 'admitted').length + 1
      let verdict: 'in_control' | 'out_of_control' = 'in_control'
      const violated: string[] = []
      if (active !== null && active.ucl !== null && active.lcl !== null) {
        const v = Number(measuredValue)
        if (v > Number(active.ucl) || v < Number(active.lcl)) {
          verdict = 'out_of_control'
          violated.push('point_beyond_limits')
        }
      }
      sample.judgement = {
        id: `jd-${String(spcSamples.length + 1).padStart(3, '0')}`, sampleId: id, controlItemId, pointNo,
        verdict, violatedCodes: violated, ruleSetId: 'rs-default', ruleSetVersion: 1,
        controlLimitId: active?.id ?? null, controlLimitVersion: active?.version ?? null,
        judgedAt: NOW, enterpriseId: 'n-ent', createdAt: NOW, createdBy: null,
      }
      spcSamples.push(sample)
      raiseOocIfNeeded(sample)
      return ok({ sampleId: id, admission: 'admitted', pointNo, verdict, violatedCodes: violated, controlLimitVersion: active?.version ?? null })
    },
  },
  {
    method: 'POST', pattern: 'spc/ooc/dispose',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const task = spcOocTasks.find((t) => t.id === str(body['oocTaskId']))
      if (task === undefined) rejectNotFound('失控处置任务不存在或不在授权数据范围内')
      if (task!.status !== 'open') {
        rejectRule('[PE-12] 该失控处置任务已处置：失控未处置不得静默关闭，处置链可查（复控确认后闭环）')
      }
      if (!str(body['causeCategory']) || !str(body['correctiveAction'])) {
        rejectRule('[PE-12] 处置记录必须包含原因分类与纠正措施')
      }
      task!.status = 'disposed'
      task!.causeCategory = str(body['causeCategory'])
      task!.correctiveAction = str(body['correctiveAction'])
      task!.isolationSuggestion = (body['isolationSuggestion'] as string | undefined) ?? null
      task!.disposedBy = 'admin'
      task!.disposedAt = NOW
      return ok({ oocTaskId: task!.id, status: task!.status })
    },
  },
  {
    method: 'POST', pattern: 'spc/ooc/confirm-recontrol',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const task = spcOocTasks.find((t) => t.id === str(body['oocTaskId']))
      if (task === undefined) rejectNotFound('失控处置任务不存在或不在授权数据范围内')
      if (task!.status === 'open') {
        rejectRule('[PE-12] 失控未处置不得复控确认：请先完成处置记录（原因分类/纠正措施/隔离建议）')
      }
      if (task!.status === 're_control_confirmed') {
        rejectRule('[PE-12] 该任务已确认复控，处置链已闭环')
      }
      task!.status = 're_control_confirmed'
      task!.recontrolConfirmedBy = 'admin'
      task!.recontrolConfirmedAt = NOW
      return ok({ oocTaskId: task!.id, status: task!.status })
    },
  },
  {
    method: 'POST', pattern: 'spc/calibration/record',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const gauge = spcGauges.find((g) => g.id === str(body['gaugeId']))
      if (gauge === undefined) rejectNotFound('计量器具不存在或不在授权数据范围内')
      const record: SpcCalibrationRecordView = {
        id: `cal-${gauge!.history.length + 1 + 100}`, gaugeId: gauge!.id,
        calibratedAt: str(body['calibratedAt'], NOW),
        result: str(body['result'], 'qualified') as SpcCalibrationRecordView['result'],
        certificateNo: str(body['certificateNo']), validUntil: str(body['validUntil']),
        basis: str(body['basis']), recordedBy: 'admin', commandReceiptId: null,
        plantId: gauge!.plantId, enterpriseId: 'n-ent', businessTime: NOW, createdAt: NOW, createdBy: 'admin',
      }
      gauge!.history.push(record) // PE-15：追加式，不改写旧记录
      return ok({ calibrationId: record.id, calibrationStatus: gaugeStatusOf(gauge!), historyCount: gauge!.history.length })
    },
  },
  {
    method: 'POST', pattern: 'spc/miscalibration/action',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const gauge = spcGauges.find((g) => g.id === str(body['gaugeId']))
      if (gauge === undefined) rejectNotFound('计量器具不存在或不在授权数据范围内')
      if (!str(body['itemRef'])) {
        rejectRule('[PE-18] 失准处置必须逐项登记圈定项（itemKind＋itemRef）')
      }
      const action = {
        id: `misa-${spcMiscalActions.length + 1}`, gaugeId: gauge!.id,
        windowFrom: str(body['windowFrom']), windowTo: str(body['windowTo']),
        itemKind: str(body['itemKind']), itemRef: str(body['itemRef']),
        itemLabel: (body['itemLabel'] as string | undefined) ?? null,
        actionKind: str(body['actionKind']), externalRef: (body['externalRef'] as string | undefined) ?? null,
        customerComplaintHint: str(body['itemKind']) === 'shipped_unit',
        actedBy: 'admin', actedAt: NOW, commandReceiptId: null,
        plantId: gauge!.plantId, enterpriseId: 'n-ent', createdAt: NOW, createdBy: 'admin',
      }
      spcMiscalActions.push(action)
      return ok({ actionId: action.id, customerComplaintHint: action.customerComplaintHint })
    },
  },
  {
    method: 'POST', pattern: 'spc/tool/consume',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const tool = spcTools.find((t) => t.id === str(body['toolId']))
      if (tool === undefined) rejectNotFound('工具台账不存在或不在授权数据范围内')
      const quantity = Number(str(body['quantity'], '0'))
      if (!Number.isFinite(quantity) || quantity <= 0) {
        rejectRule('[PE-20] 寿命消耗数量必须为正数十进制字符串')
      }
      tool.accumulatedLife = (Number(tool.accumulatedLife) + quantity).toFixed(4)
      recomputeToolStatus(tool)
      const detail = spcToolDetails[tool.id]
      if (detail !== undefined) {
        detail.tool = { ...tool }
        detail.usage.unshift({
          id: `tu-${detail.usage.length + 1}`, toolId: tool.id,
          source: (str(body['source'], 'work_report_output') as 'work_report_output' | 'collected_sample'),
          quantity: quantity.toFixed(4), refType: str(body['refType'], 'work_report'), refId: str(body['refId']),
          commandReceiptId: null, plantId: tool.plantId, enterpriseId: tool.enterpriseId,
          businessTime: NOW, createdAt: NOW, createdBy: 'admin',
        })
        detail.status = tool.status
        detail.effectiveLife = tool.effectiveLife
        detail.schedulableForScheduling = tool.schedulableForScheduling
      }
      return ok({ toolId: tool.id, accumulatedLife: tool.accumulatedLife, status: tool.status })
    },
  },
  {
    method: 'POST', pattern: 'spc/tool/adjust',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const tool = spcTools.find((t) => t.id === str(body['toolId']))
      if (tool === undefined) rejectNotFound('工具台账不存在或不在授权数据范围内')
      const reason = str(body['reason'])
      if (!reason) {
        rejectRule('[PE-21] 寿命修正必须走具名调整：理由必填并留审计，不得静默重置')
      }
      const delta = Number(str(body['delta'], '0'))
      if (!Number.isFinite(delta) || delta === 0) {
        rejectRule('[PE-21] 调整增量必须为非零十进制字符串（负值=扣减）')
      }
      tool.adjustmentSum = (Number(tool.adjustmentSum) + delta).toFixed(4)
      recomputeToolStatus(tool)
      const detail = spcToolDetails[tool.id]
      if (detail !== undefined) {
        detail.tool = { ...tool }
        detail.adjustmentSum = tool.adjustmentSum
        detail.effectiveLife = tool.effectiveLife
        detail.status = tool.status
        detail.adjustments.unshift({
          id: `tad-${detail.adjustments.length + 1}`, toolId: tool.id, delta: delta.toFixed(4),
          reason, commandReceiptId: null, enterpriseId: tool.enterpriseId, createdAt: NOW, createdBy: 'admin',
        })
      }
      return ok({ toolId: tool.id, adjustmentSum: tool.adjustmentSum, effectiveLife: tool.effectiveLife, status: tool.status })
    },
  },

  // ---------------- csw 外协查询 ----------------
  {
    method: 'GET', pattern: 'csw/outsourcing-tasks',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const status = query.get('status')
      const taskNoLike = query.get('taskNoLike')
      const items = cswTasks.filter((t) => {
        if (status !== null && t.status !== status) return false
        if (taskNoLike !== null && !t.taskNo.includes(taskNoLike)) return false
        return true
      })
      return pageOf(items, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'csw/outsourcing-tasks/:id',
    handler: (_ctx, params) => {
      const task = requireCswTask(params['id'] ?? '')
      return { task: { ...task }, units: cswUnits.filter((u) => u.taskId === task.id) }
    },
  },
  {
    method: 'GET', pattern: 'csw/outsourcing-erp-export',
    handler: () => ({
      facts: cswTasks
        .filter((t) => Number(t.sentQty) > 0)
        .map((t) => ({
          taskNo: t.taskNo, supplierCode: t.supplierCode, supplierName: t.supplierName,
          orderNo: t.orderNo, operationName: t.operationName, sentQty: t.sentQty,
          returnedQty: t.returnedQty, uom: t.uom, sentAt: t.sentAt, receivedAt: t.receivedAt, closedAt: t.closedAt,
        })),
      note: '外协加工数量事实导出（CS-24：商务结算归 ERP，本系统不记应付/加工费/发票；模拟适配器先行，真实接口族无样例 BLOCKED_EXTERNAL）',
    }),
  },

  // ---------------- csw 外协命令（CS-19 状态机） ----------------
  {
    method: 'POST', pattern: 'csw/outsourcing/create',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      if (!str(body['orderOperationId']) || !str(body['supplierName']) || !str(body['qty'])) {
        rejectRule('[CS-19] 外协任务创建须挂接订单工序，携带供应方与数量')
      }
      const id = `owt-${String(cswTasks.length + 1).padStart(3, '0')}`
      const task: CswOutsourcingTaskView = {
        id, taskNo: `OWT-2026-1028-${String(cswTasks.length + 1).padStart(3, '0')}`,
        enterpriseId: 'n-ent', plantId: 'n-plant', orderId: 'po-1027-006',
        orderOperationId: str(body['orderOperationId']), orderNo: 'MO-2026-1027-006', operationName: '绞制',
        supplierCode: (body['supplierCode'] as string | undefined) ?? null, supplierName: str(body['supplierName']),
        qty: str(body['qty']), uom: '盘', transitLocationId: str(body['transitLocationId'], 'loc-owt-01'),
        transitLocationCode: str(body['transitLocationCode'], 'OWT-TRANS-01'),
        returnLocationId: (body['returnLocationId'] as string | undefined) ?? null,
        returnLocationCode: (body['returnLocationCode'] as string | undefined) ?? null,
        status: 'draft', statusLabel: '草稿', inspectionResult: null, occupationActive: false,
        sentQty: '0.0000', returnedQty: '0.0000', sentBy: null, sentAt: null, receivedBy: null, receivedAt: null,
        inspectedBy: null, inspectedAt: null, closedBy: null, closedAt: null,
        recallReason: null, recalledBy: null, recalledAt: null, disposeReason: null, disposedBy: null, disposedAt: null,
        createdBy: 'admin', createdAt: NOW, updatedAt: NOW, updatedBy: null,
      }
      cswTasks.unshift(task)
      return ok({ taskId: id, taskNo: task.taskNo, status: task.status })
    },
  },
  {
    method: 'POST', pattern: 'csw/outsourcing/submit',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const task = requireCswTask(str(body['taskId']))
      requireCswTransition(task, ['draft'], '提交待发送')
      setTaskStatus(task, 'pending_send')
      return ok({ taskId: task.id, status: task.status })
    },
  },
  {
    method: 'POST', pattern: 'csw/outsourcing/send',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const task = requireCswTask(str(body['taskId']))
      requireCswTransition(task, ['pending_send'], '发送')
      const lines = (body['lines'] as Array<{ unitId: string; quantity: string }> | undefined) ?? []
      if (lines.length === 0) {
        rejectRule('[CS-21] 发送须携带单元行（两段原子步：来源减＋外协在途增），不整单凭空出库')
      }
      for (const line of lines) {
        cswUnits.push({
          id: `uow-${cswUnits.length + 1}`, taskId: task.id, unitId: line.unitId, unitNo: line.unitId,
          sendLotId: null, sentQty: line.quantity, returnedQty: '0.0000', returnLotId: null,
          status: 'sent', createdAt: NOW, updatedAt: NOW,
        })
      }
      task.sentQty = lines.reduce((sum, l) => sum + Number(l.quantity), 0).toFixed(4)
      task.sentBy = 'admin'
      task.sentAt = NOW
      setTaskStatus(task, 'sent')
      return ok({ taskId: task.id, status: task.status, sentQty: task.sentQty, note: 'CS-20：材料所有权保留不变，库存状态转入外协在途' })
    },
  },
  {
    method: 'POST', pattern: 'csw/outsourcing/receive',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const task = requireCswTask(str(body['taskId']))
      requireCswTransition(task, ['sent'], '回厂接收')
      const lines = (body['lines'] as Array<{ unitId: string; quantity: string; returnLotNo?: string }> | undefined) ?? []
      if (lines.length === 0) {
        rejectRule('[CS-21] 回厂接收须携带单元行（外协在途减＋回厂目的增）')
      }
      for (const line of lines) {
        const unit = cswUnits.find((u) => u.taskId === task.id && u.unitId === line.unitId)
        if (unit !== undefined) {
          unit.returnedQty = line.quantity
          unit.returnLotId = line.returnLotNo ?? null
          unit.status = 'returned'
          unit.updatedAt = NOW
        } else {
          cswUnits.push({
            id: `uow-${cswUnits.length + 1}`, taskId: task.id, unitId: line.unitId, unitNo: line.unitId,
            sendLotId: null, sentQty: '0.0000', returnedQty: line.quantity, returnLotId: line.returnLotNo ?? null,
            status: 'returned', createdAt: NOW, updatedAt: NOW,
          })
        }
      }
      task.returnedQty = lines.reduce((sum, l) => sum + Number(l.quantity), 0).toFixed(4)
      task.receivedBy = 'admin'
      task.receivedAt = NOW
      task.inspectionResult = 'pending'
      setTaskStatus(task, 'return_received')
      return ok({ taskId: task.id, status: task.status, returnedQty: task.returnedQty, note: 'CS-22：回厂接收后默认全部必检（检验结论与放行走质量合同）' })
    },
  },
  {
    method: 'POST', pattern: 'csw/outsourcing/inspect',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const task = requireCswTask(str(body['taskId']))
      // 与 domain OUTSOURCING_TRANSITIONS 同口径（PC-08）：inspect 仅允许自 return_received
      requireCswTransition(task, ['return_received'], '检验结论')
      const result = str(body['inspectionResult'])
      if (result !== 'passed' && result !== 'rejected') {
        rejectRule('[CS-22] 检验结论只允许 passed/rejected（默认全部必检；结论与放行走质量合同）')
      }
      task.inspectionResult = result
      task.inspectedBy = 'admin'
      task.inspectedAt = NOW
      setTaskStatus(task, 'inspecting')
      return ok({ taskId: task.id, status: task.status, inspectionResult: task.inspectionResult })
    },
  },
  {
    method: 'POST', pattern: 'csw/outsourcing/close',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const task = requireCswTask(str(body['taskId']))
      requireCswTransition(task, ['inspecting'], '关闭')
      if (task.inspectionResult !== 'passed') {
        rejectRule('[CS-22] 检验未通过的任务不能关闭：请走退回处置（return_disposed）')
      }
      task.closedBy = 'admin'
      task.closedAt = NOW
      setTaskStatus(task, 'closed')
      return ok({ taskId: task.id, status: task.status })
    },
  },
  {
    method: 'POST', pattern: 'csw/outsourcing/recall',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const task = requireCswTask(str(body['taskId']))
      requireCswTransition(task, ['sent'], '收回')
      task.recallReason = str(body['reason'], '计划员收回')
      task.recalledBy = 'admin'
      task.recalledAt = NOW
      setTaskStatus(task, 'recalled')
      return ok({ taskId: task.id, status: task.status })
    },
  },
  {
    method: 'POST', pattern: 'csw/outsourcing/dispose',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const task = requireCswTask(str(body['taskId']))
      requireCswTransition(task, ['return_received', 'inspecting'], '退回处置')
      if (task.inspectionResult === 'passed') {
        rejectRule('[CS-19] 检验已通过的任务应走关闭，不适用退回处置')
      }
      task.disposeReason = str(body['reason'], '检验不合格退回')
      task.disposedBy = 'admin'
      task.disposedAt = NOW
      setTaskStatus(task, 'return_disposed')
      return ok({ taskId: task.id, status: task.status })
    },
  },

  // ---------------- cost（形状对齐落盘控制器 apps/api/src/cost/cost.controller.ts） ----------------
  {
    method: 'GET', pattern: 'cost/runs',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const plantId = query.get('plantId')
      const orderId = query.get('orderId')
      const shiftDate = query.get('shiftDate')
      const items = costRuns.filter(
        (r) =>
          (plantId === null || r.plantId === plantId) &&
          (orderId === null || r.orderId === orderId) &&
          (shiftDate === null || r.shiftDate === shiftDate),
      )
      return pageOf(items, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'cost/runs/:id',
    handler: (_ctx, params) => {
      const run = costRuns.find((r) => r.id === (params['id'] ?? ''))
      if (run === undefined) rejectNotFound('归集产出不存在或不在授权数据范围内')
      return {
        run: {
          runId: run!.id, runNo: run!.runNo, orderId: run!.orderId,
          allocationVersionId: run!.allocationVersionId, priceVersionId: run!.priceVersionId,
          shiftDate: run!.shiftDate, shiftCalendarId: run!.shiftCalendarId, dataCutoffAt: run!.dataCutoffAt,
          shiftSnapshotAnchor: run!.shiftSnapshotAnchor, estimateAmount: run!.estimateAmount,
          actualAmount: run!.actualAmount, energyMeteredUsage: run!.energyMeteredUsage,
          energyEstimatedUsage: run!.energyEstimatedUsage, energyCoverageRatio: run!.energyCoverageRatio,
          machineHours: run!.machineHours, laborSource: run!.laborSource,
          equipmentCostCaliber: run!.equipmentCostCaliber, recalcOf: run!.recalcOf,
          oldNewComparison: run!.oldNewComparison,
        },
        lines: costRunLines[run!.id] ?? [],
      }
    },
  },
  {
    method: 'GET', pattern: 'cost/orders/:orderId/summary',
    handler: (_ctx, params) => {
      const summary = costOrderSummaries[params['orderId'] ?? '']
      if (summary === undefined) rejectNotFound('生产订单不存在或不在授权数据范围内')
      return summary
    },
  },
  {
    method: 'GET', pattern: 'cost/energy-intensity',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const shiftDate = query.get('shiftDate')
      const runs = costRuns.filter((r) => shiftDate === null || r.shiftDate === shiftDate)
      const all = runs.map((r) => {
        const summary = Object.values(costOrderSummaries).find((s) => s.orderId === r.orderId)
        const total = Number(r.energyMeteredUsage) + Number(r.energyEstimatedUsage)
        const coverage = total === 0 ? null : (Number(r.energyMeteredUsage) / total).toFixed(4)
        const output = r.id === 'run-003' ? 0 : r.id === 'run-001' ? 1484 : 1185
        return {
          runId: r.id,
          orderNo: summary?.orderNo ?? null,
          productFamilyId: (costRunLines[r.id]?.[0]?.productFamilyId) ?? null,
          shiftDate: r.shiftDate,
          meteredUsage: r.energyMeteredUsage,
          estimatedUsage: r.energyEstimatedUsage,
          coverageRatio: coverage,
          uomCode: r.energyUomCode,
          outputQty: `${output}.0000`,
          intensityPerOutput: total > 0 && output > 0 ? (total / output).toFixed(4) : null,
        }
      })
      const start = (page - 1) * pageSize
      return { items: all.slice(start, start + pageSize), total: all.length }
    },
  },
  {
    method: 'GET', pattern: 'cost/oee',
    handler: (_ctx, _params, query) => {
      const equipmentCode = query.get('equipmentCode')
      const windowStart = query.get('windowStart')
      const windowEnd = query.get('windowEnd')
      if (equipmentCode === null || windowStart === null || windowEnd === null) {
        rejectRule('[CE-10] 缺少 plantId/equipmentCode/windowStart/windowEnd 查询参数', 422)
      }
      const demo = costOeeByEquipment[equipmentCode!]
      if (demo === undefined) rejectNotFound('设备不存在或不在授权数据范围内')
      return { ...demo!, windowStart: windowStart!, windowEnd: windowEnd! }
    },
  },
  {
    method: 'GET', pattern: 'cost/meters',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      return pageOf(costMeters, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'cost/allocation-versions',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const items = costAllocationVersions.map((v) => ({
        ...v,
        referencedByRuns: costRuns.filter((r) => r.allocationVersionId === v.id).length,
      }))
      return pageOf(items, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'cost/price-versions',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      return pageOf(costPriceVersions, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'cost/recon-items',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const runId = query.get('runId')
      const kinds = query.get('kinds')?.split(',') ?? null
      const statuses = query.get('statuses')?.split(',') ?? null
      const items = costReconItems.filter(
        (i) =>
          (runId === null || i.runId === runId) &&
          (kinds === null || kinds.includes(String(i.kind))) &&
          (statuses === null || statuses.includes(String(i.dispositionStatus))),
      )
      return pageOf(items, page, pageSize)
    },
  },
  {
    method: 'GET', pattern: 'cost/labor-checks',
    handler: (_ctx, _params, query) => {
      const { page, pageSize } = queryPage(query)
      const orderId = query.get('orderId')
      const statuses = query.get('statuses')?.split(',') ?? null
      const items = costLaborChecks.filter(
        (c) =>
          (orderId === null || c.orderId === orderId) &&
          (statuses === null || statuses.includes(String(c.status))),
      )
      return pageOf(items, page, pageSize)
    },
  },
  {
    method: 'POST', pattern: 'cost/acquisition/run',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const orderId = str(body['orderId'])
      const shiftDate = str(body['shiftDate'])
      const dataCutoffAt = str(body['dataCutoffAt'])
      const allocationVersionId = str(body['allocationVersionId'])
      const priceVersionId = str(body['priceVersionId'])
      if (!orderId || !shiftDate || !dataCutoffAt || !allocationVersionId || !priceVersionId) {
        rejectRule('[CE-S1] 归集须绑定订单/班次/数据截止时点/分摊版本/价格版本')
      }
      const template = costRunFactTemplates[orderId]
      if (template === undefined) rejectNotFound('生产订单不存在或不在授权数据范围内')
      // CE-11：同 (order, shift) 已有归集 → 首跑拒绝，重算走显式 recalc
      if (costRuns.some((r) => r.orderId === orderId && r.shiftDate === shiftDate)) {
        rejectRule(
          `[CE-11] 订单 ${orderId} 班次 ${shiftDate} 已有归集产出——历史报表不静默重算，重算走显式命令 cost.acquisition.recalc`,
        )
      }
      const lines = template!.lines.map((l) => ({ ...l }))
      const anyPriceMissing = lines.some((l) => l.priceMissing)
      const actualAmount = anyPriceMissing
        ? null
        : lines.reduce((acc, l) => acc + Number(l.amount ?? 0), 0).toFixed(4)
      const run: CostRunView = {
        id: `run-n${costRuns.length + 1}`, runNo: `CR-N-${String(costRuns.length + 1).padStart(3, '0')}`,
        orderId, allocationVersionId, priceVersionId, shiftDate, shiftCalendarId: 'cal-day-a',
        dataCutoffAt, shiftSnapshotAnchor: { shift: '白班' },
        estimateAmount: template!.estimateAmount, actualAmount,
        estimatePossible: template!.estimatePossible, estimateMissingReason: template!.estimateMissingReason,
        energyMeteredUsage: template!.lines.filter((l) => l.sourceKind === 'energy' && l.valueFlag === 'measured').reduce((a, l) => a + Number(l.quantity), 0).toFixed(4),
        energyEstimatedUsage: template!.lines.filter((l) => l.sourceKind === 'energy' && l.valueFlag === 'estimated').reduce((a, l) => a + Number(l.quantity), 0).toFixed(4),
        energyCoverageRatio: '0.5000', energyUomCode: 'KWH',
        machineHours: '48.0000', laborSource: COST_LABOR_SOURCE, equipmentCostCaliber: COST_EQUIPMENT_CALIBER,
        recalcOf: null, oldNewComparison: null, plantId: 'n-plant', createdAt: NOW,
      }
      costRuns.push(run)
      costRunLines[run.id] = lines
      return ok({
        runId: run.id, runNo: run.runNo, estimateAmount: run.estimateAmount, actualAmount: run.actualAmount,
        lineCount: lines.length,
        note: 'CE-02：归集只读业务事实（不重新执行报工/扣库存）；CE-03 实测/估算分列',
      })
    },
  },
  {
    method: 'POST', pattern: 'cost/acquisition/recalc',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const reason = str(body['reason'])
      if (!reason) {
        rejectRule('[CE-11] cost.acquisition.recalc：重算必须填写理由（reason，OA-29 高影响操作留痕）')
      }
      const orderId = str(body['orderId'])
      const shiftDate = str(body['shiftDate'])
      const dataCutoffAt = str(body['dataCutoffAt'])
      const allocationVersionId = str(body['allocationVersionId'])
      const priceVersionId = str(body['priceVersionId'])
      if (!orderId || !shiftDate || !dataCutoffAt || !allocationVersionId || !priceVersionId) {
        rejectRule('[CE-S1] 重算须绑定订单/班次/数据截止时点/分摊版本/价格版本')
      }
      const prior = costRuns.find((r) => r.orderId === orderId && r.shiftDate === shiftDate)
      if (prior === undefined) {
        rejectRule(`[CE-11] 订单 ${orderId} 班次 ${shiftDate} 无既有归集产出——首次归集走 cost.acquisition.run`)
      }
      const priorLines = costRunLines[prior.id] ?? []
      const newLines = priorLines.map((l, idx) => ({ ...l, lineId: `cl-r-${idx + 1}` }))
      const anyPriceMissing = newLines.some((l) => l.priceMissing)
      const newActual = anyPriceMissing
        ? null
        : newLines.reduce((acc, l) => acc + Number(l.amount ?? 0), 0).toFixed(4)
      const comparison = {
        priorRunId: prior.id,
        priorEstimateAmount: prior.estimateAmount,
        priorActualAmount: prior.actualAmount,
        newEstimateAmount: prior.estimateAmount,
        newActualAmount: newActual,
        reason,
        note: '重算为新版本产出（append-only）：历史 run 不改写，对照在落库前固化（CE-11）',
      }
      const run: CostRunView = {
        ...prior,
        id: `run-r${costRuns.length + 1}`, runNo: `CR-R-${String(costRuns.length + 1).padStart(3, '0')}`,
        dataCutoffAt, allocationVersionId, priceVersionId, actualAmount: newActual,
        recalcOf: prior.id, oldNewComparison: comparison, createdAt: NOW,
      }
      costRuns.push(run)
      costRunLines[run.id] = newLines
      return ok({ runId: run.id, runNo: run.runNo, recalcOf: prior.id, oldNewComparison: comparison })
    },
  },
  {
    method: 'POST', pattern: 'cost/recon/resolve',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const itemId = str(body['itemId'])
      const reason = str(body['reason'])
      const targetStatus = str(body['targetStatus'])
      const item = costReconItems.find((i) => i.id === itemId)
      if (item === undefined) rejectNotFound('对账差异行不存在')
      if (!['open', 'confirmed', 'adjusted'].includes(targetStatus)) {
        rejectRule(`[CE-S5] 目标处置状态非法：${targetStatus}`)
      }
      if (item!.dispositionStatus === 'adjusted') {
        rejectRule('[CE-S5] adjusted 为终态，不可再流转（差异吸收已留痕）')
      }
      if (item!.dispositionStatus === targetStatus) {
        rejectRule(`[CE-S5] 处置状态未变化（${targetStatus}）`)
      }
      if (!reason) {
        rejectRule('[CE-S5] 对账处置必须填写理由（reason，差异处置留痕）')
      }
      item!.dispositionStatus = targetStatus as 'confirmed'
      item!.disposedBy = 'admin'
      item!.disposedAt = NOW
      item!.dispositionReason = reason
      return ok({ itemId: item!.id, dispositionStatus: item!.dispositionStatus, diffQuantity: item!.diffQuantity })
    },
  },
  {
    method: 'POST', pattern: 'cost/labor-check/run',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const orderId = str(body['orderId'])
      const shiftDate = str(body['shiftDate'])
      const thresholdRatio = str(body['thresholdRatio']) || '0.1000'
      if (!orderId || !shiftDate) {
        rejectRule('[CA-12] 工时核对须指定订单与班次（工时主源 labor_record vs OT 运行参考源）')
      }
      const templates: Record<string, { operationKey: string; orderOperationId: string; laborHours: string; otRuntimeHours: string | null }> = {
        'po-1027-001': { operationKey: '拉丝', orderOperationId: 'opo-001-2', laborHours: '128.5000', otRuntimeHours: '141.2000' },
        'po-1027-002': { operationKey: '挤塑', orderOperationId: 'opo-002-4', laborHours: '76.0000', otRuntimeHours: null },
      }
      const t = templates[orderId]
      if (t === undefined) rejectNotFound('生产订单不存在或不在授权数据范围内')
      const existing = costLaborChecks.find((c) => c.orderId === orderId && c.shiftDate === shiftDate && c.status === 'open')
      if (existing !== undefined) {
        return ok({ checkId: existing.id, status: existing.status, note: '该订单班次已有未确认核对提示（幂等）' })
      }
      const deviation =
        t!.otRuntimeHours === null || Number(t!.laborHours) === 0
          ? null
          : (Math.abs(Number(t!.otRuntimeHours) - Number(t!.laborHours)) / Number(t!.laborHours)).toFixed(4)
      const check: CostLaborCheckView = {
        id: `lc-n${costLaborChecks.length + 1}`, orderId, operationKey: t!.operationKey,
        orderOperationId: t!.orderOperationId, shiftDate, laborHours: t!.laborHours,
        otRuntimeHours: t!.otRuntimeHours, deviationRatio: deviation, thresholdRatio,
        status: 'open', missingSide: t!.otRuntimeHours === null ? 'ot' : null,
        acknowledgedBy: null, acknowledgedAt: null, reason: null, plantId: 'n-plant',
      }
      costLaborChecks.push(check)
      return ok({ checkId: check.id, status: check.status, deviationRatio: check.deviationRatio, thresholdRatio })
    },
  },
  {
    method: 'POST', pattern: 'cost/labor-check/acknowledge',
    handler: (ctx) => {
      const body = bodyOf(ctx)
      const checkId = str(body['checkId'])
      const reason = str(body['reason'])
      const check = costLaborChecks.find((c) => c.id === checkId)
      if (check === undefined) rejectNotFound('工时核对提示不存在')
      if (!reason) {
        rejectRule('[CA-12] 工时核对确认必须填写理由（主从冲突不自动改写报工工时，确认留痕）')
      }
      if (check!.status === 'acknowledged') {
        rejectRule('[CA-12] 该核对提示已确认（不可重复确认）')
      }
      check!.status = 'acknowledged'
      check!.acknowledgedBy = 'admin'
      check!.acknowledgedAt = NOW
      check!.reason = reason
      return ok({ checkId: check!.id, status: check!.status })
    },
  },
]

function stripChange(c: MockSpcChange): Record<string, unknown> {
  const { impacts, adjustments, oldSpecLabel, newSpecLabel, ...rest } = c
  void impacts
  void adjustments
  void oldSpecLabel
  void newSpecLabel
  return { ...rest }
}

/**
 * mock 路由匹配（method + path，path 可含 query）。命中返回 handler，未命中返回 null。
 */
export function mockP3Routes(
  method: 'GET' | 'POST',
  path: string,
): ((ctx: MockP3Context) => unknown | Promise<unknown>) | null {
  const [pathname, search = ''] = path.split('?')
  const query = new URLSearchParams(search)
  const segments = (pathname ?? '').replace(/^\/+/, '').split('/')
  for (const rule of ROUTES) {
    if (rule.method !== method) continue
    const patternSegments = rule.pattern.split('/')
    if (patternSegments.length !== segments.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < patternSegments.length; i += 1) {
      const p = patternSegments[i]!
      const s = segments[i]!
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(s)
      else if (p !== s) {
        matched = false
        break
      }
    }
    if (matched) return (ctx) => rule.handler(ctx, params, query)
  }
  return null
}

/** 重置 mock 状态（测试隔离用；演示模式刷新页面即重置同等语义）。 */
export function resetMockP3State(): void {
  // 还原命令产生的可变状态：事实/失控任务/变更处置/外协状态机/工具寿命/校准历史/失准处置
  for (const fact of otFacts) {
    if (fact.factId === 'fact-001') {
      fact.status = 'pending_confirm'
      fact.statusLabel = '待确认'
      fact.confirmedBy = null
      fact.confirmedAt = null
      fact.outboxEventId = null
    }
  }
  while (otFacts.length > 2) otFacts.pop()
  for (const sample of otSamples) {
    if (sample.sampleId === 'smp-003') {
      sample.sessionLinkStatus = 'pending_confirm'
      sample.sessionLinkStatusLabel = '待确认'
    }
  }
  const chg = spcChanges[0]
  if (chg !== undefined && chg.id === 'chg-001') {
    chg.status = 'draft'
    chg.publishedAt = null
    chg.publishedBy = null
    chg.adjustments = []
    for (const impact of chg.impacts) {
      impact.disposition = null
      impact.followsVersion = null
      impact.dispositionBy = null
      impact.dispositionAt = null
    }
  }
  while (spcChanges.length > 1) spcChanges.pop()
  while (spcSamples.length > 3) spcSamples.pop()
  while (spcOocTasks.length > 1) spcOocTasks.pop()
  const ooc = spcOocTasks[0]
  if (ooc !== undefined) {
    ooc.status = 'open'
    ooc.causeCategory = null
    ooc.correctiveAction = null
    ooc.isolationSuggestion = null
    ooc.disposedBy = null
    ooc.disposedAt = null
    ooc.recontrolConfirmedBy = null
    ooc.recontrolConfirmedAt = null
  }
  spcMiscalActions.length = 0
  for (const gauge of spcGauges) {
    while (gauge.history.length > 0 && gauge.history[gauge.history.length - 1]!.id.startsWith('cal-1')) {
      if (gauge.history.length <= (gauge.id === 'g-001' ? 2 : 1)) break
      gauge.history.pop()
    }
  }
  for (const tool of spcTools) {
    tool.accumulatedLife = tool.id === 't-001' ? '468200.0000' : '32100.0000'
    tool.adjustmentSum = '0.0000'
    recomputeToolStatus(tool)
  }
  const detail1 = spcToolDetails['t-001']
  if (detail1 !== undefined) {
    detail1.tool = { ...spcTools[0]! }
    detail1.adjustmentSum = '0.0000'
    detail1.effectiveLife = '468200.0000'
    detail1.status = 'warning'
    detail1.adjustments = []
    detail1.usage = detail1.usage.filter((u) => !u.id.startsWith('tu-100'))
  }
  const detail2 = spcToolDetails['t-002']
  if (detail2 !== undefined) {
    detail2.tool = { ...spcTools[1]! }
    detail2.adjustmentSum = '0.0000'
    detail2.effectiveLife = '32100.0000'
    detail2.status = 'normal'
    detail2.usage = detail2.usage.filter((u) => !u.id.startsWith('tu-100'))
  }
  for (const task of cswTasks) {
    const initial = cswInitialStatuses[task.id]
    if (initial !== undefined) {
      task.status = initial
      task.statusLabel = CSW_STATUS_LABELS[initial] ?? initial
      task.occupationActive = initial === 'sent' || initial === 'return_received' || initial === 'inspecting'
    }
  }
  while (cswTasks.length > 6) cswTasks.pop()
  // 单元行完整复位（命令会改写 sent/returned 字段与状态；PDA 扫码匹配依赖单元行状态）
  const uow1 = cswUnits.find((u) => u.id === 'uow-001')
  if (uow1 !== undefined) {
    uow1.sentQty = '48.0000'
    uow1.returnedQty = '0.0000'
    uow1.returnLotId = null
    uow1.status = 'sent'
  }
  while (cswUnits.length > 3) cswUnits.pop()
  // cost：弹出命令新增的 run（模板行随之清理）、还原对账处置与工时核对状态
  while (costRuns.length > 3) {
    const removed = costRuns.pop()
    if (removed !== undefined && removed.id in costRunLines) delete costRunLines[removed.id]
  }
  for (const item of costReconItems) {
    if (item.id === 'rec-001' || item.id === 'rec-002') {
      item.dispositionStatus = 'open'
      item.disposedBy = null
      item.disposedAt = null
      item.dispositionReason = null
    }
  }
  while (costLaborChecks.length > 2) costLaborChecks.pop()
  const lc1 = costLaborChecks[0]
  if (lc1 !== undefined && lc1.id === 'lc-001') {
    lc1.status = 'open'
    lc1.acknowledgedBy = null
    lc1.acknowledgedAt = null
    lc1.reason = null
  }
  const lc2 = costLaborChecks[1]
  if (lc2 !== undefined && lc2.id === 'lc-002') {
    lc2.status = 'open'
    lc2.acknowledgedBy = null
    lc2.acknowledgedAt = null
    lc2.reason = null
  }
}

const cswInitialStatuses: Record<string, CswOutsourcingTaskView['status']> = {
  'owt-001': 'draft',
  'owt-002': 'pending_send',
  'owt-003': 'sent',
  'owt-004': 'return_received',
  'owt-005': 'inspecting',
  'owt-006': 'closed',
}
