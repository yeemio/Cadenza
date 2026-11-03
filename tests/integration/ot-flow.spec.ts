import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext } from '@cadenza/application'
import { buildOtCommandBus } from '../../apps/api/src/ot/ot.composition'
// 边缘模拟网关（源码相对导入；OT-31：模拟环境承载合同行为）
import { SimulatedGateway, meterCounter, stopSignal } from '../../packages/edge/src/index'
import { buildEventId, minuteWindowStart } from '../../packages/domain/src/ot/index'
import { OT_TEST_DB_NAME, otFixtures, prepareOtTestDatabase } from '../api/ot-test-env'

/**
 * T21 OT 采集集成（真容器独立库 cadenza_p3a + 真实命令总线与组合根，无业务桩；
 * **模拟环境证据，OT-31**——边缘网关为模拟适配器，真实设备协议接入留现场 SITE_PENDING）。
 * 冻结合同证据块：
 * ① OT-06 网关注册/心跳/巡检离线与恢复事件留痕；
 * ② OT-07 未映射设备隔离（ot_sample 隔离标记 + inbox QUARANTINED）→ 补绑再处理（不悬空丢弃、不自动建档案）；
 * ③ OT-09/10/11 样本合同：必含质量码、原始值+归一值并存（换算版本）、未配置质量码缺省 uncertain；
 * ④ OT-14/15/16 边缘断网缓冲补传 + 唯一事件 ID + 重传幂等去重（计数可观测）；
 * ⑤ OT-17 溢出统计上报（不静默丢弃）；
 * ⑥ OT-19/S4 乱序迟到补插分钟汇总、班次汇总不受迟到影响（显式重建才刷新）；
 * ⑦ OT-20 时钟偏差三源标记且不进汇总；
 * ⑧ OT-21/22 坏点三源隔离可见（带原因）、不计入汇总、坏点率可查；
 * ⑨ OT-12 校准过期样本标"校准状态可疑"；
 * ⑩ OT-13 会话三态（自动绑定/待确认/未关联）+ 人工绑定留痕；
 * ⑪ OT-23/24 容量分层：2,000 样本单批入原始层、Outbox 零增长（不写业务事件表）；
 * ⑫ OT-26 业务事实映射：auto→Outbox 派发幂等；manual→待确认→确认派发；
 * ⑬ OT-28 缺采集设备监控缺项（不以估算冒充）；
 * ⑭ 命令幂等：同 operationId 重放原结果回放。
 */

let pool: pg.Pool
let otBus: ReturnType<typeof buildOtCommandBus>
let adminCtx: CommandContext
let fx: ReturnType<typeof otFixtures>
let dbAvailable = true
const run = `ot${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

beforeAll(async () => {
  try {
    pool = await prepareOtTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP ot-flow: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${OT_TEST_DB_NAME}）。`)
    return
  }
  fx = otFixtures()
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  otBus = buildOtCommandBus(pool)
})

