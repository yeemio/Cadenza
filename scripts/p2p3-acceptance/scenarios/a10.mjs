/**
 * A10 维护闭环（maintenance 域 P2-E/T19 + scheduling 域联证）：
 * - 状态机全链：报修→分派→处理中→待复机→复机关闭（MT-07/13；越级/终态不可取消反证）；
 * - 停机事实：建单开停机、复机闭停机（MT-09 起止原子）；状态流水 WEB 来源（MT-02/08）；
 * - 备件消耗记账：复机同事务消耗+issue 流水扣前/扣后（MT-11）；
 * - 能力事件：down/restored 成对（MT-10/15）；
 * - 排产约束联证（A3-3）：维修设备不可新增正数排产 → 复机后排产恢复可见。
 */
import { must, httpStep, sqlStep, sqlOne, q, eqQty, beijingToday, ensureAdminPermissions } from '../lib.mjs'

export async function run(run) {
  await ensureAdminPermissions(run) // 场景自足：并行会话 seed 可能中途重置授权
  run.setScenario('A10')
  const s = run.state
  const plant = s.szPlantId
  const today = beijingToday()

  // ---- 1) Web 报修建单（置维修 + 开停机 + 能力下降事件） ----
  const create = await httpStep(run, 'Web 报修建单（POST /maintenance/orders）',
    'POST', '/maintenance/orders',
    { equipmentCode: s.eqMtCode, description: 'P23 验收：主轴承异响', reason: 'P23 验收报修', operationId: `${s.run}-a10-create` },
    [200, 201])
  const orderId = create.body?.data?.orderId ?? null
  s.a10 = { orderId }
  must(run, '建单成功（reported）', create.body?.data?.status === 'reported', JSON.stringify(create.body?.data))

  const mt0 = sqlStep(run, 'SQL：建单即置维修 + 开停机 + 能力下降事件 + 状态流水',
    `SELECT (SELECT equipment_status FROM equipment WHERE id = ${q(s.equipment[s.eqMtCode].id)}),
       (SELECT count(*) FROM downtime_event WHERE order_id = ${q(orderId)} AND end_at IS NULL),
       (SELECT count(*) FROM outbox WHERE task_kind = 'maintenance.capacity-change' AND payload->>'orderId' = ${q(orderId)} AND payload->>'changeKind' = 'down'),
       (SELECT count(*) FROM equipment_status_log WHERE equipment_id = ${q(s.equipment[s.eqMtCode].id)})`)
  must(run, '建单四写：设备置维修(2) + 停机开区间 + down 事件 + WEB 流水',
    Number(mt0[0]?.[0]) === 2 && Number(mt0[0]?.[1]) === 1 && Number(mt0[0]?.[2]) === 1 && Number(mt0[0]?.[3]) >= 1,
    JSON.stringify(mt0))

  // ---- 2) 状态机推进：分派→处理中→待复机 ----
  await httpStep(run, '分派（记录分派人/被派人）',
    'POST', '/maintenance/orders/dispatch',
    { orderId, assignee: '王维修', operationId: `${s.run}-a10-dispatch` },
    [200, 201])
  await httpStep(run, '开工处理（in_progress）',
    'POST', '/maintenance/orders/start',
    { orderId, operationId: `${s.run}-a10-start` },
    [200, 201])
  await httpStep(run, '维修完成（待复机）',
    'POST', '/maintenance/orders/finish-repair',
    { orderId, operationId: `${s.run}-a10-finish` },
    [200, 201])
  const st = sqlOne(`SELECT status FROM maintenance_order WHERE id = ${q(orderId)}`)
  must(run, '状态机走至 pending_restart（报修→分派→处理中→待复机）', st === 'pending_restart', `status=${st}`)

  // 越级反证：待复机不可取消（MT-14；O-2 修复后 maintenance 业务拒绝与其余域同款映射为 422）
  const cancel = await httpStep(run, '待复机取消反证 → 422 [MT-14]',
    'POST', '/maintenance/orders/cancel',
    { orderId, cancelReason: '越态取消反证', operationId: `${s.run}-a10-cancel` },
    422)
  must(run, '待复机不可取消（MT-14，HTTP 422 + code/message 形状）',
    String(cancel.body?.message ?? '').includes('MT-14') && String(cancel.body?.code ?? '').startsWith('ERR_'),
    JSON.stringify(cancel.body))

  // ---- 3) 排产约束联证（A3-3）：维修设备不可新增正数排产 ----
  const slotBlocked = await httpStep(run, '维修设备新增正数排产反证 → 422 [A3-3]',
    'POST', '/scheduling/slots',
    { orderOperationId: s.orderCost.op1Id, equipmentId: s.equipment[s.eqMtCode].id, productionDate: today, plannedQty: '100.0000', operationId: `${s.run}-a10-slot-blocked` },
    422)
  must(run, '维修设备排产被拒（A3-3 维修且无槽不可新建正数）', String(slotBlocked.body?.message ?? '').includes('A3-3'), JSON.stringify(slotBlocked.body?.message))

  // ---- 4) 复机关闭（备件消耗同事务 + 闭停机 + 置正常 + 能力恢复事件） ----
  const spareBefore = sqlOne(`SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(s.uSpareId)} AND status = 'active'`)
  const restart = await httpStep(run, '复机关闭（备件消耗 5 + 责任人）',
    'POST', '/maintenance/orders/restart',
    {
      orderId, responsible: '刘工',
      spareParts: [{ unitId: s.uSpareId, quantity: '5.0000' }],
      operationId: `${s.run}-a10-restart`,
    },
    [200, 201])
  must(run, '复机成功（closed + 复机正常结果）', restart.body?.data?.status === 'closed', JSON.stringify(restart.body?.data))

  const mt1 = sqlStep(run, 'SQL：复机后六写对齐（设备正常/停机闭口/流水对齐/工单关闭字段）',
    `SELECT (SELECT equipment_status FROM equipment WHERE id = ${q(s.equipment[s.eqMtCode].id)}),
       (SELECT count(*) FROM downtime_event WHERE order_id = ${q(orderId)} AND end_at IS NOT NULL),
       (SELECT start_at::text || '→' || end_at::text FROM downtime_event WHERE order_id = ${q(orderId)}),
       (SELECT old_status || '→' || new_status || '@' || source FROM equipment_status_log WHERE equipment_id = ${q(s.equipment[s.eqMtCode].id)} ORDER BY created_at DESC LIMIT 1),
       (SELECT result || '/' || responsible FROM maintenance_order WHERE id = ${q(orderId)})`)
  must(run, '复机后：设备正常(1) + 停机闭口起止原子 + 流水 2→1@WEB + 关闭结果/责任人',
    Number(mt1[0]?.[0]) === 1 && Number(mt1[0]?.[1]) === 1 && Boolean(mt1[0]?.[2]?.includes('→')) &&
      mt1[0]?.[3]?.startsWith('2→1@WEB') && Boolean(mt1[0]?.[4]),
    JSON.stringify(mt1))

  // 备件消耗记账（MT-11）：消耗行引用库存流水 + 余额 100→95
  const spareRows = sqlStep(run, 'SQL：备件消耗行 + issue 流水扣前/扣后 + 余额',
    `SELECT u.quantity::text, t.movement_kind, t.before_qty::text, t.after_qty::text, t.id::text = u.stock_transaction_id::text,
       (SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(s.uSpareId)} AND status = 'active')
     FROM spare_part_usage u LEFT JOIN stock_transaction t ON t.id = u.stock_transaction_id
     WHERE u.order_id = ${q(orderId)}`)
  must(run, '备件消耗记账：行引用同事务流水、issue 扣前 100→扣后 95、余额 95（MT-11 + IT-19）',
    spareRows.length === 1 && spareRows[0][1] === 'issue' && eqQty(spareRows[0][2], spareBefore ?? 100) && eqQty(spareRows[0][3], 95) &&
      spareRows[0][4] === 't' && eqQty(spareRows[0][5], 95),
    JSON.stringify(spareRows))

  // 能力事件成对 + 详情对齐（A10：工单＋停机＋备件＋状态流水＋能力事件链）
  const capRows = sqlStep(run, 'SQL：能力事件成对（down + restored）',
    `SELECT payload->>'changeKind', count(*) FROM outbox WHERE task_kind = 'maintenance.capacity-change' AND payload->>'orderId' = ${q(orderId)} GROUP BY payload->>'changeKind'`)
  const capMap = Object.fromEntries(capRows.map((r) => [r[0], Number(r[1])]))
  must(run, '能力事件成对（down×1 + restored×1，MT-10/15）', capMap['down'] === 1 && capMap['restored'] === 1, JSON.stringify(capRows))

  const detail = await httpStep(run, '工单详情对齐（GET /maintenance/orders/:id）',
    'GET', `/maintenance/orders/${orderId}`, undefined, 200)
  const d = detail.body?.data ?? detail.body ?? {}
  must(run, '详情四链齐备（停机/备件/状态流水/能力事件）',
    (d.downtimeEvents ?? []).length === 1 && (d.spareUsages ?? []).length === 1 &&
      (d.equipmentStatusLogs ?? []).length >= 2 && (d.capacityEvents ?? []).length === 2,
    JSON.stringify({ down: d.downtimeEvents?.length, spare: d.spareUsages?.length, logs: d.equipmentStatusLogs?.length, cap: d.capacityEvents?.length }))

  // ---- 5) 排产恢复：复机后同一槽位保存成功 + 设备视图可见 ----
  const slotOk = await httpStep(run, '复机后同一排产保存 → 成功（能力恢复）',
    'POST', '/scheduling/slots',
    { orderOperationId: s.orderCost.op1Id, equipmentId: s.equipment[s.eqMtCode].id, productionDate: today, plannedQty: '100.0000', operationId: `${s.run}-a10-slot-ok` },
    [200, 201])
  must(run, '复机后排产恢复（同载荷成功）', slotOk.body?.data?.action === 'upserted', JSON.stringify(slotOk.body?.data))

  const deviceView = await httpStep(run, '设备视图（GET /scheduling/device-view，按工作中心+设备收敛）',
    'GET', `/scheduling/device-view?plantId=${plant}&workCenterId=${s.wcId}&equipmentId=${s.equipment[s.eqMtCode].id}`, undefined, 200)
  const dvEq = (deviceView.body?.equipments ?? [])[0]
  const dvCell = (dvEq?.cells ?? []).find((c) => c.productionDate === today)
  must(run, '排产恢复可见：当日 plannedTotal=100', eqQty(dvCell?.plannedTotal, 100), JSON.stringify(dvCell))

  // ---- 6) 跨域四账对账 ----
  const balRows = sqlStep(run, 'SQL 四账一：备件余额 95（在册）',
    `SELECT quantity::text, status FROM stock_balance WHERE unit_id = ${q(s.uSpareId)}`)
  must(run, '余额对账：备件 95 active', eqQty(balRows[0]?.[0], 95) && balRows[0]?.[1] === 'active', JSON.stringify(balRows))

  const txRows = sqlStep(run, 'SQL 四账二：维保流水（issue 1 行扣前/扣后）',
    `SELECT movement_kind, before_qty::text, after_qty::text FROM stock_transaction WHERE unit_id = ${q(s.uSpareId)} AND movement_kind = 'issue' ORDER BY business_time`)
  must(run, '流水对账：issue 100→95（投料收货流水不计）', txRows.length === 1 && eqQty(txRows[0][1], 100) && eqQty(txRows[0][2], 95), JSON.stringify(txRows))

  const outboxRows = sqlStep(run, 'SQL 四账三：A10 Outbox（能力事件）',
    `SELECT task_kind, count(*) FROM outbox WHERE task_kind = 'maintenance.capacity-change' GROUP BY task_kind`)
  must(run, 'Outbox 对账：capacity-change 在册', outboxRows.length === 1 && Number(outboxRows[0][1]) >= 2, JSON.stringify(outboxRows))

  const auditRows = sqlStep(run, 'SQL 四账四：A10 审计（maintenance 五命令）',
    `SELECT action, count(*) FROM audit_entry WHERE action LIKE 'maintenance.%' AND actor = 'admin' GROUP BY action ORDER BY action`)
  const auditMap = Object.fromEntries(auditRows.map((r) => [r[0], Number(r[1])]))
  must(run, '审计对账：建单/分派/开工/完修/复机在册',
    (auditMap['maintenance.order.create'] ?? 0) >= 1 && (auditMap['maintenance.order.dispatch'] ?? 0) >= 1 &&
      (auditMap['maintenance.order.start'] ?? 0) >= 1 && (auditMap['maintenance.order.finish-repair'] ?? 0) >= 1 &&
      (auditMap['maintenance.order.restart'] ?? 0) >= 1,
    JSON.stringify(auditRows))

  run.saveState()
  return run
}
