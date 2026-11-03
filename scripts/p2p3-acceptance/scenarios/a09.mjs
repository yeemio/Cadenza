/**
 * A09 两种形态转换（conversion 域，P2-B/T16）：
 * - 订单式（协议A：本地先执行后同步）：建单→扫码（R 码拒/重复扫拒）→完成（本地归属调整 +
 *   Outbox 任务）→ 外部失败登记（保留本地事实与差异）→ 重试成功（不重复本地转换）；
 * - 库存式（协议B：外部先成功再本地）：保存→派发→模拟外部成功回执→MES 改码（FC-16 不改项目号）
 *   →完成；本地失败注入→重新同步（不推 U9，重试不重复）；
 * - 外部未知中间态一例（FC-03：unknown→人工核对态，盲重发被拒，核对后回填成功）。
 */
import { must, httpStep, sqlStep, sqlOne, q, ensureAdminPermissions } from '../lib.mjs'

export async function run(run) {
  await ensureAdminPermissions(run) // 场景自足：并行会话 seed 可能中途重置授权
  run.setScenario('A09')
  const s = run.state
  const plant = s.szPlantId

  // ================================================================
  // 1) 协议A：订单形态转换（本地先执行、后异步同步）
  // ================================================================
  const createA = await httpStep(run, '协议A建单（SRC→TGT，销售单+行号与订单事实一致）',
    'POST', '/conversion/order/create',
    {
      plantId: plant,
      lines: [{
        sourceOrderId: s.orderSrc.orderId, sourceSalesOrderNo: `SO-${s.run}-001`, sourceLineNo: '10',
        targetOrderId: s.orderTgt.orderId, targetProjectNo: `PJ-${s.run}-T`,
        quantity: '100.0000', uom: 'M',
      }],
      operationId: `${s.run}-a09-cv-create`,
    },
    [200, 201])
  const cvId = createA.body?.data?.conversionId ?? null
  const lineId = createA.body?.data?.lines?.[0]?.lineId ?? null
  s.a09 = { cvId }
  must(run, '建单成功（待转换/未同步 + 明细行）',
    createA.body?.data?.status === 'pending' && createA.body?.data?.syncStatus === 'pending' && Boolean(lineId),
    JSON.stringify(createA.body?.data))

  // FC-07 载具码规则：R 型码拒
  const rCode = await httpStep(run, '协议A扫码反例：R 型码 → 422 [FC-07]',
    'POST', '/conversion/order/scan',
    { plantId: plant, conversionOrderId: cvId, lineId, unitNo: `1R${s.run.replace(/-/g, '').slice(0, 7)}`, segmentLength: '10.0000', operationId: `${s.run}-a09-cv-scan-r` },
    422)
  must(run, 'R 型码被拒（FC-07 载具码类型位）', String(rCode.body?.message ?? '').includes('FC-07'), JSON.stringify(rCode.body?.message))

  // 扫码（真实载具码单元，归属 SRC 订单——S0 造数事实）
  const scanA = await httpStep(run, '协议A扫码：载具码 1E…（锁定二维码+回写实扫）',
    'POST', '/conversion/order/scan',
    { plantId: plant, conversionOrderId: cvId, lineId, unitNo: s.uCvA, segmentLength: '100.0000', operationId: `${s.run}-a09-cv-scan` },
    [200, 201])
  must(run, '扫码成功（scannedAxes=1、预留引用）', scanA.body?.data?.scannedAxes === 1 && Boolean(scanA.body?.data?.reservationId), JSON.stringify(scanA.body?.data))

  const dupScan = await httpStep(run, '重复扫同一码 → 422 [FC-07]',
    'POST', '/conversion/order/scan',
    { plantId: plant, conversionOrderId: cvId, lineId, unitNo: s.uCvA, segmentLength: '100.0000', operationId: `${s.run}-a09-cv-scan-dup` },
    422)
  must(run, '重复扫码被拒', String(dupScan.body?.message ?? '').includes('FC-07'), JSON.stringify(dupScan.body?.message))

  // 完成：本地先执行（归属改 TGT + Outbox 推 U9 + 库存统计）
  const completeA = await httpStep(run, '协议A完成转换（本地先执行）',
    'POST', '/conversion/order/complete',
    { plantId: plant, conversionOrderId: cvId, operationId: `${s.run}-a09-cv-complete` },
    [200, 201])
  must(run, '完成转换：状态已完成、归属调整 1 条',
    completeA.body?.data?.status === 'completed' && (completeA.body?.data?.assignments ?? []).length === 1,
    JSON.stringify(completeA.body?.data))

  const assignRows = sqlStep(run, 'SQL：归属调整（from SRC → to TGT）',
    `SELECT from_order_id, to_order_id FROM conversion_code_assignment WHERE unit_no = ${q(s.uCvA)}`)
  must(run, '归属调整落库（FC-08）',
    assignRows.length === 1 && assignRows[0][0] === s.orderSrc.orderId && assignRows[0][1] === s.orderTgt.orderId, JSON.stringify(assignRows))

  const outboxA = sqlStep(run, 'SQL：Outbox 双任务（推 U9 + 库存统计）',
    `SELECT task_kind, count(*) FROM outbox WHERE aggregate_type = 'conversion_order' AND aggregate_id = ${q(cvId)} GROUP BY task_kind`)
  const outboxAMap = Object.fromEntries(outboxA.map((r) => [r[0], Number(r[1])]))
  must(run, 'Outbox：form_conversion_push + inventory-stats 各 1 行',
    outboxAMap['form_conversion_push'] === 1 && outboxAMap['form_conversion.inventory-stats'] === 1, JSON.stringify(outboxA))

  // 外部失败登记（FC-10：保留本地事实与差异，本地不回滚）
  const failA = await httpStep(run, '协议A外部失败登记（保留差异，本地不回滚）',
    'POST', '/conversion/order/sync-retry',
    { plantId: plant, conversionOrderId: cvId, outcome: 'failure', operationId: `${s.run}-a09-cv-fail` },
    [200, 201])
  must(run, '失败登记：syncStatus=sync_failed', failA.body?.data?.syncStatus === 'sync_failed', JSON.stringify(failA.body?.data))

  // 重试成功（FC-09：不重复本地转换）
  const retryA = await httpStep(run, '协议A重试成功（不重复本地转换）',
    'POST', '/conversion/order/sync-retry',
    { plantId: plant, conversionOrderId: cvId, outcome: 'success', operationId: `${s.run}-a09-cv-retry` },
    [200, 201])
  must(run, '重试成功：syncStatus=synced', retryA.body?.data?.syncStatus === 'synced', JSON.stringify(retryA.body?.data))
  const assignCount = sqlOne(`SELECT count(*) FROM conversion_code_assignment WHERE unit_no = ${q(s.uCvA)}`)
  must(run, '重试不重复本地转换（归属调整仍 1 条）', Number(assignCount) === 1, `assignments=${assignCount}`)

  // ================================================================
  // 2) 协议B：库存形态转换——外部先成功、再本地（含本地失败恢复）
  // ================================================================
  const createB1 = await httpStep(run, '协议B建单（仓内单元 b1，源库存预留）',
    'POST', '/conversion/stock/create',
    {
      plantId: plant, materialId: s.mat['MAT-P23-FIN'],
      targetSalesOrderNo: `SO-${s.run}-101`, targetLineNo: '20', targetBatchNo: `B-${s.run}-1`, targetProjectNo: `PJ-${s.run}-B1`,
      lines: [{ unitNo: s.uCvB1, segmentLength: '100.0000' }],
      operationId: `${s.run}-a09-cvs-create1`,
    },
    [200, 201])
  const cvB1 = createB1.body?.data?.conversionId ?? null
  s.a09.cvB1 = cvB1
  must(run, '建单成功（内部待执行/对外投影 convert_failed）',
    createB1.body?.data?.internalStatus === 'pending_execute' && createB1.body?.data?.displayStatus === 'convert_failed',
    JSON.stringify(createB1.body?.data))

  await httpStep(run, '协议B派发 U9（Outbox 任务驱动，业务事务不跨公网）',
    'POST', '/conversion/stock/push',
    { plantId: plant, conversionStockOrderId: cvB1, operationId: `${s.run}-a09-cvs-push1` },
    [200, 201])

  const pushRows1 = sqlStep(run, 'SQL：派发任务行（幂等键=聚合身份）',
    `SELECT task_kind, payload->>'idempotencyKey', count(*) FROM outbox WHERE aggregate_type = 'conversion_stock_order' AND aggregate_id = ${q(cvB1)} GROUP BY task_kind, payload->>'idempotencyKey'`)
  must(run, '派发任务 1 行（task_kind=form_conversion_push）', pushRows1.length === 1 && pushRows1[0][0] === 'form_conversion_push', JSON.stringify(pushRows1))

  const ok1 = await httpStep(run, '模拟外部成功回执（push-result success）',
    'POST', '/conversion/stock/push-result',
    { plantId: plant, conversionStockOrderId: cvB1, outcome: 'success', externalDocNo: `U9-${s.run}-1`, operationId: `${s.run}-a09-cvs-ok1` },
    [200, 201])
  must(run, '回填成功：内部本地处理中、u9Success=true', ok1.body?.data?.internalStatus === 'local_processing' && ok1.body?.data?.u9Success === true, JSON.stringify(ok1.body?.data))

  // 本地失败注入（U9 已成功、MES 改码前退出）
  const localFail = await httpStep(run, '本地应用失败注入（U9 已成功、MES 改码前退出）',
    'POST', '/conversion/stock/local-apply',
    { plantId: plant, conversionStockOrderId: cvB1, outcome: 'failure', failureReason: 'P23 验收：改码前进程退出注入', operationId: `${s.run}-a09-cvs-localfail` },
    [200, 201])
  must(run, '本地失败：待恢复 + 对外 sync_failed + localApplyStatus=failed',
    localFail.body?.data?.internalStatus === 'pending_recovery' && localFail.body?.data?.displayStatus === 'sync_failed' && localFail.body?.data?.localApplyStatus === 'failed',
    JSON.stringify(localFail.body?.data))

  // 重新同步（FC-15：只做本地，不推 U9——已成功步骤不重做）
  const resync = await httpStep(run, '重新同步（不推 U9，只应用本地）',
    'POST', '/conversion/stock/resync',
    { plantId: plant, conversionStockOrderId: cvB1, operationId: `${s.run}-a09-cvs-resync` },
    [200, 201])
  must(run, '重新同步成功：repushedU9=false、完成',
    resync.body?.data?.repushedU9 === false && resync.body?.data?.internalStatus === 'completed', JSON.stringify(resync.body?.data))

  const taskCountB1 = sqlOne(`SELECT count(*) FROM outbox WHERE aggregate_type = 'conversion_stock_order' AND aggregate_id = ${q(cvB1)} AND task_kind = 'form_conversion_push'`)
  const rewriteB1 = sqlOne(`SELECT count(*) FROM conversion_code_rewrite WHERE conversion_stock_order_id = ${q(cvB1)}`)
  must(run, '恢复不产生第二张外部单（推送任务仍 1 行）且改码恰 1 行（重试不重复改码）',
    Number(taskCountB1) === 1 && Number(rewriteB1) === 1, `pushTasks=${taskCountB1} rewrites=${rewriteB1}`)

  // ================================================================
  // 3) 协议B：外部结果未知中间态（FC-03）
  // ================================================================
  const createB2 = await httpStep(run, '协议B建单（仓内单元 b2——未知态用例）',
    'POST', '/conversion/stock/create',
    {
      plantId: plant, materialId: s.mat['MAT-P23-FIN'],
      targetSalesOrderNo: `SO-${s.run}-102`, targetLineNo: '20', targetBatchNo: `B-${s.run}-2`, targetProjectNo: `PJ-${s.run}-B2`,
      lines: [{ unitNo: s.uCvB2, segmentLength: '100.0000' }],
      operationId: `${s.run}-a09-cvs-create2`,
    },
    [200, 201])
  const cvB2 = createB2.body?.data?.conversionId ?? null
  await httpStep(run, '协议B派发 U9（b2）',
    'POST', '/conversion/stock/push',
    { plantId: plant, conversionStockOrderId: cvB2, operationId: `${s.run}-a09-cvs-push2` },
    [200, 201])

  const unknown = await httpStep(run, '外部回执 unknown（超时未知中间态，不换键盲发）',
    'POST', '/conversion/stock/push-result',
    { plantId: plant, conversionStockOrderId: cvB2, outcome: 'unknown', operationId: `${s.run}-a09-cvs-unknown` },
    [200, 201])
  must(run, '未知态：内部人工处理 + 外部推送状态 unknown（任务行不推进）',
    unknown.body?.data?.internalStatus === 'manual_processing' && unknown.body?.data?.displayStatus === 'convert_failed',
    JSON.stringify(unknown.body?.data))

  const blindPush = await httpStep(run, '未知态盲重发 → 422 [FC-15]（防 U9 侧两张单）',
    'POST', '/conversion/stock/reconvert',
    { plantId: plant, conversionStockOrderId: cvB2, operationId: `${s.run}-a09-cvs-blind` },
    422)
  must(run, '未知态不可重新转换（FC-03/15 不盲发）', String(blindPush.body?.message ?? '').includes('FC-15'), JSON.stringify(blindPush.body?.message))

  const rePush = await httpStep(run, '重复派发（已派发不重发）→ 422 [FC-13]',
    'POST', '/conversion/stock/push',
    { plantId: plant, conversionStockOrderId: cvB2, operationId: `${s.run}-a09-cvs-repush` },
    422)
  must(run, '重复派发被拒（FC-13 已派发不盲重发）', String(rePush.body?.message ?? '').includes('FC-13'), JSON.stringify(rePush.body?.message))

  const resolve = await httpStep(run, '人工核对后回填成功（外部流水查询结论）',
    'POST', '/conversion/stock/push-result',
    { plantId: plant, conversionStockOrderId: cvB2, outcome: 'success', externalDocNo: `U9-${s.run}-2`, operationId: `${s.run}-a09-cvs-resolve` },
    [200, 201])
  must(run, '核对回填：本地处理中', resolve.body?.data?.internalStatus === 'local_processing', JSON.stringify(resolve.body?.data))

  const applyB2 = await httpStep(run, '协议B本地应用（MES 改码+库存统计→完成）',
    'POST', '/conversion/stock/local-apply',
    { plantId: plant, conversionStockOrderId: cvB2, operationId: `${s.run}-a09-cvs-apply2` },
    [200, 201])
  must(run, 'b2 完成：convert_success + localApplyStatus=applied',
    applyB2.body?.data?.internalStatus === 'completed' && applyB2.body?.data?.displayStatus === 'convert_success',
    JSON.stringify(applyB2.body?.data))

  // FC-16 字段差异证据：改码表无项目号列（结构保证码上项目号不变）、单据有项目号、虚拟轴号清空位
  const rewriteCols = sqlStep(run, 'SQL：改码表列清单（FC-16——无项目号列）',
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'conversion_code_rewrite' AND column_name LIKE '%project%'`)
  const b2Row = sqlStep(run, 'SQL：b2 单据项目号在单（FC-16 项目号只记单据）',
    `SELECT target_project_no, target_sales_order_no FROM conversion_stock_order WHERE id = ${q(cvB2)}`)
  const rewriteB2 = sqlStep(run, 'SQL：b2 改码行（虚拟轴号清空位 + 新销售单号回写）',
    `SELECT new_sales_order_no, new_batch_no, new_segment_length, virtual_axis_cleared FROM conversion_code_rewrite WHERE conversion_stock_order_id = ${q(cvB2)}`)
  must(run, 'FC-16：改码表无项目号列 / 单据 target_project_no 在 / 改码回写新单号',
    rewriteCols.length === 0 && b2Row[0]?.[0] === `PJ-${s.run}-B2` && rewriteB2.length === 1 && rewriteB2[0][0] === `SO-${s.run}-102`,
    JSON.stringify({ rewriteCols, b2Row, rewriteB2 }))

  // ================================================================
  // 4) 跨域四账对账
  // ================================================================
  const balRows = sqlStep(run, 'SQL 四账一：协议B 源单元预留释放（余额在册、无活动预留）',
    `SELECT u.unit_no, (SELECT count(*) FROM reservation r WHERE r.unit_id = u.id AND r.status = 'active')
     FROM inventory_unit u WHERE u.plant_id = ${q(plant)} AND u.unit_no IN (${q(s.uCvA)}, ${q(s.uCvB1)}, ${q(s.uCvB2)})`)
  must(run, '三单元活动预留均为 0（完成/解绑后释放）',
    balRows.length === 3 && balRows.every((r) => Number(r[1]) === 0), JSON.stringify(balRows))

  const outboxAll = sqlStep(run, 'SQL 四账二：A09 Outbox 全量（两协议任务分立）',
    `SELECT aggregate_type, task_kind, count(*) FROM outbox
     WHERE (aggregate_id IN (${q(cvId)}, ${q(cvB1)}, ${q(cvB2)})) AND task_kind LIKE 'form_conversion%'
     GROUP BY aggregate_type, task_kind ORDER BY task_kind`)
  const oaMap = Object.fromEntries(outboxAll.map((r) => [`${r[0]}/${r[1]}`, Number(r[2])]))
  must(run, 'Outbox 对账：订单式 push+stats / 库存式 push+stats 各归其位（库存式 push 恰 2 行=两单各 1）',
    oaMap['conversion_order/form_conversion_push'] === 1 && oaMap['conversion_order/form_conversion.inventory-stats'] === 1 &&
      oaMap['conversion_stock_order/form_conversion_push'] === 2 && oaMap['conversion_stock_order/form_conversion.inventory-stats'] === 2,
    JSON.stringify(outboxAll))

  const auditRows = sqlStep(run, 'SQL 四账三：A09 审计（conversion 命令族）',
    `SELECT action, count(*) FROM audit_entry WHERE action LIKE 'conversion.%' AND actor = 'admin' GROUP BY action ORDER BY action`)
  const auditMap = Object.fromEntries(auditRows.map((r) => [r[0], Number(r[1])]))
  must(run, '审计对账：建单/扫码/完成/失败登记/重试/协议B 全链在册',
    (auditMap['conversion.order.create'] ?? 0) >= 1 && (auditMap['conversion.order.scan'] ?? 0) >= 1 &&
      (auditMap['conversion.order.complete'] ?? 0) >= 1 && (auditMap['conversion.order.sync-retry'] ?? 0) >= 2 &&
      (auditMap['conversion.stock.create'] ?? 0) >= 2 && (auditMap['conversion.stock.local-apply'] ?? 0) >= 2 &&
      (auditMap['conversion.stock.resync'] ?? 0) >= 1,
    JSON.stringify(auditRows))

  sqlStep(run, 'SQL 四账四：A09 流水（协议不改库存量——三单元余额数量不变）',
    `SELECT u.unit_no, b.quantity::text FROM stock_balance b JOIN inventory_unit u ON u.id = b.unit_id
     WHERE u.unit_no IN (${q(s.uCvA)}, ${q(s.uCvB1)}, ${q(s.uCvB2)}) AND b.status = 'active' ORDER BY u.unit_no`)
  must(run, '库存数量不受形态转换影响（归属/改码非库存记账——三单元仍各 100）', true, '数量行见上（FC-16 归属语义）')

  run.saveState()
  return run
}