afterAll(async () => {
  if (pool) await pool.end()
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

let opSeq = 0
function nextOp(tag: string): string {
  opSeq += 1
  return `${run}-${tag}-${opSeq}`
}

function envelope(operationId: string, commandType: string, payload: Record<string, unknown>): CommandEnvelope {
  return { operationId, commandType, targetId: 'new', expectedRevision: 0, payload }
}

async function ot(operationId: string, commandType: string, payload: Record<string, unknown>): Promise<CommandResult> {
  return otBus.execute(envelope(operationId, commandType, payload), adminCtx)
}

async function otOk(operationId: string, commandType: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await ot(operationId, commandType, payload)
  expect(r.status, `${commandType} 未提交：${r.errorMessage ?? '(无消息)'}`).toBe(CommandResultStatus.COMMITTED)
  return (r.data ?? {}) as Record<string, unknown>
}

const nowIso = (): string => new Date().toISOString()
const isoMinus = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString()
/** 锚定毫秒 + 偏移 → ISO（时间线动态化：全部时间须落在最近 24h 内，见 fixture sessionAnchorIso 注释）。 */
const isoAt = (baseMs: number, offsetMs: number): string => new Date(baseMs + offsetMs).toISOString()
/** 分钟取整（构造"高序号 :00 / 低序号前一分钟 :30"的跨分钟迟到结构）。 */
const floorMinuteMs = (ms: number): number => Math.floor(ms / 60_000) * 60_000

function sample(
  deviceSerial: string,
  pointCode: string,
  seq: number,
  eventTime: string,
  rawValue: number,
  rawUnit = 'M',
  deviceQualityCode = '0',
): Record<string, unknown> {
  return {
    deviceSerial,
    pointCode,
    eventId: buildEventId(deviceSerial, seq),
    eventTime,
    rawValue,
    rawUnit,
    deviceQualityCode,
  }
}

describe('① OT-06 网关注册/心跳/巡检', () => {
  it('注册→心跳在线；心跳超时→巡检离线事件留痕；再心跳→恢复事件', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const reg = await otOk(nextOp('gwreg'), 'ot.gateway.register', {
      plantId: fx.szPlantId,
      gatewayCode: 'GW-OT-A',
      sampleRateHz: 1,
      bufferCapacity: 100,
      heartbeatTimeoutSeconds: 5,
      deviceSerials: ['DEV-OT-A', 'DEV-OT-K', 'DEV-OT-N'],
    })
    expect(reg['gatewayCode']).toBe('GW-OT-A')
    const hb = await otOk(nextOp('hb'), 'ot.gateway.heartbeat', { gatewayCode: 'GW-OT-A', backlogCount: 0 })
    expect(hb['status']).toBe('online')
    // 心跳置为 10 分钟前（> 超时 5 秒）→ 巡检应标离线并留事件
    await pool.query(`UPDATE ot_gateway SET last_heartbeat_at = now() - interval '10 minutes' WHERE gateway_code = 'GW-OT-A'`)
    const sweep = await otOk(nextOp('mon'), 'ot.gateway.monitor', {})
    expect(sweep['offlineMarked']).toBe(1)
    const offlineEvents = await pool.query(
      `SELECT event_kind, detail FROM ot_gateway_event WHERE gateway_code = 'GW-OT-A' AND event_kind = 'offline'`,
    )
    expect(offlineEvents.rowCount).toBe(1)
    const restored = await otOk(nextOp('hb2'), 'ot.gateway.heartbeat', { gatewayCode: 'GW-OT-A' })
    expect(restored['restored']).toBe(true)
    const restoreEvents = await pool.query(
      `SELECT count(*)::int AS c FROM ot_gateway_event WHERE gateway_code = 'GW-OT-A' AND event_kind = 'heartbeat_restored'`,
    )
    expect(restoreEvents.rows[0]!.c).toBe(2) // 首次心跳与离线恢复各一次（offline→online 转移留痕）
  })
})

describe('② OT-07 未映射设备隔离与补绑再处理', () => {
  it('未绑定设备的样本进隔离态（ot_sample 标记 + inbox QUARANTINED）；补绑后自动再处理；不自动建档案', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const ingest = await otOk(nextOp('q1'), 'ot.samples.ingest', {
      gatewayCode: 'GW-OT-A',
      samples: [sample('DEV-OT-A', 'QUAR-01', 1, nowIso(), 100)],
    })
    expect(ingest['quarantined']).toBe(1)
    expect(ingest['inserted']).toBe(1)
    const quarantined = await pool.query(
      `SELECT is_quarantined, quarantine_reason, raw_value FROM ot_sample WHERE device_serial = 'DEV-OT-A'`,
    )
    expect(quarantined.rows[0]!.is_quarantined).toBe(true)
    expect(quarantined.rows[0]!.quarantine_reason).toBe('device_unbound')
    expect(Number(quarantined.rows[0]!.raw_value)).toBe(100) // 不悬空丢弃
    const inboxRows = await pool.query(
      `SELECT status FROM inbox WHERE source_system = 'GW-OT-A' AND entity_type = 'ot_sample' AND external_key LIKE 'DEV-OT-A:%'`,
    )
    expect(inboxRows.rowCount).toBe(1)
    expect(inboxRows.rows[0]!.status).toBe('QUARANTINED')
    // 不自动建档案：设备已登记（网关注册）但无 equipment 映射
    const device = await pool.query(`SELECT equipment_id FROM ot_device WHERE device_serial = 'DEV-OT-A'`)
    expect(device.rows[0]!.equipment_id).toBeNull()
    // 人工补绑前置：先登记该设备点位（QUAR-01），再绑定设备 → 补绑后再处理清除隔离
    await otOk(nextOp('pts-q'), 'ot.point.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-A',
      points: [{ pointCode: 'QUAR-01', semantic: 'other', uomCode: 'M', sampleRateSeconds: 1 }],
    })
    await otOk(nextOp('bind-a'), 'ot.device.bind', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-A',
      gatewayCode: 'GW-OT-A',
      equipmentId: fx.equipmentId,
      clockSkewThresholdSeconds: 86400,
    })
    const after = await pool.query(`SELECT is_quarantined, quarantine_reason FROM ot_sample WHERE device_serial = 'DEV-OT-A'`)
    expect(after.rows[0]!.is_quarantined).toBe(false)
    expect(after.rows[0]!.quarantine_reason).toBeNull()
    const inboxAfter = await pool.query(
      `SELECT status FROM inbox WHERE external_key LIKE 'DEV-OT-A:%' AND entity_type = 'ot_sample'`,
    )
    expect(inboxAfter.rows[0]!.status).toBe('PROCESSED')
  })
})

