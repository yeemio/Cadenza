/**
 * A08 装箱发运（P1 验收）：
 * - 模拟 DC 分段组成 + PL 分段入站（三类行）；
 * - 备货扫码（有轴行，产出单元真实在库合格）；质量锁拒绝一次（未放行单元=待检采购批次）；
 * - 打包绑定托码（未满绑定拒 → 扫满 → 绑定）；
 * - 确认出库（库存已发运断言 + 实发轴/发货状态两任务行独立断言）；
 * - 无差异 NOOP_NEEDED 一例（实发轴号=快照客户轴号）。
 */
import { must, httpStep, sqlStep, sqlOne, q, eqQty, UOM_M_ID, OWNER_NAME } from '../lib.mjs'

export async function run(run) {
  run.setScenario('A08')
  const s = run.state
  const sz = s.szPlantId
  const soNo = `SO-${s.run}-SHIP`

  // 备货单元：A04 产出的成品单元（线边库、qualified、in_stock）
  // unitA = op1 产出（托盘行装入用）；unitB = op2 末道产出（有轴行装入用）
  const prdu = s.prduUnits ?? []
  const unitB = prdu.find((u) => Number(u.qty) === 600) // 末道 600
  const unitA = prdu.find((u) => Number(u.qty) === 2000) // op1 2000
  must(run, '备货源单元就绪（末道 600 + 前道 2000 各一）', Boolean(unitB && unitA), JSON.stringify(prdu.map((u) => `${u.unitNo}:${u.qty}`)))

  // ---- 1) DC 分段/组成模拟入站（IF-04：幂等 + missing 标记） ----
  const dcIn = await httpStep(run, 'DC 组成入站（salesOrderLineNo=10，segmentLength=600）',
    'POST', '/shipping/dc-composition/inbound',
    { dcId: `DC-${s.run}`, salesOrderNo: soNo, lineNo: 10, plantId: sz, composition: { segmentLength: '600.0000', segmentQty: 1, packingPlan: 'PLT-01' }, operationId: `${s.run}-a08-dc1` },
    [200])
  must(run, 'DC 组成 received', dcIn.body?.data?.syncStatus === 'received', JSON.stringify(dcIn.body?.data))

  const dcRepeat = await httpStep(run, 'DC 组成重复报文幂等（skipped=true 不重复应用）',
    'POST', '/shipping/dc-composition/inbound',
    { dcId: `DC-${s.run}`, salesOrderNo: soNo, lineNo: 10, plantId: sz, composition: { segmentLength: '600.0000' }, operationId: `${s.run}-a08-dc1r` },
    [200])
  must(run, 'DC 幂等 skipped', dcRepeat.body?.data?.skipped === true, JSON.stringify(dcRepeat.body?.data))

  // ---- 2) PL 分段入站（三类行：有轴 + 托盘） ----
  const plNo = `PL-${s.run}-001`
  const pl = await httpStep(run, 'PL 入站（有轴行 CAX-P1-01 + 托盘行 总轴数 1）',
    'POST', '/shipping/pl/inbound',
    {
      plNo, salesOrderNo: soNo, customerName: 'P1电缆客户', plantId: sz,
      lines: [
        { lineNo: 1, lineKind: 'axis_item', materialId: s.mat['MAT-P1-FIN'], materialCode: 'MAT-P1-FIN', salesOrderLineNo: '10', customerAxisNo: 'CAX-P1-01', standardSegmentLength: '600.0000' },
        { lineNo: 2, lineKind: 'pallet', materialId: s.mat['MAT-P1-FIN'], materialCode: 'MAT-P1-FIN', salesOrderLineNo: '10', requiredCount: 1 },
      ],
      operationId: `${s.run}-a08-pl1`,
    },
    [200, 201])
  const shipmentOrderId = pl.body?.data?.orderId ?? null
  s.shipment = { orderId: shipmentOrderId, plNo }
  s.ops = { ...(s.ops ?? {}), 'shipping.pl.inbound': `${s.run}-a08-pl1` }
  must(run, 'PL 入站成功（compositionMissing=false、待装箱）',
    pl.body?.data?.compositionMissing === false && pl.body?.data?.status === 'pending_packing', JSON.stringify(pl.body?.data))

  const lines = sqlStep(run, 'SQL：PL 行（有轴行/托盘行快照）',
    `SELECT line_no, id, line_kind, customer_axis_no, standard_segment_length::text, required_count FROM shipment_line WHERE shipment_order_id = ${q(shipmentOrderId)} ORDER BY line_no`)
  const axisLineId = lines.find((r) => r[0] === '1')?.[1] ?? null
  const palletLineId = lines.find((r) => r[0] === '2')?.[1] ?? null
  s.shipment.axisLineId = axisLineId
  s.shipment.palletLineId = palletLineId
  must(run, '两行落库（有轴行快照 CAX-P1-01/600；托盘行应扫 1）', Boolean(axisLineId && palletLineId), JSON.stringify(lines))

  // ---- 3) 质量锁拒绝一次（真实待检单元：追加一笔需检收货且不做质检结论） ----
  // A02 两批均已合格；此处按真实业务再造一个待检在库单元（line10 超收限 550 内再收 20）
  const barcodeP = `R${String(`${s.run}PEND`).replace(/[^0-9A-Za-z]/g, '').slice(0, 9).padEnd(9, '0')}`
  const rcvPending = await httpStep(run, '追加需检收货 20（不做质检结论 → 真实待检在库单元）',
    'POST', '/purchase/receive',
    {
      plantId: sz, orderLineId: s.po.line10Id,
      arrivalTime: '2026-10-27T03:00:00.000Z', confirmTime: '2026-10-27T03:30:00.000Z',
      warehouseId: s.wh.sz9101, warehouseCode: '9101', locationId: s.loc.sz9101['91010101'], locationCode: '91010101',
      ownerId: s.entId, ownerName: OWNER_NAME, uomId: UOM_M_ID, uomCode: 'M', unitPrice: '121.0000',
      details: [{ barcodeValue: barcodeP, supplierLotNo: `SL-${s.run}-P`, quantity: '20.0000' }],
      operationId: `${s.run}-a08-rcv-pending`,
    },
    [200, 201])
  const pendingUnitNo = rcvPending.body?.data?.details?.[0]?.unitNo ?? null
  const pendingQuality = sqlOne(
    `SELECT b.quality_status FROM stock_balance b JOIN inventory_unit u ON u.id = b.unit_id WHERE u.unit_no = ${q(pendingUnitNo)} AND b.status = 'active'`)
  must(run, '待检样本就绪（pending_inspection）', pendingQuality === 'pending_inspection', `unitNo=${pendingUnitNo} quality=${pendingQuality}`)

  const lockReject = await httpStep(run, `质量锁拒绝：扫入未放行（待检）单元 ${pendingUnitNo} → 422 [A-T14-3]`,
    'POST', '/shipping/scan/load',
    { plantId: sz, shipmentOrderId, lineId: axisLineId, unitNo: pendingUnitNo, operationId: `${s.run}-a08-lock` },
    422)
  must(run, '未放行单元拒装入（未审核/质量锁）',
    String(lockReject.body?.message ?? '').includes('A-T14-3') && String(lockReject.body?.message ?? '').includes('未审核'),
    JSON.stringify(lockReject.body))

  // ---- 4) 备货扫码（有轴行 + 托盘行） ----
  const scanAxis = await httpStep(run, `备货扫码：有轴行装入末道产出单元 ${unitB?.unitNo}（实际段长留痕）`,
    'POST', '/shipping/scan/load',
    { plantId: sz, shipmentOrderId, lineId: axisLineId, unitNo: unitB?.unitNo, actualSegmentLength: '598.5000', operationId: `${s.run}-a08-scan-axis` },
    [200, 201])
  must(run, '有轴行装入成功（行已装箱；单仍待装箱——托盘行未满）',
    scanAxis.body?.data?.lineStatus === 'packed' && scanAxis.body?.data?.orderStatus === 'pending_packing', JSON.stringify(scanAxis.body?.data))

  // 打包任务（先扫托码+选调入库位）→ 托盘行扫入 → 未满绑定拒 → 扫满绑定
  const packing = await httpStep(run, '打包任务创建（托码 PLT-P1-01 + 调入库位 010102）',
    'POST', '/shipping/packing',
    { plantId: sz, shipmentOrderId, palletCode: 'PLT-P1-01', toLocationId: s.loc['010102'], toLocationCode: '010102', operationId: `${s.run}-a08-packing` },
    [200, 201])
  const packingId = packing.body?.data?.packingId ?? null
  s.shipment.packingId = packingId
  must(run, '打包任务创建成功（pending，挂接托盘行）', packing.body?.data?.status === 'pending' && (packing.body?.data?.linkedLines ?? []).length === 1, JSON.stringify(packing.body?.data))

  const earlyBind = await httpStep(run, '未满绑定拒绝（托盘行 0/1）→ 422 [A-T14-4]',
    'POST', '/shipping/packing/bind', { plantId: sz, packingOrderId: packingId, operationId: `${s.run}-a08-bind-early` }, 422)
  must(run, '未满绑定拒绝', String(earlyBind.body?.message ?? '').includes('A-T14-4'), JSON.stringify(earlyBind.body))

  const scanPallet = await httpStep(run, `备货扫码：托盘行装入产出单元 ${unitA?.unitNo}`,
    'POST', '/shipping/scan/load',
    { plantId: sz, shipmentOrderId, lineId: palletLineId, unitNo: unitA?.unitNo, operationId: `${s.run}-a08-scan-pallet` },
    [200, 201])
  must(run, '托盘行装入后全部行扫满 → 待出库',
    scanPallet.body?.data?.orderStatus === 'ready_to_ship', JSON.stringify(scanPallet.body?.data))

  const bind = await httpStep(run, '绑定托码（扫满后绑定成功）',
    'POST', '/shipping/packing/bind', { plantId: sz, packingOrderId: packingId, operationId: `${s.run}-a08-bind` }, [200])
  must(run, '绑定成功（bound，托盘行打包状态已打包）', bind.body?.data?.status === 'bound', JSON.stringify(bind.body?.data))

  // ---- 5) 确认出库 ----
  const confirm = await httpStep(run, '确认出库（POST /shipping/ship/confirm）',
    'POST', '/shipping/ship/confirm',
    { plantId: sz, shipmentOrderId, reason: 'P1 验收：发运出库', operationId: `${s.run}-a08-ship` },
    [200])
  const cd = confirm.body?.data ?? {}
  must(run, '出库成功：已出库 + 实发轴差异（CAX-P1-01 vs 实发 PRDU 单元号 → pending）+ 状态回传 pending',
    cd.status === 'shipped' && cd.actualAxisSyncStatus === 'pending' && cd.shippingStatusSyncStatus === 'pending' && cd.postedUnits === 2,
    JSON.stringify(cd))

  // 库存已发运断言：单元 shipped + 余额关闭归零 + issue 流水（扣前/扣后）
  // D-2 修复后报工产出先经组单移位上架（线边+货架两段余额行），发运后每单元多条 closed
  // 余额行——按单元聚合（Σ余额=0 且全部行 closed），JOIN 不再一余产行。
  const shippedRows = sqlStep(run, 'SQL：库存已发运（单元状态/Σ余额/余额全关/issue 流水）',
    `SELECT u.unit_no, u.status, COALESCE(SUM(b.quantity),0)::text, (bool_and(b.status = 'closed'))::text AS all_closed,
       (SELECT t.movement_kind || ':' || t.before_qty::text || '→' || t.after_qty::text FROM stock_transaction t
        WHERE t.unit_id = u.id AND t.ref_type = 'shipment_order' LIMIT 1) AS issue_tx
     FROM inventory_unit u LEFT JOIN stock_balance b ON b.unit_id = u.id
     WHERE u.unit_no IN (${q(unitB?.unitNo)}, ${q(unitA?.unitNo)})
     GROUP BY u.unit_no, u.status, u.id`)
  const okShipped = shippedRows.length === 2 && shippedRows.every(
    (r) => r[1] === 'shipped' && eqQty(r[2], 0) && r[3] === 'true' && String(r[4]).startsWith('issue:'),
  )
  must(run, '库存已发运：两单元 shipped、余额关闭归零、issue 流水含扣前/扣后', okShipped, JSON.stringify(shippedRows))

  // ---- 6) 实发轴 / 发货状态两任务行独立断言 ----
  const taskRows = sqlStep(run, 'SQL：两条回传任务行（独立状态）',
    `SELECT task_kind, status FROM outbox
     WHERE aggregate_type = 'shipment_order' AND aggregate_id = ${q(shipmentOrderId)}
       AND task_kind IN ('shipping.actual-axis-sync','shipping.status-sync')`)
  const axisTask = taskRows.find((r) => r[0] === 'shipping.actual-axis-sync')
  const statusTask = taskRows.find((r) => r[0] === 'shipping.status-sync')
  must(run, '两任务行独立存在：实发轴 PENDING（有差异）/ 发货状态 PENDING',
    taskRows.length === 2 && axisTask?.[1] === 'PENDING' && statusTask?.[1] === 'PENDING', JSON.stringify(taskRows))

  // 独立恢复：状态先成功、实发轴先失败再成功（互不影响）
  const retryStatus = await httpStep(run, '发货状态回传重试成功',
    'POST', '/shipping/sync/status/retry', { plantId: sz, shipmentOrderId, operationId: `${s.run}-a08-sync-status1` }, [200])
  must(run, '状态回传 synced（快照=出库完成时点）', retryStatus.body?.data?.status === 'synced' && retryStatus.body?.data?.dispatched === true, JSON.stringify(retryStatus.body?.data))

  const retryAxisFail = await httpStep(run, '实发轴回传重试失败（模拟适配器 failure）',
    'POST', '/shipping/sync/actual-axis/retry', { plantId: sz, shipmentOrderId, outcome: 'failure', operationId: `${s.run}-a08-sync-axis-f` }, [200])
  must(run, '实发轴回传 sync_failed（不影响状态列）', retryAxisFail.body?.data?.status === 'sync_failed', JSON.stringify(retryAxisFail.body?.data))

  const syncStatusAfter = sqlOne(`SELECT shipping_status_sync_status FROM shipment_order WHERE id = ${q(shipmentOrderId)}`)
  const axisStatusAfter = sqlOne(`SELECT actual_axis_sync_status FROM shipment_order WHERE id = ${q(shipmentOrderId)}`)
  must(run, '两列独立：shipping=synced / actual_axis=sync_failed',
    syncStatusAfter === 'synced' && axisStatusAfter === 'sync_failed', `shipping=${syncStatusAfter} axis=${axisStatusAfter}`)

  const retryAxisOk = await httpStep(run, '实发轴回传再次重试成功（恢复）',
    'POST', '/shipping/sync/actual-axis/retry', { plantId: sz, shipmentOrderId, operationId: `${s.run}-a08-sync-axis-ok` }, [200])
  must(run, '实发轴回传恢复 synced', retryAxisOk.body?.data?.status === 'synced', JSON.stringify(retryAxisOk.body?.data))

  // ---- 7) 无差异 NOOP_NEEDED 一例（实发轴号=快照客户轴号） ----
  const plNo2 = `PL-${s.run}-002`
  const unitC = prdu.find((u) => Number(u.qty) === 1500) // op1 1500
  const pl2 = await httpStep(run, `无差异 PL 入站（客户轴号=实发单元号 ${unitC?.unitNo}）`,
    'POST', '/shipping/pl/inbound',
    {
      plNo: plNo2, salesOrderNo: `SO-${s.run}-SHIP2`, customerName: 'P1电缆客户', plantId: sz,
      lines: [{ lineNo: 1, lineKind: 'axis_item', materialId: s.mat['MAT-P1-FIN'], materialCode: 'MAT-P1-FIN', salesOrderLineNo: '10', customerAxisNo: unitC?.unitNo, standardSegmentLength: '1500.0000' }],
      operationId: `${s.run}-a08-pl2`,
    },
    [200, 201])
  const orderId2 = pl2.body?.data?.orderId ?? null
  const line2Id = sqlOne(`SELECT id FROM shipment_line WHERE shipment_order_id = ${q(orderId2)} AND line_no = 1`)
  await httpStep(run, '无差异备货扫码（实发轴号==客户轴号）',
    'POST', '/shipping/scan/load',
    { plantId: sz, shipmentOrderId: orderId2, lineId: line2Id, unitNo: unitC?.unitNo, operationId: `${s.run}-a08-scan2` },
    [200, 201])

  const confirm2 = await httpStep(run, '无差异确认出库 → 实发轴 NOOP_NEEDED（不是失败）',
    'POST', '/shipping/ship/confirm',
    { plantId: sz, shipmentOrderId: orderId2, operationId: `${s.run}-a08-ship2` },
    [200])
  must(run, '无差异：actualAxisSyncStatus=noop_needed + 发货状态 pending',
    confirm2.body?.data?.actualAxisSyncStatus === 'noop_needed' && confirm2.body?.data?.shippingStatusSyncStatus === 'pending',
    JSON.stringify(confirm2.body?.data))
  const noopTask = sqlOne(
    `SELECT status FROM outbox WHERE aggregate_type = 'shipment_order' AND aggregate_id = ${q(orderId2)} AND task_kind = 'shipping.actual-axis-sync'`)
  must(run, '实发轴任务行 NOOP_NEEDED（IF-00.4 无需同步不是失败态）', noopTask === 'NOOP_NEEDED', `status=${noopTask}`)

  // 重试已成功侧（noop）跳过不重做
  const noopRetry = await httpStep(run, '无差异侧实发轴重试 → skipped（终态不重做）',
    'POST', '/shipping/sync/actual-axis/retry', { plantId: sz, shipmentOrderId: orderId2, operationId: `${s.run}-a08-sync-noop` }, [200])
  must(run, 'noop 侧重试 skipped=true', noopRetry.body?.data?.skipped === true, JSON.stringify(noopRetry.body?.data))

  run.saveState()
  return run
}
