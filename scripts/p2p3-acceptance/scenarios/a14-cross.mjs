/**
 * A14 P2/P3 跨域抽验（五段各一条 + 末尾跨域四账）：
 * - csw 外协一段（CS-19～22/CA-15）：创建→提交→发送（两段交接/所有权保留）→在外（sent）→回厂
 *   （目的余额强制待检=默认全部必检）→检验→关闭（结算事实出站）；
 * - reverse 盘点差异调整单一条（WR-24/25）：开盘锁仓（移库被拦）→点数（盘亏 -2）→差异调整单
 *   （原因+去向+adjust 流水扣前扣后）→关盘解锁；差异对账（余额=账面−差异）；
 * - disposition 让步处置一条（QD-19/23）：不合格单元让步放行——质量投影 qualified、
   原不合格收货事实保留（检验链不动）、审批人+让步范围落库；
 * - reporting 班次快照一条（RP-18/19/21/22）：默认四族指标注册→班次快照重算→良率分子/分母
 *   与原单据 SQL 逐笔对账（口径分母核对）、幂等重算不产重复行；
 * - aiquery AQ-C1 一次真实问数往返（订单进度）：会话登记→execute→六段信封
 *   （来源 freshness.sources/口径 contextEcho.effectiveFilters/完整性 completeness.totalKnown 齐全）
 *   + 五量 SQL 对照 + 审计行在册。
 */
import { must, httpStep, sqlStep, sqlOne, sql, q, eqQty, P23_PERMISSIONS, ensureAdminPermissions, UOM_M_ID, OWNER_NAME, REPO_ROOT } from '../lib.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const A14_PERMISSIONS = [
  ...P23_PERMISSIONS,
  'csw.read', 'csw.post', 'reverse.read', 'reverse.post',
  'disposition.read', 'disposition.post', 'reporting.read', 'reporting.post', 'aiquery.use',
]