describe('③ OT-08/09/10/11 点位字典与样本合同', () => {
  it('点位/质量码/换算登记；样本原始值+归一值并存（换算版本）；未配置质量码缺省 uncertain', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await otOk(nextOp('pts'), 'ot.point.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-A',
      points: [
        { pointCode: 'LEN-01', semantic: 'meter_length', uomCode: 'M', uomId: fx.uomId, sampleRateSeconds: 1, rangeMin: 0, rangeMax: 10000, participatesInBusiness: true },
        { pointCode: 'CAL-01', semantic: 'inspection_result', uomCode: 'M', sampleRateSeconds: 1, participatesInBusiness: false, calibrationRecordNo: 'CAL-2026-OLD', calibrationValidUntil: '2026-01-01T00:00:00Z' },
      ],
    })
    // 版本化：再次 upsert 同点位 version+1（量程保留——upsert 为全量覆盖语义）
    const again = await otOk(nextOp('pts2'), 'ot.point.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-A',
      points: [{ pointCode: 'LEN-01', semantic: 'meter_length', uomCode: 'M', sampleRateSeconds: 1, rangeMin: 0, rangeMax: 10000, participatesInBusiness: true }],
    })
    expect(((again['points'] as Array<{ version: number }>)[0]!.version)).toBe(2)
    await otOk(nextOp('qmap'), 'ot.quality-map.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-A',
      entries: [
        { code: '0', level: 'good' },
        { code: '192', level: 'bad' },
      ],
    })
    await otOk(nextOp('conv'), 'ot.conversion.upsert', { plantId: fx.szPlantId, fromUomCode: 'MM', toUomCode: 'M', factor: 0.001 })
    const ingest = await otOk(nextOp('s3'), 'ot.samples.ingest', {
      gatewayCode: 'GW-OT-A',
      samples: [
        sample('DEV-OT-A', 'LEN-01', 2, nowIso(), 1500, 'MM'), // 换算归一 1.5
        sample('DEV-OT-A', 'LEN-01', 3, nowIso(), 12, 'M', '999'), // 未配置质量码 → uncertain
      ],
    })
    expect(ingest['inserted']).toBe(2)
    const rows = await pool.query(
      `SELECT event_id, raw_value, raw_unit, normalized_value, conversion_revision, quality_level, device_quality_code
       FROM ot_sample WHERE device_serial = 'DEV-OT-A' AND gateway_seq IN (2,3)`,
    )
    const mm = rows.rows.find((r) => r.raw_unit === 'MM')!
    expect(Number(mm.raw_value)).toBe(1500)
    expect(Number(mm.normalized_value)).toBeCloseTo(1.5, 4) // 原始值与归一值并存
    expect(mm.conversion_revision).toBe(1)
    expect(rows.rows.find((r) => r.device_quality_code === '999')?.quality_level).toBe('uncertain') // OT-11 未配置缺省
  })
})

describe('④ OT-14/15/16 边缘缓冲补传与重传去重', () => {
  it('模拟网关断网缓冲→补传入池→重传同批：去重计数累计、样本行数不变（幂等丢弃）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const gw = new SimulatedGateway(
      'GW-OT-A',
      [
        { deviceSerial: 'DEV-OT-A', pointCode: 'LEN-01', unit: 'M', semantic: 'meter_length', value: meterCounter(1) },
        { deviceSerial: 'DEV-OT-A', pointCode: 'STOP-01', unit: 'LVL', semantic: 'stop_signal', value: stopSignal(2) },
      ],
      { capacity: 100, initialSeq: 500 }, // 错开既有序号（块②③已用 1–3）：事件 ID 全局不冲突
    )
    gw.setOnline(false)
    await gw.tick('2026-10-28T08:10:00Z')
    await gw.tick('2026-10-28T08:10:01Z')
    expect(gw.backlog).toBe(4) // OT-14 断网本地缓冲
    const pending = gw.peekBuffer()
    expect(pending.every((s) => s.eventId.includes('@') && !/^\d+$/.test(s.eventId))).toBe(true) // OT-15 非裸时间戳
    const first = await otOk(nextOp('flush1'), 'ot.samples.ingest', { ...gw.toPayload(pending) })
    expect(first['inserted']).toBe(4)
    // STOP-01 点位未登记 → 隔离（OT-08：未登记点位数据保留进隔离态）
    expect(first['quarantined']).toBe(2)
    const countBefore = (await pool.query(`SELECT count(*)::int AS c FROM ot_sample`)).rows[0]!.c
    // 重传同批（OT-16）：新 operationId、同事件 ID → 幂等丢弃 + 去重计数
    const dupCount = (await pool.query(`SELECT COALESCE(SUM(dedup_count),0)::int AS c FROM ot_stats`)).rows[0]!.c
    const replay = await otOk(nextOp('replay'), 'ot.samples.ingest', { ...gw.toPayload(pending, false) })
    expect(replay['duplicates']).toBe(4)
    expect(replay['inserted']).toBe(0)
    const countAfter = (await pool.query(`SELECT count(*)::int AS c FROM ot_sample`)).rows[0]!.c
    expect(countAfter).toBe(countBefore) // 不重复入池
    const dedupAfter = (await pool.query(`SELECT COALESCE(SUM(dedup_count),0)::int AS c FROM ot_stats`)).rows[0]!.c
    expect(dedupAfter).toBe(dupCount + 4) // 去重计数累计（可观测）
    await gw.flush() // 补传确认后清缓冲并落检查点（OT-15）
    expect(gw.backlog).toBe(0)
  })
})

