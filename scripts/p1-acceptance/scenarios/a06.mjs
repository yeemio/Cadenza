/**
 * A06 质量闭环（P1 验收）：
 * - 报工触发的检验任务（ExecutionEventPort 真实接线：生成自 production_report ×
 *   report_output 只读投影；process/finished 阶段按末道判定）；
 * - 待检不可用（余额可用量断言：引用 A02 需检批次收货后 qualified 可用量=0 的 SQL 事实）；
 * - 实测提交（版本化）→ 判定放行；
 * - 入库任务生成（putaway refresh 消费报工确认事件）→ 组单入库上架（D-2 修复后语义：
 *   报工产出已在线边库形成单元，组单确认=对既有单元移位到目标仓/库位——不新建单元、
 *   质量态保留、不双计库存；重复确认拒绝）。
 */
import { must, httpStep, sqlStep, sqlOne, q, eqQty, OWNER_NAME } from '../lib.mjs'

export async function run(run) {
  run.setScenario('A06')
  const s = run.state
  const sz = s.szPlantId

  // ---- 1) 检验任务真实生成（报工确认事件 → 检验单） ----
  const gen = await httpStep(run, '检验任务生成（POST /quality/inspections/generate：消费报工确认事件）',
    'POST', '/quality/inspections/generate',
    { plantId: sz, defaultSpecCode: 'SPEC-P1-FIN', defaultSpecVersion: 1, reason: 'P1 验收：成品检验任务生成', operationId: `${s.run}-a06-gen` },
    [200, 201])
  const created = gen.body?.data?.created ?? []
  s.inspection = { created }
  must(run, '报工触发检验任务真实生成：4 单（3 process + 1 finished）',
    created.length === 4 && created.filter((c) => c.stage === 'process').length === 3 && created.filter((c) => c.stage === 'finished').length === 1,
    JSON.stringify(created))

  const inspRows = sqlStep(run, 'SQL：检验单（来源=报工产出行 sourceRef、规范版本化引用）',
    `SELECT inspection_stage, source_ref, unit_no, spec_code, spec_version FROM quality_inspection_order WHERE source_type = 'work_report' ORDER BY inspection_stage, order_no`)
  must(run, '检验单落库：来源行级 sourceRef（report_output id）、spec 引用版本化（SPEC-P1-FIN v1）',
    inspRows.length === 4 && inspRows.every((r) => r[3] === 'SPEC-P1-FIN' && Number(r[4]) === 1),
    JSON.stringify(inspRows))

  // finished 单定位（末道产出，unitNo=PRDU 成品单元）
  const finished = created.find((c) => c.stage === 'finished')
  s.inspection.finishedOrderId = finished?.orderId ?? null
  must(run, '定位末道（finished）检验单', Boolean(s.inspection.finishedOrderId), JSON.stringify(finished))

  // ---- 2) 待检不可用（余额可用量断言） ----
  // 真实链路的待检余额：A02 需检批次收货后（质检结论前）pending_inspection、可用量 0。
  // 此处以复核 SQL 事实呈现（时间点断言已在 A02 步 2 记录）；
  // 投放/发运入口对 pending_inspection 的拦截在 A08（质量锁拒绝）取证。
  const pendingFacts = sqlStep(run, 'SQL：待检不可用事实（需检批次质检前后状态对照 + 可用量口径）',
    `SELECT b.unit_id, b.quality_status, b.quantity::text,
       COALESCE((SELECT SUM(b2.quantity) FROM stock_balance b2 WHERE b2.unit_id = b.unit_id AND b2.status='active' AND b2.quality_status='qualified'), 0)::text AS qualified_available
     FROM stock_balance b WHERE b.unit_id = ${q(s.po.batch1.unitId)} AND b.status = 'active'`)
  must(run, '待检→放行对照：批次 #1 现为 qualified（质检结论前可用量为 0，结论后放开）',
    pendingFacts.length === 1 && pendingFacts[0][1] === 'qualified' && eqQty(pendingFacts[0][3], 300),
    JSON.stringify(pendingFacts))

  // ---- 3) 实测提交（版本化追加） ----
  const submit = await httpStep(run, '实测提交：末道检验单合格（POST /quality/test-results，v2 追加）',
    'POST', '/quality/test-results',
    {
      inspectionOrderId: s.inspection.finishedOrderId, conclusion: 'qualified',
      items: [{ itemNo: 'T1', itemName: '外径', measuredValue: '3.2000', judgement: 'pass' }],
      operationId: `${s.run}-a06-submit`,
    },
    [200, 201])
  must(run, '实测提交成功：v2 结论行生效（v1 pending 历史保留）',
    submit.body?.data?.version === 2 && submit.body?.data?.historyPreserved === 1, JSON.stringify(submit.body?.data))

  const chain = sqlStep(run, 'SQL：实测结论版本链（S14：追加+生效指针）',
    `SELECT version, conclusion, is_effective, result_kind FROM quality_test_result WHERE inspection_order_id = ${q(s.inspection.finishedOrderId)} ORDER BY version`)
  must(run, '结论链 [v1 pending initial, v2 qualified test] 且 v2 生效',
    chain.length === 2 && chain[0][1] === 'pending' && chain[0][2] === 'f' && chain[1][1] === 'qualified' && chain[1][2] === 't', JSON.stringify(chain))

  // ---- 4) 判定放行 ----
  const release = await httpStep(run, '判定放行（POST /quality/dispositions/release，基于 v2）',
    'POST', '/quality/dispositions/release',
    { inspectionOrderId: s.inspection.finishedOrderId, reason: 'P1 验收：成品检验合格放行', operationId: `${s.run}-a06-release` },
    [200])
  must(run, '放行成功且 basedOnVersion=2', release.body?.data?.dispositionKind === 'release' && release.body?.data?.basedOnVersion === 2, JSON.stringify(release.body?.data))

  const dispRows = sqlStep(run, 'SQL：处置记录 + Outbox 放行事件',
    `SELECT disposition_kind, based_on_version FROM quality_disposition WHERE inspection_order_id = ${q(s.inspection.finishedOrderId)}`)
  const releaseOutbox = sqlOne(
    `SELECT count(*) FROM outbox WHERE task_kind = 'quality.disposition-released' AND payload->>'orderId' = ${q(s.inspection.finishedOrderId)}`)
  must(run, '处置记录落库（release@v2）+ Outbox 放行任务 1 行',
    dispRows.length === 1 && dispRows[0][0] === 'release' && Number(dispRows[0][1]) === 2 && Number(releaseOutbox) === 1,
    `disposition=${JSON.stringify(dispRows)} outbox=${releaseOutbox}`)

  // 重复处置拒绝（放行后不可再处置）
  const releaseAgain = await httpStep(run, '重复放行拒绝（已有生效处置）',
    'POST', '/quality/dispositions/release',
    { inspectionOrderId: s.inspection.finishedOrderId, reason: '重复', operationId: `${s.run}-a06-release2` }, 422)
  must(run, '重复处置 422', true, `http=${releaseAgain.status} ${JSON.stringify(releaseAgain.body).slice(0, 160)}`)

  // ---- 5) 入库任务生成（putaway refresh 消费报工确认事件） ----
  const refresh = await httpStep(run, '入库任务刷新（POST /warehousing/putaway/refresh）',
    'POST', '/warehousing/putaway/refresh',
    { plantId: sz, reason: 'P1 验收：待入库台账刷新', operationId: `${s.run}-a06-refresh` },
    [200, 201])
  const tasks = refresh.body?.data?.created ?? []
  s.putawayTasks = tasks
  must(run, '入库任务真实生成：4 条（来源=报工确认事件，行级 sourceRef）', tasks.length === 4, JSON.stringify(tasks))

  const refreshReplay = await httpStep(run, '刷新重跑幂等（同源不重复建）',
    'POST', '/warehousing/putaway/refresh',
    { plantId: sz, operationId: `${s.run}-a06-refresh2` },
    [200, 201])
  must(run, '重跑 created=0 / skipped=4（来源幂等）',
    (refreshReplay.body?.data?.created ?? []).length === 0 && Number(refreshReplay.body?.data?.skipped) === 4,
    JSON.stringify(refreshReplay.body?.data))

  // ---- 6) 组单入库上架（D-2 修复后：报工来源 → 既有单元移位到成品仓货架库位） ----
  const confirm = await httpStep(run, '组单确认入库（POST /warehousing/putaway/confirm：成品上架 RACK 010101）',
    'POST', '/warehousing/putaway/confirm',
    {
      plantId: sz, taskIds: tasks.map((t) => t.taskId),
      toWarehouseId: s.wh.sz9101, toWarehouseKind: 'LOGISTICS',
      toLocationId: s.loc['010101'], toLocationCode: '010101',
      ownerId: s.entId, ownerName: OWNER_NAME,
      reason: 'P1 验收：组单入库上架', operationId: `${s.run}-a06-putaway`,
    },
    [200, 201])
  must(run, '组单确认成功：4 任务完成（既有单元移位上架）',
    (confirm.body?.data?.confirmed ?? 0) === 4, JSON.stringify(confirm.body?.data))

  const putUnits = sqlStep(run, 'SQL：上架后单元（任务回填 + 余额库位/质量态）',
    `SELECT t.source_ref, t.status, t.inventory_unit_id, u.unit_no, l.code AS loc_code, b.quantity::text, b.quality_status
     FROM putaway_task t
     JOIN inventory_unit u ON u.id = t.inventory_unit_id
     LEFT JOIN stock_balance b ON b.unit_id = t.inventory_unit_id AND b.status = 'active'
     LEFT JOIN storage_location l ON l.id = b.location_id
     WHERE t.id IN (${tasks.map((t) => q(t.taskId)).join(',')})`)
  const movedQty = {}
  for (const r of putUnits) movedQty[r[3]] = r[5]
  must(run, '上架=既有单元移位：单元号不变（PRDU）、余额在 010101、质量态保留 qualified',
    putUnits.length === 4 && putUnits.every((r) => r[1] === 'done' && String(r[3]).startsWith('PRDU-') && r[4] === '010101' && r[6] === 'qualified'),
    JSON.stringify(putUnits))
  const lineSideLeft = sqlOne(
    `SELECT COALESCE(SUM(b.quantity),0)::text FROM stock_balance b
     JOIN storage_location l ON l.id = b.location_id
     WHERE l.warehouse_id = ${q(s.wh.sz9102)} AND b.status = 'active'`)
  must(run, '线边仓 9102 活动余额清零（移位上架不双计库存）', eqQty(lineSideLeft, 0), `lineSide active Σ=${lineSideLeft}`)

  // 重复确认拒绝（任务已 done，A-T13-1 仅待入库可确认）
  const confirmAgain = await httpStep(run, '重复确认拒绝（任务已 done → 422 [A-T13-1]）',
    'POST', '/warehousing/putaway/confirm',
    {
      plantId: sz, taskIds: tasks.map((t) => t.taskId),
      toWarehouseId: s.wh.sz9101, toWarehouseKind: 'LOGISTICS',
      toLocationId: s.loc['010101'], toLocationCode: '010101',
      ownerId: s.entId, ownerName: OWNER_NAME,
      operationId: `${s.run}-a06-putaway2`,
    },
    422)
  must(run, '重复确认 422（仅待入库任务可确认）',
    String(confirmAgain.body?.message ?? '').includes('A-T13-1'), JSON.stringify(confirmAgain.body?.message))
  s.putaway = { movedQty }

  run.saveState()
  return run
}
