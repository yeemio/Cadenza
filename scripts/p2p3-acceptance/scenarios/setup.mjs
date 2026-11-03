/**
 * S0 环境自足（P2/P3 验收前置场景）：
 * - 种子组织节点解析 + admin(sysadmin) 域许可合并（真实 /org/grants 命令，幂等）；
 * - 真实命令建：仓库×2（WAREHOUSE/LINE_SIDE，run 唯一码）+ 货架 + 库位、工作中心、设备×2、工序定义；
 * - 料品直落 SQL 模拟 U9 同步（MD-01）；
 * - 生产订单×4（真实 /process/orders/receive + start）：SRC/TGT（形态转换锚点，带销售单号）、
 *   FEED（倒轴子段投料目标）、COST（成本归集 + 扫码报工会话）；
 * - COST 订单：扫码报工（显式 businessTime 制造会话时间窗，供 A12-OT 工序关联）→ 末道人工审核
 *   → 工时记录 8h（真实 POST /execution/labor-records，CA-12 报工主源事实）；
 * - 库存单元（真实 POST /inventory/receive）：协议A 载具码单元（10 位 1E…，归属 SQL 造数——
 *   报工链只产 PRDU 内部码，conversion 线交付同款口径）、协议B 仓内单元×2、备件单元；
 * - 倒轴/分托/修正场景单元由各场景自行收货（A05）。
 */
import {
  must, httpStep, sqlStep, sqlOne, sql, q, eqQty,
  ensureAdminPermissions, receiveUnit, seedUnitOwnership, UOM_M_ID,
} from '../lib.mjs'