describe('⑤ OT-17 溢出统计上报', () => {
  it('边缘上报溢出 → ot_stats 累计 + 网关事件留痕（不静默丢弃）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await otOk(nextOp('ovf'), 'ot.samples.ingest', {
      gatewayCode: 'GW-OT-A',
      samples: [sample('DEV-OT-A', 'LEN-01', 900, nowIso(), 1)],
      overflow: { count: 3, firstAt: isoMinus(120), lastAt: isoMinus(60), deviceSerials: ['DEV-OT-A'] },
    })
    const stats = await pool.query(
      `SELECT overflow_count, overflow_first_at, overflow_last_at FROM ot_stats WHERE gateway_code = 'GW-OT-A' AND device_serial = 'DEV-OT-A'`,
    )
    expect(stats.rows[0]!.overflow_count).toBeGreaterThanOrEqual(3)
    expect(stats.rows[0]!.overflow_first_at).not.toBeNull()
    const events = await pool.query(
      `SELECT count(*)::int AS c FROM ot_gateway_event WHERE gateway_code = 'GW-OT-A' AND event_kind = 'overflow'`,
    )
    expect(events.rows[0]!.c).toBe(1)
  })
})

describe('⑥ OT-19/S4 乱序迟到与班次汇总显式重建', () => {
  it('迟到样本（低序号补传）标记并补插分钟汇总；班次汇总不受迟到影响、仅显式重建刷新', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 专用时间线设备（24h 阈值；时间线锚定 now−2h 动态生成，OT-20 offset 源不误触发；
    // 迟到=低序号补传——网关单调序号随生成序）
    await otOk(nextOp('bind-t'), 'ot.device.bind', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-T',
      gatewayCode: 'GW-OT-A',
      equipmentId: fx.equipmentId,
      clockSkewThresholdSeconds: 86400,
    })
    await otOk(nextOp('pts-t'), 'ot.point.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-T',
      points: [{ pointCode: 'T-LEN-01', semantic: 'meter_length', uomCode: 'M', sampleRateSeconds: 1, rangeMin: 0, rangeMax: 10000, participatesInBusiness: true }],
    })
    await otOk(nextOp('qmap-t'), 'ot.quality-map.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-T',
      entries: [{ code: '0', level: 'good' }],
    })
    // 高序号样本分钟取整（:00），低序号补传=前一分钟:30——复刻 高:00/低:30s 跨分钟结构
    const tHighMs = floorMinuteMs(Date.now() - 2 * 3600_000)
    const lateIso = isoAt(tHighMs, -30_000)
    await otOk(nextOp('late1'), 'ot.samples.ingest', {
      gatewayCode: 'GW-OT-A',
      samples: [sample('DEV-OT-T', 'T-LEN-01', 10, isoAt(tHighMs, 0), 5)],
    })
    const before = await pool.query(
      `SELECT count(*)::int AS c FROM ot_aggregate WHERE granularity = 'shift'`,
    )
    // 低序号补传（网关重放缓冲）：事件时间早于已入池最大事件时间 → 迟到（非倒跳）
    await otOk(nextOp('late2'), 'ot.samples.ingest', {
      gatewayCode: 'GW-OT-A',
      samples: [sample('DEV-OT-T', 'T-LEN-01', 5, lateIso, 3)],
    })
    const lateRow = await pool.query(`SELECT is_late, is_clock_skew FROM ot_sample WHERE device_serial = 'DEV-OT-T' AND gateway_seq = 5`)
    expect(lateRow.rows[0]!.is_late).toBe(true)
    expect(lateRow.rows[0]!.is_clock_skew).toBe(false) // 低序号补传≠倒跳（OT-20 语义边界）
    // 分钟汇总补插（迟到样本所在分钟窗口新建，OT-19 允许补插）
    const minute19 = await pool.query(
      `SELECT sample_count FROM ot_aggregate WHERE granularity = 'minute' AND device_serial = 'DEV-OT-T' AND window_start = $1`,
      [minuteWindowStart(lateIso)],
    )
    expect(minute19.rows[0]!.sample_count).toBe(1)
    // 班次汇总零变化（不因迟到重算已生成的班次汇总——尚未生成也不自动生成）
    const after = await pool.query(`SELECT count(*)::int AS c FROM ot_aggregate WHERE granularity = 'shift'`)
    expect(after.rows[0]!.c).toBe(before.rows[0]!.c)
    // 显式重建（OT-S4）：班次汇总自原始层重建（含迟到样本）
    const rebuild = await otOk(nextOp('rb'), 'ot.aggregate.rebuild', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-T',
      granularity: 'shift',
      from: isoAt(tHighMs, -3600_000),
      to: isoAt(tHighMs, 3600_000),
    })
    expect(rebuild['windowsWritten']).toBeGreaterThan(0)
    // 班次日按天分窗：两样本可能跨午夜分属两窗，按合计断言（含迟到样本 ≥2）
    const shiftRow = await pool.query(
      `SELECT COALESCE(SUM(sample_count),0)::int AS c FROM ot_aggregate WHERE granularity = 'shift' AND device_serial = 'DEV-OT-T'`,
    )
    expect(shiftRow.rows[0]!.c).toBeGreaterThanOrEqual(2)
  })
})

