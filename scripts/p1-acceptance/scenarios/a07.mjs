/**
 * A07 移库/调拨（P1 验收）：
 * - 同仓移库一单（原/现库位逐码，两行 move 流水）；
 * - 调拨三段（出库 → 在途 → 接收）+ 在途两仓 Σ 断言（在途不双计）+ 完成对账。
 */
import { must, httpStep, sqlStep, sql, sqlOne, q, eqQty } from '../lib.mjs'

export async function run(run) {
  run.setScenario('A07')
  const s = run.state
  const sz = s.szPlantId
  // 移库/调拨对象：A02 质检合格的采购铜杆单元（仓库 9101 普通库位 91010101 在库）
  const unit1 = s.po.batch1.unitId
  const unit2 = s.po.batch2.unitId

  // ---- 1) 同仓移库一单（91010101 → 货架 010101，同仓 9101） ----
  const move = await httpStep(run, '同仓移库：铜杆单元 91010101 → 货架 010101（POST /warehousing/moves）',
    'POST', '/warehousing/moves',
    {
      plantId: sz, unitId: unit1, toLocationId: s.loc['010101'], toLocationCode: '010101',
      reason: 'P1 验收：上架整理移库', operationId: `${s.run}-a07-move`,
    },
    [200, 201])
  must(run, '移库成功（fromAfter=0 / toAfter=300）',
    eqQty(move.body?.data?.fromAfter, 0) && eqQty(move.body?.data?.toAfter, 300), JSON.stringify(move.body?.data))

  const moveRows = sqlStep(run, 'SQL：移库记录（原/现库位逐码）+ 两行 move 流水',
    `SELECT from_location_code, to_location_code, quantity::text FROM warehouse_move WHERE inventory_unit_id = ${q(unit1)}`)
  const moveTx = sqlOne(`SELECT count(*) FROM stock_transaction WHERE unit_id = ${q(unit1)} AND movement_kind = 'move'`)
  const unit1Loc = sqlOne(`SELECT location_id FROM stock_balance WHERE unit_id = ${q(unit1)} AND status = 'active'`)
  must(run, '移库记录 91010101→010101、300；两行流水；余额库位已切换',
    moveRows.length === 1 && moveRows[0][0] === '91010101' && moveRows[0][1] === '010101' && eqQty(moveRows[0][2], 300)
      && Number(moveTx) === 2 && unit1Loc === s.loc['010101'],
    `rows=${JSON.stringify(moveRows)} moveTx=${moveTx} loc=${unit1Loc === s.loc['010101'] ? '010101' : unit1Loc}`)

  // ---- 2) 调拨创建（草稿）→ 提交（锁定=作业预留） ----
  // 行量 = 单元全额（在途对账口径：调出仓应留 0，避免部分调出残留误判双计）
  const unit1Qty = Number(sqlOne(`SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(unit1)} AND status = 'active'`))
  const unit2Qty = Number(sqlOne(`SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(unit2)} AND status = 'active'`))
  must(run, '调拨前单元余额读取（300 / 200）', unit1Qty === 300 && unit2Qty === 200, `unit1=${unit1Qty} unit2=${unit2Qty}`)
  const line1Qty = `${unit1Qty.toFixed(4)}`
  const line2Qty = `${unit2Qty.toFixed(4)}`

  const create = await httpStep(run, `调拨创建：9101 → 9103（两行全额：${line1Qty} + ${line2Qty}，POST /warehousing/transfers）`,
    'POST', '/warehousing/transfers',
    {
      plantId: sz, transferKind: 'warehouse',
      fromWarehouseId: s.wh.sz9101, toWarehouseId: s.wh.sz9103,
      transitLocationId: s.loc.sz9190['91900101'], transitLocationCode: '91900101',
      note: 'P1 验收：仓库调拨三段',
      lines: [
        { unitId: unit1, unitNo: s.po.batch1.unitNo, quantity: line1Qty, materialId: s.mat['MAT-P1-RAW'], materialCode: 'MAT-P1-RAW', materialType: 1 },
        { unitId: unit2, unitNo: s.po.batch2.unitNo, quantity: line2Qty, materialId: s.mat['MAT-P1-RAW'], materialCode: 'MAT-P1-RAW', materialType: 1 },
      ],
      operationId: `${s.run}-a07-tr-create`,
    },
    [200, 201])
  const transferOrderId = create.body?.data?.orderId ?? null
  s.transfer = { orderId: transferOrderId, orderNo: create.body?.data?.orderNo }
  must(run, '调拨单创建成功（draft，两行）', create.body?.data?.status === 'draft' && create.body?.data?.lines?.length === 2, JSON.stringify(create.body?.data))

  const submit = await httpStep(run, '调拨提交（POST /warehousing/transfers/submit：锁定=作业预留）',
    'POST', '/warehousing/transfers/submit',
    { transferOrderId, lockValidUntil: new Date(Date.now() + 3_600_000).toISOString(), operationId: `${s.run}-a07-tr-submit` },
    [200])
  must(run, '提交后 ready 且逐行锁定', submit.body?.data?.status === 'ready' && submit.body?.data?.lockedLines?.length === 2, JSON.stringify(submit.body?.data))

  const lineRows = sqlStep(run, 'SQL：调拨行（预留 id 回填）',
    `SELECT line_no, id, reservation_id IS NOT NULL FROM transfer_order_line WHERE transfer_order_id = ${q(transferOrderId)} ORDER BY line_no`)
  s.transfer.line1 = lineRows[0]?.[1] ?? null
  s.transfer.line2 = lineRows[1]?.[1] ?? null
  must(run, '两行均已锁定（reservation 非空）', lineRows.length === 2 && lineRows.every((r) => r[2] === 'true' || r[2] === 't'), JSON.stringify(lineRows))

  // ---- 3) 出库段（逐行：来源减 + 在途增） ----
  const ship1 = await httpStep(run, `调拨出库段：行 1（${line1Qty}）`,
    'POST', '/warehousing/transfers/ship', { transferOrderId, lineId: s.transfer.line1, operationId: `${s.run}-a07-tr-ship1` }, [200])
  must(run, '行 1 出库后 shipping', ship1.body?.data?.status === 'shipping', JSON.stringify(ship1.body?.data))
  const ship2 = await httpStep(run, `调拨出库段：行 2（${line2Qty}）`,
    'POST', '/warehousing/transfers/ship', { transferOrderId, lineId: s.transfer.line2, operationId: `${s.run}-a07-tr-ship2` }, [200])
  must(run, '行 2 出库完成', eqQty(ship2.body?.data?.outQty, unit2Qty), JSON.stringify(ship2.body?.data))

  // ---- 4) 在途段（两仓 Σ 断言：在途不双计） ----
  const transit = await httpStep(run, '调拨在途段（POST /warehousing/transfers/transit：对账断言）',
    'POST', '/warehousing/transfers/transit', { transferOrderId, operationId: `${s.run}-a07-tr-transit` }, [200])
  const rec = transit.body?.data?.reconciliation ?? {}
  sqlStep(run, 'SQL 在途对账：在途库位 Σ / 调出仓 Σ / 调入仓 Σ',
    `SELECT l.code, COALESCE(SUM(b.quantity),0)::text FROM stock_balance b
     JOIN storage_location l ON l.id = b.location_id
     WHERE b.unit_id IN (${q(unit1)}, ${q(unit2)}) AND b.status = 'active' GROUP BY l.code ORDER BY l.code`)
  must(run, '在途对账返回：transitQty=500、调出仓应留 0、调入仓 0',
    eqQty(rec.transitQty, 500) && eqQty(rec.expectedTransitQty, 500) && eqQty(rec.fromWarehouseRemainQty, 0) && eqQty(rec.toWarehouseQty, 0),
    JSON.stringify(rec))

  const transitBal = sql(
    `SELECT COALESCE(SUM(b.quantity),0)::text FROM stock_balance b WHERE b.location_id = ${q(s.loc.sz9190['91900101'])} AND b.status = 'active'`)
  const fromRemain = Number(sqlOne(
    `SELECT COALESCE(SUM(b.quantity),0)::text FROM stock_balance b
     JOIN storage_location l ON l.id = b.location_id
     WHERE b.unit_id IN (${q(unit1)}, ${q(unit2)}) AND b.status = 'active' AND l.warehouse_id = ${q(s.wh.sz9101)}`))
  const toBefore = Number(sqlOne(
    `SELECT COALESCE(SUM(b.quantity),0)::text FROM stock_balance b
     JOIN storage_location l ON l.id = b.location_id
     WHERE b.unit_id IN (${q(unit1)}, ${q(unit2)}) AND b.status = 'active' AND l.warehouse_id = ${q(s.wh.sz9103)}`))
  must(run, '在途两仓 Σ 断言：在途=500、调出仓=0（余额清零转在途）、调入仓=0（不双计）',
    eqQty(transitBal[0][0], 500) && fromRemain === 0 && toBefore === 0,
    `transit=${transitBal[0][0]} from=${fromRemain} to=${toBefore}`)

  // ---- 5) 接收段（在途减 + 目的增 → 完成） ----
  const recv1 = await httpStep(run, '调拨接收段：行 1 → 91030101',
    'POST', '/warehousing/transfers/receive',
    { transferOrderId, lineId: s.transfer.line1, toLocationId: s.loc.sz9103['91030101'], toLocationCode: '91030101', operationId: `${s.run}-a07-tr-recv1` },
    [200])
  must(run, '行 1 接收成功（receiving）', recv1.body?.data?.status === 'receiving', JSON.stringify(recv1.body?.data))
  const recv2 = await httpStep(run, '调拨接收段：行 2 → 91030101（完成）',
    'POST', '/warehousing/transfers/receive',
    { transferOrderId, lineId: s.transfer.line2, toLocationId: s.loc.sz9103['91030101'], toLocationCode: '91030101', operationId: `${s.run}-a07-tr-recv2` },
    [200])
  must(run, '全部行接收 → completed', recv2.body?.data?.status === 'completed', JSON.stringify(recv2.body?.data))

  // 完成对账：Σ 数量守恒（300+200 = 调出仓 0 + 调入仓 500 + 在途 0）
  const afterFrom = Number(sqlOne(
    `SELECT COALESCE(SUM(b.quantity),0)::text FROM stock_balance b
     JOIN storage_location l ON l.id = b.location_id
     WHERE b.unit_id IN (${q(unit1)}, ${q(unit2)}) AND b.status = 'active' AND l.warehouse_id = ${q(s.wh.sz9101)}`))
  const afterTo = Number(sqlOne(
    `SELECT COALESCE(SUM(b.quantity),0)::text FROM stock_balance b
     JOIN storage_location l ON l.id = b.location_id
     WHERE b.unit_id IN (${q(unit1)}, ${q(unit2)}) AND b.status = 'active' AND l.warehouse_id = ${q(s.wh.sz9103)}`))
  const afterTransit = Number(sqlOne(
    `SELECT COALESCE(SUM(b.quantity),0)::text FROM stock_balance b WHERE b.location_id = ${q(s.loc.sz9190['91900101'])} AND b.status = 'active'`))
  sqlStep(run, 'SQL 完成对账：调出仓/调入仓/在途',
    `SELECT ${afterFrom}, ${afterTo}, ${afterTransit}`)
  must(run, '完成对账：500 = 调出 0 + 调入 500 + 在途 0（守恒；调入仓 300+200=500）',
    afterFrom === 0 && afterTo === 500 && afterTransit === 0,
    `from=${afterFrom} to=${afterTo} transit=${afterTransit}`)

  // 流水形态：每单元 transfer_out×2（来源减+在途增，IT-25 两段一个事务）/ transfer_in×2（在途减+目的增）
  const txKinds = sqlStep(run, 'SQL：调拨流水形态（每单元 transfer_out×2 / transfer_in×2）',
    `SELECT u.unit_no, t.movement_kind, count(*) FROM stock_transaction t
     JOIN inventory_unit u ON u.id = t.unit_id
     WHERE t.unit_id IN (${q(unit1)}, ${q(unit2)}) AND t.movement_kind IN ('transfer_out','transfer_in')
     GROUP BY u.unit_no, t.movement_kind ORDER BY u.unit_no, t.movement_kind`)
  must(run, '两单元各 transfer_out×2 + transfer_in×2（两行流水/段，含在途侧）',
    txKinds.length === 4 && txKinds.every((r) => Number(r[2]) === 2), JSON.stringify(txKinds))

  run.saveState()
  return run
}
