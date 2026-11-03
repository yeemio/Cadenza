/**
 * A12-COST 扩展（cost 域：表计配置→能源归集分摊→OEE 缺项展示，CE-S3/CE-09/CE-10/CE-12）：
 * - 表计配置（车间级电表、人工抄表通道、防双源：manual 不得绑 OT 点位）+ 两次抄表（用量=读数差）；
 * - 显式重算（CE-11）：新 run 能源行=实测（表计读数差×机时占比分摊）、来源可回算（首读数引用）、
 *   旧 run 汇总零改写（append-only）；
 * - 能源单耗与覆盖率（CE-09：energy-intensity 读面 metered/estimated/coverageRatio 分列）；
 * - OEE 缺项展示（CE-10/PRODUCT_CONTRACT §6：标准速度未数值化 GAP-S1 → 缺项标注，oee/三率 null
 *   不出假百分比；执行设备无停机行 → downtime 缺项并列示）。
 */
import { must, httpStep, sqlStep, sql, q, eqQty, nowIso, ensureAdminPermissions } from '../lib.mjs'

export async function run(run) {
  await ensureAdminPermissions(run) // 场景自足：并行会话 seed 可能中途重置授权
  run.setScenario('A12-COST-EXT')
  const s = run.state
  const plant = s.szPlantId
  const orderId = s.orderCost.orderId
  const shiftDate = s.cost?.shiftDate ?? s.utcDay
  const tag = s.run.replace(/[^0-9A-Za-z]/g, '').slice(0, 10).toUpperCase()
  const d = s.utcDay
  const dayBefore = new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

  // ---- 1) 表计配置（CE-S3/CE-09：设备级电表=绑定执行设备——与 OT 会话/样本同设备，能源份额按
  //     该设备订单机时占比确定性归属，跨 run 重放不漂移） ----
  const meter = await httpStep(run, `表计登记（设备级电表 EM-${tag}，人工抄表通道）`,
    'POST', '/cost/meters',
    {
      plantId: plant, meterCode: `EM-${tag}`, meterName: 'P23验收执行设备电表', energyType: 'electric',
      coverageKind: 'equipment', equipmentId: s.equipment[s.eqExecCode].id, sampleSource: 'manual', uomCode: 'kWh',
      reason: 'A12-COST 扩展：表计配置', operationId: `${s.run}-cx-meter`,
    },
    [200, 201])
  const meterId = meter.body?.data?.meterId ?? null
  s.costExt = { meterId }
  must(run, '表计登记成功', Boolean(meterId), JSON.stringify(meter.body?.data))

  const badMeter = await httpStep(run, '防双源反例：manual 表计绑 OT 点位 → 422 [CE-09]',
    'POST', '/cost/meters',
    { plantId: plant, meterCode: `EM-${tag}X`, energyType: 'electric', coverageKind: 'equipment', equipmentId: s.equipment[s.eqExecCode].id, sampleSource: 'manual', otPointId: 'any-point', uomCode: 'kWh', operationId: `${s.run}-cx-meter-bad` },
    422)
  must(run, '人工抄表不得绑定点位被拒（CE-09 防双源混读）', String(badMeter.body?.message ?? '').includes('CE-09'), JSON.stringify(badMeter.body?.message))

  // ---- 2) 两次人工抄表（CE-09：用量=窗口内累计读数差 1050−1000=50） ----
  await httpStep(run, '抄表① 1000 kWh（D 00:30Z）',
    'POST', '/cost/meters/readings',
    { plantId: plant, meterId, reading: '1000.0000', readAt: `${d}T00:30:00Z`, reason: 'A12-COST 扩展抄表', operationId: `${s.run}-cx-read1` },
    [200, 201])
  await httpStep(run, '抄表② 1050 kWh（D 01:00Z）',
    'POST', '/cost/meters/readings',
    { plantId: plant, meterId, reading: '1050.0000', readAt: `${d}T01:00:00Z`, reason: 'A12-COST 扩展抄表', operationId: `${s.run}-cx-read2` },
    [200, 201])
  const usageRows = sqlStep(run, 'SQL：表计读数（append-only 两行）',
    `SELECT reading::text, reading_type FROM cost_meter_reading WHERE meter_id = ${q(meterId)} ORDER BY read_at`)
  must(run, '两次抄表在册（manual 两行）', usageRows.length === 2 && usageRows.every((r) => r[1] === 'manual'), JSON.stringify(usageRows))

  // ---- 3) 显式重算（CE-11：换绑定归集，能源行入账） ----
  const allocV1 = s.cost?.allocV1
  const priceV1 = s.cost?.priceV1
  must(run, '前置：S0/a12-cost 分摊与价格版本可用', Boolean(allocV1 && priceV1), `alloc=${allocV1} price=${priceV1}`)
  const oldHeads = sql(`SELECT id::text, COALESCE(estimate_amount::text,'null') || '/' || COALESCE(actual_amount::text,'null'), energy_metered_usage::text FROM cost_acquisition_run WHERE order_id = ${q(orderId)} AND shift_date = ${q(shiftDate)}::date ORDER BY created_at`)

  const recalc = await httpStep(run, `显式重算（绑定 v1 机时占比，含表计量）`,
    'POST', '/cost/acquisition/recalc',
    { plantId: plant, orderId, shiftDate, dataCutoffAt: nowIso(), allocationVersionId: allocV1, priceVersionId: priceV1, reason: 'A12-COST 扩展：表计能源归集重算', operationId: `${s.run}-cx-recalc` },
    [200, 201])
  const runX = recalc.body?.data ?? {}
  s.costExt.runId = runX.runId ?? null
  must(run, '重算成功（新 run + recalc_of 链）', Boolean(runX.runId) && Boolean(runX.recalcOf), JSON.stringify(runX))

  const energyRows = sqlStep(run, 'SQL：能源归集行（实测=表计读数差×设备订单机时占比，来源=首读数可回算）',
    `SELECT quantity::text, value_flag, uom_code, source_fact_id IS NOT NULL, facts->>'meterCode', facts->>'meterUsage', facts->>'readingCount'
     FROM cost_acquisition_line WHERE run_id = ${q(s.costExt.runId)} AND source_kind = 'energy'`)
  const measuredLines = energyRows.filter((r) => r[1] === 'measured')
  const estimatedLines = energyRows.filter((r) => r[1] === 'estimated')
  const measuredSum = measuredLines.reduce((acc, r) => acc + Number(r[0]), 0)
  must(run, '能源行入账：实测恰 50.0000 kWh、表计引用可回算（CE-05/09：唯一能源来源=表计读数）',
    measuredLines.length >= 1 && Math.abs(measuredSum - 50) < 1e-6 &&
      measuredLines.some((r) => r[0] === '50.0000' && r[2] === 'kWh' && r[3] && r[4] === `EM-${tag}` && r[5] === '50.0000' && r[6] === '2'),
    JSON.stringify(energyRows))
  must(run, '估算外推显著标注（CE-09：覆盖不足部分按强度外推并标 estimated，不以实测冒充）',
    estimatedLines.every((r) => Number(r[0]) >= 0) && estimatedLines.every((r) => r[1] === 'estimated'),
    JSON.stringify({ estimated: estimatedLines.length }))

  const oldUnchanged = sqlStep(run, 'SQL：旧 run 汇总零改写（append-only 对照）',
    `SELECT id::text, COALESCE(estimate_amount::text,'null') || '/' || COALESCE(actual_amount::text,'null'), energy_metered_usage::text FROM cost_acquisition_run WHERE order_id = ${q(orderId)} AND shift_date = ${q(shiftDate)}::date ORDER BY created_at`)
  must(run, '旧 run 零改写（CE-11 历史报表不静默重算）',
    oldUnchanged.length === oldHeads.length + 1 &&
      oldHeads.every((h, i) => oldUnchanged[i][0] === h[0] && oldUnchanged[i][1] === h[1] && oldUnchanged[i][2] === h[2]),
    JSON.stringify({ before: oldHeads, after: oldUnchanged }))

  // ---- 4) 能源单耗与覆盖率（CE-09 读面；共享 dev 库存在跨 run 未覆盖机时 → 估算列按实读回，
  //     实测列恒为本表计读数差 50，覆盖率=实测/(实测+估算) 动态对账） ----
  const ei = await httpStep(run, '能源单耗查询（GET /cost/energy-intensity）',
    'GET', `/cost/energy-intensity?plantId=${plant}&shiftDate=${shiftDate}&page=1&pageSize=20`, undefined, 200)
  const eiItems = ei.body?.items ?? ei.body?.data?.items ?? []
  const eiRun = eiItems.find((x) => x.runId === s.costExt.runId)
  const eiCoverageOk = eiRun ? Number(eiRun.coverageRatio) > 0 && Number(eiRun.coverageRatio) <= 1 : false
  must(run, '单耗读面：实测恒 50（读数差）、估算列示不冒充、覆盖率∈(0,1]、单耗可算',
    Boolean(eiRun) && eqQty(eiRun.meteredUsage, 50) && Number(eiRun.estimatedUsage) >= 0 &&
      eiCoverageOk && Boolean(eiRun.intensityPerOutput),
    JSON.stringify(eiRun))

  // ---- 5) OEE 缺项展示（CE-10：分母缺项不出假百分比） ----
  const oeeMt = await httpStep(run, 'OEE（维保设备：标准速度未数值化 → 缺项）',
    'GET', `/cost/oee?plantId=${plant}&equipmentCode=${encodeURIComponent(s.eqMtCode)}&windowStart=${encodeURIComponent(`${dayBefore}T16:00:00Z`)}&windowEnd=${encodeURIComponent(nowIso())}`,
    undefined, 200)
  const o1 = oeeMt.body ?? {}
  must(run, 'CE-10 缺项：std_rate 文本未数值化（GAP-S1）→ missing 含 standard_speed_not_numeric，oee/三率 null',
    (o1.missing ?? []).includes('standard_speed_not_numeric') && o1.oee === null && o1.availability === null &&
      o1.performance === null && o1.qualityRate === null && o1.standardSpeedPerHour === null,
    JSON.stringify({ missing: o1.missing, downtimeMinutes: o1.downtimeMinutes, stdRateText: o1.stdRateText }))

  const oeeExec = await httpStep(run, 'OEE（执行设备：无停机行 → 停机分母缺项并列示）',
    'GET', `/cost/oee?plantId=${plant}&equipmentCode=${encodeURIComponent(s.eqExecCode)}&windowStart=${encodeURIComponent(`${dayBefore}T16:00:00Z`)}&windowEnd=${encodeURIComponent(nowIso())}`,
    undefined, 200)
  const o2 = oeeExec.body ?? {}
  must(run, 'CE-10 缺项并列：无停机事实 → downtime_missing + 标准速度缺项，仍不出百分比',
    (o2.missing ?? []).includes('downtime_missing') && (o2.missing ?? []).includes('standard_speed_not_numeric') && o2.oee === null,
    JSON.stringify({ missing: o2.missing, downtimeMinutes: o2.downtimeMinutes }))

  // ---- 6) 四账口径 ----
  const balRows = sqlStep(run, 'SQL 四账一：表计读数余额口径（归集只读，读数零改写）',
    `SELECT count(*), min(reading::text), max(reading::text) FROM cost_meter_reading WHERE meter_id = ${q(meterId)}`)
  must(run, '读数对账：仍两行 1000→1050（CE-02 只读业务事实）',
    balRows[0]?.[0] === '2' && balRows[0]?.[1] === '1000.0000' && balRows[0]?.[2] === '1050.0000', JSON.stringify(balRows))

  const lineCount = sqlStep(run, 'SQL 四账二：本 run 明细行分布（labor/equipment/energy）',
    `SELECT source_kind, count(*) FROM cost_acquisition_line WHERE run_id = ${q(s.costExt.runId)} GROUP BY source_kind ORDER BY source_kind`)
  const lineMap = Object.fromEntries(lineCount.map((r) => [r[0], Number(r[1])]))
  must(run, '明细对账：labor/equipment_runtime 在册 + energy 新增',
    (lineMap['labor'] ?? 0) >= 1 && (lineMap['equipment_runtime'] ?? 0) >= 1 && (lineMap['energy'] ?? 0) >= 1, JSON.stringify(lineCount))

  const outboxRows = sqlStep(run, 'SQL 四账三：cost Outbox（归集完成通知累计）',
    `SELECT count(*) FROM outbox WHERE task_kind LIKE 'cost.%'`)
  must(run, 'Outbox 对账：归集完成事件累计 ≥3（首跑+重算+本轮）', Number(outboxRows[0]?.[0]) >= 3, JSON.stringify(outboxRows))

  const auditRows = sqlStep(run, 'SQL 四账四：cost 扩展审计（表计/抄表/重算）',
    `SELECT action, count(*) FROM audit_entry WHERE action IN ('cost.meter.register','cost.meter.reading.record','cost.acquisition.recalc') AND actor = 'admin' GROUP BY action ORDER BY action`)
  const auditMap = Object.fromEntries(auditRows.map((r) => [r[0], Number(r[1])]))
  must(run, '审计对账：表计登记/抄表×2/重算在册',
    (auditMap['cost.meter.register'] ?? 0) >= 1 && (auditMap['cost.meter.reading.record'] ?? 0) >= 2 && (auditMap['cost.acquisition.recalc'] ?? 0) >= 2,
    JSON.stringify(auditRows))

  run.saveState()
  return run
}