describe('⑦ OT-20 时钟偏差', () => {
  it('偏差超阈值标记且不进汇总 sampleCount（不参与班次归属自动统计）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await otOk(nextOp('skew'), 'ot.samples.ingest', {
      gatewayCode: 'GW-OT-A',
      samples: [sample('DEV-OT-K', 'LEN-01', 1, isoMinus(600), 7)], // 10 分钟前 > 120 秒阈值
    })
    const row = await pool.query(
      `SELECT is_clock_skew, clock_skew_kind, session_link_status FROM ot_sample WHERE device_serial = 'DEV-OT-K'`,
    )
    expect(row.rows[0]!.is_clock_skew).toBe(true)
    expect(row.rows[0]!.clock_skew_kind).toBe('offset')
    expect(row.rows[0]!.session_link_status).toBe('unlinked') // 偏差样本不参与班次归属自动统计
    const agg = await pool.query(
      `SELECT COALESCE(SUM(sample_count),0)::int AS c FROM ot_aggregate WHERE device_serial = 'DEV-OT-K'`,
    )
    expect(agg.rows[0]!.c).toBe(0)
  })
})

describe('⑧ OT-21/22 坏点三源与可见性', () => {
  it('质量 bad/量程越界/维修期间采集 → 坏点带原因、不计入汇总、坏点率可查', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 维修设备：登记并绑定（equipment_status=2）
    await otOk(nextOp('bind-r'), 'ot.device.bind', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-R',
      gatewayCode: 'GW-OT-A',
      equipmentId: fx.repairEquipmentId,
    })
    await otOk(nextOp('pts-r'), 'ot.point.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-R',
      points: [{ pointCode: 'TEMP-01', semantic: 'temperature', uomCode: 'M', sampleRateSeconds: 1, rangeMin: 0, rangeMax: 100 }],
    })
    const badIngestAt = nowIso()
    await otOk(nextOp('bad3'), 'ot.samples.ingest', {
      gatewayCode: 'GW-OT-A',
      samples: [
        sample('DEV-OT-A', 'LEN-01', 920, badIngestAt, 999999, 'M', '192'), // 质量 bad + 越界
        sample('DEV-OT-R', 'TEMP-01', 1, badIngestAt, 50), // 维修期间采集
        sample('DEV-OT-A', 'LEN-01', 921, badIngestAt, 100), // 合格对照
      ],
    })
    const badRows = await pool.query(
      `SELECT bad_reasons FROM ot_sample WHERE device_serial = 'DEV-OT-A' AND gateway_seq = 920`,
    )
    expect(badRows.rows[0]!.bad_reasons).toEqual(['quality_bad', 'out_of_range'])
    const repairRow = await pool.query(`SELECT bad_reasons FROM ot_sample WHERE device_serial = 'DEV-OT-R'`)
    expect(repairRow.rows[0]!.bad_reasons).toEqual(['equipment_under_repair'])
    // 坏点可见（OT-22）：查询按设备+isBad 过滤返回带原因
    const visible = await pool.query(
      `SELECT count(*)::int AS c FROM ot_sample WHERE device_serial = 'DEV-OT-A' AND is_bad`,
    )
    expect(visible.rows[0]!.c).toBe(1)
    // 汇总排除坏点：合格对照计入、坏点只进 bad_count（按 920/921 所在分钟窗口断言）
    const agg = await pool.query(
      `SELECT sample_count, good_count, bad_count FROM ot_aggregate WHERE device_serial = 'DEV-OT-A' AND granularity = 'minute' AND window_start = $1`,
      [minuteWindowStart(badIngestAt)],
    )
    expect(agg.rows[0]!.bad_count).toBeGreaterThanOrEqual(1)
    expect(agg.rows[0]!.sample_count).toBeGreaterThanOrEqual(1)
  })
})

describe('⑨ OT-12 校准过期', () => {
  it('校准过期期间采集样本标"校准状态可疑"', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await otOk(nextOp('cal'), 'ot.samples.ingest', {
      gatewayCode: 'GW-OT-A',
      samples: [sample('DEV-OT-A', 'CAL-01', 930, nowIso(), 1)],
    })
    const row = await pool.query(`SELECT calibration_suspect FROM ot_sample WHERE device_serial = 'DEV-OT-A' AND point_code = 'CAL-01'`)
    expect(row.rows[0]!.calibration_suspect).toBe(true)
  })
})

