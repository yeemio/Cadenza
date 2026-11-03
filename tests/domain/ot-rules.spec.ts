import { describe, expect, it } from 'vitest'
// domain ot 面未并入包名入口（共享文件 domain/src/index.ts 不改动）：
// 测试直接以相对路径消费 TS 源码（vitest 转译；typecheck:tests 以相对导入纳入编译）。
import {
  OtRuleViolation,
  assertEventIdMatchesDevice,
  assertGatewaySpec,
  assertMappingSpec,
  assertPointSpec,
  assertQualityCodeMapEntries,
  assertSampleShape,
  buildEventId,
  classifyBadPoint,
  classifyClockSkew,
  deriveGatewayStatus,
  evaluateMeterToQuantity,
  evaluateStopToDowntime,
  isAggregateEligible,
  isCalibrationSuspect,
  isLateSample,
  linkSession,
  mapQualityLevel,
  mergeAggregate,
  minuteWindowStart,
  normalizeSample,
  parseEventId,
  shiftWindowStartIso,
  type QualityLevel,
  type SessionWindowView,
} from '../../packages/domain/src/ot/index'

/**
 * T21 ot 域纯规则单测——冻结合同 ot-collection.md OT-05~OT-21/OT-24/OT-26/OT-S4 逐条。
 * 覆盖：网关注册校验与状态推导、点位字典校验与量程、样本形状、量纲归一、
 * 质量码映射缺省、校准过期、会话三态、事件 ID 构造、迟到、时钟偏差三源、
 * 坏点三源、汇总并入与资格、映射评估（计长/停机）。
 */

const NOW = '2026-10-28T08:00:00Z'

function expectViolation(fn: () => void, rule: string): void {
  expect(fn).toThrow(OtRuleViolation)
  try {
    fn()
  } catch (error) {
    expect((error as OtRuleViolation).rule).toBe(rule)
    expect((error as OtRuleViolation).message.length).toBeGreaterThan(0)
  }
}

describe('OT-06 网关注册与状态推导', () => {
  it('合法注册通过；非法采样率/容量/超时拒绝', () => {
    expect(() =>
      assertGatewaySpec({ gatewayCode: 'GW-01', sampleRateHz: 1, bufferCapacity: 100, heartbeatTimeoutSeconds: 60 }),
    ).not.toThrow()
    expectViolation(
      () => assertGatewaySpec({ gatewayCode: '', sampleRateHz: 1, bufferCapacity: 100, heartbeatTimeoutSeconds: 60 }),
      'OT-06',
    )
    expectViolation(
      () => assertGatewaySpec({ gatewayCode: 'GW-01', sampleRateHz: 0, bufferCapacity: 100, heartbeatTimeoutSeconds: 60 }),
      'OT-06',
    )
    expectViolation(
      () => assertGatewaySpec({ gatewayCode: 'GW-01', sampleRateHz: 1, bufferCapacity: 0, heartbeatTimeoutSeconds: 60 }),
      'OT-06',
    )
  })

  it('状态推导：从未心跳=离线；超阈值=离线；阈值内=在线', () => {
    expect(deriveGatewayStatus(null, 60, NOW)).toBe('offline')
    expect(deriveGatewayStatus('2026-10-28T07:59:30Z', 60, NOW)).toBe('online')
    expect(deriveGatewayStatus('2026-10-28T07:58:00Z', 60, NOW)).toBe('offline')
  })
})

