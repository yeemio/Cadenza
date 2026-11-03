import { describe, expect, it } from 'vitest'
// domain ot 面未并入包名入口（共享文件不改动）：测试以相对路径消费 TS 源码/已构建 dist
// （vitest 转译 + typecheck:tests 相对导入；dist 依赖由 workspace 拓扑先构建）。
import { buildEventId, parseEventId } from '../../domain/src/ot/index'
import {
  EdgeBuffer,
  MemoryCheckpointStore,
  SimulatedGateway,
  constant,
  meterCounter,
  stopSignal,
} from '../src/index'

/**
 * 边缘模拟网关单测（模拟环境证据，OT-31）：唯一事件 ID 构造（OT-15）、
 * 断网缓冲与恢复补传（OT-14）、缓冲溢出丢最旧+统计（OT-17）、
 * 检查点续发（OT-15 重装续发）、重传载荷（OT-16 服务端去重的前提）。
 */

const POINTS = [
  { deviceSerial: 'DEV-OT-01', pointCode: 'LEN-01', unit: 'M', semantic: 'meter_length' as const, value: meterCounter(1.5) },
  { deviceSerial: 'DEV-OT-01', pointCode: 'STOP-01', unit: 'LVL', semantic: 'stop_signal' as const, value: stopSignal(2) },
  { deviceSerial: 'DEV-OT-02', pointCode: 'TEMP-01', unit: 'DEG_C', semantic: 'temperature' as const, value: constant(25) },
]

describe('OT-15 唯一事件 ID', () => {
  it('构造=设备序列号@网关内单调序号；解析往返；非裸时间戳', () => {
    const id = buildEventId('DEV-OT-01', 42)
    expect(id).toBe('DEV-OT-01@42')
    expect(parseEventId(id)).toEqual({ deviceSerial: 'DEV-OT-01', gatewaySeq: 42 })
    expect(id).not.toMatch(/^1[6-9]\d{8,}/) // 禁裸时间戳充当唯一 ID
  })

  it('非法事件 ID 拒绝（无 @/非正整数序号）', () => {
    expect(() => parseEventId('no-at-sign')).toThrow()
    expect(() => parseEventId('DEV@0')).toThrow()
    expect(() => parseEventId('DEV@-3')).toThrow()
  })
})

describe('OT-17 缓冲溢出', () => {
  it('容量上限丢最旧并记录溢出统计（条数/时段/设备），不静默丢弃', () => {
    const buffer = new EdgeBuffer(2)
    buffer.push(makeSample('DEV-A@1', '2026-10-28T08:00:01Z', 'DEV-A'))
    buffer.push(makeSample('DEV-B@2', '2026-10-28T08:00:02Z', 'DEV-B'))
    buffer.push(makeSample('DEV-A@3', '2026-10-28T08:00:03Z', 'DEV-A'))
    expect(buffer.size).toBe(2)
    const stats = buffer.takeOverflowStats()
    expect(stats).not.toBeNull()
    expect(stats!.count).toBe(1)
    expect(stats!.firstAt).toBe('2026-10-28T08:00:01Z')
    expect(stats!.deviceSerials).toEqual(['DEV-A'])
    // 剩余为最旧之后的两条
    expect(buffer.peek().map((s) => s.eventId)).toEqual(['DEV-B@2', 'DEV-A@3'])
  })
})

describe('OT-14/15 断网缓冲、补传与检查点续发', () => {
  it('离线 tick 入缓冲；恢复 flush 清空；重装后从检查点续发（序号不回退）', async () => {
    const store = new MemoryCheckpointStore()
    const gw = new SimulatedGateway('GW-OT-TEST', POINTS, { capacity: 100, checkpointStore: store })
    gw.setOnline(false)
    const tick1 = await gw.tick('2026-10-28T08:01:00Z')
    expect(tick1).toHaveLength(3)
    expect(gw.backlog).toBe(3)
    // 重传载荷与缓冲同批（OT-16 服务端去重前提）
    const replay = gw.replayPayload()
    expect(replay!.samples.map((s) => s.eventId)).toEqual(tick1.map((s) => s.eventId))
    // 恢复补传：只补数据（载荷仅样本批次，OT-18）
    const flushed = await gw.flush()
    expect(flushed.flushed).toBe(3)
    expect(gw.backlog).toBe(0)
    // 检查点落盘 → 重装（新实例同 store）续发
    const lastSeq = gw.lastSeq
    const reinstalled = new SimulatedGateway('GW-OT-TEST', POINTS, { capacity: 100, checkpointStore: store })
    expect(await reinstalled.restoreFromCheckpoint()).toBe(true)
    expect(reinstalled.lastSeq).toBe(lastSeq)
    reinstalled.setOnline(false)
    const tick2 = await reinstalled.tick('2026-10-28T08:02:00Z')
    // 序号从检查点续发：新事件 ID 序号全部大于检查点
    for (const s of tick2) expect(s.gatewaySeq).toBeGreaterThan(lastSeq)
  })

  it('发生器确定性：同 tick 序号同值（计长累计/停机信号前两 tick 高电平）', async () => {
    const gw = new SimulatedGateway('GW-DET', POINTS, { capacity: 100 })
    gw.setOnline(false)
    const t0 = await gw.tick('2026-10-28T08:00:00Z')
    expect(t0.find((s) => s.pointCode === 'LEN-01')!.rawValue).toBe(1.5)
    expect(t0.find((s) => s.pointCode === 'STOP-01')!.rawValue).toBe(1)
    const t1 = await gw.tick('2026-10-28T08:00:01Z')
    expect(t1.find((s) => s.pointCode === 'LEN-01')!.rawValue).toBe(3)
    expect(t1.find((s) => s.pointCode === 'STOP-01')!.rawValue).toBe(1)
    const t2 = await gw.tick('2026-10-28T08:00:02Z')
    expect(t2.find((s) => s.pointCode === 'STOP-01')!.rawValue).toBe(0)
  })
})

function makeSample(eventId: string, eventTime: string, deviceSerial: string) {
  const parsed = parseEventId(eventId)
  return {
    deviceSerial,
    pointCode: 'LEN-01',
    eventId,
    gatewaySeq: parsed.gatewaySeq,
    eventTime,
    rawValue: 1,
    rawUnit: 'M',
    deviceQualityCode: '0',
  }
}