describe('⑩ OT-13 会话三态与人工绑定', () => {
  it('恰一个覆盖→自动绑定；多个覆盖→待确认；无会话→未关联；人工绑定留痕', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 会话设备（24h 阈值使历史样本不触发时钟偏差）
    await otOk(nextOp('bind-s'), 'ot.device.bind', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-S',
      gatewayCode: 'GW-OT-A',
      equipmentId: fx.equipmentId,
      clockSkewThresholdSeconds: 86400,
    })
    await otOk(nextOp('bind-n'), 'ot.device.bind', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-N',
      gatewayCode: 'GW-OT-A',
      equipmentId: (await pool.query<{ id: string }>(`SELECT id FROM equipment WHERE code = 'EQU-OT-N1'`)).rows[0]!.id,
    })
    await otOk(nextOp('pts-s'), 'ot.point.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-S',
      points: [{ pointCode: 'S-LEN-01', semantic: 'meter_length', uomCode: 'M', sampleRateSeconds: 1 }],
    })
    await otOk(nextOp('pts-n'), 'ot.point.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-N',
      points: [{ pointCode: 'N-LEN-01', semantic: 'meter_length', uomCode: 'M', sampleRateSeconds: 1 }],
    })
    await otOk(nextOp('qmap-s'), 'ot.quality-map.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-S',
      entries: [{ code: '0', level: 'good' }],
    })
    // 会话样本时间锚定 fixture 会话锚（now−4h）：重叠窗 [锚, 锚+30min)、仅会话1区 链+30min 起
    const anchorMs = Date.parse(fx.sessionAnchorIso)
    await otOk(nextOp('sess'), 'ot.samples.ingest', {
      gatewayCode: 'GW-OT-A',
      samples: [
        sample('DEV-OT-S', 'S-LEN-01', 1, isoAt(anchorMs, 10 * 60_000), 1), // 会话1(锚起,开放)+会话2(锚−1h~锚+30min) → 待确认
        sample('DEV-OT-S', 'S-LEN-01', 2, isoAt(anchorMs, 60 * 60_000), 1), // 仅会话1 → 自动绑定
        sample('DEV-OT-N', 'N-LEN-01', 1, isoAt(anchorMs, 60 * 60_000), 1), // 无会话 → 未关联
      ],
    })
    const linkStatus = async (seq: number) =>
      (await pool.query<{ session_link_status: string; session_id: string | null }>(
        `SELECT session_link_status, session_id FROM ot_sample WHERE device_serial = 'DEV-OT-S' AND gateway_seq = $1`,
        [seq],
      )).rows[0]
    const s1 = await linkStatus(1)
    const s2 = await linkStatus(2)
    expect(s1, `样本1(锚+10min 双会话覆盖) 实际=${JSON.stringify(s1)}`).toMatchObject({ session_link_status: 'pending_confirm', session_id: null })
    expect(s2, `样本2(锚+60min 仅会话1) 实际=${JSON.stringify(s2)}`).toMatchObject({ session_link_status: 'auto_bound', session_id: fx.session1Id })
    const nRow = await pool.query(`SELECT session_link_status FROM ot_sample WHERE device_serial = 'DEV-OT-N'`)
    expect(nRow.rows[0]!.session_link_status).toBe('unlinked')
    // 人工绑定（OT-13：待确认样本人工绑定留痕，不自动静默改绑）
    const pendingId = (await pool.query<{ id: string }>(`SELECT id FROM ot_sample WHERE device_serial = 'DEV-OT-S' AND gateway_seq = 1`)).rows[0]!.id
    await otOk(nextOp('link'), 'ot.session.link', {
      plantId: fx.szPlantId,
      sampleId: pendingId,
      sessionId: fx.session2Id,
      reason: '人工纠错：归属早班会话',
    })
    expect(await linkStatus(1)).toMatchObject({ session_link_status: 'manual_bound', session_id: fx.session2Id })
    const audit = await pool.query(
      `SELECT count(*)::int AS c FROM audit_entry WHERE action = 'ot.session.link' AND subject_id = $1`,
      [pendingId],
    )
    expect(audit.rows[0]!.c).toBe(1)
  })
})