describe('OT-08/OT-12 点位字典', () => {
  const base = {
    pointCode: 'LEN-01',
    semantic: 'meter_length',
    uomCode: 'M',
    sampleRateSeconds: 1,
    rangeMin: null as number | null,
    rangeMax: null as number | null,
    participatesInBusiness: true,
    calibrationRecordNo: null as string | null,
    calibrationValidUntil: null as string | null,
  }
  it('合法点位通过；语义/单位/采样率/量程成对校验', () => {
    expect(() => assertPointSpec(base)).not.toThrow()
    expectViolation(() => assertPointSpec({ ...base, semantic: 'magic' }), 'OT-08')
    expectViolation(() => assertPointSpec({ ...base, uomCode: '' }), 'OT-08')
    expectViolation(() => assertPointSpec({ ...base, sampleRateSeconds: 0 }), 'OT-08')
    expectViolation(() => assertPointSpec({ ...base, rangeMin: 1, rangeMax: null }), 'OT-08')
    expectViolation(() => assertPointSpec({ ...base, rangeMin: 10, rangeMax: 1 }), 'OT-08')
  })
  it('OT-12：登记校准有效期必须引用校准记录版本号', () => {
    expectViolation(
      () => assertPointSpec({ ...base, calibrationValidUntil: '2026-12-31T00:00:00Z' }),
      'OT-12',
    )
    expect(() =>
      assertPointSpec({ ...base, calibrationValidUntil: '2026-12-31T00:00:00Z', calibrationRecordNo: 'CAL-2026-001' }),
    ).not.toThrow()
  })
})

describe('OT-09 样本形状（必含质量码）', () => {
  const base = {
    deviceSerial: 'DEV-01',
    pointCode: 'LEN-01',
    eventTime: NOW,
    rawValue: 1.5,
    rawUnit: 'M',
    deviceQualityCode: '0',
  }
  it('缺质量码拒绝（OT-09 必含）', () => {
    expect(() => assertSampleShape(base)).not.toThrow()
    expectViolation(() => assertSampleShape({ ...base, deviceQualityCode: '' }), 'OT-09')
    expectViolation(() => assertSampleShape({ ...base, eventTime: 'not-a-time' }), 'OT-09')
  })
})

describe('OT-10 量纲归一（原始值+归一值并存）', () => {
  it('同单位恒等；异单位按换算版本；无换算规则标缺失不丢值', () => {
    const conversions = [{ fromUomCode: 'MM', toUomCode: 'M', factor: 0.001, revision: 3 }]
    expect(normalizeSample(1.5, 'M', 'M', conversions)).toEqual({
      normalizedValue: 1.5,
      conversionRevision: null,
      conversionMissing: false,
    })
    expect(normalizeSample(1500, 'MM', 'M', conversions)).toEqual({
      normalizedValue: 1.5,
      conversionRevision: 3,
      conversionMissing: false,
    })
    expect(normalizeSample(1, 'FT', 'M', conversions)).toEqual({
      normalizedValue: null,
      conversionRevision: null,
      conversionMissing: true,
    })
  })
})

describe('OT-11 质量码映射', () => {
  it('映射命中；未配置一律 uncertain（缺省 fail-safe）', () => {
    const map = new Map<string, QualityLevel>([
      ['0', 'good'],
      ['192', 'bad'],
    ])
    expect(mapQualityLevel('0', map)).toBe('good')
    expect(mapQualityLevel('192', map)).toBe('bad')
    expect(mapQualityLevel('999', map)).toBe('uncertain')
    expect(mapQualityLevel('0', new Map())).toBe('uncertain')
    expect(() =>
      assertQualityCodeMapEntries([
        { code: '0', level: 'good' },
        { code: '0', level: 'bad' },
      ]),
    ).toThrow()
  })
})

describe('OT-12 校准过期', () => {
  it('事件时间晚于有效期 → 可疑；未配置/未过期 → 不可疑', () => {
    expect(isCalibrationSuspect('2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z')).toBe(true)
    expect(isCalibrationSuspect('2027-01-01T00:00:00Z', '2026-06-01T00:00:00Z')).toBe(false)
    expect(isCalibrationSuspect(null, NOW)).toBe(false)
  })
})

describe('OT-13 会话三态', () => {
  const sessions: SessionWindowView[] = [
    { sessionId: 's1', equipmentCode: 'EQU-01', startAt: '2026-10-28T07:00:00Z', endAt: null },
    { sessionId: 's2', equipmentCode: 'EQU-01', startAt: '2026-10-28T06:00:00Z', endAt: '2026-10-28T09:00:00Z' },
  ]
  it('恰一个覆盖→自动绑定；多个覆盖→待确认；零个→未关联', () => {
    expect(linkSession('2026-10-28T10:00:00Z', sessions)).toEqual({ sessionId: 's1', status: 'auto_bound' })
    expect(linkSession('2026-10-28T08:00:00Z', sessions)).toEqual({ sessionId: null, status: 'pending_confirm' })
    expect(linkSession('2026-10-28T05:00:00Z', sessions)).toEqual({ sessionId: null, status: 'unlinked' })
  })
})