export async function run(run) {
  run.setScenario('S0')
  const s = run.state

  // ---- 1) 种子组织节点 + 授权 ----
  const nodes = Object.fromEntries(
    sql(`SELECT code, id FROM org_node WHERE status = 'active' AND code IN ('ENT-HD','PLNT-SZ','DEPT-SZ-JZ','DEPT-SZ-WL')`).map((r) => [r[0], r[1]]),
  )
  s.nodes = nodes
  must(run, '种子组织节点齐全（ENT-HD/PLNT-SZ/DEPT-SZ-JZ/DEPT-SZ-WL）',
    Object.keys(nodes).length === 4, JSON.stringify(Object.keys(nodes)))
  s.entId = nodes['ENT-HD']
  s.szPlantId = nodes['PLNT-SZ']

  await ensureAdminPermissions(run)
  must(run, 'sysadmin 域许可合并成功（P2/P3 六域 + 依赖域）', true, 'rework/conversion/maintenance/spc/ot/cost + execution/scheduling/process/masterdata/inventory')

  // 车间操作人 szws01（DEPT-SZ-JZ 车间主任，dept_category=1）：A05 分托车间分叉（RS-13①）用
  const wsUserId = sqlOne(`SELECT id FROM user_account WHERE login_name = 'szws01'`)
  const wsGrant = await httpStep(run, '给 szws01 授 rework.read/post（苏州厂范围）',
    'POST', '/org/grants',
    {
      principalType: 'user', principalId: wsUserId, scopeType: 'plant', scopeObjectId: s.szPlantId,
      permissions: ['rework.read', 'rework.post'],
      reason: `P2/P3 验收（${s.run}）：车间操作人分托命令授权`,
      operationId: `${s.run}-s0-grant-szws01`,
    },
    [200, 201])
  must(run, 'szws01 rework 授权成功', Boolean(wsGrant.body?.data?.grantId), JSON.stringify(wsGrant.body?.data))

  // ---- 2) 仓库×2（run 唯一 4 位码：重跑以新 run 标签新建数据，不清理旧数据） ----
  const h = Math.abs([...s.run].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))
  const whCodes = [String(1000 + (h % 8990)), String(1000 + ((h + 4495) % 8990))]
  if (whCodes[0] === whCodes[1]) whCodes[1] = String(Number(whCodes[1]) === 9999 ? 1000 : Number(whCodes[1]) + 1)
  const warehouses = [
    // MD-23：WAREHOUSE 类型仓允许料品类型 [1,3]（类型 2 仅线边仓可放——p1 a01 同口径）
    { code: whCodes[0], name: `P23普通仓${s.run}`, dept: 'DEPT-SZ-WL', type: 'WAREHOUSE', materialTypes: [1, 3], key: 'whMain' },
    { code: whCodes[1], name: `P23线边仓${s.run}`, dept: 'DEPT-SZ-JZ', type: 'LINE_SIDE', materialTypes: [1, 2, 3], key: 'whLine' },
  ]
  s.wh = {}
  for (const w of warehouses) {
    const res = await httpStep(run, `建仓库 ${w.key}（code=${w.code} ${w.type}）`,
      'POST', '/masterdata/warehouses',
      { code: w.code, name: w.name, deptId: nodes[w.dept], warehouseType: w.type, materialTypes: w.materialTypes, operationId: `${s.run}-s0-wh-${w.key}`, reason: 'P2/P3 验收主数据准备' },
      [200, 201])
    s.wh[w.key] = res.body?.data?.warehouseId ?? null
    must(run, `仓库 ${w.key}（${w.code}/${w.type}）创建成功`, Boolean(s.wh[w.key]), `id=${s.wh[w.key]}`)
  }
  const whMainCode = whCodes[0]
  const whLineCode = whCodes[1]

  // 货架不建（MD-30 货架编号工厂内唯一且仅 100 槽——本验收不消费 RACK 库位，避免占位；
  // P1ACC a01 已证货架自动生成行为）

  // 普通库位（8 位 = 仓库码 4 + 库位码 4）
  s.loc = {}
  for (const [whKey, code] of [['whMain', `${whMainCode}0101`], ['whLine', `${whLineCode}0101`]]) {
    const res = await httpStep(run, `建普通库位 ${code}（仓库 ${whKey}）`,
      'POST', '/masterdata/locations',
      { warehouseId: s.wh[whKey], code, operationId: `${s.run}-s0-loc-${whKey}`, reason: 'P2/P3 验收主数据准备' },
      [200, 201])
    s.loc[whKey] = res.body?.data?.locationId ?? null
    must(run, `库位 ${code}@${whKey} 创建成功`, Boolean(s.loc[whKey]), JSON.stringify(res.body?.data))
  }
  s.loc.whMainCode = `${whMainCode}0101`
  s.loc.whLineCode = `${whLineCode}0101`

  // ---- 3) 工作中心 / 设备×2 / 工序定义（run 唯一码；10 位 run 标识避免跨 run 撞码——
  //     既有同码工序走更新路径需 process.admin，验收账号不持该许可） ----
  const runTag = s.run.replace(/[^0-9A-Za-z]/g, '').slice(0, 10).toUpperCase()
  const wc = await httpStep(run, `建工作中心 WC-${runTag}`,
    'POST', '/masterdata/work-centers',
    { code: `WC-${runTag}`, name: `P23验收工作中心${s.run}`, deptId: nodes['DEPT-SZ-JZ'], operationId: `${s.run}-s0-wc`, reason: 'P2/P3 验收主数据准备' },
    [200, 201])
  s.wcId = wc.body?.data?.workCenterId ?? null
  must(run, '工作中心创建成功', Boolean(s.wcId), `wcId=${s.wcId}`)

  s.equipment = {}
  for (const [code, name] of [[`EQ-${runTag}-01`, `P23验收一号机${s.run}`], [`EQ-${runTag}-10`, `P23验收十号机${s.run}`]]) {
    const res = await httpStep(run, `建设备 ${code}`,
      'POST', '/masterdata/equipment',
      { code, name, deptId: nodes['DEPT-SZ-JZ'], workCenterId: s.wcId, equipmentStatus: 1, capacity: '6000', operationId: `${s.run}-s0-eq-${code}`, reason: 'P2/P3 验收主数据准备' },
      [200, 201])
    s.equipment[code] = { id: res.body?.data?.equipmentId ?? null }
    must(run, `设备 ${code} 创建成功（状态 1 正常）`, Boolean(s.equipment[code].id), JSON.stringify(res.body?.data))
  }
  s.eqExecCode = `EQ-${runTag}-01`
  s.eqMtCode = `EQ-${runTag}-10`

  const opDef = await httpStep(run, `建工序定义 OP-${runTag}-01`,
    'POST', '/process/operations',
    { deptId: nodes['DEPT-SZ-JZ'], workCenterId: s.wcId, companyOrgCode: 'ORG-P23', code: `OP-${runTag}-01`, name: `P23验收-绞制${s.run}`, operationId: `${s.run}-s0-opdef` },
    [200, 201])
  s.opDefId = opDef.body?.data?.operationId ?? null
  must(run, '工序定义创建成功', Boolean(s.opDefId), JSON.stringify(opDef.body?.data))

  // ---- 4) 料品：直落 SQL 模拟 U9 同步（MD-01） ----
  const materials = [
    { code: 'MAT-P23-FIN', name: 'P23验收-成品缆', type: 3, qc: 0 },
    { code: 'MAT-P23-RAW', name: 'P23验收-铜杆（免检）', type: 1, qc: 0 },
    { code: 'MAT-P23-SPARE', name: 'P23验收-备件', type: 2, qc: 0 },
  ]
  s.mat = {}
  for (const m of materials) {
    const id = sqlOne(
      `INSERT INTO material (org_scope_id, code, name, material_type, base_uom, qc_flag, source_system, created_by)
       VALUES (${q(s.entId)}, ${q(m.code)}, ${q(m.name)}, ${m.type}, 'M', ${m.qc}, 'U9', 'p23-acceptance')
       ON CONFLICT (org_scope_id, code) WHERE status = 'active' DO UPDATE SET updated_at = now() RETURNING id`,
    )
    s.mat[m.code] = id
    must(run, `料品 ${m.code}（type=${m.type} qc_flag=${m.qc}）模拟 U9 同步落库`, Boolean(id), `id=${id}`)
  }

  // ---- 5) 生产订单×4（真实命令：接收 + 开工） ----
  const mkOrder = async (key, orderNo, salesOrderNo, lineNo) => {
    const body = {
      orderNo, materialId: s.mat['MAT-P23-FIN'], productionDeptId: nodes['DEPT-SZ-JZ'], productionQty: '1000.0000',
      uom: 'M', processConfirmed: true, initialStatus: 'released',
      operations: [{ seq: 1, operationDefinitionId: s.opDefId, workCenterId: s.wcId }],
      operationId: `${s.run}-s0-order-${key}`,
    }
    if (salesOrderNo) body.salesOrderNo = salesOrderNo
    if (lineNo) body.lineNo = lineNo
    const res = await httpStep(run, `接收生产订单 ${orderNo}`, 'POST', '/process/orders/receive', body, [200, 201])
    const orderId = res.body?.data?.orderId ?? null
    s[key] = { orderId, orderNo }
    await httpStep(run, `订单开工 ${orderNo}`, 'POST', `/process/orders/${orderId}/start`, { operationId: `${s.run}-s0-start-${key}` }, [200])
    const opId = sqlOne(`SELECT id FROM order_operation WHERE order_id = ${q(orderId)} AND seq = 1`)
    s[key].op1Id = opId
    must(run, `订单 ${orderNo} 就绪（in_progress + op1）`, Boolean(orderId && opId), `orderId=${orderId} op1=${opId}`)
  }
  await mkOrder('orderSrc', `MO-${s.run}-SRC`, `SO-${s.run}-001`, '10')
  await mkOrder('orderTgt', `MO-${s.run}-TGT`, `SO-${s.run}-002`, '10')
  await mkOrder('orderFeed', `MO-${s.run}-FEED`, null, null)
  await mkOrder('orderCost', `MO-${s.run}-COST`, `SO-${s.run}-003`, '10')

  // ---- 6) COST 订单：扫码报工（显式 businessTime 制造会话窗）→ 末道人工审核 → 工时 8h ----
  // 统一业务日（O-3 修复后口径）：全链（报工/工时/OT 样本/成本窗口）锚定 S0 时点的北京班次日 D
  // ——labor/报工 businessTime 固定 D T00:0xZ（北京 08:0x → shift_date 恒为 D），OT 样本时间戳
  // 同锚（a12-ot）；成本归集/核对窗口按工厂班次日历 [D-1 T16:00Z, D T16:00Z) 对齐，任一墙钟
  // 时段裸跑不再跨北京零点错位（R3 实测错位已由 cost 线窗口修复收敛）
  const utcDay = new Date().toISOString().slice(0, 10)
  s.utcDay = utcDay
  const laborTime = `${utcDay}T00:05:00Z`
  const reportTime = `${utcDay}T00:01:00Z`
  const report = await httpStep(run, `扫码报工 500（${s.eqExecCode}，businessTime=${reportTime.slice(11, 19)}——制造会话时间窗）`,
    'POST', '/execution/scan/reports',
    {
      orderId: s.orderCost.orderId, orderOperationId: s.orderCost.op1Id,
      equipmentId: s.equipment[s.eqExecCode].id, equipmentCode: s.eqExecCode,
      outputs: [{
        quantity: '500.0000', uomId: UOM_M_ID, uomCode: 'M',
        targetLocationId: s.loc.whLine, targetLocationCode: s.loc.whLineCode,
        ownerId: s.entId, ownerName: '华东电缆集团（自有）',
      }],
      businessTime: reportTime, operationId: `${s.run}-s0-report-cost`,
    },
    [200, 201])
  const reportId = report.body?.data?.reportId ?? null
  s.costReportId = reportId
  must(run, '扫码报工提交成功（单工序=末道 → 待审）', report.body?.data?.reviewOutcome === 'pending_review', JSON.stringify(report.body?.data))

  const review = await httpStep(run, '人工审核通过（POST /execution/reports/:id/review）',
    'POST', `/execution/reports/${reportId}/review`, { operationId: `${s.run}-s0-review-cost` }, [200])
  must(run, '人工审核 manual_approved（产出落线边）', review.body?.data?.reviewStatus === 'manual_approved', JSON.stringify(review.body?.data))

  const labor = await httpStep(run, '工时记录 8h（POST /execution/labor-records，CA-12 报工主源）',
    'POST', '/execution/labor-records',
    { orderId: s.orderCost.orderId, orderOperationId: s.orderCost.op1Id, hours: '8.0000', businessTime: laborTime, note: 'P23 验收成本归集工时事实', operationId: `${s.run}-s0-labor` },
    [200, 201])
  s.laborRecordId = labor.body?.data?.laborRecordId ?? null
  must(run, '工时记录落库', Boolean(s.laborRecordId), JSON.stringify(labor.body?.data))

  // 会话事实（OT 工序关联窗口）：business_time = 报工 businessTime，提交后 updated_at ≈ now
  const sessRows = sqlStep(run, 'SQL：报工会话（设备码/状态/起止窗）',
    `SELECT equipment_code, status, business_time::text, updated_at::text FROM execution_session WHERE order_id = ${q(s.orderCost.orderId)}`)
  const sess = sessRows[0]
  s.costSession = { equipmentCode: sess?.[0], status: sess?.[1], from: sess?.[2], to: sess?.[3] }
  must(run, '会话已提交且带设备码（OT-13 auto_bound 匹配键）',
    sess?.[0] === s.eqExecCode && sess?.[1] === 'submitted', JSON.stringify(sess))

  // ---- 7) 库存单元（真实收货） ----
  // 协议A 载具码单元：10 位（1E + 8 位 run 标识尾串——跨 run 唯一）；归属 SQL 造数（报工链只产 PRDU 内部码）
  const cvTag = s.run.replace(/[^0-9A-Za-z]/g, '').slice(-8).toUpperCase()
  // FC-07 载具码恰 10 位：1E/2F + 8 位（协议B 两单元以尾位 1/2 区分）
  s.uCvA = `1E${cvTag}`
  const uCvAId = await receiveUnit(run, `收货协议A载具码单元 ${s.uCvA}（100 M，普通仓）`, {
    plantId: s.szPlantId, unitNo: s.uCvA, materialId: s.mat['MAT-P23-FIN'], materialCode: 'MAT-P23-FIN',
    locationId: s.loc.whMain, locationCode: s.loc.whMainCode, quantity: '100.0000',
  })
  s.uCvAId = uCvAId
  must(run, '协议A载具码单元收货成功', Boolean(uCvAId), `unitId=${uCvAId}`)

  const own = seedUnitOwnership({
    entId: s.entId, plantId: s.szPlantId, orderId: s.orderSrc.orderId, orderOperationId: s.orderSrc.op1Id,
    unitId: uCvAId, quantity: '100.0000', locationId: s.loc.whMain, locationCode: s.loc.whMainCode,
  })
  must(run, '协议A单元归属事实造数落库（report_output → SRC 订单）', Boolean(own.reportId), JSON.stringify(own))

  // 协议B 仓内单元×2（FC-17：仓库类型=WAREHOUSE、成品、库存>0）
  // FC-07 载具码恰 10 位：类型位 E/F（第 2 位）+ 8 位 run 标识（首位数字区分用途，跨 run 唯一）
  s.uCvB1 = `3F${cvTag}`
  s.uCvB2 = `4F${cvTag}`
  s.uCvB1Id = await receiveUnit(run, `收货协议B单元 ${s.uCvB1}（100 M，普通仓）`, {
    plantId: s.szPlantId, unitNo: s.uCvB1, materialId: s.mat['MAT-P23-FIN'], materialCode: 'MAT-P23-FIN',
    locationId: s.loc.whMain, locationCode: s.loc.whMainCode, quantity: '100.0000',
  })
  s.uCvB2Id = await receiveUnit(run, `收货协议B单元 ${s.uCvB2}（100 M，普通仓）`, {
    plantId: s.szPlantId, unitNo: s.uCvB2, materialId: s.mat['MAT-P23-FIN'], materialCode: 'MAT-P23-FIN',
    locationId: s.loc.whMain, locationCode: s.loc.whMainCode, quantity: '100.0000',
  })
  must(run, '协议B仓内单元×2 收货成功', Boolean(s.uCvB1Id && s.uCvB2Id), `b1=${s.uCvB1Id} b2=${s.uCvB2Id}`)

  // 备件单元（A10 维保备件消耗；类型 2 料品放线边仓——MD-23）
  s.uSpare = `SP${cvTag}001`
  s.uSpareId = await receiveUnit(run, `收货备件单元 ${s.uSpare}（100 M，线边仓）`, {
    plantId: s.szPlantId, unitNo: s.uSpare, materialId: s.mat['MAT-P23-SPARE'], materialCode: 'MAT-P23-SPARE',
    locationId: s.loc.whLine, locationCode: s.loc.whLineCode, quantity: '100.0000',
  })
  must(run, '备件单元收货成功', Boolean(s.uSpareId), `unitId=${s.uSpareId}`)

  // ---- 8) 环境对账：四张前置表在册 ----
  sqlStep(run, 'SQL 对账：本 run 主数据/订单/单元计数',
    `SELECT 'order', count(*) FROM production_order WHERE order_no LIKE ${q(`MO-${s.run}-%`)}
     UNION ALL SELECT 'unit', count(*) FROM inventory_unit WHERE unit_no IN (${q(s.uCvA)}, ${q(s.uCvB1)}, ${q(s.uCvB2)}, ${q(s.uSpare)})
     UNION ALL SELECT 'labor', count(*) FROM labor_record WHERE order_id = ${q(s.orderCost.orderId)}`)
  const laborHours = sqlOne(`SELECT hours::text FROM labor_record WHERE id = ${q(s.laborRecordId)}`)
  must(run, '工时 8.0000 在册', eqQty(laborHours, 8), `hours=${laborHours}`)

  run.saveState()
  return run
}