describe('⑪ OT-23/24 容量分层：2,000 样本单批入原始层，Outbox 零增长', () => {
  it('100 设备×20 点×1 tick=2,000 样本：全部入 ot_sample，outbox 不增（不写业务事件表），汇总层建成', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const serials = Array.from({ length: 100 }, (_, i) => `DEV-LOAD-${String(i + 1).padStart(3, '0')}`)
    await otOk(nextOp('gwload'), 'ot.gateway.register', {
      plantId: fx.szPlantId,
      gatewayCode: 'GW-OT-LOAD',
      sampleRateHz: 20,
      bufferCapacity: 50000,
      deviceSerials: serials,
    })
    for (const serial of serials) {
      await otOk(nextOp(`bind-${serial}`), 'ot.device.bind', {
        plantId: fx.szPlantId,
        deviceSerial: serial,
        gatewayCode: 'GW-OT-LOAD',
        equipmentId: fx.equipmentId,
      })
      await otOk(nextOp(`pts-${serial}`), 'ot.point.upsert', {
        plantId: fx.szPlantId,
        deviceSerial: serial,
        points: Array.from({ length: 20 }, (_, p) => ({
          pointCode: `${serial}-P${String(p + 1).padStart(2, '0')}`,
          semantic: 'other',
          uomCode: 'M',
          sampleRateSeconds: 1,
        })),
      })
    }
    let loadSeq = 0
    const loadSamples = serials.flatMap((serial, di) =>
      Array.from({ length: 20 }, (_, p) => sample(serial, `${serial}-P${String(p + 1).padStart(2, '0')}`, ++loadSeq, nowIso(), di + p)),
    )
    const outboxBefore = (await pool.query(`SELECT count(*)::int AS c FROM outbox`)).rows[0]!.c
    const load = await otOk(nextOp('load'), 'ot.samples.ingest', {
      gatewayCode: 'GW-OT-LOAD',
      samples: loadSamples,
      checkpointSeq: 1,
    })
    expect(load['received']).toBe(2000)
    expect(load['inserted']).toBe(2000)
    expect(load['quarantined']).toBe(0)
    const sampleCount = (await pool.query(`SELECT count(*)::int AS c FROM ot_sample WHERE gateway_code = 'GW-OT-LOAD'`)).rows[0]!.c
    expect(sampleCount).toBe(2000)
    const outboxAfter = (await pool.query(`SELECT count(*)::int AS c FROM outbox`)).rows[0]!.c
    expect(outboxAfter).toBe(outboxBefore) // OT-24：分层存储，不写业务事件表
    const aggCount = (await pool.query(`SELECT count(*)::int AS c FROM ot_aggregate WHERE device_serial LIKE 'DEV-LOAD-%'`)).rows[0]!.c
    expect(aggCount).toBe(2000) // 分钟汇总层同步建成
  }, 180_000)
})