describe('OT-15 唯一事件 ID 与 OT-19 迟到', () => {
  it('构造/解析/设备前缀校验；禁裸时间戳', () => {
    expect(buildEventId('DEV-01', 7)).toBe('DEV-01@7')
    expect(parseEventId('DEV-01@7')).toEqual({ deviceSerial: 'DEV-01', gatewaySeq: 7 })
    expect(() => parseEventId('DEV-01')).toThrow()
    expect(() => assertEventIdMatchesDevice('DEV-02@7', 'DEV-01')).toThrow()
    expect(assertEventIdMatchesDevice('DEV-01@7', 'DEV-01')).toBe(7)
  })
  it('事件时间早于已入池最大事件时间 → 迟到', () => {
    expect(isLateSample('2026-10-28T07:59:00Z', '2026-10-28T08:00:00Z')).toBe(true)
    expect(isLateSample('2026-10-28T08:01:00Z', '2026-10-28T08:00:00Z')).toBe(false)
    expect(isLateSample('2026-10-28T07:00:00Z', null)).toBe(false)
  })
})

describe('OT-20 时钟偏差三源（阈值按设备可配置，缺省 120 秒）', () => {
  it('offset：|事件-接收|>阈值', () => {
    const r = classifyClockSkew({
      eventTime: '2026-10-28T07:57:00Z',
      receivedAt: NOW,
      now: NOW,
      thresholdSeconds: 120,
      deviceLatest: null,
      gatewaySeq: 1,
    })
    expect(r).toEqual({ isClockSkew: true, kind: 'offset' })
  })
  it('ahead：事件时间超前于当前时间超阈值', () => {
    const r = classifyClockSkew({
      eventTime: '2026-10-28T08:05:00Z',
      receivedAt: NOW,
      now: NOW,
      thresholdSeconds: 120,
      deviceLatest: null,
      gatewaySeq: 1,
    })
    expect(r.kind).toBe('ahead')
  })
  it('backward：更高序号更早事件时间（倒跳）；重放低序号不算倒跳', () => {
    const backward = classifyClockSkew({
      eventTime: '2026-10-28T07:00:00Z',
      receivedAt: NOW,
      now: NOW,
      thresholdSeconds: 120,
      deviceLatest: { gatewaySeq: 5, eventTime: '2026-10-28T07:59:00Z' },
      gatewaySeq: 6,
    })
    expect(backward.kind).toBe('backward')
    const replay = classifyClockSkew({
      eventTime: '2026-10-28T07:00:00Z',
      receivedAt: NOW,
      now: NOW,
      thresholdSeconds: 120,
      deviceLatest: { gatewaySeq: 5, eventTime: '2026-10-28T07:59:00Z' },
      gatewaySeq: 3,
    })
    expect(replay.kind).not.toBe('backward')
  })
  it('阈值内不标', () => {
    const r = classifyClockSkew({
      eventTime: '2026-10-28T07:59:30Z',
      receivedAt: NOW,
      now: NOW,
      thresholdSeconds: 120,
      deviceLatest: null,
      gatewaySeq: 1,
    })
    expect(r.isClockSkew).toBe(false)
  })
})

describe('OT-21 坏点三源', () => {
  it('质量 bad / 量程越界 / 维修期间采集 → 坏点（原因并列）', () => {
    expect(classifyBadPoint({ qualityLevel: 'bad', rawValue: 1, rangeMin: null, rangeMax: null, equipmentStatus: 1 }))
      .toEqual({ isBad: true, reasons: ['quality_bad'] })
    expect(classifyBadPoint({ qualityLevel: 'good', rawValue: 200, rangeMin: 0, rangeMax: 100, equipmentStatus: 1 }))
      .toEqual({ isBad: true, reasons: ['out_of_range'] })
    const both = classifyBadPoint({ qualityLevel: 'bad', rawValue: 200, rangeMin: 0, rangeMax: 100, equipmentStatus: 2 })
    expect(both.isBad).toBe(true)
    expect(both.reasons).toEqual(['quality_bad', 'out_of_range', 'equipment_under_repair'])
    expect(classifyBadPoint({ qualityLevel: 'good', rawValue: 1, rangeMin: 0, rangeMax: 100, equipmentStatus: 1 }).isBad).toBe(false)
  })
})