export async function run(run) {
  await ensureAdminPermissions(run, A14_PERMISSIONS) // 场景自足 + 跨域许可合并
  run.setScenario('A14')
  const s = run.state
  const plant = s.szPlantId
  const cvTag = s.run.replace(/[^0-9A-Za-z]/g, '').slice(-8).toUpperCase()
  const d = s.utcDay

  // =====================================================================
  // 段一：csw 外协（发送→在外→回厂必检 CA-15/CS-22→检验→关闭）
  // =====================================================================
  // 外协在途位（whMain 内新库位 0202）
  const transitCode = `${s.loc.whMainCode.slice(0, 4)}0202`
  const transitLoc = await httpStep(run, `建外协在途位 ${transitCode}（whMain 仓内）`,
    'POST', '/masterdata/locations',
    { warehouseId: s.wh.whMain, code: transitCode, operationId: `${s.run}-a14-loc-transit`, reason: 'A14 外协在途位' },
    [200, 201])
  const transitLocId = transitLoc.body?.data?.locationId ?? null
  must(run, '外协在途位就绪', Boolean(transitLocId), JSON.stringify(transitLoc.body?.data))

  // 外协发送单元（真实收货 100 M 线边仓）
  const uOw = `6F${cvTag}`
  const uOwId = (await httpStep(run, `收货外协发送单元 ${uOw}（100 M，线边仓）`,
    'POST', '/inventory/receive',
    {
      plantId: plant, lotNo: `LOT-${s.run}-${uOw}`, unitNo: uOw, materialId: s.mat['MAT-P23-FIN'], materialCode: 'MAT-P23-FIN',
      uomId: UOM_M_ID, uomCode: 'M', quantity: '100.0000', measurementBasis: 'nominal',
      locationId: s.loc.whLine, locationCode: s.loc.whLineCode, ownerId: s.entId, ownerName: OWNER_NAME,
      qualityStatus: 'qualified', operationId: `${s.run}-a14-rcv-ow`,
    },
    [200, 201])).body?.data?.unitId ?? null
  must(run, '外协发送单元收货成功', Boolean(uOwId), `unitId=${uOwId}`)

  const owtCreate = await httpStep(run, '外协任务创建（FEED 工序 60，供应方快照）',
    'POST', '/csw/outsourcing/create',
    {
      orderOperationId: s.orderFeed.op1Id, supplierCode: 'SUP-A14', supplierName: '苏州外协加工A',
      qty: '60.0000', transitLocationId: transitLocId, transitLocationCode: transitCode,
      returnLocationId: s.loc.whMain, returnLocationCode: s.loc.whMainCode,
      operationId: `${s.run}-a14-ow-create`,
    },
    [200, 201])
  const owtId = owtCreate.body?.data?.taskId ?? null
  must(run, '外协任务创建（draft）', owtCreate.body?.data?.status === 'draft', JSON.stringify(owtCreate.body?.data))

  await httpStep(run, '外协任务提交', 'POST', '/csw/outsourcing/submit', { taskId: owtId, operationId: `${s.run}-a14-ow-submit` }, [200, 201])

  const sendRes = await httpStep(run, '外协发送 60（两段交接：来源减+在途增，所有权保留）',
    'POST', '/csw/outsourcing/send',
    { taskId: owtId, lines: [{ unitId: uOwId, quantity: '60.0000' }], operationId: `${s.run}-a14-ow-send` },
    [200, 201])
  must(run, '发送成功（sent，sentQty=60）', sendRes.body?.data?.status === 'sent', JSON.stringify(sendRes.body?.data))

  const sentRows = sqlStep(run, 'SQL：发送段对账（来源 40 / 在途 60 同 owner / transfer_out 流水）',
    `SELECT b.location_code, b.quantity::text, b.status, b.quality_status, b.owner_id::text = ${q(s.entId)}
     FROM stock_balance b
     WHERE b.unit_id = ${q(uOwId)} AND b.status = 'active' ORDER BY b.location_code`)
  const txOut = sqlOne(`SELECT count(*) FROM stock_transaction WHERE unit_id = ${q(uOwId)} AND movement_kind = 'transfer_out'`)
  must(run, '发送段两段原子：来源余额 40 + 在途余额 60（owner 不变 CS-20）+ transfer_out 流水在册',
    sentRows.length === 2 && eqQty(sentRows.find((r) => r[0] === s.loc.whLineCode)?.[1], 40) &&
      eqQty(sentRows.find((r) => r[0] === transitCode)?.[1], 60) && Number(txOut) >= 2 &&
      sentRows.every((r) => r[4] === 't'),
    JSON.stringify(sentRows))

  const owtSent = await httpStep(run, '在外状态读回（GET /csw/outsourcing-tasks/:id → sent）',
    'GET', `/csw/outsourcing-tasks/${owtId}`, undefined, 200)
  const sentTask = owtSent.body?.task ?? owtSent.body?.data?.task ?? {}
  must(run, '在外事实：status=sent、sentQty=60、sentAt 留痕（CS-19 每步操作者时间）',
    sentTask.status === 'sent' && eqQty(sentTask.sentQty, 60) && Boolean(sentTask.sentAt),
    JSON.stringify({ status: sentTask.status, sentQty: sentTask.sentQty, sentAt: sentTask.sentAt }))

  const rcvRes = await httpStep(run, '回厂接收 60（目的位=回厂位）',
    'POST', '/csw/outsourcing/receive',
    { taskId: owtId, lines: [{ unitId: uOwId, quantity: '60.0000' }], operationId: `${s.run}-a14-ow-receive` },
    [200, 201])
  const rcvQty = sqlOne(`SELECT returned_qty::text FROM csw_outsourcing_task WHERE id = ${q(owtId)}`)
  must(run, '回厂接收成功（return_received，returnedQty=60）',
    rcvRes.body?.data?.status === 'return_received' && eqQty(rcvQty, 60),
    JSON.stringify({ data: rcvRes.body?.data, returnedQty: rcvQty }))

  const rcvRows = sqlStep(run, 'SQL：回厂段对账（在途闭口清零 IT-29 / 回厂余额 60 强制待检 CS-22/CA-15）',
    `SELECT b.location_code, b.quantity::text, b.status, b.quality_status
     FROM stock_balance b
     WHERE b.unit_id = ${q(uOwId)} ORDER BY b.location_code`)
  const rcvMain = rcvRows.find((r) => r[0] === s.loc.whMainCode)
  const rcvTransit = rcvRows.find((r) => r[0] === transitCode)
  const rcvLine = rcvRows.find((r) => r[0] === s.loc.whLineCode)
  must(run, '回厂必检（CA-15 默认全部必检）：回厂余额 60 quality=pending_inspection、在途余额零口关闭（IT-29）、余量 40 不动',
    rcvRows.length === 3 && eqQty(rcvMain?.[1], 60) && rcvMain?.[2] === 'active' && rcvMain?.[3] === 'pending_inspection' &&
      eqQty(rcvTransit?.[1], 0) && rcvTransit?.[2] === 'closed' && eqQty(rcvLine?.[1], 40) && rcvLine?.[3] === 'qualified',
    JSON.stringify(rcvRows))

  await httpStep(run, '外协检验通过', 'POST', '/csw/outsourcing/inspect', { taskId: owtId, inspectionResult: 'passed', operationId: `${s.run}-a14-ow-inspect` }, [200, 201])
  const closeRes = await httpStep(run, '外协关闭（须检验通过）', 'POST', '/csw/outsourcing/close', { taskId: owtId, operationId: `${s.run}-a14-ow-close` }, [200, 201])
  must(run, '外协任务关闭（closed）', closeRes.body?.data?.status === 'closed', JSON.stringify(closeRes.body?.data))

  const settleRows = sqlStep(run, 'SQL：结算事实出站（发送/关闭两时点快照，CS-24 模拟出站）',
    `SELECT payload->>'sentQty', payload->>'returnedQty', payload->>'closedAt' IS NOT NULL
     FROM outbox WHERE task_kind = 'csw.outsourcing.settlement-export' AND payload->>'taskNo' = ${q(sentTask.taskNo ?? '')} ORDER BY created_at`)
  must(run, '结算事实两时点在册（发送时点 sentQty=60；关闭时点 sent=returned=60+closedAt）',
    settleRows.length === 2 && settleRows[0][0] === '60.0000' &&
      settleRows[1][0] === '60.0000' && settleRows[1][1] === '60.0000' && settleRows[1][2] === 't',
    JSON.stringify(settleRows))

  // =====================================================================
  // 段二：reverse 盘点差异调整单（WR-24/25）
  // =====================================================================
  const stOpen = await httpStep(run, '开盘锁仓（whMain）',
    'POST', '/reverse/stocktake/open',
    { plantId: plant, warehouseId: s.wh.whMain, note: 'A14 盘点差异调整抽验', reason: 'A14 验收盘点', operationId: `${s.run}-a14-st-open` },
    [200, 201])
  const stOrderId = stOpen.body?.data?.orderId ?? null
  must(run, '开盘成功（counting+locked）', stOpen.body?.data?.status === 'counting' && stOpen.body?.data?.locked === true, JSON.stringify(stOpen.body?.data))

  const moveBlocked = await httpStep(run, '锁仓拦截移库（WR-24①）→ 422',
    'POST', '/reverse/move/submit',
    { plantId: plant, warehouseId: s.wh.whMain, toLocationId: s.loc.whMain, stagedUnitNos: [], operationId: `${s.run}-a14-move-blocked` },
    422)
  must(run, '盘点锁定移库被拦（WR-24）', String(moveBlocked.body?.message ?? '').includes('WR-24'), JSON.stringify(moveBlocked.body?.message))

  const b1Book = sqlOne(`SELECT b.quantity::text FROM stock_balance b WHERE b.unit_id = ${q(s.uCvB1Id)} AND b.status = 'active'`)
  const countRes = await httpStep(run, `点数 ${s.uCvB1}（账面 ${b1Book} → 点数 98，盘亏 2）`,
    'POST', '/reverse/stocktake/record-count',
    { orderId: stOrderId, lines: [{ unitNo: s.uCvB1, countedQty: '98.0000' }], reason: 'A14 点数', operationId: `${s.run}-a14-st-count` },
    [200, 201])
  must(run, `点数落册（diffs=1，账面→${b1Book}→98）`, countRes.body?.data?.diffs === 1, JSON.stringify(countRes.body?.data))

  const adjust = await httpStep(run, '差异调整单执行（原因+去向必填，盘亏 -2）',
    'POST', '/reverse/stock-adjustment/execute',
    {
      plantId: plant, stocktakeOrderId: stOrderId,
      lines: [{ unitId: s.uCvB1Id, adjustQty: '-2.0000' }],
      reason: 'A14 盘点差异：线盘端面碰伤盘亏', destination: '报废（现场处置）',
      operationId: `${s.run}-a14-adjust`,
    },
    [200, 201])
  must(run, '差异调整单执行成功', Boolean(adjust.body?.data?.adjustmentNo ?? adjust.body?.data?.id), JSON.stringify(adjust.body?.data))

  const adjRows = sqlStep(run, 'SQL：调整对账（adjust 流水扣前/扣后 + 余额=账面−差异 + 调整单行）',
    `SELECT t.movement_kind, t.before_qty::text, t.after_qty::text,
       (SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(s.uCvB1Id)} AND status = 'active'),
       (SELECT count(*) FROM stock_adjustment_line WHERE inventory_unit_id = ${q(s.uCvB1Id)} AND adjust_qty = '-2.0000')
     FROM stock_transaction t
     WHERE t.unit_id = ${q(s.uCvB1Id)} AND t.movement_kind = 'adjust' ORDER BY t.business_time DESC LIMIT 1`)
  must(run, `对账成立：adjust ${b1Book}→${Number(b1Book) - 2}、余额 ${Number(b1Book) - 2}、调整单行在册`,
    adjRows.length === 1 && adjRows[0][0] === 'adjust' && eqQty(adjRows[0][1], b1Book) && eqQty(adjRows[0][2], Number(b1Book) - 2) &&
      eqQty(adjRows[0][3], Number(b1Book) - 2) && Number(adjRows[0][4]) >= 1,
    JSON.stringify(adjRows))

  const stClose = await httpStep(run, '关盘解锁', 'POST', '/reverse/stocktake/close', { orderId: stOrderId, reason: 'A14 盘点完成', operationId: `${s.run}-a14-st-close` }, [200, 201])
  must(run, '关盘成功（completed+unlocked）', stClose.body?.data?.status === 'completed' && stClose.body?.data?.locked === false, JSON.stringify(stClose.body?.data))

  // =====================================================================
  // 段三：disposition 让步处置（QD-19/23：原不合格事实保留）
  // =====================================================================
  const uCc = `5F${cvTag}`
  const ccLot = `LOT-${s.run}-${uCc}`
  const uCcId = (await httpStep(run, `收货不合格单元 ${uCc}（100 M，普通仓，unqualified）`,
    'POST', '/inventory/receive',
    {
      plantId: plant, lotNo: ccLot, unitNo: uCc, materialId: s.mat['MAT-P23-FIN'], materialCode: 'MAT-P23-FIN',
      uomId: UOM_M_ID, uomCode: 'M', quantity: '100.0000', measurementBasis: 'nominal',
      locationId: s.loc.whMain, locationCode: s.loc.whMainCode, ownerId: s.entId, ownerName: OWNER_NAME,
      qualityStatus: 'unqualified', operationId: `${s.run}-a14-rcv-cc`,
    },
    [200, 201])).body?.data?.unitId ?? null
  must(run, '不合格单元收货成功（原不合格事实=收货不合格）', Boolean(uCcId), `unitId=${uCcId}`)

  const concession = await httpStep(run, '让步放行（审批人+让步范围）',
    'POST', '/disposition/dispositions/concession',
    {
      plantId: plant, unitNo: uCc, approver: '质量负责人-张工', scopeBatchNo: ccLot, scopeQty: '100.0000',
      requestedQty: '100.0000', basis: 'A14 让步处置抽验：客户书面让步接收', operationId: `${s.run}-a14-concession`,
    },
    [200, 201])
  must(run, '让步成功（unqualifiedFactPreserved=true）', concession.body?.data?.unqualifiedFactPreserved === true, JSON.stringify(concession.body?.data))

  const ccRows = sqlStep(run, 'SQL：让步对账（处置记录 concession+审批人+范围；质量投影 qualified；原收货事实保留）',
    `SELECT (SELECT disposition_kind FROM qd_disposition_record WHERE id = ${q(concession.body?.data?.dispositionId ?? '')}),
       (SELECT approver FROM qd_disposition_record WHERE id = ${q(concession.body?.data?.dispositionId ?? '')}),
       (SELECT quality_status FROM stock_balance WHERE unit_id = ${q(uCcId)} AND status = 'active'),
       (SELECT count(*) FROM stock_transaction WHERE unit_id = ${q(uCcId)} AND movement_kind = 'receive' AND before_qty = '0.0000'),
       (SELECT concession_scope->>'batchNo' FROM qd_disposition_record WHERE id = ${q(concession.body?.data?.dispositionId ?? '')})`)
  must(run, 'QD-23：让步=保留原不合格事实的放行（投影 qualified + 原收货事实行不动 + 范围落库）',
    ccRows[0]?.[0] === 'concession' && ccRows[0]?.[1] === '质量负责人-张工' && ccRows[0]?.[2] === 'qualified' &&
      Number(ccRows[0]?.[3]) >= 1 && ccRows[0]?.[4] === ccLot,
    JSON.stringify(ccRows))

  // =====================================================================
  // 段四：reporting 班次快照（RP-18/19/21/22 口径分母核对）
  // =====================================================================
  await httpStep(run, '默认四族指标注册（幂等）',
    'POST', '/reporting/metric-definition/register',
    { metricKeys: ['*'], operationId: `${s.run}-a14-metrics` },
    [200, 201])

  const snap = await httpStep(run, `班次快照重算（${d}）`,
    'POST', '/reporting/shift-snapshot/rebuild',
    { plantId: plant, shiftDate: d, operationId: `${s.run}-a14-snap` },
    [200, 201])
  must(run, '快照重算成功', Boolean(snap.body?.data?.snapshots ?? snap.body?.data?.count ?? snap.body?.data), JSON.stringify(snap.body?.data))

  const snapList = await httpStep(run, '快照读回（GET /reporting/shift-snapshots）',
    'GET', `/reporting/shift-snapshots?plantId=${plant}&shiftDateFrom=${d}&shiftDateTo=${d}&page=1&pageSize=20`, undefined, 200)
  const snapItems = snapList.body?.items ?? snapList.body?.data?.items ?? []
  const yieldSnap = snapItems.find((x) => x.metricKey === 'yield.qualified-rate')
  must(run, '良率快照在册（status=ok，指标版本 v1）',
    Boolean(yieldSnap) && yieldSnap.status === 'ok' && Number(yieldSnap.metricVersion) === 1,
    JSON.stringify(snapItems.map((x) => ({ key: x.metricKey, status: x.status }))))

  // 口径分母核对（RP-22：分子/分母与原单据同条件 SQL 逐笔对账——与 reportQty 同一 WHERE）
  const numDen = sql(`SELECT COALESCE(sum(ro.qualified_qty),0)::text, COALESCE(sum(ro.quantity),0)::text, count(*)
     FROM report_output ro JOIN production_report pr ON pr.id = ro.report_id
     WHERE pr.plant_id = ${q(plant)} AND pr.status = 'submitted'
       AND pr.review_status IN ('auto_approved','manual_approved') AND pr.shift_date = ${q(d)}::date`)
  must(run, `口径分母核对：分子合格量=${numDen[0][0]} = 分母产出量=${numDen[0][1]}（快照 ${yieldSnap.numeratorValue}/${yieldSnap.denominatorValue}）`,
    yieldSnap.numeratorValue === numDen[0][0] && yieldSnap.denominatorValue === numDen[0][1],
    JSON.stringify({ snapshot: { n: yieldSnap.numeratorValue, d: yieldSnap.denominatorValue, value: yieldSnap.value }, sql: numDen[0] }))

  const snapAgain = await httpStep(run, '幂等重算（同键覆盖不产重复行，RP-S2）',
    'POST', '/reporting/shift-snapshot/rebuild',
    { plantId: plant, shiftDate: d, metricKeys: ['yield.qualified-rate'], operationId: `${s.run}-a14-snap2` },
    [200, 201])
  const snapCount = sqlOne(`SELECT count(*) FROM shift_snapshot WHERE plant_id = ${q(plant)} AND shift_date = ${q(d)}::date AND metric_key = 'yield.qualified-rate'`)
  must(run, '幂等键：重算后良率快照恰 1 行且值不变', Number(snapCount) === 1 && Boolean(snapAgain.body?.data), `rows=${snapCount}`)

  // =====================================================================
  // 段五：aiquery AQ-C1 真实问数往返（订单进度）
  // =====================================================================
  const sess = await httpStep(run, '问数会话登记（POST /aiquery/sessions，web 渠道）',
    'POST', '/aiquery/sessions', { channel: 'web' }, [200, 201])
  const aqSessionId = sess.body?.sessionId ?? sess.body?.data?.sessionId ?? null
  must(run, '会话登记成功', Boolean(aqSessionId), JSON.stringify(sess.body))

  const internalToken = readInternalToken()
  const requestId = randomUUID()
  const exec1 = await httpStep(run, `AQ-C1 execute（orderRef=${s.orderCost.orderNo}）`,
    'POST', '/internal/aiquery/execute',
    {
      requestId, toolCallSeq: 1, sessionId: aqSessionId,
      capabilityId: 'aq.order-progress', capabilityVersion: 1,
      params: { orderRef: { kind: 'orderNo', value: s.orderCost.orderNo } },
    },
    [200], { token: internalToken })
  const env = exec1.body ?? {}
  const orderData = env.data?.order ?? {}
  const fiveQty = orderData.totalQuantities ?? {}
  must(run, '六段信封：status=ok_with_data + 订单命中',
    env.status === 'ok_with_data' && orderData.orderNo === s.orderCost.orderNo, JSON.stringify({ status: env.status, orderNo: orderData.orderNo }))

  // 五量 SQL 对照（approved/qualified 按审核通过产出聚合）
  const fiveSql = sql(`SELECT
     COALESCE(sum(CASE WHEN pr.status='draft' THEN ro.quantity ELSE 0 END),0)::text,
     COALESCE(sum(CASE WHEN pr.status='submitted' AND pr.review_status IN ('auto_approved','manual_approved') THEN ro.quantity ELSE 0 END),0)::text,
     COALESCE(sum(CASE WHEN pr.status='submitted' AND pr.review_status IN ('auto_approved','manual_approved') THEN ro.qualified_qty ELSE 0 END),0)::text
     FROM report_output ro JOIN production_report pr ON pr.id = ro.report_id WHERE pr.order_id = ${q(s.orderCost.orderId)}`)
  must(run, `五量对照：approved=${fiveSql[0][1]} / qualified=${fiveSql[0][2]}（SQL 同口径）`,
    fiveQty.approvedQty === fiveSql[0][1] && fiveQty.qualifiedQty === fiveSql[0][2],
    JSON.stringify({ envelope: fiveQty, sql: fiveSql[0] }))

  must(run, '来源/口径/完整性标注齐全：freshness.sources ≥4 + contextEcho.effectiveFilters 回显 + completeness.totalKnown',
    (env.freshness?.sources ?? []).length >= 4 &&
      env.contextEcho?.effectiveFilters?.orderRef?.value === s.orderCost.orderNo &&
      env.completeness?.totalKnown === true && env.auditRef?.requestId === requestId,
    JSON.stringify({ sources: (env.freshness?.sources ?? []).map((x) => x.source ?? x.name), filters: env.contextEcho?.effectiveFilters, completeness: env.completeness, auditRef: env.auditRef }))

  const aqAudit = sqlStep(run, 'SQL：问数审计行在册（AQ-S2）',
    `SELECT result_status, capability_id FROM ai_query_audit WHERE request_id = ${q(requestId)} AND tool_call_seq = 1`)
  must(run, '审计对账：execute 审计行在册（ok_with_data）',
    aqAudit.length === 1 && aqAudit[0][0] === 'ok_with_data' && aqAudit[0][1] === 'aq.order-progress', JSON.stringify(aqAudit))

  // =====================================================================
  // 跨域四账（A14 末尾：余额/流水/Outbox/审计 五域合计）
  // =====================================================================
  const balRows = sqlStep(run, 'SQL 四账一：本 run 关键余额（外协单元三段 + 盘点单元 + 备件）',
    `SELECT (SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(uOwId)} AND location_id = ${q(s.loc.whMain)} AND status = 'active'),
       (SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(s.uCvB1Id)} AND status = 'active'),
       (SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(s.uSpareId)} AND status = 'active')`)
  must(run, `余额对账：外协回厂 60 待检 / 盘点后 ${Number(b1Book) - 2} / 备件在册`,
    eqQty(balRows[0]?.[0], 60) && eqQty(balRows[0]?.[1], Number(b1Book) - 2) && Number(balRows[0]?.[2]) > 0,
    JSON.stringify(balRows))

  const txRows = sqlStep(run, 'SQL 四账二：A14 流水（transfer_out/transfer_in/adjust 三类在册）',
    `SELECT movement_kind, count(*) FROM stock_transaction WHERE movement_kind IN ('transfer_out','transfer_in','adjust')
       AND business_time >= ${q(`${d}T00:00:00Z`)} GROUP BY movement_kind ORDER BY movement_kind`)
  const txMap = Object.fromEntries(txRows.map((r) => [r[0], Number(r[1])]))
  must(run, '流水对账：transfer_out/transfer_in/adjust 均在册（IT-18 唯一记账方）',
    (txMap['transfer_out'] ?? 0) >= 2 && (txMap['transfer_in'] ?? 0) >= 2 && (txMap['adjust'] ?? 0) >= 1,
    JSON.stringify(txRows))

  const outboxRows = sqlStep(run, 'SQL 四账三：A14 Outbox（csw 结算 + reverse 盘点开单 + aiquery 无业务出站）',
    `SELECT task_kind, count(*) FROM outbox WHERE task_kind IN ('csw.outsourcing.settlement-export','reverse.stocktake-opened') GROUP BY task_kind ORDER BY task_kind`)
  const outboxMap = Object.fromEntries(outboxRows.map((r) => [r[0], Number(r[1])]))
  must(run, 'Outbox 对账：结算事实 ≥2 + 盘点开单 ≥1', (outboxMap['csw.outsourcing.settlement-export'] ?? 0) >= 2 && (outboxMap['reverse.stocktake-opened'] ?? 0) >= 1, JSON.stringify(outboxRows))

  const auditRows = sqlStep(run, 'SQL 四账四：A14 跨域审计分布（csw/reverse/disposition 命令域；reporting 投影维护命令不落 audit_entry——导出审计另计，如实口径）',
    `SELECT substring(action from '^([a-z]+)\\.') AS domain, count(*) FROM audit_entry
     WHERE action LIKE 'csw.outsourcing.%' OR action LIKE 'reverse.stocktake.%' OR action LIKE 'reverse.stock-adjustment.%'
        OR action LIKE 'disposition.disposition.%'
     GROUP BY 1 ORDER BY 1`)
  const auditDomainMap = Object.fromEntries(auditRows.map((r) => [r[0], Number(r[1])]))
  must(run, '审计对账：csw/reverse/disposition 三域命令在册（reporting 见快照 computedBy 留痕）',
    (auditDomainMap['csw'] ?? 0) >= 6 && (auditDomainMap['reverse'] ?? 0) >= 4 && (auditDomainMap['disposition'] ?? 0) >= 1,
    JSON.stringify(auditRows))

  run.saveState()
  return run
}

/** 内部服务令牌（部署 .env AIQUERY_INTERNAL_TOKEN；未配置 → 空串按 401 如实失败）。 */
function readInternalToken() {
  try {
    const envText = readFileSync(join(REPO_ROOT, '.env'), 'utf8')
    const line = envText.split('\n').find((l) => l.startsWith('AIQUERY_INTERNAL_TOKEN='))
    return line ? line.slice('AIQUERY_INTERNAL_TOKEN='.length).trim().replace(/^"|"$/g, '') : ''
  } catch {
    return ''
  }
}
