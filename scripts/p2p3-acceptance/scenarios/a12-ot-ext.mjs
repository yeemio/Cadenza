/**
 * A12-OT 扩展（ot 域：工序关联三态其余两态 + 坏点/时钟偏差不参与判定，OT-13/20/21/22）：
 * - 第二报工会话（真实命令，同设备时间窗重叠）→ 重叠窗样本 pending_confirm；
 * - 窗口外样本 unlinked（时间窗不命中）；时钟偏差样本（ahead）标 skew 且不自动绑定；
 * - 人工绑定/纠错（ot.session.link：pending→manual_bound→unlinked 留痕，OT-13 不静默改绑）；
 * - 坏点（质量码 bad）样本：is_bad + 原因可见（OT-22）、分钟汇总 badCount 分列（OT-21 不入判定侧）；
 * - 判定侧排除复证：以 cost 域机时来源同款 SQL（good∧非隔离∧非坏点∧速度语义）证明坏点/偏差样本
 *   不进入成本机时口径（OT-21 不入成本能耗归集）。
 */
import { must, httpStep, sqlStep, sqlOne, q, ensureAdminPermissions, UOM_M_ID } from '../lib.mjs'

export async function run(run) {
  await ensureAdminPermissions(run) // 场景自足：并行会话 seed 可能中途重置授权
  run.setScenario('A12-OT-EXT')
  const s = run.state
  const plant = s.szPlantId
  const tag = s.run.replace(/[^0-9A-Za-z]/g, '').slice(0, 10).toUpperCase()
  const serial = `DEV-${tag}X`
  const gwCode = `GW-${tag}X`
  const d = s.utcDay
  const dayBefore = new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  const dayAhead = new Date(Date.parse(`${d}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10)

  // ---- 1) 网关×2 号机（时钟阈值 172800s：覆盖昨日窗样本且不误伤） ----
  const gw = await httpStep(run, `网关注册（${gwCode}）`,
    'POST', '/ot/gateway/register',
    { plantId: plant, gatewayCode: gwCode, sampleRateHz: 20, bufferCapacity: 10000, deviceSerials: [serial], operationId: `${s.run}-otx-gw` },
    [200, 201])
  must(run, '网关注册成功', Boolean(gw.body?.data), JSON.stringify(gw.body?.data))
  await httpStep(run, `设备绑定（${serial} → ${s.eqExecCode}，时钟阈值 172800s）`,
    'POST', '/ot/device/bind',
    { plantId: plant, deviceSerial: serial, gatewayCode: gwCode, equipmentId: s.equipment[s.eqExecCode].id, clockSkewThresholdSeconds: 172800, operationId: `${s.run}-otx-bind` },
    [200, 201])
  const pts = await httpStep(run, '点位字典（TMP-01 温度 60s + SPD-02 速度 3600s）',
    'POST', '/ot/point/upsert',
    {
      plantId: plant, deviceSerial: serial,
      points: [
        { pointCode: 'TMP-01', semantic: 'temperature', uomCode: 'CEL', sampleRateSeconds: 60 },
        { pointCode: 'SPD-02', semantic: 'speed', uomCode: 'M', sampleRateSeconds: 3600 },
      ],
      operationId: `${s.run}-otx-points`,
    },
    [200, 201])
  must(run, '点位字典登记成功', Boolean(pts.body?.data), JSON.stringify(pts.body?.data))
  await httpStep(run, '质量码映射（0→good、1→bad）',
    'POST', '/ot/quality-map/upsert',
    { plantId: plant, deviceSerial: serial, entries: [{ code: '0', level: 'good' }, { code: '1', level: 'bad' }], operationId: `${s.run}-otx-qmap` },
    [200, 201])

  // ---- 2) 第二报工会话（同设备、时间窗重叠 → 制造双窗覆盖） ----
  const feedReport = await httpStep(run, `第二订单扫码报工 10（${s.eqExecCode}，businessTime=${d}T00:04 → 会话窗与 S0 会话重叠）`,
    'POST', '/execution/scan/reports',
    {
      orderId: s.orderFeed.orderId, orderOperationId: s.orderFeed.op1Id,
      equipmentId: s.equipment[s.eqExecCode].id, equipmentCode: s.eqExecCode,
      outputs: [{
        quantity: '10.0000', uomId: UOM_M_ID, uomCode: 'M',
        targetLocationId: s.loc.whLine, targetLocationCode: s.loc.whLineCode,
        ownerId: s.entId, ownerName: '华东电缆集团（自有）',
      }],
      businessTime: `${d}T00:04:00Z`, operationId: `${s.run}-otx-report-feed`,
    },
    [200, 201])
  const feedReportId = feedReport.body?.data?.reportId ?? null
  const feedReview = await httpStep(run, '第二会话报工人工审核',
    'POST', `/execution/reports/${feedReportId}/review`, { operationId: `${s.run}-otx-review-feed` }, [200])
  must(run, '第二会话就绪（manual_approved）', feedReview.body?.data?.reviewStatus === 'manual_approved', JSON.stringify(feedReview.body?.data))

  const costSessionId = sqlOne(`SELECT id FROM execution_session WHERE order_id = ${q(s.orderCost.orderId)} AND equipment_code = ${q(s.eqExecCode)}`)
  const feedSessionId = sqlOne(`SELECT id FROM execution_session WHERE order_id = ${q(s.orderFeed.orderId)} AND equipment_code = ${q(s.eqExecCode)}`)
  must(run, '两会话在册（S0 COST 会话 + 本场景 FEED 会话）', Boolean(costSessionId && feedSessionId), `cost=${costSessionId} feed=${feedSessionId}`)

  // ---- 3) 四样本入池：窗口外（unlinked）/重叠窗（pending_confirm）/坏点（bad）/时钟偏差（ahead） ----
  // 注：批次按事件时间升序排列（OT-19 乱序入池；倒跳样本会被判 backward 偏差——本组以时序升序
  //     构造，偏差仅由超前的 ahead 样本承载，四类标记互不串扰）
  const mk = (n, pointCode, eventTime, rawValue, deviceQualityCode, unit) => ({
    deviceSerial: serial, pointCode, eventId: `${serial}@${n}`, eventTime, rawValue, rawUnit: unit, deviceQualityCode,
  })
  const batch = [
    mk(1, 'TMP-01', `${dayBefore}T12:00:00Z`, 44.0, '0', 'CEL'), // 窗口外（两会话起点之前）→ unlinked
    mk(2, 'TMP-01', `${d}T00:05:30Z`, 45.5, '0', 'CEL'), // 双窗覆盖 → pending_confirm
    mk(3, 'SPD-02', `${d}T00:06:00Z`, 300, '1', 'M'), // 质量码 bad → 坏点
    mk(4, 'TMP-01', `${dayAhead}T00:00:00Z`, 46.0, '0', 'CEL'), // 超前 >48h → clock skew(ahead) 不自动绑定
  ]
  const outboxBefore = Number(sqlOne(`SELECT count(*) FROM outbox`))
  const ingest = await httpStep(run, '四样本入池（窗口外/重叠窗/坏点/时钟偏差各一）',
    'POST', '/ot/samples/ingest',
    { gatewayCode: gwCode, samples: batch, operationId: `${s.run}-otx-ingest` },
    [200, 201])
  must(run, '入池成功：received 4 / inserted 4 / quarantined 0 / bad 1 / skew 1',
    ingest.body?.data?.received === 4 && ingest.body?.data?.inserted === 4 &&
      ingest.body?.data?.quarantined === 0 && ingest.body?.data?.bad === 1 && ingest.body?.data?.skew === 1,
    JSON.stringify(ingest.body?.data))

  const outboxAfter = Number(sqlOne(`SELECT count(*) FROM outbox`))
  must(run, '遥测只读复核：入池零 Outbox 增长（OT-03/24）', outboxAfter === outboxBefore, `before=${outboxBefore} after=${outboxAfter}`)

  const rows = sqlStep(run, 'SQL：四样本分类列（三态 + 坏点/偏差标记）',
    `SELECT point_code, event_time::text, session_link_status, session_id IS NOT NULL, is_clock_skew, clock_skew_kind, is_bad, bad_reasons::text, quality_level
     FROM ot_sample WHERE device_serial = ${q(serial)} ORDER BY gateway_seq`)
  must(run, 'OT-13 三态齐备：窗口外 unlinked（非偏差）、重叠窗 pending_confirm（未自动绑）、偏差样本不自动绑定',
    rows.length === 4 && rows[0][2] === 'unlinked' && rows[0][4] === 'f' &&
      rows[1][2] === 'pending_confirm' && rows[1][3] === 'f' &&
      rows[3][2] === 'unlinked' && rows[3][4] === 't' && rows[3][5] === 'ahead',
    JSON.stringify(rows))
  must(run, 'OT-21/22：坏点样本 is_bad + 原因可见 + 质量档 bad',
    rows[2][6] === 't' && String(rows[2][7] ?? '').includes('quality') && rows[2][8] === 'bad',
    JSON.stringify(rows[2]))

  // ---- 4) 人工绑定/纠错（OT-13：留痕，不自动静默改绑） ----
  const s1Id = sqlOne(`SELECT id FROM ot_sample WHERE device_serial = ${q(serial)} AND event_id = ${q(`${serial}@2`)}`)
  const link = await httpStep(run, '人工绑定（pending_confirm → manual_bound，关联 COST 会话）',
    'POST', '/ot/session/link',
    { sampleId: s1Id, sessionId: costSessionId, reason: 'A12-OT 扩展：重叠窗人工确认归属 COST 会话', operationId: `${s.run}-otx-link` },
    [200, 201])
  must(run, '人工绑定成功（manual_bound）', link.body?.data?.sessionLinkStatus === 'manual_bound', JSON.stringify(link.body?.data))

  const unlink = await httpStep(run, '人工纠错解绑（manual_bound → unlinked）',
    'POST', '/ot/session/link',
    { sampleId: s1Id, sessionId: null, reason: 'A12-OT 扩展：绑定纠错解绑留痕', operationId: `${s.run}-otx-unlink` },
    [200, 201])
  must(run, '纠错解绑成功（unlinked）', unlink.body?.data?.sessionLinkStatus === 'unlinked', JSON.stringify(unlink.body?.data))

  const linkAudit = sqlStep(run, 'SQL：人工绑定/解绑审计留痕（ot.session.link 两行）',
    `SELECT count(*) FROM audit_entry WHERE action = 'ot.session.link' AND subject_id = ${q(s1Id)}`)
  must(run, '绑定链留痕在册（before/after 两行审计）', Number(linkAudit[0]?.[0]) === 2, JSON.stringify(linkAudit))

  // ---- 5) 分钟汇总分列（OT-21/OT-S4：good/bad/skew 分列不混算） ----
  const aggRows = sqlStep(run, 'SQL：分钟汇总（good/bad/skew 计数分列）',
    `SELECT point_code, to_char(window_start, 'YYYY-MM-DD"T"HH24:MI'), good_count, bad_count, skew_count
     FROM ot_aggregate WHERE device_serial = ${q(serial)} AND granularity = 'minute' ORDER BY window_start, point_code`)
  const aggBy = Object.fromEntries(aggRows.map((r) => [`${r[0]}@${r[1]}`, { good: Number(r[2]), bad: Number(r[3]), skew: Number(r[4]) }]))
  must(run, '汇总分列：好点 goodCount=1、坏点 badCount=1、偏差点 skewCount=1（不混算）',
    aggBy[`TMP-01@${d}T00:05`]?.good === 1 && aggBy[`SPD-02@${d}T00:06`]?.bad === 1 && aggBy[`TMP-01@${dayAhead}T00:00`]?.skew === 1,
    JSON.stringify(aggBy))

  // ---- 6) 判定侧排除复证：cost 机时来源同款 SQL（good∧非隔离∧非坏点∧速度语义） ----
  const runtimeRows = sqlStep(run, 'SQL：设备机时口径（cost CA-13 同款过滤，坏点/偏差/温度点不入）',
    `SELECT (count(DISTINCT s.event_time) * max(p.sample_rate_seconds))::text AS seconds
     FROM ot_sample s
     JOIN ot_device dv ON dv.device_serial = s.device_serial AND dv.equipment_id = ${q(s.equipment[s.eqExecCode].id)}
     JOIN ot_point p ON p.device_serial = s.device_serial AND p.point_code = s.point_code AND p.semantic = 'speed' AND p.status = 'active'
     WHERE s.event_time >= ${q(`${dayBefore}T16:00:00Z`)} AND s.quality_level = 'good' AND s.is_quarantined = false AND s.is_bad = false
       AND COALESCE(s.normalized_value, s.raw_value) > 0`)
  must(run, 'OT-21 判定排除：机时口径仍 3h（SPD-02 坏点不入，S0 SPD-01 3 事件独占）',
    Number(runtimeRows[0]?.[0]) === 3 * 3600, JSON.stringify(runtimeRows))

  // ---- 7) 查询面：坏点/偏差样本可查（OT-22 保留可查带原因） ----
  const badQuery = await httpStep(run, '坏点样本查询（GET /ot/samples?isBad=true）',
    'GET', `/ot/samples?deviceSerial=${encodeURIComponent(serial)}&isBad=true&page=1&pageSize=10`, undefined, 200)
  const badItems = badQuery.body?.items ?? badQuery.body?.data?.items ?? []
  must(run, '坏点样本查询可见（1 行带原因）', badItems.length === 1, JSON.stringify({ total: badQuery.body?.total ?? badQuery.body?.data?.total }))

  const skewQuery = await httpStep(run, '时钟偏差样本查询（GET /ot/samples?isClockSkew=true）',
    'GET', `/ot/samples?deviceSerial=${encodeURIComponent(serial)}&isClockSkew=true&page=1&pageSize=10`, undefined, 200)
  const skewItems = skewQuery.body?.items ?? skewQuery.body?.data?.items ?? []
  must(run, '偏差样本查询可见（1 行带 kind）', skewItems.length === 1, JSON.stringify({ total: skewQuery.body?.total ?? skewQuery.body?.data?.total }))

  // ---- 8) 四账口径 ----
  const stateRows = sqlStep(run, 'SQL 四账：本设备样本状态分布（三态 + 标记列）',
    `SELECT session_link_status, count(*), sum(CASE WHEN is_bad THEN 1 ELSE 0 END), sum(CASE WHEN is_clock_skew THEN 1 ELSE 0 END)
     FROM ot_sample WHERE device_serial = ${q(serial)} GROUP BY session_link_status ORDER BY session_link_status`)
  const stateMap = Object.fromEntries(stateRows.map((r) => [r[0], { n: Number(r[1]), bad: Number(r[2]), skew: Number(r[3]) }]))
  must(run, '样本对账：重叠窗坏点保持待确认 1（bad 标记随行）、unlinked 3（窗口外/纠错后/偏差）、偏差标记 1',
    stateMap['pending_confirm']?.n === 1 && stateMap['pending_confirm']?.bad === 1 &&
      stateMap['unlinked']?.n === 3 && stateMap['unlinked']?.skew === 1,
    JSON.stringify(stateRows))

  const auditRows = sqlStep(run, 'SQL 四账：OT 扩展审计（入池/绑定/解绑）',
    `SELECT action, count(*) FROM audit_entry WHERE action IN ('ot.samples.ingest','ot.session.link') AND actor = 'admin' GROUP BY action`)
  const auditMap = Object.fromEntries(auditRows.map((r) => [r[0], Number(r[1])]))
  must(run, '审计对账：入池在册 + 绑定/解绑 2 行', (auditMap['ot.samples.ingest'] ?? 0) >= 1 && (auditMap['ot.session.link'] ?? 0) >= 2, JSON.stringify(auditRows))

  run.saveState()
  return run
}
