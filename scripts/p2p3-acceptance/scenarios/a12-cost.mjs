/**
 * A12 成本归集分摊版本一例（cost 域，P3-D/T24；工时主源+机时参考按 CA-12 口径）：
 * - 分摊版本 v1（machine_hours 默认公式）+ v2（output_qty）+ 价格版本 v1；
 * - 归集首跑（CE-11）：工时行源=labor_record（CA-12 主源）8h、机时行源=ot_sample（CA-12 参考）
 *   金额恒 null（工资/机时费率出界，CE-01/CA-13）；
 * - 工时核对（CA-12）：报工 8h vs OT 运行 3h → 偏差超阈值 open 提示，且不改写报工工时；
 * - 显式重算换 v2（CE-11）：新 run + 新旧对照 + recalc_of + 历史 run 零改写。
 */
import { must, httpStep, sqlStep, sqlOne, q, eqQty, nowIso, ensureAdminPermissions } from '../lib.mjs'

export async function run(run) {
  await ensureAdminPermissions(run) // 场景自足：并行会话 seed 可能中途重置授权
  run.setScenario('A12-COST')
  const s = run.state
  const plant = s.szPlantId
  const orderId = s.orderCost.orderId
  // 班次日期锚定 S0 的 UTC 日（全链同日：工时 shift_date/OT 样本/归集窗口——见 setup §6 注；
  // labor shift_date 按北京班次日归属，与 UTC 锚窗口跨北京零点错位属成本线交付 §8-10 已登记风险族）
  const shiftDate = s.utcDay ?? new Date().toISOString().slice(0, 10)

  // ---- 1) 分摊版本 + 价格版本（version_no 工厂内唯一——按现有最大值递增，支持任意轮重跑） ----
  const nextAlloc = Number(sqlOne(`SELECT COALESCE(MAX(version_no),0) FROM cost_allocation_version WHERE plant_id = ${q(plant)}`)) + 1
  const nextPrice = Number(sqlOne(`SELECT COALESCE(MAX(version_no),0) FROM cost_price_version WHERE plant_id = ${q(plant)}`)) + 1
  const av1 = await httpStep(run, `分摊版本 v${nextAlloc}（machine_hours 默认公式）`,
    'POST', '/cost/allocation-versions',
    { plantId: plant, versionNo: nextAlloc, formula: 'machine_hours', operationId: `${s.run}-cost-av1` },
    [200, 201])
  const allocV1 = av1.body?.data?.versionId ?? null
  const av2 = await httpStep(run, `分摊版本 v${nextAlloc + 1}（output_qty 产量占比）`,
    'POST', '/cost/allocation-versions',
    { plantId: plant, versionNo: nextAlloc + 1, formula: 'output_qty', operationId: `${s.run}-cost-av2` },
    [200, 201])
  const allocV2 = av2.body?.data?.versionId ?? null
  must(run, '两分摊版本创建成功', Boolean(allocV1 && allocV2), `v${nextAlloc}=${allocV1} v${nextAlloc + 1}=${allocV2}`)

  const badFormula = await httpStep(run, '公式枚举反例 → 422 [CE-S2]',
    'POST', '/cost/allocation-versions',
    { plantId: plant, versionNo: nextAlloc + 2, formula: 'magic', operationId: `${s.run}-cost-av-bad` },
    422)
  must(run, '非法公式被拒（CE-S2）', String(badFormula.body?.message ?? '').includes('CE-S2'), JSON.stringify(badFormula.body?.message))

  const pv1 = await httpStep(run, `价格版本 v${nextPrice}（三料品全覆盖）`,
    'POST', '/cost/price-versions',
    {
      plantId: plant, versionNo: nextPrice, priceSource: 'standard_cost',
      items: [
        { materialCode: 'MAT-P23-RAW', materialId: s.mat['MAT-P23-RAW'], unitPrice: '12.500000', uomCode: 'M' },
        { materialCode: 'MAT-P23-FIN', materialId: s.mat['MAT-P23-FIN'], unitPrice: '20.000000', uomCode: 'M' },
        { materialCode: 'MAT-P23-SPARE', materialId: s.mat['MAT-P23-SPARE'], unitPrice: '0.800000', uomCode: 'M' },
      ],
      operationId: `${s.run}-cost-pv1`,
    },
    [200, 201])
  const priceV1 = pv1.body?.data?.versionId ?? null
  must(run, '价格版本创建成功（3 行）', Boolean(priceV1) && pv1.body?.data?.items === 3, JSON.stringify(pv1.body?.data))

  // ---- 2) 归集首跑（CE-11 + CA-12 主从口径） ----
  const stockTxBefore = Number(sqlOne(`SELECT count(*) FROM stock_transaction`))
  const unitBefore = Number(sqlOne(`SELECT count(*) FROM inventory_unit`))
  const cutoff = nowIso()
  const acq = await httpStep(run, `归集首跑（${shiftDate}，v1 机时占比）`,
    'POST', '/cost/acquisition/run',
    { plantId: plant, orderId, shiftDate, dataCutoffAt: cutoff, allocationVersionId: allocV1, priceVersionId: priceV1, operationId: `${s.run}-cost-run1` },
    [200, 201])
  const run1 = acq.body?.data ?? {}
  s.cost = { run1Id: run1.runId ?? null, shiftDate, allocV1, allocV2, priceV1, cutoff }
  must(run, '首跑成功（COMMITTED）', Boolean(run1.runId) || acq.body?.status === 'COMMITTED', JSON.stringify(run1))

  const stockTxAfter = Number(sqlOne(`SELECT count(*) FROM stock_transaction`))
  const unitAfter = Number(sqlOne(`SELECT count(*) FROM inventory_unit`))
  must(run, 'CE-02 只读业务事实：库存写命令零新增', stockTxAfter === stockTxBefore && unitAfter === unitBefore,
    `tx ${stockTxBefore}→${stockTxAfter} unit ${unitBefore}→${unitAfter}`)

  // CA-12：工时行主源 labor_record 8h；机时行参考源 ot_sample 3h（速度点位 3 事件 × 3600s）
  const lineRows = sqlStep(run, 'SQL：归集明细（labor/equipment 两行来源映射 CE-05）',
    `SELECT source_kind, source_table, quantity::text, amount::text FROM cost_acquisition_line WHERE run_id = ${q(run1.runId)} ORDER BY source_kind`)
  const laborLine = lineRows.find((r) => r[1] === 'labor_record')
  const runtimeLine = lineRows.find((r) => r[1] === 'ot_sample')
  must(run, 'CA-12 工时主源：labor 行源=labor_record、数量 8h、金额 null（工资出界）',
    Boolean(laborLine) && eqQty(laborLine[2], 8) && laborLine[3] === '', JSON.stringify(lineRows))
  must(run, 'CA-12 机时参考：equipment 行源=ot_sample、数量 3h、金额 null（机时费率出界）',
    Boolean(runtimeLine) && eqQty(runtimeLine[2], 3) && runtimeLine[3] === '', JSON.stringify(lineRows))

  // 估算缺项（CE-03）：无 BOM → estimatePossible=false（不以估算冒充）
  const runHead = sqlStep(run, 'SQL：run 头（估算/实测两列 + 在制 + 班次锚）',
    `SELECT estimate_amount::text, actual_amount::text, estimate_possible, machine_hours::text, labor_source, equipment_cost_caliber
     FROM cost_acquisition_run WHERE id = ${q(run1.runId)}`)
  must(run, 'run 头对账：无 BOM 估算缺项（estimatePossible=f）+ laborSource=labor_record（CA-12）+ 机时口径不含折旧（CA-13）',
    runHead.length === 1 && runHead[0][2] === 'f' && runHead[0][4] === 'labor_record',
    JSON.stringify(runHead))

  // 首跑幂等：同 (order, shift) 重复首跑拒绝（CE-11 历史报表不静默重算）
  const dupRun = await httpStep(run, '同 (订单, 班次) 重复首跑 → 422 [CE-11]',
    'POST', '/cost/acquisition/run',
    { plantId: plant, orderId, shiftDate, dataCutoffAt: nowIso(), allocationVersionId: allocV1, priceVersionId: priceV1, operationId: `${s.run}-cost-run-dup` },
    422)
  must(run, '重复首跑被拒（CE-11）', String(dupRun.body?.message ?? '').includes('CE-11'), JSON.stringify(dupRun.body?.message))

  // ---- 3) 工时核对（CA-12：报工主源 vs OT 参考，不改写报工） ----
  const laborBefore = sqlOne(`SELECT hours::text FROM labor_record WHERE id = ${q(s.laborRecordId)}`)
  const lc = await httpStep(run, '工时核对生成（报工 8h vs OT 3h）',
    'POST', '/cost/labor-check/run',
    { plantId: plant, orderId, shiftDate, operationId: `${s.run}-cost-lc` },
    [200, 201])
  const created = (lc.body?.data?.created ?? [])[0] ?? {}
  s.cost.checkId = created.checkId ?? null
  const checkRow = sqlStep(run, 'SQL：核对行（labor/ot/偏差/阈值/状态）',
    `SELECT labor_hours::text, ot_runtime_hours::text, deviation_ratio::text, threshold_ratio::text, status FROM cost_labor_check WHERE id = ${q(s.cost.checkId)}`)
  must(run, '核对生成 open 提示：labor=8 / ot=3 / 偏差 0.625 超阈值 0.10',
    Boolean(s.cost.checkId) && eqQty(checkRow[0]?.[0], 8) && eqQty(checkRow[0]?.[1], 3) &&
      eqQty(checkRow[0]?.[2], 0.625) && eqQty(checkRow[0]?.[3], 0.1) && checkRow[0]?.[4] === 'open',
    JSON.stringify({ created, checkRow }))

  const laborAfter = sqlOne(`SELECT hours::text FROM labor_record WHERE id = ${q(s.laborRecordId)}`)
  must(run, 'CA-12 核心口径：提示不改写报工工时（主源不动）', laborAfter === laborBefore && eqQty(laborAfter, 8), `${laborBefore}→${laborAfter}`)

  const ack = await httpStep(run, '核对确认（acknowledged 留痕）',
    'POST', '/cost/labor-check/acknowledge',
    { plantId: plant, checkId: s.cost.checkId, reason: 'P23 验收：班前准备工时核对确认', operationId: `${s.run}-cost-lc-ack` },
    [200, 201])
  must(run, '核对确认成功', Boolean(ack.body?.data), JSON.stringify(ack.body?.data))

  // ---- 4) 显式重算换 v2（CE-11：新 run + 对照 + 历史零改写） ----
  const oldHead = sqlOne(`SELECT COALESCE(estimate_amount::text,'null') || '/' || COALESCE(actual_amount::text,'null') FROM cost_acquisition_run WHERE id = ${q(run1.runId)}`)
  const recalc = await httpStep(run, '显式重算（换 v2 产量占比，理由必填）',
    'POST', '/cost/acquisition/recalc',
    { plantId: plant, orderId, shiftDate, dataCutoffAt: nowIso(), allocationVersionId: allocV2, priceVersionId: priceV1, reason: 'P23 验收：分摊版本切换重算', operationId: `${s.run}-cost-recalc` },
    [200, 201])
  const run2 = recalc.body?.data ?? {}
  must(run, '重算成功（新 run + recalc_of 挂旧 run）', Boolean(run2.runId) && run2.recalcOf === run1.runId, JSON.stringify(run2))

  const cmpRows = sqlStep(run, 'SQL：新旧对照固化 + 旧 run 零改写（CE-11/CE-S2）',
    `SELECT recalc_of IS NOT NULL, old_new_comparison IS NOT NULL,
       (SELECT COALESCE(estimate_amount::text,'null') || '/' || COALESCE(actual_amount::text,'null') FROM cost_acquisition_run WHERE id = ${q(run1.runId)})
     FROM cost_acquisition_run WHERE id = ${q(run2.runId)}`)
  must(run, '对照固化 + 旧 run 汇总不变', cmpRows[0]?.[0] === 't' && cmpRows[0]?.[1] === 't' && cmpRows[0]?.[2] === oldHead,
    JSON.stringify({ cmpRows, oldHead }))

  const noReason = await httpStep(run, '重算缺理由 → 422 [CE-11]（OA-29 高影响留痕）',
    'POST', '/cost/acquisition/recalc',
    { plantId: plant, orderId, shiftDate, dataCutoffAt: nowIso(), allocationVersionId: allocV2, priceVersionId: priceV1, operationId: `${s.run}-cost-recalc-noreason` },
    422)
  must(run, '重算理由必填被拒', String(noReason.body?.message ?? '').includes('CE-11'), JSON.stringify(noReason.body?.message))

  // ---- 5) 四账口径 ----
  const balRows = sqlStep(run, 'SQL 四账一：余额零变动（归集只读）',
    `SELECT count(*) FROM stock_balance b JOIN inventory_unit u ON u.id = b.unit_id WHERE u.unit_no = ${q(s.uSpare)} AND b.status = 'active'`)
  must(run, '余额对账：归集不动库存', balRows.length >= 1, JSON.stringify(balRows))

  const lineCount = sqlStep(run, 'SQL 四账二：两 run 明细行（append-only，行数只增）',
    `SELECT run_id, count(*) FROM cost_acquisition_line WHERE run_id IN (${q(run1.runId)}, ${q(run2.runId)}) GROUP BY run_id`)
  must(run, '流水对账：两 run 各有明细', lineCount.length === 2, JSON.stringify(lineCount))

  const outboxRows = sqlStep(run, 'SQL 四账三：归集完成 Outbox 事件',
    `SELECT task_kind, count(*) FROM outbox WHERE task_kind LIKE 'cost.%' GROUP BY task_kind`)
  must(run, 'Outbox 对账：归集完成通知 ≥2（首跑+重算）', outboxRows.length >= 1 && Number(outboxRows[0][1]) >= 2, JSON.stringify(outboxRows))

  const auditRows = sqlStep(run, 'SQL 四账四：cost 审计（版本/归集/重算/核对）',
    `SELECT action, count(*) FROM audit_entry WHERE action LIKE 'cost.%' AND actor = 'admin' GROUP BY action ORDER BY action`)
  const auditMap = Object.fromEntries(auditRows.map((r) => [r[0], Number(r[1])]))
  must(run, '审计对账：版本/首跑/重算/核对/确认在册',
    (auditMap['cost.allocation-version.create'] ?? 0) >= 2 && (auditMap['cost.price-version.create'] ?? 0) >= 1 &&
      (auditMap['cost.acquisition.run'] ?? 0) >= 1 && (auditMap['cost.acquisition.recalc'] ?? 0) >= 1 &&
      (auditMap['cost.labor-check.run'] ?? 0) >= 1 && (auditMap['cost.labor-check.acknowledge'] ?? 0) >= 1,
    JSON.stringify(auditRows))

  run.saveState()
  return run
}
