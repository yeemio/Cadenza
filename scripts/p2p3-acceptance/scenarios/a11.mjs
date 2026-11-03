/**
 * A11 恢复抽验（P2 域任选 2 命令同 operationId 重放原结果）：
 * - P2-B conversion.order.create：同 operationId 重放 → 原 conversionId 回放、单据恰 1 行、回执 1 行；
 * - P2-E maintenance.order.create：同 operationId 重放 → 原 orderId 回放、工单恰 1 行、回执 1 行
 *   （重放不二次执行——不重复开停机/不重复扣备件）；用例后把工单走完关闭，不残留维修态设备。
 */
import { must, httpStep, sqlStep, sqlOne, q, ensureAdminPermissions } from '../lib.mjs'

export async function run(run) {
  run.setScenario('A11')
  await ensureAdminPermissions(run) // 场景自足：并行会话 seed 可能中途重置授权
  const s = run.state
  const plant = s.szPlantId

  // ---- 1) P2-B：conversion.order.create 同 operationId 重放 ----
  const opA = `${s.run}-a11-replay-cv`
  const bodyA = {
    plantId: plant,
    lines: [{
      sourceOrderId: s.orderSrc.orderId, sourceSalesOrderNo: `SO-${s.run}-001`, sourceLineNo: '10',
      targetOrderId: s.orderTgt.orderId, targetProjectNo: `PJ-${s.run}-R`,
      quantity: '50.0000', uom: 'M',
    }],
    operationId: opA,
  }
  const firstA = await httpStep(run, '协议A建单（首发）',
    'POST', '/conversion/order/create', bodyA, [200, 201])
  const cvId = firstA.body?.data?.conversionId ?? null
  const replayA = await httpStep(run, '同 operationId 重放（断响应恢复）',
    'POST', '/conversion/order/create', bodyA, [200, 201])
  const cvRows = Number(sqlOne(`SELECT count(*) FROM conversion_order WHERE id = ${q(cvId)}`))
  const receiptA = Number(sqlOne(`SELECT count(*) FROM command_receipt WHERE operation_id = ${q(opA)}`))
  must(run, 'P2-B 重放回放原结果：同 conversionId、单据恰 1 行、回执恰 1 行',
    replayA.body?.data?.conversionId === cvId && cvRows === 1 && receiptA === 1,
    `first=${cvId} replay=${replayA.body?.data?.conversionId} orders=${cvRows} receipts=${receiptA}`)

  // ---- 2) P2-E：maintenance.order.create 同 operationId 重放 ----
  const opB = `${s.run}-a11-replay-mt`
  const bodyB = {
    equipmentCode: s.eqMtCode,
    description: 'P23 验收 A11 重放用例',
    reason: 'P23 验收：幂等重放取证',
    operationId: opB,
  }
  const firstB = await httpStep(run, '维保报修建单（首发）',
    'POST', '/maintenance/orders', bodyB, [200, 201])
  const mtId = firstB.body?.data?.orderId ?? null
  const downtimeCount0 = Number(sqlOne(`SELECT count(*) FROM downtime_event WHERE order_id = ${q(mtId)}`))
  const replayB = await httpStep(run, '同 operationId 重放（断响应恢复）',
    'POST', '/maintenance/orders', bodyB, [200, 201])
  const mtRows = Number(sqlOne(`SELECT count(*) FROM maintenance_order WHERE id = ${q(mtId)}`))
  const downtimeCount1 = Number(sqlOne(`SELECT count(*) FROM downtime_event WHERE order_id = ${q(mtId)}`))
  const receiptB = Number(sqlOne(`SELECT count(*) FROM command_receipt WHERE operation_id = ${q(opB)}`))
  must(run, 'P2-E 重放回放原结果：同 orderId、工单恰 1 行、停机不重复开、回执恰 1 行',
    replayB.body?.data?.orderId === mtId && mtRows === 1 && downtimeCount1 === downtimeCount0 && downtimeCount0 === 1 && receiptB === 1,
    `first=${mtId} replay=${replayB.body?.data?.orderId} orders=${mtRows} downtime ${downtimeCount0}→${downtimeCount1} receipts=${receiptB}`)

  // ---- 3) 不同 operationId 重发同载荷 → 真实执行（同设备在途停机拒 MT-09，证重放确未执行；
  //     O-2 修复后 maintenance 业务拒绝与其余域同款映射为 422） ----
  const differentOp = await httpStep(run, '不同 operationId 同载荷 → 422 [MT-09]（证明重放未执行、在途停机守卫生效）',
    'POST', '/maintenance/orders',
    { ...bodyB, operationId: `${s.run}-a11-replay-mt-new` },
    422)
  must(run, '新 operationId 触发真实守卫（MT-09 同设备在途停机，HTTP 422）',
    String(differentOp.body?.message ?? '').includes('MT-09') && String(differentOp.body?.code ?? '').startsWith('ERR_'),
    JSON.stringify(differentOp.body))

  // ---- 4) 收尾：把重放用例工单走完（不留维修态设备） ----
  await httpStep(run, '收尾：分派', 'POST', '/maintenance/orders/dispatch', { orderId: mtId, assignee: '王维修', operationId: `${s.run}-a11-mt-dispatch` }, [200, 201])
  await httpStep(run, '收尾：处理中', 'POST', '/maintenance/orders/start', { orderId: mtId, operationId: `${s.run}-a11-mt-start` }, [200, 201])
  await httpStep(run, '收尾：待复机', 'POST', '/maintenance/orders/finish-repair', { orderId: mtId, operationId: `${s.run}-a11-mt-finish` }, [200, 201])
  await httpStep(run, '收尾：复机关闭（无备件）', 'POST', '/maintenance/orders/restart', { orderId: mtId, responsible: '刘工', operationId: `${s.run}-a11-mt-restart` }, [200, 201])
  const eqStatus = sqlOne(`SELECT equipment_status FROM equipment WHERE id = ${q(s.equipment[s.eqMtCode].id)}`)
  const mtStatus = sqlOne(`SELECT status FROM maintenance_order WHERE id = ${q(mtId)}`)
  must(run, '收尾完成：设备回正常、工单关闭', Number(eqStatus) === 1 && mtStatus === 'closed', `eq=${eqStatus} order=${mtStatus}`)

  // ---- 5) 四账口径：回执单行性抽样 ----
  const receiptRows = sqlStep(run, 'SQL 四账：两 operationId 回执单行性',
    `SELECT operation_id, count(*) FROM command_receipt WHERE operation_id IN (${q(opA)}, ${q(opB)}) GROUP BY operation_id`)
  must(run, '回执对账：两条各 1 行', receiptRows.length === 2 && receiptRows.every((r) => Number(r[1]) === 1), JSON.stringify(receiptRows))

  run.saveState()
  return run
}
