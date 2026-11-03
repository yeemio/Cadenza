/**
 * A12-SPC 控制限版本化一例（spc 域，P3-C/T23）：
 * - 规则集创建/发布（PE-09）→ 受控项目（PE-08）→ 器具登记+校准（PE-15/16）；
 * - 0 样本重算 building v1 → 3 基线样本 → 重算 active v2（PE-10 ±3σ 口径）；
 * - 在控样本判定绑 v2 → 规则集变更触发重算 v3 → 历史判定行不改标（仍绑 v2）→
 *   新样本按 v3 判定（PE-S2 版本化/append-only）。
 */
import { must, httpStep, sqlStep, sql, q, ensureAdminPermissions } from '../lib.mjs'

export async function run(run) {
  await ensureAdminPermissions(run) // 场景自足：并行会话 seed 可能中途重置授权
  run.setScenario('A12-SPC')
  const s = run.state
  const plant = s.szPlantId

  // ---- 1) 规则集创建 + 发布 ----
  const rsCreate = await httpStep(run, '规则集创建（i_mr：单点越限+连续 6 点同侧）',
    'POST', '/spc/rule-set/create',
    { plantId: plant, name: `P23现场规则集-${s.run}`, version: 1, chartType: 'i_mr', criteria: ['point_beyond_limits', 'run_same_side_6'], operationId: `${s.run}-spc-rs-create` },
    [200, 201])
  const ruleSetId = rsCreate.body?.data?.ruleSetId ?? null
  must(run, '规则集创建成功', Boolean(ruleSetId), JSON.stringify(rsCreate.body?.data))

  const rsPub = await httpStep(run, '规则集发布',
    'POST', '/spc/rule-set/publish',
    { plantId: plant, ruleSetId, operationId: `${s.run}-spc-rs-pub` },
    [200, 201])
  must(run, '规则集发布成功（published）', rsPub.body?.data?.status === 'published', JSON.stringify(rsPub.body?.data))

  const rsDup = await httpStep(run, '同版本重复创建 → 422 [PE-S2]',
    'POST', '/spc/rule-set/create',
    { plantId: plant, name: `P23现场规则集-${s.run}`, version: 1, chartType: 'i_mr', criteria: ['point_beyond_limits'], operationId: `${s.run}-spc-rs-dup` },
    422)
  must(run, '重复版本被拒（PE-S2）', String(rsDup.body?.message ?? '').includes('PE-S2'), JSON.stringify(rsDup.body?.message))

  // ---- 2) 受控项目 ----
  const ciCreate = await httpStep(run, '受控项目创建（随规范版本冻结）',
    'POST', '/spc/control-item/create',
    { plantId: plant, specCode: `INS-${s.run}`, specVersion: 1, itemNo: 'OD-01', itemName: '外径', pointRef: 'SPD-01', ruleSetId, operationId: `${s.run}-spc-ci` },
    [200, 201])
  const itemId = ciCreate.body?.data?.controlItemId ?? null
  s.spc = { itemId }
  must(run, '受控项目创建成功', Boolean(itemId), JSON.stringify(ciCreate.body?.data))

  // ---- 3) 器具登记 + 校准（有效） ----
  const gauge = await httpStep(run, '器具登记（合格千分尺）',
    'POST', '/spc/gauge/register',
    { plantId: plant, gaugeNo: `G-${s.run}-OK`, name: 'P23验收千分尺', gaugeKind: '千分尺', operationId: `${s.run}-spc-gauge` },
    [200, 201])
  const gaugeId = gauge.body?.data?.gaugeId ?? null
  must(run, '器具登记成功', Boolean(gaugeId), JSON.stringify(gauge.body?.data))

  const cal = await httpStep(run, '校准记录（qualified、有效期至 2027）',
    'POST', '/spc/calibration/record',
    { plantId: plant, gaugeId, calibratedAt: '2026-10-01T00:00:00Z', result: 'qualified', certificateNo: `CERT-${s.run}-1`, validUntil: '2027-10-01T00:00:00Z', basis: 'JJG 21-2026', operationId: `${s.run}-spc-cal` },
    [200, 201])
  must(run, '校准记录登记成功', Boolean(cal.body?.data), JSON.stringify(cal.body?.data))

  // ---- 4) 控制限版本化：building v1 → 基线 → active v2 → 规则集变更 v3 ----
  const cl0 = await httpStep(run, '0 样本重算 → building v1',
    'POST', '/spc/control-limit/recalc',
    { plantId: plant, controlItemId: itemId, baselineGroupCount: 3, operationId: `${s.run}-spc-cl0` },
    [200, 201])
  must(run, '样本不足：building v1', cl0.body?.data?.status === 'building' && cl0.body?.data?.version === 1, JSON.stringify(cl0.body?.data))

  for (const [i, v] of ['2.0000', '2.1000', '2.2000'].entries()) {
    const res = await httpStep(run, `基线样本 ${i + 1}/3（采集来源，质量码 good + 器具有效）`,
      'POST', '/spc/sample/record',
      {
        plantId: plant, controlItemId: itemId, source: 'collection', gaugeId,
        measuredValue: v, qualityCode: 'good', sampledAt: `2026-10-28T09:0${i}:00Z`,
        operationId: `${s.run}-spc-base-${i}`,
      },
      [200, 201])
    must(run, `基线样本 ${i + 1} 准入（admitted、校准快照 valid）`, res.body?.data?.admission === 'admitted' && res.body?.data?.calibrationStatus === 'valid', JSON.stringify(res.body?.data))
  }

  const cl2 = await httpStep(run, '3 基线重算 → active v2（±3σ）',
    'POST', '/spc/control-limit/recalc',
    { plantId: plant, controlItemId: itemId, baselineGroupCount: 3, operationId: `${s.run}-spc-cl2` },
    [200, 201])
  must(run, '控制限 v2 active：CL=2.100000 / UCL=2.400000 / LCL=1.800000',
    cl2.body?.data?.version === 2 && cl2.body?.data?.status === 'active' &&
      cl2.body?.data?.cl === '2.100000' && cl2.body?.data?.ucl === '2.400000' && cl2.body?.data?.lcl === '1.800000',
    JSON.stringify(cl2.body?.data))

  const inControl = await httpStep(run, '在控样本 2.15 → 判定绑 v2',
    'POST', '/spc/sample/record',
    { plantId: plant, controlItemId: itemId, source: 'collection', gaugeId, measuredValue: '2.1500', qualityCode: 'good', sampledAt: '2026-10-28T10:00:00Z', operationId: `${s.run}-spc-ic` },
    [200, 201])
  must(run, '在控判定（in_control、limitVersion=2）',
    inControl.body?.data?.judgement?.verdict === 'in_control' && inControl.body?.data?.judgement?.limitVersion === 2,
    JSON.stringify(inControl.body?.data?.judgement))

  const before = sql(`SELECT sample_id, control_limit_version FROM spc_point_judgement WHERE control_item_id = ${q(itemId)} ORDER BY point_no`)
  const cl3 = await httpStep(run, '规则集变更触发重算 → v3（triggerKind=rule_set_change）',
    'POST', '/spc/control-limit/recalc',
    { plantId: plant, controlItemId: itemId, baselineGroupCount: 3, triggerKind: 'rule_set_change', triggerRef: `P23 规则集变更-${s.run}`, operationId: `${s.run}-spc-cl3` },
    [200, 201])
  must(run, '重算 v3（版本化推进）', cl3.body?.data?.version === 3 && cl3.body?.data?.triggerKind === 'rule_set_change', JSON.stringify(cl3.body?.data))

  const after = sql(`SELECT sample_id, control_limit_version FROM spc_point_judgement WHERE control_item_id = ${q(itemId)} ORDER BY point_no`)
  must(run, '历史判定行不改标（PE-10/PE-S2：仍绑 v2）',
    JSON.stringify(before) === JSON.stringify(after) && after.every((r) => Number(r[1]) === 2),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)

  const next = await httpStep(run, '新样本 2.13 → 按 v3 判定',
    'POST', '/spc/sample/record',
    { plantId: plant, controlItemId: itemId, source: 'collection', gaugeId, measuredValue: '2.1300', qualityCode: 'good', sampledAt: '2026-10-28T13:00:00Z', operationId: `${s.run}-spc-v3` },
    [200, 201])
  must(run, '新样本判定绑 v3', next.body?.data?.judgement?.limitVersion === 3, JSON.stringify(next.body?.data?.judgement))

  // 控制图查询（版本链可读）
  const chart = await httpStep(run, '控制图查询（GET /spc/control-items/:id/chart）',
    'GET', `/spc/control-items/${itemId}/chart`, undefined, 200)
  const limitVersions = (chart.body?.data?.limitVersions ?? chart.body?.limitVersions ?? [])
  must(run, '控制图版本链可见（v1/v2/v3）',
    Array.isArray(limitVersions) && limitVersions.length === 3, JSON.stringify({ keys: Object.keys(chart.body?.data ?? chart.body ?? {}) }))

  // ---- 5) 四账口径 ----
  const verRows = sqlStep(run, 'SQL 四账一：控制限版本三行（append-only）',
    `SELECT version, status, trigger_kind FROM spc_control_limit_version WHERE control_item_id = ${q(itemId)} ORDER BY version`)
  must(run, '版本行对账：v1 building / v2 active / v3 rule_set_change',
    verRows.length === 3 && verRows[0][1] === 'building' && verRows[1][1] === 'active' && verRows[2][2] === 'rule_set_change',
    JSON.stringify(verRows))

  const sampleRows = sqlStep(run, 'SQL 四账二：样本 5 行全部 admitted',
    `SELECT admission, count(*) FROM spc_sample WHERE control_item_id = ${q(itemId)} GROUP BY admission`)
  must(run, '样本对账：5 admitted 0 rejected', sampleRows.length === 1 && sampleRows[0][0] === 'admitted' && Number(sampleRows[0][1]) === 5, JSON.stringify(sampleRows))

  sqlStep(run, 'SQL 四账三：SPC 无 Outbox 任务（失控才发事件——本例无失控）',
    `SELECT count(*) FROM outbox WHERE task_kind LIKE 'spc.%'`)
  const auditRows = sqlStep(run, 'SQL 四账四：SPC 审计（规则集/受控项目/校准/样本/重算）',
    `SELECT action, count(*) FROM audit_entry WHERE action LIKE 'spc.%' AND actor = 'admin' GROUP BY action ORDER BY action`)
  const auditMap = Object.fromEntries(auditRows.map((r) => [r[0], Number(r[1])]))
  must(run, '审计对账：六类命令在册',
    (auditMap['spc.rule-set.create'] ?? 0) >= 1 && (auditMap['spc.rule-set.publish'] ?? 0) >= 1 &&
      (auditMap['spc.control-item.create'] ?? 0) >= 1 && (auditMap['spc.gauge.register'] ?? 0) >= 1 &&
      (auditMap['spc.calibration.record'] ?? 0) >= 1 && (auditMap['spc.sample.record'] ?? 0) >= 5,
    JSON.stringify(auditRows))

  run.saveState()
  return run
}
