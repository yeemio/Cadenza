/**
 * A04 报工与投料（P1 验收）：
 * - 三入口各提交一张同类报工（order/workbench/scan）：服务端同规则
 *   （非末道提交即自动审核；末道待审 → 人工审核同一记账路径）；
 * - 三账断言：线边库余额 + 订单完成数量 + Outbox 末道产出任务；
 * - 同 operationId 重放不重复；超产拒绝一次；
 * - 单独投料一单（实时扣减 + 扣前/扣后流水 + 重放不重复扣）——D-1 修复后语义：
 *   [A7-2] 线边判定=单元所在库位隶属仓库类型 LINE_SIDE（主数据事实），
 *   非线边仓（9101 物流成品仓）单元被正确拒绝；LINE_SIDE 仓（9102）产出单元投料成功。
 */
import { must, httpStep, sqlStep, sqlOne, q, eqQty, UOM_M_ID, UOM_M, OWNER_NAME } from '../lib.mjs'

function outputLine(s, quantity, locationCode = '91020101') {
  return {
    quantity, uomId: UOM_M_ID, uomCode: UOM_M,
    targetLocationId: s.loc.sz9102[locationCode], targetLocationCode: locationCode,
    ownerId: s.entId, ownerName: OWNER_NAME,
  }
}

