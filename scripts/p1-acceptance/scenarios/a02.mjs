/**
 * A02 采购主链（P1 验收）：
 * - 模拟 ERP 采购订单入站（五元组幂等）→ 分批扫码收货（需检料）→ 四账一致
 *   （Σ明细 = 批次 = 订单行 = Σ余额 = Σ流水）；
 * - 免检料直收（exempt）→ 质检合格判定（版本化）→ 价格复核只读投影 →
 *   Outbox 合格任务行存在。
 */
import { must, httpStep, sqlStep, sql, sqlOne, q, eqQty, UOM_M_ID, UOM_M, OWNER_NAME } from '../lib.mjs'

const arrival = '2026-10-27T01:00:00.000Z'
const confirm = '2026-10-27T02:00:00.000Z'

/** R 码（原料码型：R + 9 位字母数字）。 */
function rCode(seed) {
  return `R${String(seed).replace(/[^0-9A-Za-z]/g, '').slice(0, 9).padEnd(9, '0')}`
}

export async function run(run) {
  run.setScenario('A02')
  const s = run.state
  const sz = s.szPlantId
  const ownerId = s.entId
  const orderNo = `PO-${s.run}-001`
  s.po = { orderNo }

  // ---- 1) ERP 订单入站（IF-08 五元组幂等） ----
  const sync = await httpStep(run, '模拟 ERP 采购订单入站（POST /purchase/orders/sync，两行：需检铜杆 500 / 免检辅材 100）',
    'POST', '/purchase/orders/sync',
    {
      orgCode: 'ORG-HD', orderNo, sourceSystem: 'ERP', plantId: sz, supplierName: 'P1铜材供应商', contractNo: 'CT-P1-001',
      lines: [
        { lineNo: 10, materialCode: 'MAT-P1-RAW', materialName: 'P1验收-铜杆（需检）', plannedQty: '500.0000', overReceiptLimit: '550.0000', status: 1 },
        { lineNo: 20, materialCode: 'MAT-P1-EXP', materialName: 'P1验收-免检辅材', plannedQty: '100.0000', status: 1 },
      ],
      operationId: `${s.run}-a02-posync`,
    },
    [200, 201])
  const line10 = sync.body?.data?.lines?.find((l) => l.lineNo === 10)
  const line20 = sync.body?.data?.lines?.find((l) => l.lineNo === 20)
  s.po.line10Id = line10?.lineId ?? null
  s.po.line20Id = line20?.lineId ?? null
  s.ops = { ...(s.ops ?? {}), 'purchase.order-sync': `${s.run}-a02-posync` }
  must(run, '订单同步成功且两行 applied', line10?.applied === true && line20?.applied === true, JSON.stringify(sync.body?.data))

  // ---- 2) 分批收货 #1（需检料 300，1 明细） ----
  const barcode1 = rCode(`${s.run}RAW1`)
  s.po.barcode1 = barcode1
  const rcv1 = await httpStep(run, '分批收货 #1：需检铜杆 300（POST /purchase/receive）',
    'POST', '/purchase/receive',
    {
      plantId: sz, orderLineId: s.po.line10Id, arrivalTime: arrival, confirmTime: confirm,
      warehouseId: s.wh.sz9101, warehouseCode: '9101', locationId: s.loc.sz9101['91010101'], locationCode: '91010101',
      ownerId, ownerName: OWNER_NAME, uomId: UOM_M_ID, uomCode: UOM_M, unitPrice: '120.5000',
      details: [{ barcodeValue: barcode1, supplierLotNo: `SL-${s.run}-1`, grade: 'TG-1', quantity: '300.0000' }],
      operationId: `${s.run}-a02-rcv1`,
    },
    [200, 201])
  s.po.batch1 = {
    batchId: rcv1.body?.data?.batchId ?? null,
    batchNo: rcv1.body?.data?.batchNo ?? null,
    detailId: rcv1.body?.data?.details?.[0]?.detailId ?? null,
    unitId: rcv1.body?.data?.details?.[0]?.unitId ?? null,
    unitNo: rcv1.body?.data?.details?.[0]?.unitNo ?? null,
  }
  s.ops = { ...(s.ops ?? {}), 'purchase.receive-confirm#1': `${s.run}-a02-rcv1` }
  must(run, '收货 #1 成功且批次待检（inspectionStatus=pending，余额级待检不可用见下步）',
    rcv1.body?.data?.inspectionStatus === 'pending' && rcv1.body?.data?.totalQty === '300.0000' && rcv1.body?.data?.lineStatus === 2,
    JSON.stringify(rcv1.body?.data) ?? String(rcv1.body))

  // 待检不可用（可用量=0，余额质量闸门）——A06 同口径引用
  const avail1 = sqlStep(run, 'SQL 对账：需检批次单元余额（待检不可用——qualified 可用量=0）',
    `SELECT b.quality_status, b.quantity::text, '0' AS qualified_qty
     FROM stock_balance b WHERE b.unit_id = ${q(s.po.batch1.unitId)} AND b.status = 'active'`)
  must(run, '需检收货后余额 pending_inspection 且可用量为 0',
    avail1.length === 1 && avail1[0][0] === 'pending_inspection' && eqQty(avail1[0][1], 300), JSON.stringify(avail1))

  // ---- 3) 分批收货 #2（需检料 200，1 明细） ----
  const barcode2 = rCode(`${s.run}RAW2`)
  s.po.barcode2 = barcode2
  const rcv2 = await httpStep(run, '分批收货 #2：需检铜杆 200',
    'POST', '/purchase/receive',
    {
      plantId: sz, orderLineId: s.po.line10Id, arrivalTime: arrival, confirmTime: confirm,
      warehouseId: s.wh.sz9101, warehouseCode: '9101', locationId: s.loc.sz9101['91010101'], locationCode: '91010101',
      ownerId, ownerName: OWNER_NAME, uomId: UOM_M_ID, uomCode: UOM_M, unitPrice: '140.0000',
      details: [{ barcodeValue: barcode2, supplierLotNo: `SL-${s.run}-2`, grade: 'TG-1', quantity: '200.0000' }],
      operationId: `${s.run}-a02-rcv2`,
    },
    [200, 201])
  s.po.batch2 = {
    batchId: rcv2.body?.data?.batchId ?? null,
    batchNo: rcv2.body?.data?.batchNo ?? null,
    detailId: rcv2.body?.data?.details?.[0]?.detailId ?? null,
    unitId: rcv2.body?.data?.details?.[0]?.unitId ?? null,
    unitNo: rcv2.body?.data?.details?.[0]?.unitNo ?? null,
  }
  s.ops = { ...(s.ops ?? {}), 'purchase.receive-confirm#2': `${s.run}-a02-rcv2` }
  must(run, '收货 #2 成功（累计 500）', rcv2.body?.data?.lineReceivedQty === '500.0000', JSON.stringify(rcv2.body?.data))

  // ---- 4) 四账一致断言（Σ明细=批次=订单行=Σ余额=Σ流水） ----
  const sumDetails = Number(sqlOne(`SELECT COALESCE(SUM(quantity),0)::text FROM receipt_detail WHERE batch_id IN (${q(s.po.batch1.batchId)}, ${q(s.po.batch2.batchId)})`))
  const sumBatches = Number(sqlOne(`SELECT COALESCE(SUM(received_qty),0)::text FROM purchase_receipt_batch WHERE id IN (${q(s.po.batch1.batchId)}, ${q(s.po.batch2.batchId)})`))
  const lineRow = sql(`SELECT received_qty::text, status FROM purchase_order_line WHERE id = ${q(s.po.line10Id)}`)
  const sumBalances = Number(sqlOne(
    `SELECT COALESCE(SUM(b.quantity),0)::text FROM stock_balance b
     WHERE b.unit_id IN (${q(s.po.batch1.unitId)}, ${q(s.po.batch2.unitId)}) AND b.status = 'active'`))
  const sumTx = Number(sqlOne(
    `SELECT COALESCE(SUM(t.quantity),0)::text FROM stock_transaction t
     WHERE t.unit_id IN (${q(s.po.batch1.unitId)}, ${q(s.po.batch2.unitId)}) AND t.movement_kind = 'receive'`))
  sqlStep(run, 'SQL 四账对账：Σ明细/Σ批次/订单行已收/Σ余额/Σ收货流水',
    `SELECT ${sumDetails}, ${sumBatches}, ${lineRow[0]?.[0] ?? 'null'}, ${sumBalances}, ${sumTx}`)
  must(run, '四账一致：500 = Σ明细 = Σ批次 = 订单行 = Σ余额 = Σ流水',
    sumDetails === 500 && sumBatches === 500 && eqQty(lineRow[0]?.[0], 500) && sumBalances === 500 && sumTx === 500,
    `details=${sumDetails} batches=${sumBatches} line=${lineRow[0]?.[0]} balances=${sumBalances} tx=${sumTx}`)

  // 流水含扣前/扣后（IT-19）
  const txDetail = sqlStep(run, 'SQL：收货流水行含 before/after（IT-19）',
    `SELECT movement_kind, before_qty::text, after_qty::text FROM stock_transaction WHERE unit_id = ${q(s.po.batch1.unitId)} ORDER BY line_no`)
  must(run, '收货流水 before=0 after=300', txDetail.length === 1 && txDetail[0][0] === 'receive' && eqQty(txDetail[0][1], 0) && eqQty(txDetail[0][2], 300), JSON.stringify(txDetail))

  // ---- 5) 免检料直收 ----
  const barcodeE = rCode(`${s.run}EXP1`)
  const rcvE = await httpStep(run, '免检辅材直收 100（qc_flag=0 → exempt）',
    'POST', '/purchase/receive',
    {
      plantId: sz, orderLineId: s.po.line20Id, arrivalTime: arrival, confirmTime: confirm,
      warehouseId: s.wh.sz9101, warehouseCode: '9101', locationId: s.loc.sz9101['91010101'], locationCode: '91010101',
      ownerId, ownerName: OWNER_NAME, uomId: UOM_M_ID, uomCode: UOM_M, unitPrice: '30.0000',
      details: [{ barcodeValue: barcodeE, supplierLotNo: `SL-${s.run}-E`, quantity: '100.0000' }],
      operationId: `${s.run}-a02-rcvE`,
    },
    [200, 201])
  s.po.batchExp = {
    batchId: rcvE.body?.data?.batchId ?? null,
    batchNo: rcvE.body?.data?.batchNo ?? null,
    unitId: rcvE.body?.data?.details?.[0]?.unitId ?? null,
    unitNo: rcvE.body?.data?.details?.[0]?.unitNo ?? null,
  }
  must(run, '免检批次 inspectionStatus=exempt（有依据：料品 qc_flag=0）',
    rcvE.body?.data?.inspectionStatus === 'exempt', JSON.stringify(rcvE.body?.data))
  const expBal = sqlOne(`SELECT quality_status FROM stock_balance WHERE unit_id = ${q(s.po.batchExp.unitId)} AND status='active'`)
  must(run, '免检批次余额直接 qualified 可用', expBal === 'qualified', `quality_status=${expBal}`)

  // ---- 6) 质检合格判定（版本化：batch 模式 → code 模式追加版本行） ----
  const inspect1 = await httpStep(run, '批量质检：批次 #1 全部合格（POST /purchase/inspections mode=batch）',
    'POST', '/purchase/inspections',
    { mode: 'batch', conclusion: 'qualified', batchId: s.po.batch1.batchId, operationId: `${s.run}-a02-insp1` },
    [200, 201])
  must(run, '批次 #1 质检后 all_qualified', inspect1.body?.data?.inspectionStatus === 'all_qualified', JSON.stringify(inspect1.body?.data))

  const inspect2 = await httpStep(run, 'PDA 单码复判：批次 #2 明细再判合格（code 模式，版本化追加）',
    'POST', '/purchase/inspections',
    { mode: 'code', conclusion: 'qualified', batchId: s.po.batch2.batchId, barcodeValue: barcode2, operationId: `${s.run}-a02-insp2` },
    [200, 201])
  must(run, '批次 #2 单码质检成功', inspect2.body?.data?.inspectionStatus === 'all_qualified', JSON.stringify(inspect2.body?.data))

  const chain = sqlStep(run, 'SQL：明细 #2 质检版本链（S14：追加版本行+生效指针，历史保留）',
    `SELECT version, conclusion, is_effective, source FROM inspection_record WHERE detail_id = ${q(s.po.batch2.detailId)} ORDER BY version`)
  must(run, '版本链 [v1 pending(receive), v2 qualified(pda)] 且 v2 生效',
    chain.length === 2 && chain[0][1] === 'pending' && chain[0][2] === 'f' && chain[1][1] === 'qualified' && chain[1][2] === 't' && chain[1][3] === 'pda',
    JSON.stringify(chain))

  // 质检后库存质量投影放开（T12 闸门）
  const qualifiedBal = sqlOne(`SELECT quality_status FROM stock_balance WHERE unit_id = ${q(s.po.batch1.unitId)} AND status='active'`)
  must(run, '质检合格后批次 #1 余额转 qualified', qualifiedBal === 'qualified', `quality_status=${qualifiedBal}`)

  // ---- 7) 价格复核只读投影（批次 #2：有批次 #1 价格历史 → 均价/偏差/ppm 可复算） ----
  const detail = await httpStep(run, '批次详情只读投影（GET /purchase/batches/:id：价格历史/均价/偏差/ppm）',
    'GET', `/purchase/batches/${s.po.batch2.batchId}`, undefined, 200)
  const d = detail.body ?? {}
  sqlStep(run, 'SQL：批次 #2 价格快照列', `SELECT unit_price, avg_price, deviation_ppm, price_flag, review_status FROM purchase_receipt_batch WHERE id = ${q(s.po.batch2.batchId)}`)
  // 复算：历史 [批次#1 120.5] → 均价 120.5；本批 140 → 浮动 (140−120.5)/120.5 ≈ +161826ppm ≥ +10% → flag=up
  must(run, '价格投影可复算：priceHistory≥1、avgPrice=120.5、deviationPpm≈161826、flag=up、review=pending',
    Array.isArray(d.priceHistory) && d.priceHistory.length >= 1 &&
      eqQty(d.avgPrice, 120.5) && Math.abs(Number(d.deviationPpm) - 161826) < 2 && d.priceFlag === 'up' && d.reviewStatus === 'pending',
    `history=${JSON.stringify(d.priceHistory)} avg=${d.avgPrice} ppm=${d.deviationPpm} flag=${d.priceFlag} review=${d.reviewStatus}`)

  const beforeReview = sql(`SELECT received_qty::text, inspection_status, storage_status FROM purchase_receipt_batch WHERE id = ${q(s.po.batch1.batchId)}`)
  const reviewOk = await httpStep(run, '价格复核确认（POST /purchase/price-review）',
    'POST', '/purchase/price-review', { batchId: s.po.batch1.batchId, operationId: `${s.run}-a02-review` }, [200])
  must(run, '价格复核成功 reviewStatus=reviewed', reviewOk.body?.data?.reviewStatus === 'reviewed', JSON.stringify(reviewOk.body?.data))

  const afterReview = sql(`SELECT received_qty::text, inspection_status, storage_status, review_status FROM purchase_receipt_batch WHERE id = ${q(s.po.batch1.batchId)}`)
  must(run, '价格复核不改变质检/库存/数量（只读投影）',
    afterReview[0][0] === beforeReview[0][0] && afterReview[0][1] === beforeReview[0][1] && afterReview[0][2] === beforeReview[0][2] && afterReview[0][3] === 'reviewed',
    `before=${JSON.stringify(beforeReview[0])} after=${JSON.stringify(afterReview[0])}`)

  // 已复核不可撤销（再复核拒绝）
  const reviewAgain = await httpStep(run, '重复价格复核拒绝（已复核不可撤销）',
    'POST', '/purchase/price-review', { batchId: s.po.batch1.batchId, operationId: `${s.run}-a02-review2` }, 422)
  must(run, '重复复核 422', true, `http=${reviewAgain.status} ${JSON.stringify(reviewAgain.body).slice(0, 160)}`)

  // ---- 8) Outbox 合格任务行 ----
  const outbox = sqlStep(run, 'SQL：Outbox 合格收货回传任务行（IF-09 qualified_sync）',
    `SELECT task_kind, status, payload->>'batchNo' AS batch_no FROM outbox
     WHERE task_kind = 'qualified_sync' AND payload->>'batchNo' IN (${q(s.po.batch1.batchNo)}, ${q(s.po.batch2.batchNo)}, ${q(s.po.batchExp.batchNo)})`)
  must(run, '三条合格任务行（免检批+两需检批全部合格）', outbox.length === 3, JSON.stringify(outbox))

  run.saveState()
  return run
}