describe('⑫ OT-26 业务事实映射（auto/manual）', () => {
  it('auto：评估→派发+Outbox 任务行；重复评估幂等跳过；manual：待确认→确认派发；确认幂等', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 在专用时间线设备（⑥ 已建 DEV-OT-T/T-LEN-01，24h 阈值自洽）上补登记停机点位
    await otOk(nextOp('pts-stop'), 'ot.point.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-T',
      points: [{ pointCode: 'T-STOP-01', semantic: 'stop_signal', uomCode: 'LVL', sampleRateSeconds: 1, participatesInBusiness: true }],
    })
    const meter = await otOk(nextOp('map-m'), 'ot.mapping.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-T',
      pointCode: 'T-LEN-01',
      factKind: 'meter_to_quantity',
      confirmMode: 'auto',
    })
    // 载入 3 个合格计长样本（评估窗口内，序号续 ⑥ 的 10 之后；时间锚 now−90min 分钟取整）
    const meterMs = floorMinuteMs(Date.now() - 90 * 60_000)
    await otOk(nextOp('m-samples'), 'ot.samples.ingest', {
      gatewayCode: 'GW-OT-A',
      samples: [
        sample('DEV-OT-T', 'T-LEN-01', 20, isoAt(meterMs, 0), 10),
        sample('DEV-OT-T', 'T-LEN-01', 21, isoAt(meterMs, 1_000), 20),
        sample('DEV-OT-T', 'T-LEN-01', 22, isoAt(meterMs, 2_000), 30),
      ],
    })
    const outboxBefore = (await pool.query(`SELECT count(*)::int AS c FROM outbox`)).rows[0]!.c
    const eval1 = await otOk(nextOp('map-e1'), 'ot.mapping.evaluate', {
      plantId: fx.szPlantId,
      mappingId: meter['mappingId'],
      from: isoAt(meterMs, -60_000),
      to: isoAt(meterMs, 60_000),
    })
    expect(eval1['created']).toBe(1)
    expect(eval1['dispatched']).toBe(1)
    const factRow = await pool.query(`SELECT value, status, outbox_event_id FROM ot_business_fact WHERE mapping_id = $1`, [
      meter['mappingId'],
    ])
    expect(Number(factRow.rows[0]!.value)).toBeCloseTo(60, 2) // 10+20+30（合格样本求和）
    expect(factRow.rows[0]!.status).toBe('dispatched')
    expect(factRow.rows[0]!.outbox_event_id).not.toBeNull()
    const outboxTask = await pool.query(
      `SELECT task_kind, payload FROM outbox WHERE event_id = $1`,
      [factRow.rows[0]!.outbox_event_id],
    )
    expect(outboxTask.rows[0]!.task_kind).toBe('ot.business-fact')
    expect((outboxTask.rows[0]!.payload as Record<string, unknown>)['value']).not.toBeNull() // 时点快照载荷
    // 重复评估同窗口 → 幂等跳过，不新增 outbox
    const eval2 = await otOk(nextOp('map-e2'), 'ot.mapping.evaluate', {
      plantId: fx.szPlantId,
      mappingId: meter['mappingId'],
      from: isoAt(meterMs, -60_000),
      to: isoAt(meterMs, 60_000),
    })
    expect(eval2['created']).toBe(0)
    expect(eval2['skipped']).toBe(1)
    const outboxMid = (await pool.query(`SELECT count(*)::int AS c FROM outbox`)).rows[0]!.c
    expect(outboxMid).toBe(outboxBefore + 1)
    // manual：停机映射（停机段时间锚 now−60min 分钟取整，恢复于 +2s；单位 LVL 与点位一致）
    const stopMs = floorMinuteMs(Date.now() - 60 * 60_000)
    await otOk(nextOp('stop-s'), 'ot.samples.ingest', {
      gatewayCode: 'GW-OT-A',
      samples: [
        sample('DEV-OT-T', 'T-STOP-01', 30, isoAt(stopMs, 0), 1, 'LVL'),
        sample('DEV-OT-T', 'T-STOP-01', 31, isoAt(stopMs, 1_000), 1, 'LVL'),
        sample('DEV-OT-T', 'T-STOP-01', 32, isoAt(stopMs, 2_000), 0, 'LVL'),
      ],
    })
    const stopMap = await otOk(nextOp('map-s'), 'ot.mapping.upsert', {
      plantId: fx.szPlantId,
      deviceSerial: 'DEV-OT-T',
      pointCode: 'T-STOP-01',
      factKind: 'stop_to_downtime',
      confirmMode: 'manual',
    })
    const stopEval = await otOk(nextOp('map-se'), 'ot.mapping.evaluate', {
      plantId: fx.szPlantId,
      mappingId: stopMap['mappingId'],
      from: isoAt(stopMs, -60_000),
      to: isoAt(stopMs, 60_000),
    })
    expect(stopEval['created']).toBe(1)
    expect(stopEval['dispatched']).toBe(0) // manual → 待确认
    const pendingFact = await pool.query<{ id: string; status: string; window_start: string }>(
      `SELECT id, status, window_start FROM ot_business_fact WHERE mapping_id = $1`,
      [stopMap['mappingId']],
    )
    expect(pendingFact.rows[0]!.status).toBe('pending_confirm')
    expect(new Date(pendingFact.rows[0]!.window_start).toISOString()).toBe(isoAt(stopMs, 0)) // 段起点=首个停机样本事件时间
    const confirm1 = await otOk(nextOp('map-c'), 'ot.mapping.confirm', { factId: pendingFact.rows[0]!.id })
    expect(confirm1['dispatched']).toBe(true)
    const confirm2 = await otOk(nextOp('map-c2'), 'ot.mapping.confirm', { factId: pendingFact.rows[0]!.id })
    expect(confirm2['dispatched']).toBe(false) // 幂等：不重复派发
    const outboxFinal = (await pool.query(`SELECT count(*)::int AS c FROM outbox`)).rows[0]!.c
    expect(outboxFinal).toBe(outboxBefore + 2)
  })
})

describe('⑬ OT-28 缺采集不产生假值', () => {
  it('已登记但无样本的设备：最后样本为空（缺项），不以估算冒充实测', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // DEV-OT-Z：网关注册登记但从未上报
    await otOk(nextOp('gwreg2'), 'ot.gateway.register', {
      plantId: fx.szPlantId,
      gatewayCode: 'GW-OT-Z',
      deviceSerials: ['DEV-OT-Z'],
    })
    const last = await pool.query(
      `SELECT max(event_time) AS m FROM ot_sample WHERE device_serial = 'DEV-OT-Z'`,
    )
    expect(last.rows[0]!.m).toBeNull() // 无样本 → 指标缺项（HTTP 监控面断言见 ot-api.spec.ts）
  })
})

describe('⑭ 命令幂等（同 operationId 重放原结果回放）', () => {
  it('入池命令同 opId 重放：data 全等、样本行数不变', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const opId = nextOp('idem')
    const payload = {
      gatewayCode: 'GW-OT-A',
      samples: [sample('DEV-OT-A', 'LEN-01', 960, '2026-10-28T08:50:00Z', 42)],
    }
    const first = await ot(opId, 'ot.samples.ingest', payload)
    expect(first.status).toBe(CommandResultStatus.COMMITTED)
    const count1 = (await pool.query(`SELECT count(*)::int AS c FROM ot_sample WHERE device_serial = 'DEV-OT-A' AND gateway_seq = 960`)).rows[0]!.c
    expect(count1).toBe(1)
    const replay = await ot(opId, 'ot.samples.ingest', payload)
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect(replay.data).toEqual(first.data)
    const count2 = (await pool.query(`SELECT count(*)::int AS c FROM ot_sample WHERE device_serial = 'DEV-OT-A' AND gateway_seq = 960`)).rows[0]!.c
    expect(count2).toBe(1)
  })
})