export async function run(run) {
  run.setScenario('A04')
  const s = run.state
  const orderId = s.order.orderId

  // ---- 1) 三入口同类报工（op1 拉丝，非末道 → 提交即自动审核） ----
  const entries = [
    { name: '实绩录入（order 入口）', path: `/execution/orders/${orderId}/reports`, body: { orderOperationId: s.order.op1Id, outputs: [outputLine(s, '2000.0000')] }, opId: `${s.run}-a04-r-order` },
    { name: '工作台（workbench 入口）', path: '/execution/workbench/reports', body: { orderId, orderOperationId: s.order.op1Id, outputs: [outputLine(s, '1500.0000')] }, opId: `${s.run}-a04-r-wb` },
    { name: '扫码（scan 入口，设备当日排产默认绑定工序）', path: '/execution/scan/reports', body: { orderId, equipmentId: s.equipment['EQ-P1-01'].id, equipmentCode: 'EQ-P1-01', outputs: [outputLine(s, '1000.0000')] }, opId: `${s.run}-a04-r-scan` },
  ]
  s.reports = {}
  for (const e of entries) {
    const res = await httpStep(run, `三入口报工：${e.name} → op1 产出`,
      'POST', e.path, { ...e.body, operationId: e.opId }, [200, 201])
    const data = res.body?.data ?? {}
    s.reports[e.opId] = { reportId: data.reportId, source: data.source }
    must(run, `${e.name} 成功且自动审核（auto_approved）`, res.body?.status === 'COMMITTED' && data.reviewOutcome === 'auto_approved', JSON.stringify(data))
  }

  // 服务端同规则：三张报工单来源三值、全部 auto_approved、工序同为 op1
  const reportRows = sqlStep(run, 'SQL：三入口报工单（source/order_operation/review）',
    `SELECT source, order_operation_id, review_status, status FROM production_report WHERE order_id = ${q(orderId)} ORDER BY source`)
  must(run, '三入口同规则：source ∈ {order,scan,workbench}、全部 auto_approved、同一工序',
    reportRows.length === 3 &&
      ['order', 'scan', 'workbench'].every((src) => reportRows.some((r) => r[0] === src)) &&
      reportRows.every((r) => r[2] === 'auto_approved' && r[1] === s.order.op1Id && r[3] === 'submitted'),
    JSON.stringify(reportRows))

  // ---- 2) 非末道三账断言：线边余额 4500 / 完成数量 0 / 无末道推送 ----
  const balOp1 = sqlOne(
    `SELECT COALESCE(SUM(b.quantity),0)::text FROM stock_balance b
     JOIN report_output o ON o.stock_unit_id = b.unit_id
     JOIN production_report r ON r.id = o.report_id
     WHERE r.order_id = ${q(orderId)} AND r.operation_seq = 1 AND b.status = 'active'`)
  const completed1 = sqlOne(`SELECT completed_qty::text FROM production_order WHERE id = ${q(orderId)}`)
  const pushOp1 = sqlOne(
    `SELECT count(*) FROM outbox WHERE task_kind = 'execution.last-operation-output-push' AND payload->>'orderId' = ${q(orderId)}`)
  sqlStep(run, 'SQL 三账（非末道）：Σ线边余额 / completed_qty / 末道推送任务数',
    `SELECT ${balOp1}, ${completed1}, ${pushOp1}`)
  must(run, '非末道三账：Σ线边余额=4500、完成数量=0（非末道不回写）、无末道推送任务',
    eqQty(balOp1, 4500) && eqQty(completed1, 0) && Number(pushOp1) === 0,
    `balances=${balOp1} completed=${completed1} push=${pushOp1}`)

  // ---- 3) 末道报工（op2）→ 待审 → 人工审核 → 三账 ----
  const lastSubmit = await httpStep(run, '末道报工：op2 绞制 600（真实配置末道一律待审）',
    'POST', `/execution/orders/${orderId}/reports`,
    { orderOperationId: s.order.op2Id, outputs: [outputLine(s, '600.0000')], operationId: `${s.run}-a04-r-last` },
    [200, 201])
  const lastData = lastSubmit.body?.data ?? {}
  s.reports[`${s.run}-a04-r-last`] = { reportId: lastData.reportId }
  s.ops = { ...(s.ops ?? {}), 'execution.report.submit': `${s.run}-a04-r-last` }
  must(run, '末道提交 → pending_review（待人工审核）', lastData.reviewOutcome === 'pending_review', JSON.stringify(lastData))

  const review = await httpStep(run, '班组长审核通过（POST /execution/reports/:id/review）',
    'POST', `/execution/reports/${lastData.reportId}/review`, { operationId: `${s.run}-a04-review` }, [200])
  must(run, '人工审核 manual_approved', review.body?.data?.reviewStatus === 'manual_approved', JSON.stringify(review.body?.data))

  const balOp2 = sqlOne(
    `SELECT COALESCE(SUM(b.quantity),0)::text FROM stock_balance b
     JOIN report_output o ON o.stock_unit_id = b.unit_id
     JOIN production_report r ON r.id = o.report_id
     WHERE r.order_id = ${q(orderId)} AND r.operation_seq = 2 AND b.status = 'active'`)
  const completed2 = sqlOne(`SELECT completed_qty::text FROM production_order WHERE id = ${q(orderId)}`)
  const pushRows = sqlStep(run, 'SQL 三账（末道审核后）：Σ成品线边余额 / completed_qty / Outbox 末道产出推送',
    `SELECT b.quantity::text, b.quality_status FROM stock_balance b
       JOIN report_output o ON o.stock_unit_id = b.unit_id
       JOIN production_report r ON r.id = o.report_id
       WHERE r.order_id = ${q(orderId)} AND r.operation_seq = 2 AND b.status = 'active'`)
  const pushCount = sqlOne(
    `SELECT count(*) FROM outbox WHERE task_kind = 'execution.last-operation-output-push' AND payload->>'orderId' = ${q(orderId)}`)
  const pushPayload = sqlOne(
    `SELECT payload->>'operationSeq' FROM outbox WHERE task_kind = 'execution.last-operation-output-push' AND payload->>'orderId' = ${q(orderId)}`)
  must(run, '末道三账：Σ成品线边余额=600、completed_qty=600、Outbox 末道推送 1 行（seq=2）',
    eqQty(balOp2, 600) && eqQty(completed2, 600) && Number(pushCount) === 1 && pushPayload === '2',
    `balances=${balOp2} completed=${completed2} push=${pushCount} seq=${pushPayload} rows=${JSON.stringify(pushRows)}`)

  // 产出单元 id（A08 备货/发运用）
  const prduUnits = sqlStep(run, 'SQL：本单产出单元（线边库，qualified）',
    `SELECT o.stock_unit_id, u.unit_no, b.quantity::text FROM report_output o
     JOIN inventory_unit u ON u.id = o.stock_unit_id
     LEFT JOIN stock_balance b ON b.unit_id = u.id AND b.status = 'active'
     JOIN production_report r ON r.id = o.report_id
     WHERE r.order_id = ${q(orderId)} ORDER BY r.operation_seq, o.line_no`)
  s.prduUnits = prduUnits.map((r) => ({ unitId: r[0], unitNo: r[1], qty: r[2] }))
  must(run, '产出单元 4 个（op1×3 + op2×1）且在库合格',
    s.prduUnits.length === 4 && s.prduUnits.every((u) => u.unitNo && Number(u.qty) > 0),
    JSON.stringify(s.prduUnits))

  // ---- 4) 同 operationId 重放（断响应恢复：同 operationId 重发返回原结果） ----
  const replay = await httpStep(run, '断响应重放：同 operationId 重发末道报工命令',
    'POST', `/execution/orders/${orderId}/reports`,
    { orderOperationId: s.order.op2Id, outputs: [outputLine(s, '600.0000')], operationId: `${s.run}-a04-r-last` },
    [200, 201])
  const receiptCount = sqlOne(`SELECT count(*) FROM command_receipt WHERE operation_id = ${q(`${s.run}-a04-r-last`)}`)
  const reportCount = sqlOne(`SELECT count(*) FROM production_report WHERE order_id = ${q(orderId)} AND status <> 'deleted'`)
  must(run, '重放返回原结果且不重复入账（回执 1 行、报工单仍 4 张）',
    replay.body?.data?.reportId === lastData.reportId && Number(receiptCount) === 1 && Number(reportCount) === 4,
    `replay.reportId=${replay.body?.data?.reportId} receipts=${receiptCount} reports=${reportCount}`)

  // ---- 5) 超产拒绝一次（GAP C1 保守默认：不允许超产） ----
  const over = await httpStep(run, '超产拒绝：末道再报 500（600+500 > 1000×1.0）→ 422 [A5-1]',
    'POST', `/execution/orders/${orderId}/reports`,
    { orderOperationId: s.order.op2Id, outputs: [outputLine(s, '500.0000')], operationId: `${s.run}-a04-r-over` },
    422)
  must(run, '超产拒绝（A5-1）', String(over.body?.message ?? '').includes('A5-1'), JSON.stringify(over.body))
  const noDraft = sqlOne(`SELECT count(*) FROM execution_session WHERE order_id = ${q(orderId)} AND status = 'open'`)
  must(run, '拒绝不残留草稿', Number(noDraft) === 0, `open sessions=${noDraft}`)

  // ---- 6) 单独投料一单（D-1 修复后：A7-2 线边判定=库位隶属仓库类型 LINE_SIDE） ----
  // 投料目标订单：单工序绞制（投料源=本 run 产出单元，跨订单 confirmed+偏离记录）
  const feedOrderNo = `MO-${s.run}-FEED`
  const feedOrder = await httpStep(run, `建投料目标订单 ${feedOrderNo}（单工序）`,
    'POST', '/process/orders/receive',
    {
      orderNo: feedOrderNo, materialId: s.mat['MAT-P1-FIN'], productionDeptId: s.nodes['DEPT-SZ-JZ'], productionQty: '1000.0000',
      uom: 'M', processConfirmed: true, initialStatus: 'released',
      operations: [{ seq: 1, operationDefinitionId: s.opDef['OP-P1-02'], workCenterId: s.wcId }],
      operationId: `${s.run}-a04-feed-order`,
    },
    [200, 201])
  const feedOrderId = feedOrder.body?.data?.orderId ?? null
  s.feedOrderId = feedOrderId
  await httpStep(run, '投料目标订单开工', 'POST', `/process/orders/${feedOrderId}/start`, { operationId: `${s.run}-a04-feed-start` }, [200])
  const feedOpId = sqlOne(`SELECT id FROM order_operation WHERE order_id = ${q(feedOrderId)} AND seq = 1`)
  s.feedOpId = feedOpId
  must(run, '投料目标订单就绪（in_progress + op1）', Boolean(feedOrderId && feedOpId), `order=${feedOrderId} op=${feedOpId}`)

  // (a) 反证一：非线边仓（9101 物流成品仓 91010101）在库合格单元 → 422 [A7-2]（线边链步正确拒绝）
  const whFeed = await httpStep(run, '单独投料反证：铜杆 50（9101 物流成品仓在库单元 → 应拒）',
    'POST', '/execution/feeds',
    {
      orderId: feedOrderId, orderOperationId: feedOpId,
      lines: [{
        unitId: s.po.batch1.unitId, quantity: '50.0000', salesOrderNo: `SO-${s.run}-001`, salesLineNo: '10',
        confirmed: true, deviationReason: 'P1 验收：跨订单原料投料授权偏离记录',
      }],
      operationId: `${s.run}-a04-feed-wh`,
    },
    422)
  must(run, '非线边仓（9101）单元投料被拒（[A7-2] 线边判定=仓库类型 LINE_SIDE）',
    String(whFeed.body?.message ?? '').includes('A7-2') && String(whFeed.body?.message ?? '').includes('线边库'),
    JSON.stringify(whFeed.body?.message))

  // (b) 正例：LINE_SIDE 仓（9102 线边库位 91020101）在库合格单元投料成功（实时扣减+扣前/扣后）。
  // 投料源用场景内专用直收单元（/inventory/receive 收至线边库位、qualified、200 全量投空）——
  // 不取本 run 报工产出单元：产出单元已被 A06 组单上架任务按报工量整量覆盖（任务快照量），
  // 若此处部分消耗（1000→950），A06 移位上架会 [IT-30] 移位量超过来源余额（D-1 修复后投料
  // 真实扣减才暴露的场景纠缠，非产品缺陷）。专用单元投空后零余额关闭，不影响 A06 线边清零对账。
  const lsFeedUnitNo = `U-${s.run}-LSFEED`
  const lsRecv = await httpStep(run, `线边投料源直收：${lsFeedUnitNo} 200（POST /inventory/receive → 91020101 qualified）`,
    'POST', '/inventory/receive',
    {
      plantId: s.szPlantId, lotNo: `LOT-${s.run}-LSFEED`, unitNo: lsFeedUnitNo,
      materialId: s.mat['MAT-P1-FIN'], materialCode: 'MAT-P1-FIN',
      uomId: UOM_M_ID, uomCode: UOM_M, quantity: '200.0000', measurementBasis: 'nominal',
      locationId: s.loc.sz9102['91020101'], locationCode: '91020101',
      ownerId: s.entId, ownerName: OWNER_NAME, qualityStatus: 'qualified',
      operationId: `${s.run}-a04-feed-src`,
    },
    [200, 201])
  const lsUnitId = lsRecv.body?.data?.unitId ?? null
  must(run, '线边投料源就绪（直收 200 qualified 至 91020101）', Boolean(lsUnitId), JSON.stringify(lsRecv.body))
  await httpStep(run, '单独投料：线边在库合格单元 200 全量（POST /execution/feeds，跨订单 confirmed+偏离记录）',
    'POST', '/execution/feeds',
    {
      orderId: feedOrderId, orderOperationId: feedOpId,
      lines: [{
        unitId: lsUnitId, quantity: '200.0000', salesOrderNo: `SO-${s.run}-001`, salesLineNo: '10',
        confirmed: true, deviationReason: 'P1 验收：跨订单原料投料授权偏离记录',
      }],
      operationId: `${s.run}-a04-feed`,
    },
    [200, 201])
  const consumption = sqlStep(run, 'SQL：投料流水（扣前/扣后）',
    `SELECT before_qty::text, after_qty::text, feed_type FROM material_consumption WHERE inventory_unit_id = ${q(lsUnitId)}`)
  const balAfterRows = sqlStep(run, 'SQL：投料后余额（200 全量投空 → 零余额关闭，线边不残留）',
    `SELECT quantity::text, status FROM stock_balance WHERE unit_id = ${q(lsUnitId)}`)
  must(run, '投料实时扣减：扣前 200 → 扣后 0（含流水扣前/扣后；零余额关闭不残留线边）',
    consumption.length === 1 && eqQty(consumption[0][0], 200) && eqQty(consumption[0][1], 0) &&
      balAfterRows.length === 1 && eqQty(balAfterRows[0][0], 0) && balAfterRows[0][1] === 'closed',
    JSON.stringify({ consumption, balAfterRows }))
  const feedReplay = await httpStep(run, '投料同 operationId 重放', 'POST', '/execution/feeds',
    {
      orderId: feedOrderId, orderOperationId: feedOpId,
      lines: [{ unitId: lsUnitId, quantity: '200.0000', salesOrderNo: `SO-${s.run}-001`, salesLineNo: '10', confirmed: true, deviationReason: 'P1 验收：跨订单原料投料授权偏离记录' }],
      operationId: `${s.run}-a04-feed`,
    },
    [200, 201])
  const issueCount = sqlOne(`SELECT count(*) FROM stock_transaction WHERE unit_id = ${q(lsUnitId)} AND movement_kind = 'issue'`)
  must(run, '投料重放不重复扣（issue 流水仍 1 行）', Number(issueCount) === 1, `issue=${issueCount} replay=${JSON.stringify(feedReplay.body?.data ?? feedReplay.body)}`)

  run.saveState()
  return run
}
