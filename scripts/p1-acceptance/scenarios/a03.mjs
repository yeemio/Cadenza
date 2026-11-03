/**
 * A03 工艺与排程（P1 验收）：
 * - 产品族/BOM/路线 发布（版本冻结：published 后 PATCH 拒）；
 * - 订单接收（快照展开）→ 推导复算（末道=产量×芯×绞合，自末道向上递推）；
 * - 槽位保存（订单视图 = 设备视图）→ 硬校验拒绝一次 + 弱提醒 confirm 一次；
 * - 班次跨日一次（白班起点 07:30，次日 02:30 归前一日）。
 */
import { must, httpStep, sqlStep, sqlOne, q, beijingToday, eqQty } from '../lib.mjs'

export async function run(run) {
  run.setScenario('A03')
  const s = run.state
  const sz = s.szPlantId
  const today = beijingToday()
  s.today = today

  // ---- 1) 产品族 ----
  const fam = await httpStep(run, '建产品族 P1-FAM（POST /process/families）',
    'POST', '/process/families',
    { plantId: sz, code: 'P1-FAM', name: 'P1验收电缆族', description: 'P1 全链验收用产品族', operationId: `${s.run}-a03-fam` },
    [200, 201])
  s.famId = fam.body?.data?.familyId ?? null
  must(run, '产品族创建成功', Boolean(s.famId), JSON.stringify(fam.body?.data))

  // ---- 2) 工序主数据 ×2 ----
  s.opDef = {}
  for (const [code, name] of [['OP-P1-01', 'P1验收-拉丝'], ['OP-P1-02', 'P1验收-绞制']]) {
    const res = await httpStep(run, `建工序 ${code}（POST /process/operations）`,
      'POST', '/process/operations',
      { deptId: s.nodes['DEPT-SZ-JZ'], workCenterId: s.wcId, companyOrgCode: 'ORG-P1', code, name, operationId: `${s.run}-a03-op-${code}` },
      [200, 201])
    s.opDef[code] = res.body?.data?.operationId ?? null
    must(run, `工序 ${code} 创建成功`, Boolean(s.opDef[code]), JSON.stringify(res.body?.data))
  }

  // ---- 3) BOM 创建 + 发布（版本冻结） ----
  const bom = await httpStep(run, '建制造 BOM（MAT-P1-FIN：铜杆 2.5 M/单位）',
    'POST', '/process/boms',
    { productFamilyId: s.famId, materialId: s.mat['MAT-P1-FIN'], lines: [{ materialId: s.mat['MAT-P1-RAW'], materialCode: 'MAT-P1-RAW', quantity: '2.5000', uom: 'M' }], operationId: `${s.run}-a03-bom` },
    [200, 201])
  s.bomRevId = bom.body?.data?.revisionId ?? null
  must(run, 'BOM 版本创建成功（v1 draft）', Boolean(s.bomRevId), JSON.stringify(bom.body?.data))

  const bomPub = await httpStep(run, '发布 BOM（POST /process/boms/:id/publish）',
    'POST', `/process/boms/${s.bomRevId}/publish`, { operationId: `${s.run}-a03-bom-pub` }, [200])
  must(run, 'BOM 发布成功', bomPub.body?.data?.status === 'published', JSON.stringify(bomPub.body?.data))

  // ---- 4) 路线创建 + 发布 + 版本冻结反证 ----
  const route = await httpStep(run, '建工艺路线（seq1 拉丝 芯×2 / seq2 绞制 芯×1 绞合×7）',
    'POST', '/process/routes',
    {
      productFamilyId: s.famId,
      steps: [
        { seq: 1, operationDefinitionId: s.opDef['OP-P1-01'], workCenterId: s.wcId, coreMultiple: 2, strandFactor: '1' },
        { seq: 2, operationDefinitionId: s.opDef['OP-P1-02'], workCenterId: s.wcId, coreMultiple: 1, strandFactor: '7' },
      ],
      operationId: `${s.run}-a03-route`,
    },
    [200, 201])
  s.routeRevId = route.body?.data?.revisionId ?? null
  must(run, '路线版本创建成功', Boolean(s.routeRevId), JSON.stringify(route.body?.data))

  const routePub = await httpStep(run, '发布路线（POST /process/routes/:id/publish）',
    'POST', `/process/routes/${s.routeRevId}/publish`, { operationId: `${s.run}-a03-route-pub` }, [200])
  must(run, '路线发布成功', routePub.body?.data?.status === 'published', JSON.stringify(routePub.body?.data))

  const routePatch = await httpStep(run, '已发布路线 PATCH 修改内容 → 拒绝（[A2-2] 版本冻结）',
    'PATCH', `/process/routes/${s.routeRevId}`,
    { steps: [{ seq: 1, operationDefinitionId: s.opDef['OP-P1-01'], workCenterId: s.wcId, coreMultiple: 3 }], operationId: `${s.run}-a03-route-patch` },
    422)
  must(run, 'published 冻结：PATCH 422 且含 A2-2', String(routePatch.body?.message ?? '').includes('A2-2'), JSON.stringify(routePatch.body))

  // ---- 5) 生产订单接收（快照展开 + 需求推导） ----
  const orderNo = `MO-${s.run}-MAIN`
  const order = await httpStep(run, `接收生产订单 ${orderNo}（1000 M，已发布 BOM/路线自动引用 + 工序快照展开）`,
    'POST', '/process/orders/receive',
    {
      orderNo, materialId: s.mat['MAT-P1-FIN'], productionDeptId: s.nodes['DEPT-SZ-JZ'], productionQty: '1000.0000',
      uom: 'M', productFamilyId: s.famId, processConfirmed: true, initialStatus: 'released',
      salesOrderNo: `SO-${s.run}-001`, operationId: `${s.run}-a03-order`,
    },
    [200, 201])
  s.order = { orderId: order.body?.data?.orderId ?? null, orderNo, routeRevisionId: order.body?.data?.routeRevisionId ?? null, bomRevisionId: order.body?.data?.bomRevisionId ?? null }
  s.ops = { ...(s.ops ?? {}), 'process.order.receive': `${s.run}-a03-order` }
  must(run, '订单接收成功且工序已配置（快照引用已发布版本）',
    order.body?.data?.processConfigStatus === 'configured' && order.body?.data?.routeRevisionId === s.routeRevId && order.body?.data?.bomRevisionId === s.bomRevId,
    JSON.stringify(order.body?.data))

  // 工序行 id + 推导复算（末道=产量×芯×绞合；自末道向上：上游=下游量×芯×绞合）
  const ops = sqlStep(run, 'SQL：订单工序行（seq/offline_qty/core/strand）',
    `SELECT seq, id, offline_qty::text, core_multiple, strand_factor::text FROM order_operation WHERE order_id = ${q(s.order.orderId)} ORDER BY seq`)
  const op1 = ops.find((r) => Number(r[0]) === 1)
  const op2 = ops.find((r) => Number(r[0]) === 2)
  s.order.op1Id = op1?.[1] ?? null
  s.order.op2Id = op2?.[1] ?? null
  // 复算（独立于服务端公式）：末道 = 1000×1×7 = 7000；前道 = 7000×2×1 = 14000
  const expectOp2 = 1000 * 1 * 7
  const expectOp1 = expectOp2 * 2 * 1
  must(run, '推导复算：末道下线=产量×芯×绞合=7000，前道=14000',
    eqQty(op2?.[2], expectOp2) && eqQty(op1?.[2], expectOp1),
    `op1.offline=${op1?.[2]}（期望 ${expectOp1}） op2.offline=${op2?.[2]}（期望 ${expectOp2}）`)

  // ---- 6) 开工（A1-1：released → in_progress） ----
  await httpStep(run, '订单开工（POST /process/orders/:id/start）',
    'POST', `/process/orders/${s.order.orderId}/start`, { operationId: `${s.run}-a03-start` }, [200])
  const statusRow = sqlOne(`SELECT order_status FROM production_order WHERE id = ${q(s.order.orderId)}`)
  must(run, '开工后订单 in_progress', statusRow === 'in_progress', `order_status=${statusRow}`)

  // ---- 7) 槽位保存（订单视图 = 设备视图） ----
  const slot1 = await httpStep(run, '槽位保存：op1 @EQ-P1-01 今日 5000（POST /scheduling/slots）',
    'POST', '/scheduling/slots',
    { orderOperationId: s.order.op1Id, equipmentId: s.equipment['EQ-P1-01'].id, productionDate: today, plannedQty: '5000.0000', operationId: `${s.run}-a03-slot1` },
    [200, 201])
  must(run, '槽位 #1 保存成功', slot1.body?.data?.action === 'upserted', JSON.stringify(slot1.body?.data))

  const slot2 = await httpStep(run, '槽位保存：op2 @EQ-P1-02 今日 3000',
    'POST', '/scheduling/slots',
    { orderOperationId: s.order.op2Id, equipmentId: s.equipment['EQ-P1-02'].id, productionDate: today, plannedQty: '3000.0000', operationId: `${s.run}-a03-slot2` },
    [200, 201])
  must(run, '槽位 #2 保存成功', slot2.body?.data?.action === 'upserted', JSON.stringify(slot2.body?.data))

  // 硬校验拒绝一次：op2 其它槽 3000 + 新 8000 > 下线 7000（confirm 不豁免）
  const hard = await httpStep(run, '硬校验拒绝：op2 追加 8000（3000+8000 > 7000）→ 422 [A3-2]',
    'POST', '/scheduling/slots',
    { orderOperationId: s.order.op2Id, equipmentId: s.equipment['EQ-P1-01'].id, productionDate: today, plannedQty: '8000.0000', confirm: true, operationId: `${s.run}-a03-slot-hard` },
    422)
  must(run, '计划数量硬限拒绝（A3-2）', String(hard.body?.message ?? '').includes('A3-2'), JSON.stringify(hard.body))

  // 弱提醒：先配置设备日产能 50，再保存 op1 @EQ-P1-02 100（当日 3000+100=3100 > 50）
  const cap = await httpStep(run, '配置设备日产能 EQ-P1-02 今日 50（POST /scheduling/capacity）',
    'POST', '/scheduling/capacity',
    { equipmentId: s.equipment['EQ-P1-02'].id, productionDate: today, capacity: '50.0000', uom: 'M', operationId: `${s.run}-a03-cap` },
    [200, 201])
  must(run, '产能配置成功', Boolean(cap.body?.data?.capacityId), JSON.stringify(cap.body?.data))

  const weak = await httpStep(run, '弱提醒拒绝：op1 @EQ-P1-02 100（超产能，confirm 未携带）→ 422 [A3-2w]',
    'POST', '/scheduling/slots',
    { orderOperationId: s.order.op1Id, equipmentId: s.equipment['EQ-P1-02'].id, productionDate: today, plannedQty: '100.0000', operationId: `${s.run}-a03-slot-weak` },
    422)
  must(run, '超产能弱提醒先拒（A3-2w，错误文案即二次确认提示）', String(weak.body?.message ?? '').includes('A3-2w'), JSON.stringify(weak.body))

  const weakConfirm = await httpStep(run, '弱提醒确认：同载荷 confirm=true → 提交成功且携带提醒',
    'POST', '/scheduling/slots',
    { orderOperationId: s.order.op1Id, equipmentId: s.equipment['EQ-P1-02'].id, productionDate: today, plannedQty: '100.0000', confirm: true, operationId: `${s.run}-a03-slot-weak2` },
    [200, 201])
  must(run, 'confirm=true 后提交成功且 warnings 非空',
    weakConfirm.body?.data?.action === 'upserted' && Array.isArray(weakConfirm.body?.data?.warnings) && weakConfirm.body.data.warnings.length > 0,
    JSON.stringify(weakConfirm.body?.data))

  // 订单视图 = 设备视图（同一排产事实双投影）
  const orderView = await httpStep(run, '订单视图（GET /scheduling/order-view/:orderId）',
    'GET', `/scheduling/order-view/${s.order.orderId}`, undefined, 200)
  const ov = orderView.body ?? {}
  const ovOp1 = (ov.operations ?? []).find((o) => o.seq === 1)
  const ovOp2 = (ov.operations ?? []).find((o) => o.seq === 2)
  must(run, '订单视图：op1 已排 5100 / op2 已排 3000',
    eqQty(ovOp1?.scheduledQty, 5100) && eqQty(ovOp2?.scheduledQty, 3000),
    `op1.scheduled=${ovOp1?.scheduledQty} op2.scheduled=${ovOp2?.scheduledQty} status=${ov.schedulingStatus}`)

  const deviceView = await httpStep(run, '设备视图（GET /scheduling/device-view?plantId&equipmentId=EQ-P1-02）',
    'GET', `/scheduling/device-view?plantId=${sz}&equipmentId=${s.equipment['EQ-P1-02'].id}`, undefined, 200)
  const dvEq = (deviceView.body?.equipments ?? [])[0]
  const dvCell = (dvEq?.cells ?? []).find((c) => c.productionDate === today)
  must(run, '设备视图与订单视图同源一致：EQ-P1-02 当日 plannedTotal=3100（op2 3000 + op1 100）',
    eqQty(dvCell?.plannedTotal, 3100) && dvCell?.orderCount === 1,
    `plannedTotal=${dvCell?.plannedTotal} orderCount=${dvCell?.orderCount} details=${JSON.stringify(dvCell?.details ?? [])}`)

  // ---- 8) 班次跨日一次 ----
  const shiftSet = await httpStep(run, '设置白班起点 07:30（POST /scheduling/shift）',
    'POST', '/scheduling/shift', { plantId: sz, dayShiftStart: '07:30', operationId: `${s.run}-a03-shift` }, [200, 201])
  must(run, '班次参数保存成功', Boolean(shiftSet.body?.data?.shiftId), JSON.stringify(shiftSet.body?.data))

  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  const crossDay = await httpStep(run, `班次跨日：at=${tomorrow}T02:30:00（白班 07:30 前）→ 班次日归前一日`,
    'GET', `/scheduling/shift-date?plantId=${sz}&at=${tomorrow}T02:30:00`, undefined, 200)
  must(run, `跨日班次：${tomorrow} 02:30 的班次日期 = ${today}`,
    crossDay.body?.shiftDate === today, JSON.stringify(crossDay.body))

  const sameDay = await httpStep(run, `同日对照：at=${tomorrow}T08:00:00（白班起点后）→ 班次日=${tomorrow}`,
    'GET', `/scheduling/shift-date?plantId=${sz}&at=${tomorrow}T08:00:00`, undefined, 200)
  must(run, '同日对照：08:00 归当日', sameDay.body?.shiftDate === tomorrow, JSON.stringify(sameDay.body))

  run.saveState()
  return run
}