describe('OT-24/S4 汇总并入', () => {
  it('分钟窗口截断；坏点/偏差不进 sampleCount 只进计数列；迟到补插同窗', () => {
    expect(minuteWindowStart('2026-10-28T08:00:59.999Z')).toBe('2026-10-28T08:00:00.000Z')
    expect(shiftWindowStartIso('2026-10-28')).toBe('2026-10-28T00:00:00.000Z')
    const good = { eventTime: '2026-10-28T08:00:10Z', normalizedValue: 10, qualityLevel: 'good' as const, isBad: false, isClockSkew: false, isQuarantined: false }
    expect(isAggregateEligible(good)).toBe(true)
    let agg = mergeAggregate(null, good)
    expect(agg.sampleCount).toBe(1)
    agg = mergeAggregate(agg, { ...good, eventTime: '2026-10-28T08:00:05Z', normalizedValue: 5 })
    expect(agg.sampleCount).toBe(2)
    expect(agg.sumValue).toBe(15)
    expect(agg.firstEventTime).toBe('2026-10-28T08:00:05Z')
    agg = mergeAggregate(agg, { ...good, eventTime: '2026-10-28T08:00:20Z', isBad: true })
    expect(agg.sampleCount).toBe(2)
    expect(agg.badCount).toBe(1)
    agg = mergeAggregate(agg, { ...good, eventTime: '2026-10-28T08:00:25Z', isClockSkew: true })
    expect(agg.sampleCount).toBe(2)
    expect(agg.skewCount).toBe(1)
    agg = mergeAggregate(agg, { ...good, eventTime: '2026-10-28T08:00:30Z', isQuarantined: true })
    expect(agg.sampleCount).toBe(2)
  })
})

describe('OT-26 业务事实映射', () => {
  const samples = (vals: number[]): Array<{
    eventTime: string
    normalizedValue: number | null
    qualityLevel: 'good'
    isBad: boolean
    isClockSkew: boolean
    isQuarantined: boolean
  }> =>
    vals.map((v, i) => ({
      eventTime: new Date(Date.parse('2026-10-28T08:00:00Z') + i * 1000).toISOString(),
      normalizedValue: v,
      qualityLevel: 'good' as const,
      isBad: false,
      isClockSkew: false,
      isQuarantined: false,
    }))

  it('映射校验：不参与业务判定的点位拒（OT-08）；factKind/confirmMode 闭合', () => {
    expect(() =>
      assertMappingSpec({ factKind: 'meter_to_quantity', confirmMode: 'auto', participatesInBusiness: true }),
    ).not.toThrow()
    expectViolation(
      () => assertMappingSpec({ factKind: 'meter_to_quantity', confirmMode: 'auto', participatesInBusiness: false }),
      'OT-08',
    )
    expectViolation(
      () => assertMappingSpec({ factKind: 'magic', confirmMode: 'auto', participatesInBusiness: true }),
      'OT-26',
    )
  })
  it('计长→数量：合格样本求和；无合格样本 null（OT-28 缺采集不产生假值）', () => {
    expect(evaluateMeterToQuantity(samples([1.5, 2, 2.5]))).toEqual({ quantity: '6.0000' })
    expect(evaluateMeterToQuantity([]).quantity).toBeNull()
  })
  it('停机→停机事件：连续停机段一个事实；恢复时点=段后首个非停机样本；窗口末端未恢复标 stillRunning', () => {
    const runs = evaluateStopToDowntime(samples([1, 1, 0, 1]), { stopLevel: 1 })
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ startedAt: '2026-10-28T08:00:00.000Z', endedAt: '2026-10-28T08:00:02.000Z', stillRunning: false })
    expect(runs[1]).toMatchObject({ stillRunning: true })
    expect(evaluateStopToDowntime(samples([0, 0]))).toHaveLength(0)
  })
})
