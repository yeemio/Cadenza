/**
 * A12-SPC 扩展（spc 域：失控判定闭环 PE-12/13/14 + 失准仪器影响范围圈定 PE-15～19）：
 * - 失控判定：超限样本 → out_of_control 判定 + OOC 处置任务（质量存疑提示 qualityDoubtHint）
 *   + Outbox 失控检出事件；**quality_hold 零新增、库存质量投影不变（PE-13/CA-9：SPC 失控≠自动
 *   不合格，不直接改合格结论）**；
 * - 失控处置闭环：处置（原因分类+纠正措施）→ 处置后无在控样本复控确认拒 → 在控样本 → 复控确认
 *   （PE-12 失控未处置不得静默关闭）；
 * - 失准圈定：校准过期器具出具样本 → calibrationStatus=expired、准入拒（calibration_suspect，
 *   PE-16/17 关联检验标记）；器具可排产判定 false（CS-05③ 等价）；失准圈定查询含被拒样本 +
 *   逐项处置进度（PE-18/19 只读圈定不改写质量结论）。
 */
import { must, httpStep, sqlStep, sqlOne, sql, q, ensureAdminPermissions } from '../lib.mjs'

export async function run(run) {
  await ensureAdminPermissions(run) // 场景自足：并行会话 seed 可能中途重置授权
  run.setScenario('A12-SPC-EXT')
  const s = run.state
  const plant = s.szPlantId
  const tag = s.run.replace(/[^0-9A-Za-z]/g, '').slice(0, 10).toUpperCase()

  // ---- 1) 规则集 + 受控项目 + 器具（新链，run 唯一） ----
  const rs = await httpStep(run, '规则集创建（i_mr：单点越限）',
    'POST', '/spc/rule-set/create',
    { plantId: plant, name: `P23失控规则集-${s.run}`, version: 1, chartType: 'i_mr', criteria: ['point_beyond_limits'], operationId: `${s.run}-spx-rs` },
    [200, 201])
  const ruleSetId = rs.body?.data?.ruleSetId ?? null
  must(run, '规则集创建成功', Boolean(ruleSetId), JSON.stringify(rs.body?.data))
  await httpStep(run, '规则集发布', 'POST', '/spc/rule-set/publish', { plantId: plant, ruleSetId, operationId: `${s.run}-spx-rs-pub` }, [200, 201])

  const ci = await httpStep(run, '受控项目创建（specCode 带 X 防跨 run 冲突）',
    'POST', '/spc/control-item/create',
    { plantId: plant, specCode: `INSX-${tag}`, specVersion: 1, itemNo: 'OD-01', itemName: '外径', pointRef: 'SPD-01', ruleSetId, operationId: `${s.run}-spx-ci` },
    [200, 201])
  const itemId = ci.body?.data?.controlItemId ?? null
  must(run, '受控项目创建成功', Boolean(itemId), JSON.stringify(ci.body?.data))

  const gauge = await httpStep(run, '器具登记（有效校准至 2027）',
    'POST', '/spc/gauge/register',
    { plantId: plant, gaugeNo: `G-${s.run}-OKX`, name: 'P23失控判定千分尺', gaugeKind: '千分尺', operationId: `${s.run}-spx-gauge` },
    [200, 201])
  const gaugeId = gauge.body?.data?.gaugeId ?? null
  await httpStep(run, '校准记录（qualified）',
    'POST', '/spc/calibration/record',
    { plantId: plant, gaugeId, calibratedAt: '2026-10-01T00:00:00Z', result: 'qualified', certificateNo: `CERT-${s.run}-X1`, validUntil: '2027-10-01T00:00:00Z', basis: 'JJG 21-2026', operationId: `${s.run}-spx-cal1` },
    [200, 201])
  must(run, '器具+校准就绪', Boolean(gaugeId), `gaugeId=${gaugeId}`)

  // ---- 2) 基线 3 样本 → active 控制限（±3σ：CL=2.1/UCL=2.4/LCL=1.8） ----
  for (const [i, v] of ['2.0000', '2.1000', '2.2000'].entries()) {
    await httpStep(run, `基线样本 ${i + 1}/3（${v}）`,
      'POST', '/spc/sample/record',
      { plantId: plant, controlItemId: itemId, source: 'collection', gaugeId, measuredValue: v, qualityCode: 'good', sampledAt: `2026-10-28T14:0${i}:00Z`, operationId: `${s.run}-spx-base-${i}` },
      [200, 201])
  }
  const cl = await httpStep(run, '3 基线重算 → active v1（首算即足基线：3 组 ±3σ）',
    'POST', '/spc/control-limit/recalc',
    { plantId: plant, controlItemId: itemId, baselineGroupCount: 3, operationId: `${s.run}-spx-cl` },
    [200, 201])
  must(run, '控制限 active：CL=2.100000/UCL=2.400000/LCL=1.800000',
    cl.body?.data?.status === 'active' && cl.body?.data?.version === 1 && cl.body?.data?.cl === '2.100000' && cl.body?.data?.ucl === '2.400000' && cl.body?.data?.lcl === '1.800000',
    JSON.stringify(cl.body?.data))

  // ---- 3) 超限样本 → 失控判定 + OOC 任务 + 质量边界（PE-12/13/CA-9） ----
  const holdBefore = Number(sqlOne(`SELECT count(*) FROM quality_hold`))
  const balQualityBefore = sqlOne(
    `SELECT string_agg(DISTINCT b.quality_status, ',') FROM stock_balance b JOIN inventory_unit u ON u.id = b.unit_id WHERE u.plant_id = ${q(plant)}`,
  )
  const ooc = await httpStep(run, '超限样本 3.0（> UCL 2.4）→ 失控判定',
    'POST', '/spc/sample/record',
    {
      plantId: plant, controlItemId: itemId, source: 'collection', gaugeId, measuredValue: '3.0000', qualityCode: 'good',
      productionOrderId: s.orderCost.orderId, orderOperationId: s.orderCost.op1Id, operationSeq: 1,
      equipmentId: s.equipment[s.eqExecCode].id, equipmentCode: s.eqExecCode, shiftDate: s.utcDay,
      notifyRoles: ['quality', 'shift_leader'], sampledAt: '2026-10-28T15:00:00Z', operationId: `${s.run}-spx-ooc`,
    },
    [200, 201])
  const oocTask = ooc.body?.data?.oocTask ?? null
  s.spcExt = { itemId, gaugeId, oocTaskId: oocTask?.oocTaskId ?? null }
  must(run, '失控判定：out_of_control + 命中准则 + 判定绑 active v1',
    ooc.body?.data?.judgement?.verdict === 'out_of_control' &&
      (ooc.body?.data?.judgement?.violatedCodes ?? []).includes('point_beyond_limits') &&
      ooc.body?.data?.judgement?.limitVersion === 1,
    JSON.stringify(ooc.body?.data?.judgement))
  must(run, 'OOC 处置任务生成（质量存疑提示 qualityDoubtHint=true，通知角色在册）',
    Boolean(oocTask?.oocTaskId) && oocTask?.qualityDoubtHint === true && (oocTask?.notifyRoles ?? []).includes('quality'),
    JSON.stringify(oocTask))

  const holdAfter = Number(sqlOne(`SELECT count(*) FROM quality_hold`))
  const balQualityAfter = sqlOne(
    `SELECT string_agg(DISTINCT b.quality_status, ',') FROM stock_balance b JOIN inventory_unit u ON u.id = b.unit_id WHERE u.plant_id = ${q(plant)}`,
  )
  must(run, 'CA-9 边界：quality_hold 零新增 + 库存质量投影不变（不直接改合格结论）',
    holdAfter === holdBefore && balQualityAfter === balQualityBefore,
    `hold ${holdBefore}→${holdAfter}；quality投影 ${balQualityBefore}→${balQualityAfter}`)

  const oocOutbox = sqlStep(run, 'SQL：失控检出 Outbox 事件（spc.out-of-control-detected）',
    `SELECT payload->>'taskNo', payload->'violatedCodes'::text FROM outbox WHERE task_kind = 'spc.out-of-control-detected' AND payload->>'oocTaskId' = ${q(s.spcExt.oocTaskId)}`)
  must(run, 'Outbox 失控检出事件在册（含命中准则）', oocOutbox.length === 1, JSON.stringify(oocOutbox))

  // 失控未处置不得静默关闭：任务行 DELETE 拒（库级守卫）
  const delGuard = sqlStep(run, 'SQL：OOC 任务行 DELETE 拒（失控任务不删，PE-12 库级守卫）',
    `SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%ooc%'`)
  const delTry = (() => {
    try {
      sql(`DELETE FROM spc_ooc_task WHERE id = ${q(s.spcExt.oocTaskId)}`)
      return 'deleted'
    } catch (error) {
      return String(error.message ?? error).slice(0, 120)
    }
  })()
  must(run, 'OOC 任务不可删（处置链可查）', delTry !== 'deleted', `delete 结果：${delTry}（触发器族 ${delGuard[0]?.[0]}）`)

  // ---- 4) 失控处置闭环（PE-12：处置 → 复控确认） ----
  const dispose = await httpStep(run, '失控处置（原因分类+纠正措施+隔离建议）',
    'POST', '/spc/ooc/dispose',
    { plantId: plant, oocTaskId: s.spcExt.oocTaskId, causeCategory: '设备因素', correctiveAction: '更换卡盘后复测', isolationSuggestion: '隔离该时段批次待复检', operationId: `${s.run}-spx-dispose` },
    [200, 201])
  must(run, '处置成功（disposed）', dispose.body?.data?.status === 'disposed', JSON.stringify(dispose.body?.data))

  const confirmEarly = await httpStep(run, '处置后无在控样本即复控确认 → 422 [PE-12]',
    'POST', '/spc/ooc/confirm-recontrol',
    { plantId: plant, oocTaskId: s.spcExt.oocTaskId, operationId: `${s.run}-spx-confirm-early` },
    422)
  must(run, '无在控样本支撑复控确认被拒（PE-12）', String(confirmEarly.body?.message ?? '').includes('PE-12'), JSON.stringify(confirmEarly.body?.message))

  const recontrol = await httpStep(run, '处置后在控样本 2.14 → 判定 in_control',
    'POST', '/spc/sample/record',
    { plantId: plant, controlItemId: itemId, source: 'collection', gaugeId, measuredValue: '2.1400', qualityCode: 'good', sampledAt: '2026-10-28T16:00:00Z', operationId: `${s.run}-spx-recontrol-sample` },
    [200, 201])
  must(run, '在控样本判定（in_control）', recontrol.body?.data?.judgement?.verdict === 'in_control', JSON.stringify(recontrol.body?.data?.judgement))

  const confirm = await httpStep(run, '复控确认（处置时点后 ≥1 在控样本）',
    'POST', '/spc/ooc/confirm-recontrol',
    { plantId: plant, oocTaskId: s.spcExt.oocTaskId, operationId: `${s.run}-spx-confirm` },
    [200, 201])
  must(run, '复控确认成功（re_control_confirmed，后续在控 1）',
    confirm.body?.data?.status === 're_control_confirmed' && confirm.body?.data?.subsequentInControl === 1,
    JSON.stringify(confirm.body?.data))

  const chain = await httpStep(run, '处置链查询（GET /spc/ooc-tasks/:id）',
    'GET', `/spc/ooc-tasks/${s.spcExt.oocTaskId}`, undefined, 200)
  const chainTask = chain.body?.task ?? chain.body?.data?.task ?? chain.body ?? {}
  must(run, '处置链可查（raise→dispose→recontrol 三段留痕）',
    chainTask.status === 're_control_confirmed' && Boolean(chainTask.disposedAt) && Boolean(chainTask.recontrolConfirmedAt),
    JSON.stringify({ status: chainTask.status, disposedAt: chainTask.disposedAt, recontrolConfirmedAt: chainTask.recontrolConfirmedAt }))

  // ---- 5) 失准圈定：校准过期器具（PE-15/16/17/18/19） ----
  const gauge2 = await httpStep(run, '失准器具登记（校准合格但已于 2026-01 过期）',
    'POST', '/spc/gauge/register',
    { plantId: plant, gaugeNo: `G-${s.run}-EXP`, name: 'P23过期千分尺', gaugeKind: '千分尺', operationId: `${s.run}-spx-gauge2` },
    [200, 201])
  const gauge2Id = gauge2.body?.data?.gaugeId ?? null
  await httpStep(run, '过期校准记录（qualified、validUntil 2026-01-01）',
    'POST', '/spc/calibration/record',
    { plantId: plant, gaugeId: gauge2Id, calibratedAt: '2025-12-01T00:00:00Z', result: 'qualified', certificateNo: `CERT-${s.run}-X2`, validUntil: '2026-01-01T00:00:00Z', basis: 'JJG 21-2026', operationId: `${s.run}-spx-cal2` },
    [200, 201])

  const expSample = await httpStep(run, '过期器具出具样本 → 准入拒（关联检验标记）',
    'POST', '/spc/sample/record',
    { plantId: plant, controlItemId: itemId, source: 'collection', gaugeId: gauge2Id, measuredValue: '2.0500', qualityCode: 'good', sampledAt: '2026-10-28T17:00:00Z', operationId: `${s.run}-spx-exp-sample` },
    [200, 201])
  must(run, '过期器具样本：calibrationStatus=expired、准入拒 calibration_suspect（不入判定）',
    expSample.body?.data?.calibrationStatus === 'expired' && expSample.body?.data?.admission === 'rejected' &&
      expSample.body?.data?.rejectReason === 'calibration_suspect' && expSample.body?.data?.judgement === null,
    JSON.stringify({ calibrationStatus: expSample.body?.data?.calibrationStatus, admission: expSample.body?.data?.admission, rejectReason: expSample.body?.data?.rejectReason }))

  const gaugeDetail = await httpStep(run, '器具详情（GET /spc/gauges/:id，可排产判定）',
    'GET', `/spc/gauges/${gauge2Id}`, undefined, 200)
  const gd = gaugeDetail.body ?? {}
  must(run, 'PE-17 等价判定：过期器具 schedulableForInspection=false（检测任务不排产 CS-05③）',
    gd.schedulableForInspection === false, JSON.stringify({ calibrationStatus: gd.calibrationStatus, schedulableForInspection: gd.schedulableForInspection }))

  // 失准圈定（PE-18：只读重建，含被拒样本；PE-S4 不落地可改写表）
  const circle = await httpStep(run, '失准圈定查询（GET /spc/miscalibration/circle）',
    'GET', `/spc/miscalibration/circle?gaugeId=${gauge2Id}&from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z`, undefined, 200)
  const c = circle.body?.circle ?? circle.body?.data?.circle ?? {}
  const progress0 = circle.body?.dispositionProgress ?? circle.body?.data?.dispositionProgress ?? {}
  must(run, '圈定含被拒样本（全部实测口径）且无判定行',
    (c.measurements ?? []).length >= 1 && (c.measurements ?? []).every((m) => m.admission === 'rejected'),
    JSON.stringify({ measurements: (c.measurements ?? []).length, progress: progress0 }))
  must(run, '圈定处置进度：pending ≥1（处置前）', Number(progress0.pending ?? 0) >= 1, JSON.stringify(progress0))

  const act = await httpStep(run, '失准逐项处置（隔离，PE-19）',
    'POST', '/spc/miscalibration/action',
    { plantId: plant, gaugeId: gauge2Id, windowFrom: '2026-10-01T00:00:00Z', windowTo: '2026-10-31T23:59:59Z', itemKind: 'measurement', itemRef: (c.measurements ?? [])[0]?.sampleId ?? '', actionKind: 'isolation', reason: 'A12-SPC-EXT 失准圈定逐项处置取证', operationId: `${s.run}-spx-mis-action` },
    [200, 201])
  must(run, '逐项处置登记成功（isolation）', act.body?.data?.actionKind === 'isolation', JSON.stringify(act.body?.data))

  const circle2 = await httpStep(run, '处置后再圈定（进度推进）',
    'GET', `/spc/miscalibration/circle?gaugeId=${gauge2Id}&from=2026-10-01T00:00:00Z&to=2026-10-31T23:59:59Z`, undefined, 200)
  const progress1 = circle2.body?.dispositionProgress ?? circle2.body?.data?.dispositionProgress ?? {}
  must(run, '处置进度推进（acted ≥1、pending 递减）',
    Number(progress1.acted ?? 0) === Number(progress0.acted ?? 0) + 1 && Number(progress1.pending ?? 0) === Number(progress0.pending ?? 0) - 1,
    JSON.stringify({ before: progress0, after: progress1 }))

  // ---- 6) 四账口径 ----
  const verRows = sqlStep(run, 'SQL 四账一：本受控项目控制限版本（首算即 active v1）',
    `SELECT version, status FROM spc_control_limit_version WHERE control_item_id = ${q(itemId)} ORDER BY version`)
  must(run, '版本对账：v1 active 在册（append-only）',
    verRows.length === 1 && verRows[0][1] === 'active', JSON.stringify(verRows))

  const sampleRows = sqlStep(run, 'SQL 四账二：样本准入分布（admitted 5 + rejected 1）',
    `SELECT admission, count(*) FROM spc_sample WHERE control_item_id = ${q(itemId)} GROUP BY admission ORDER BY admission`)
  const sampleMap = Object.fromEntries(sampleRows.map((r) => [r[0], Number(r[1])]))
  must(run, '样本对账：admitted 5（基线3+失控1+复控1）/ rejected 1（过期器具）',
    sampleMap['admitted'] === 5 && sampleMap['rejected'] === 1, JSON.stringify(sampleRows))

  const outboxRows = sqlStep(run, 'SQL 四账三：SPC Outbox（失控检出 + 失准提示）',
    `SELECT task_kind, count(*) FROM outbox WHERE task_kind LIKE 'spc.%' GROUP BY task_kind ORDER BY task_kind`)
  const outboxMap = Object.fromEntries(outboxRows.map((r) => [r[0], Number(r[1])]))
  must(run, 'Outbox 对账：失控检出 ≥1（本 run）', (outboxMap['spc.out-of-control-detected'] ?? 0) >= 1, JSON.stringify(outboxRows))

  const auditRows = sqlStep(run, 'SQL 四账四：SPC 扩展审计（处置/复控确认/失准处置）',
    `SELECT action, count(*) FROM audit_entry WHERE action IN ('spc.ooc.dispose','spc.ooc.confirm-recontrol','spc.miscalibration.action') AND actor = 'admin' GROUP BY action ORDER BY action`)
  const auditMap = Object.fromEntries(auditRows.map((r) => [r[0], Number(r[1])]))
  must(run, '审计对账：处置/复控/失准逐项处置在册',
    (auditMap['spc.ooc.dispose'] ?? 0) >= 1 && (auditMap['spc.ooc.confirm-recontrol'] ?? 0) >= 1 && (auditMap['spc.miscalibration.action'] ?? 0) >= 1,
    JSON.stringify(auditRows))

  run.saveState()
  return run
}
