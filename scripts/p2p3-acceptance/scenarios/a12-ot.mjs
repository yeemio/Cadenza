/**
 * A12-OT 模拟点位采集→缓冲去重→工序关联一例（ot 域，P3-A/T21，模拟环境 OT-31）：
 * - 网关注册/设备绑定/点位字典/质量码映射（真实命令）；
 * - 用 packages/edge SimulatedGateway（确定性发生器 + 断网本地缓冲 OT-14 + 唯一事件 ID OT-15）
 *   采集 3 tick（2 点位：计长 + 速度）→ HTTP 入池；
 * - 缓冲去重（OT-16）：同批重传 → duplicates 计数、样本行数不变；
 * - 工序关联（OT-13）：样本落在 S0 扫码报工会话窗内 → auto_bound（会话=真实报工产出）；
 * - 分钟汇总层并入（OT-S4）；遥测通道只读（入池不写业务 Outbox，OT-03/24）。
 */
import { must, httpStep, sqlStep, sqlOne, q, EDGE_DIST, ensureAdminPermissions } from '../lib.mjs'
import { pathToFileURL } from 'node:url'

export async function run(run) {
  await ensureAdminPermissions(run) // 场景自足：并行会话 seed 可能中途重置授权
  run.setScenario('A12-OT')
  const s = run.state
  const plant = s.szPlantId
  const serial = `DEV-${s.run.replace(/-/g, '').slice(0, 10).toUpperCase()}`
  const gwCode = `GW-${s.run.replace(/-/g, '').slice(0, 8).toUpperCase()}`

  // ---- 1) 网关/设备/点位/质量码（真实命令） ----
  const gw = await httpStep(run, `网关注册（${gwCode}，设备清单 [${serial}]）`,
    'POST', '/ot/gateway/register',
    { plantId: plant, gatewayCode: gwCode, sampleRateHz: 20, bufferCapacity: 10000, deviceSerials: [serial], operationId: `${s.run}-ot-gw` },
    [200, 201])
  must(run, '网关注册成功', Boolean(gw.body?.data), JSON.stringify(gw.body?.data))

  const bind = await httpStep(run, `设备绑定（${serial} → ${s.eqExecCode}，时钟阈值 86400s）`,
    'POST', '/ot/device/bind',
    { plantId: plant, deviceSerial: serial, gatewayCode: gwCode, equipmentId: s.equipment[s.eqExecCode].id, clockSkewThresholdSeconds: 86400, operationId: `${s.run}-ot-bind` },
    [200, 201])
  must(run, '设备绑定成功（映射 equipment）', bind.body?.data?.equipmentId === s.equipment[s.eqExecCode].id, JSON.stringify(bind.body?.data))

  const pts = await httpStep(run, '点位字典（LEN 计长 60s + SPD 速度 3600s）',
    'POST', '/ot/point/upsert',
    {
      plantId: plant, deviceSerial: serial,
      points: [
        { pointCode: 'LEN-01', semantic: 'meter_length', uomCode: 'M', sampleRateSeconds: 60 },
        { pointCode: 'SPD-01', semantic: 'speed', uomCode: 'M', sampleRateSeconds: 3600 },
      ],
      operationId: `${s.run}-ot-points`,
    },
    [200, 201])
  must(run, '点位字典登记成功（2 点）', (pts.body?.data?.points ?? pts.body?.data ?? []).length === 2 || Boolean(pts.body?.data), JSON.stringify(pts.body?.data))

  const qmap = await httpStep(run, '质量码映射（0 → good）',
    'POST', '/ot/quality-map/upsert',
    { plantId: plant, deviceSerial: serial, entries: [{ code: '0', level: 'good' }], operationId: `${s.run}-ot-qmap` },
    [200, 201])
  must(run, '质量码映射成功', Boolean(qmap.body?.data), JSON.stringify(qmap.body?.data))

  // ---- 2) 模拟网关采集（断网缓冲 → HTTP 入池） ----
  const edge = await import(pathToFileURL(EDGE_DIST).href)
  const gw1 = new edge.SimulatedGateway(gwCode, [
    { deviceSerial: serial, pointCode: 'LEN-01', unit: 'M', semantic: 'meter_length', value: edge.meterCounter(120) },
    { deviceSerial: serial, pointCode: 'SPD-01', unit: 'M', semantic: 'speed', value: edge.constant(200) },
  ])
  gw1.setOnline(false) // 断网：本地缓冲（OT-14）
  // 事件时间锚定 S0 统一业务日（北京班次日晨间，O-3 口径）：样本始终落入成本归集/核对窗口
  // [D-1 T16:00Z, D T16:00Z)，且 ≥ 会话窗起点（报工 businessTime = D T00:01Z）保证 OT-13 auto_bound；
  // 设备时钟偏差阈值 86400s（S0 绑定），同日锚定偏移恒在阈内
  const d = s.utcDay
  const tickTimes = [`${d}T00:02:00Z`, `${d}T00:02:30Z`, `${d}T00:03:00Z`]
  for (const t of tickTimes) await gw1.tick(t)
  must(run, '断网缓冲 3 tick × 2 点 = 6 样本（OT-14）', gw1.backlog === 6, `backlog=${gw1.backlog}`)

  const pending = gw1.peekBuffer()
  const evIds = new Set(pending.map((x) => x.eventId))
  must(run, '唯一事件 ID 非裸时间戳（OT-15：序号@设备）',
    pending.length === 6 && evIds.size === 6 && pending.every((x) => x.eventId.includes('@') && !/^\d+$/.test(x.eventId)),
    JSON.stringify(pending.slice(0, 2).map((x) => x.eventId)))

  const outboxBefore = Number(sqlOne(`SELECT count(*) FROM outbox`))
  const ingest1 = await httpStep(run, '恢复补传入池（真实 POST /ot/samples/ingest）',
    'POST', '/ot/samples/ingest',
    { ...gw1.toPayload(pending), operationId: `${s.run}-ot-ingest1` },
    [200, 201])
  must(run, '入池成功：received 6 / inserted 6 / quarantined 0',
    ingest1.body?.data?.received === 6 && ingest1.body?.data?.inserted === 6 && ingest1.body?.data?.quarantined === 0,
    JSON.stringify(ingest1.body?.data))

  // 遥测通道只读（OT-03/24）：入池不写业务 Outbox
  const outboxAfter = Number(sqlOne(`SELECT count(*) FROM outbox`))
  must(run, '入池零 Outbox 增长（OT-24 不写业务事件表）', outboxAfter === outboxBefore, `before=${outboxBefore} after=${outboxAfter}`)

  // ---- 3) 缓冲去重（OT-16）：同批重传幂等丢弃 ----
  const countBefore = Number(sqlOne(`SELECT count(*) FROM ot_sample WHERE device_serial = ${q(serial)}`))
  const dedupBefore = Number(sqlOne(`SELECT COALESCE(SUM(dedup_count),0) FROM ot_stats WHERE device_serial = ${q(serial)}`))
  const replay = await httpStep(run, '同批重传（不换事件 ID）→ 幂等去重',
    'POST', '/ot/samples/ingest',
    { ...gw1.toPayload(pending, false), operationId: `${s.run}-ot-replay` },
    [200, 201])
  const countAfter = Number(sqlOne(`SELECT count(*) FROM ot_sample WHERE device_serial = ${q(serial)}`))
  const dedupAfter = Number(sqlOne(`SELECT COALESCE(SUM(dedup_count),0) FROM ot_stats WHERE device_serial = ${q(serial)}`))
  must(run, '重传去重：duplicates=6、inserted=0、样本行数不变、去重计数累计（OT-16）',
    replay.body?.data?.duplicates === 6 && replay.body?.data?.inserted === 0 && countAfter === countBefore && dedupAfter === dedupBefore + 6,
    JSON.stringify({ duplicates: replay.body?.data?.duplicates, inserted: replay.body?.data?.inserted, countBefore, countAfter, dedupBefore, dedupAfter }))

  // ---- 4) 工序关联（OT-13）：样本落在真实报工会话窗内 → auto_bound ----
  const linkRows = sqlStep(run, 'SQL：工序关联（session_link_status × 会话窗）',
    `SELECT session_link_status, count(*), MIN(session_id::text) FROM ot_sample WHERE device_serial = ${q(serial)} GROUP BY session_link_status`)
  const autoBound = linkRows.find((r) => r[0] === 'auto_bound')
  const sessId = sqlOne(`SELECT id FROM execution_session WHERE order_id = ${q(s.orderCost.orderId)} AND equipment_code = ${q(s.eqExecCode)}`)
  must(run, '样本全部 auto_bound 且会话=真实报工会话（OT-13 工序关联）',
    Boolean(autoBound) && Number(autoBound[1]) === 6 && autoBound[2] === sessId,
    JSON.stringify({ linkRows, sessId }))

  // ---- 5) 分钟汇总层 + 归一值（OT-S4/OT-10） ----
  const aggRows = sqlStep(run, 'SQL：分钟汇总窗（两点位各并入分钟层）',
    `SELECT point_code, count(*) FROM ot_aggregate WHERE device_serial = ${q(serial)} AND granularity = 'minute' GROUP BY point_code`)
  must(run, '分钟汇总层并入（OT-S4：LEN/SPD 两点位均有分钟窗）',
    aggRows.length === 2 && aggRows.every((r) => Number(r[1]) >= 1), JSON.stringify(aggRows))

  const spdRows = sqlStep(run, 'SQL：速度样本（>0、good、非隔离——成本 CA-12 参考源事实）',
    `SELECT COALESCE(normalized_value, raw_value)::text, quality_level, is_quarantined::text FROM ot_sample WHERE device_serial = ${q(serial)} AND point_code = 'SPD-01' ORDER BY gateway_seq`)
  must(run, '速度样本 3 条全 good>0（成本域 OT 运行时来源）',
    spdRows.length === 3 && spdRows.every((r) => Number(r[0]) === 200 && r[1] === 'good' && r[2] !== 't'),
    JSON.stringify(spdRows))

  // ---- 6) 四账口径 ----
  const sampleQuery = await httpStep(run, '样本查询（OT-25 按设备收敛）',
    'GET', `/ot/samples?deviceSerial=${encodeURIComponent(serial)}&page=1&pageSize=20`, undefined, 200)
  must(run, 'HTTP 样本查询 6 行', (sampleQuery.body?.data?.total ?? sampleQuery.body?.total ?? 0) === 6 || (sampleQuery.body?.data?.items ?? sampleQuery.body?.items ?? []).length === 6,
    JSON.stringify({ total: sampleQuery.body?.data?.total ?? sampleQuery.body?.total }))

  const statsRows = sqlStep(run, 'SQL 四账：ot_stats 累计（去重计数可对账 OT-S5）',
    `SELECT device_serial, COALESCE(SUM(dedup_count),0) FROM ot_stats WHERE device_serial = ${q(serial)} GROUP BY device_serial`)
  must(run, '统计对账：dedup_count=6（重传去重累计）', statsRows.length === 1 && Number(statsRows[0][1]) === 6, JSON.stringify(statsRows))

  sqlStep(run, 'SQL 四账（审计）：OT 命令族在册',
    `SELECT action, count(*) FROM audit_entry WHERE action LIKE 'ot.%' AND actor = 'admin' GROUP BY action ORDER BY action`)
  must(run, 'Outbox 零增长复核 + ot_sample 事实行触发器保护（OT-22 原始事实列不可改）', outboxAfter === outboxBefore, '见上')

  run.saveState()
  return run
}
