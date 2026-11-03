/**
 * A11 恢复与幂等抽验（P1 验收）：
 * - 总线幂等（断响应恢复）：同 operationId 重发 → 返回原结果、回执单行、业务账不重复；
 * - 业务键幂等：不同 operationId 重发同业务键（五元组/单号）→ skipped/applied=false 不重复应用。
 *（报工同 operationId 重放已在 A04 步 4 取证一例；此处跨域抽 3 命令。）
 */
import { must, httpStep, sqlStep, sqlOne, q } from '../lib.mjs'

export async function run(run) {
  run.setScenario('A11')
  const s = run.state
  const sz = s.szPlantId

  // ---- #1 purchase.order-sync：总线幂等 + 五元组幂等 ----
  const replaySync = await httpStep(run, '重放 #1a：ERP 订单同步（同 operationId 原载荷重发 → 返回原结果）',
    'POST', '/purchase/orders/sync',
    {
      orgCode: 'ORG-HD', orderNo: s.po.orderNo, sourceSystem: 'ERP', plantId: sz, supplierName: 'P1铜材供应商', contractNo: 'CT-P1-001',
      lines: [
        { lineNo: 10, materialCode: 'MAT-P1-RAW', materialName: 'P1验收-铜杆（需检）', plannedQty: '500.0000', overReceiptLimit: '550.0000', status: 1 },
        { lineNo: 20, materialCode: 'MAT-P1-EXP', materialName: 'P1验收-免检辅材', plannedQty: '100.0000', status: 1 },
      ],
      operationId: s.ops['purchase.order-sync'],
    },
    [200, 201])
  const rLines = replaySync.body?.data?.lines ?? []
  must(run, '同 operationId 重放返回原结果（lineId/applied 与首跑一致）',
    rLines.length === 2 && rLines[0]?.lineId === s.po.line10Id && rLines[0]?.applied === true && rLines[1]?.lineId === s.po.line20Id,
    JSON.stringify(rLines))

  const resyncNewOp = await httpStep(run, '重放 #1b：不同 operationId 重发同单号（五元组幂等 → applied=false）',
    'POST', '/purchase/orders/sync',
    {
      orgCode: 'ORG-HD', orderNo: s.po.orderNo, sourceSystem: 'ERP', plantId: sz,
      lines: [
        { lineNo: 10, materialCode: 'MAT-P1-RAW', plannedQty: '500.0000', overReceiptLimit: '550.0000', status: 1 },
        { lineNo: 20, materialCode: 'MAT-P1-EXP', plannedQty: '100.0000', status: 1 },
      ],
      operationId: `${s.run}-a11-posync-b`,
    },
    [200, 201])
  const bLines = resyncNewOp.body?.data?.lines ?? []
  const lineCount = sqlOne(`SELECT count(*) FROM purchase_order_line WHERE order_no = ${q(s.po.orderNo)}`)
  must(run, '五元组幂等：applied=false（不重复应用）且订单行仍 2 行',
    bLines.every((l) => l.applied === false) && Number(lineCount) === 2, `lines=${JSON.stringify(bLines)} lineCount=${lineCount}`)

  // ---- #2 process.order.receive：总线幂等 ----
  const replayOrder = await httpStep(run, '重放 #2：生产订单接收（同 operationId 重发）',
    'POST', '/process/orders/receive',
    {
      orderNo: s.order.orderNo, materialId: s.mat['MAT-P1-FIN'], productionDeptId: s.nodes['DEPT-SZ-JZ'],
      productionQty: '1000.0000', uom: 'M', productFamilyId: s.famId, processConfirmed: true, initialStatus: 'released',
      salesOrderNo: `SO-${s.run}-001`, operationId: s.ops['process.order.receive'],
    },
    [200, 201])
  const orderCount = sqlOne(`SELECT count(*) FROM production_order WHERE order_no = ${q(s.order.orderNo)}`)
  const opCount = sqlOne(`SELECT count(*) FROM order_operation WHERE order_id = ${q(s.order.orderId)}`)
  must(run, '订单接收重放：同 orderId 原结果且订单仍 1 张/工序仍 2 行',
    replayOrder.body?.data?.orderId === s.order.orderId && Number(orderCount) === 1 && Number(opCount) === 2,
    `orderId=${replayOrder.body?.data?.orderId} orders=${orderCount} ops=${opCount}`)

  // ---- #3 shipping.pl.inbound：总线幂等 + 单号幂等 ----
  const replayPl = await httpStep(run, '重放 #3a：PL 入站（同 operationId 原载荷重发 → 返回原结果）',
    'POST', '/shipping/pl/inbound',
    {
      plNo: s.shipment.plNo, salesOrderNo: `SO-${s.run}-SHIP`, customerName: 'P1电缆客户', plantId: sz,
      lines: [
        { lineNo: 1, lineKind: 'axis_item', materialId: s.mat['MAT-P1-FIN'], materialCode: 'MAT-P1-FIN', salesOrderLineNo: '10', customerAxisNo: 'CAX-P1-01', standardSegmentLength: '600.0000' },
        { lineNo: 2, lineKind: 'pallet', materialId: s.mat['MAT-P1-FIN'], materialCode: 'MAT-P1-FIN', salesOrderLineNo: '10', requiredCount: 1 },
      ],
      operationId: s.ops['shipping.pl.inbound'],
    },
    [200, 201])
  must(run, '同 operationId 重放返回原结果（orderId=原单、created=1）',
    replayPl.body?.data?.orderId === s.shipment.orderId && replayPl.body?.data?.created === 1,
    JSON.stringify(replayPl.body?.data))

  const replNewOp = await httpStep(run, '重放 #3b：不同 operationId 重发同 PL 单号（单号幂等 → skipped）',
    'POST', '/shipping/pl/inbound',
    {
      plNo: s.shipment.plNo, salesOrderNo: `SO-${s.run}-SHIP`, plantId: sz,
      lines: [{ lineNo: 1, lineKind: 'axis_item', materialCode: 'MAT-P1-FIN', salesOrderLineNo: '10', customerAxisNo: 'CAX-P1-01', standardSegmentLength: '600.0000' }],
      operationId: `${s.run}-a11-pl-b`,
    },
    [200, 201])
  const plCount = sqlOne(`SELECT count(*) FROM shipment_order WHERE pl_no = ${q(s.shipment.plNo)}`)
  must(run, '单号幂等：skipped=true 且发货单仍 1 张',
    replNewOp.body?.data?.skipped === true && replNewOp.body?.data?.created === 0 && Number(plCount) === 1,
    `data=${JSON.stringify(replNewOp.body?.data)} plCount=${plCount}`)

  // ---- 回执单行性（总线幂等底账） ----
  sqlStep(run, 'SQL：四例同 operationId 重放命令的回执行数（各 1 行）',
    `SELECT operation_id, count(*) FROM command_receipt
     WHERE operation_id IN (${q(s.ops['purchase.order-sync'])}, ${q(s.ops['process.order.receive'])}, ${q(s.ops['shipping.pl.inbound'])}, ${q(s.ops['execution.report.submit'])})
     GROUP BY operation_id ORDER BY operation_id`)
  const receiptRows = Math.trunc(Number(sqlOne(
    `SELECT count(*) FROM command_receipt WHERE operation_id IN (${q(s.ops['purchase.order-sync'])}, ${q(s.ops['process.order.receive'])}, ${q(s.ops['shipping.pl.inbound'])}, ${q(s.ops['execution.report.submit'])})`)))
  must(run, '四例（含 A04 报工）回执各 1 行（合计 4，重放不新增回执）', receiptRows === 4, `receipts=${receiptRows}`)

  // ---- 接口账一致性抽样：单例任务种类无重复行 ----
  const outboxDup = sqlOne(
    `SELECT count(*) FROM (SELECT aggregate_type, aggregate_id, task_kind, count(*) c FROM outbox
      WHERE task_kind IN ('qualified_sync','execution.last-operation-output-push','shipping.actual-axis-sync','shipping.status-sync','quality.disposition-released')
      GROUP BY 1,2,3 HAVING count(*) > 1) d`)
  must(run, '接口账抽样：单例任务种类（合格回传/末道推送/双回传/放行）无重复行', Number(outboxDup) === 0, `dupGroups=${outboxDup}`)

  run.saveState()
  return run
}
