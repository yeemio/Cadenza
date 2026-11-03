/**
 * A13 点检计划→执行→异常上报→维修工单→备件对账→复机→排产恢复（maintenance MT-12 全链）：
 * - 点检计划版本化（MT-12/MT-S4：周期+检查项模板+生效区间；v1→v2 版本快照）；
 * - 超期未执行提示（MT-12：提示口径不自动阻断——生效日起算超期列入，执行后消隐）；
 * - 执行轮次（inspection_round：实际时间+业务班次双存；fail 必填异常说明+建议报修不自动建单）；
 * - 异常上报（MT-03/04：equ- 前缀识别宽容、置维修+PDA 流水、关联建单 MT-13、开停机 MT-09）；
 * - 维修工单闭环（MT-07 状态机 + MT-09 在途停机守卫 + MT-14 待复机取消拒 + MT-11 备件消耗记账）；
 * - 复机（MT-10 六写：置正常+闭停机+流水+关闭字段+restored 能力事件）+ 排产恢复可见（A3-3：维修期
 *   新日期正数排产拒 → 复机后成功 + 设备视图 plannedTotal 可见）。
 */
import { must, httpStep, sqlStep, sqlOne, q, eqQty, ensureAdminPermissions } from '../lib.mjs'

/** 北京时区日期 + N 天（yyyy-MM-dd，UTC 日历运算防时区漂移）。 */
function beijingPlusDays(days) {
  const d = new Date(Date.now() + 8 * 3_600_000 + days * 86_400_000)
  return d.toISOString().slice(0, 10)
}

export async function run(run) {
  await ensureAdminPermissions(run) // 场景自足：并行会话 seed 可能中途重置授权
  run.setScenario('A13')
  const s = run.state
  const plant = s.szPlantId
  const today = beijingPlusDays(0)
  const tomorrow = beijingPlusDays(1)
  const planKey = `IP-${s.run.replace(/[^0-9A-Za-z]/g, '').slice(0, 10).toUpperCase()}`

  // ---- 1) 点检计划 v1（MT-12：周期+检查项模板+生效区间；生效日 D-10、周期 3 天 → 当前已超期） ----
  const v1 = await httpStep(run, `点检计划 v1（${planKey}，everyDays=3，生效 D-10 → 已超期）`,
    'POST', '/maintenance/plans/create-version',
    {
      equipmentCode: s.eqMtCode, planKey, kind: 'inspection', cycle: { everyDays: 3 },
      checkItems: ['主轴承温度', '润滑油位', '异响目测'], effectiveFrom: beijingPlusDays(-10),
      description: 'P23 第二轮补齐：点检计划', reason: 'A13 验收点检计划版本化', operationId: `${s.run}-a13-plan-v1`,
    },
    [200, 201])
  must(run, '计划 v1 创建成功（active）', v1.body?.data?.version === 1 && v1.body?.data?.status === 'active', JSON.stringify(v1.body?.data))

  // 周期反例：everyDays=0 → 422 [MT-12]
  const badCycle = await httpStep(run, '周期反例 everyDays=0 → 422 [MT-12]',
    'POST', '/maintenance/plans/create-version',
    { equipmentCode: s.eqMtCode, planKey: `${planKey}X`, kind: 'inspection', cycle: { everyDays: 0 }, checkItems: ['项'], effectiveFrom: today, operationId: `${s.run}-a13-plan-bad` },
    422)
  must(run, '非法周期被拒（MT-12）', String(badCycle.body?.message ?? '').includes('MT-12'), JSON.stringify(badCycle.body?.message))

  // 超期提示（MT-12：D-10+3=D-7 < D → 超期列入；提示不阻断生产）
  const overdue1 = await httpStep(run, '超期提示（GET /maintenance/plans/overdue，today=D）',
    'GET', `/maintenance/plans/overdue?plantId=${plant}&equipmentId=${s.equipment[s.eqMtCode].id}&today=${today}`, undefined, 200)
  const overdueList1 = overdue1.body?.items ?? overdue1.body?.data?.items ?? []
  must(run, '超期列入：planKey 在册（提示口径）',
    overdueList1.some((x) => x.planKey === planKey), JSON.stringify(overdueList1.map((x) => x.planKey)))

  // ---- 2) fail 执行轮次（MT-12：异常说明必填 + 建议报修不自动建单） ----
  const failRound = await httpStep(run, '点检执行 fail（异常说明必填）',
    'POST', '/maintenance/rounds',
    {
      planKey, version: 1, executedAt: `${today}T01:10:00Z`, shiftDate: today, result: 'fail',
      anomalyNote: '主轴承温度超标且异响明显', reason: 'A13 验收点检不合格', operationId: `${s.run}-a13-round-fail`,
    },
    [200, 201])
  must(run, 'fail 轮次：repairSuggestion 建议报修且不自动建单（GAP-F19 默认口径）',
    failRound.body?.data?.repairSuggestion?.suggested === true && failRound.body?.data?.orderId === undefined,
    JSON.stringify(failRound.body?.data))
  const failRoundId = failRound.body?.data?.roundId ?? null
  const noAutoOrder = sqlOne(`SELECT order_id IS NULL FROM inspection_round WHERE id = ${q(failRoundId)}`)
  must(run, 'SQL：fail 轮次未关联工单（不自动建单）', noAutoOrder === 't', `order_id null=${noAutoOrder}`)

  const noNote = await httpStep(run, 'fail 缺异常说明 → 422 [MT-12]',
    'POST', '/maintenance/rounds',
    { planKey, version: 1, result: 'fail', operationId: `${s.run}-a13-round-fail-nonote` },
    422)
  must(run, 'fail 必填异常说明被拒（MT-12）', String(noNote.body?.message ?? '').includes('MT-12'), JSON.stringify(noNote.body?.message))

  // ---- 3) 异常上报（MT-03/04：equ- 前缀识别宽容 → 置维修 + PDA 流水 + 关联建单 MT-13 + 开停机 MT-09） ----
  const anomaly = await httpStep(run, `异常上报（equ- 前缀小写识别宽容，置维修+关联建单）`,
    'POST', '/maintenance/equipment/anomaly-report',
    {
      equipmentCode: `equ-${s.eqMtCode}`, targetStatus: 2, createOrder: true,
      description: '点检发现主轴承异响（fail 轮次关联）', reason: 'A13 验收点检异常上报', operationId: `${s.run}-a13-anomaly`,
    },
    [200, 201])
  const a13OrderId = anomaly.body?.data?.orderId ?? null
  s.a13 = { orderId: a13OrderId, planKey }
  must(run, '异常上报：状态 1→2 + 关联建单（MT-03/13）',
    anomaly.body?.data?.statusChanged === true && anomaly.body?.data?.oldStatus === 1 &&
      anomaly.body?.data?.newStatus === 2 && Boolean(a13OrderId),
    JSON.stringify(anomaly.body?.data))

  const a13w = sqlStep(run, 'SQL：异常上报四写（置维修/开停机/能力 down/PDA 流水）',
    `SELECT (SELECT equipment_status FROM equipment WHERE id = ${q(s.equipment[s.eqMtCode].id)}),
       (SELECT count(*) FROM downtime_event WHERE order_id = ${q(a13OrderId)} AND end_at IS NULL),
       (SELECT count(*) FROM outbox WHERE task_kind = 'maintenance.capacity-change' AND payload->>'orderId' = ${q(a13OrderId)} AND payload->>'changeKind' = 'down'),
       (SELECT old_status || '→' || new_status || '@' || source FROM equipment_status_log WHERE equipment_id = ${q(s.equipment[s.eqMtCode].id)} ORDER BY created_at DESC LIMIT 1)`)
  must(run, '四写对齐：置维修(2)+停机开区间+down 事件+1→2@PDA 流水',
    Number(a13w[0]?.[0]) === 2 && Number(a13w[0]?.[1]) === 1 && Number(a13w[0]?.[2]) === 1 && a13w[0]?.[3]?.startsWith('1→2@PDA'),
    JSON.stringify(a13w))

  // ---- 4) MT-09 守卫：同设备在途停机，Web 报修建单 → 422 ----
  const dupCreate = await httpStep(run, '在途停机再报修 → 422 [MT-09]',
    'POST', '/maintenance/orders',
    { equipmentCode: s.eqMtCode, description: '在途停机重复报修反证', reason: 'A13 MT-09 守卫', operationId: `${s.run}-a13-mt09` },
    422)
  must(run, 'MT-09 守卫生效（同设备在途停机拒新建）', String(dupCreate.body?.message ?? '').includes('MT-09'), JSON.stringify(dupCreate.body?.message))

  // ---- 5) 状态机推进：分派→处理中→待复机 + MT-14 取消反例 ----
  await httpStep(run, '分派', 'POST', '/maintenance/orders/dispatch', { orderId: a13OrderId, assignee: '王维修', operationId: `${s.run}-a13-dispatch` }, [200, 201])
  await httpStep(run, '开工处理', 'POST', '/maintenance/orders/start', { orderId: a13OrderId, operationId: `${s.run}-a13-start` }, [200, 201])
  await httpStep(run, '维修完成（待复机）', 'POST', '/maintenance/orders/finish-repair', { orderId: a13OrderId, operationId: `${s.run}-a13-finish` }, [200, 201])
  const st = sqlOne(`SELECT status FROM maintenance_order WHERE id = ${q(a13OrderId)}`)
  must(run, '状态机走至 pending_restart', st === 'pending_restart', `status=${st}`)

  const cancel = await httpStep(run, '待复机取消反证 → 422 [MT-14]',
    'POST', '/maintenance/orders/cancel', { orderId: a13OrderId, cancelReason: '越态取消反证', operationId: `${s.run}-a13-cancel` }, 422)
  must(run, '待复机不可取消（MT-14）', String(cancel.body?.message ?? '').includes('MT-14'), JSON.stringify(cancel.body?.message))

  // ---- 6) A3-3：维修期间新日期正数排产被拒（本槽位尚无排产） ----
  const slotBlocked = await httpStep(run, `维修设备 D+1 新建正数排产反证 → 422 [A3-3]`,
    'POST', '/scheduling/slots',
    { orderOperationId: s.orderCost.op1Id, equipmentId: s.equipment[s.eqMtCode].id, productionDate: tomorrow, plannedQty: '80.0000', operationId: `${s.run}-a13-slot-blocked` },
    422)
  must(run, '维修设备新日期排产被拒（A3-3）', String(slotBlocked.body?.message ?? '').includes('A3-3'), JSON.stringify(slotBlocked.body?.message))

  // ---- 7) 复机（备件消耗 5 同事务 + 闭停机 + 置正常 + restored 事件） ----
  const spareBefore = sqlOne(`SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(s.uSpareId)} AND status = 'active'`)
  const restart = await httpStep(run, '复机关闭（备件消耗 5）',
    'POST', '/maintenance/orders/restart',
    { orderId: a13OrderId, responsible: '刘工', spareParts: [{ unitId: s.uSpareId, quantity: '5.0000' }], operationId: `${s.run}-a13-restart` },
    [200, 201])
  must(run, '复机成功（closed）', restart.body?.data?.status === 'closed', JSON.stringify(restart.body?.data))

  const spareRows = sqlStep(run, 'SQL：备件消耗对账（MT-11：消耗行引用 issue 流水 + 扣前/扣后 + 余额）',
    `SELECT t.movement_kind, t.before_qty::text, t.after_qty::text, u.stock_transaction_id::text = t.id::text,
       (SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(s.uSpareId)} AND status = 'active')
     FROM spare_part_usage u LEFT JOIN stock_transaction t ON t.id = u.stock_transaction_id
     WHERE u.order_id = ${q(a13OrderId)}`)
  must(run, `备件消耗记账：issue ${Number(spareBefore) - 5}→${Number(spareBefore) - 5 + 5}、余额 ${Number(spareBefore) - 5}、行引用同事务流水`,
    spareRows.length === 1 && spareRows[0][0] === 'issue' && eqQty(spareRows[0][1], spareBefore) && eqQty(spareRows[0][2], Number(spareBefore) - 5) &&
      spareRows[0][3] === 't' && eqQty(spareRows[0][4], Number(spareBefore) - 5),
    JSON.stringify({ spareBefore, spareRows }))

  const capPair = sqlStep(run, 'SQL：能力事件成对（down/restored）',
    `SELECT payload->>'changeKind', count(*) FROM outbox WHERE task_kind = 'maintenance.capacity-change' AND payload->>'orderId' = ${q(a13OrderId)} GROUP BY payload->>'changeKind'`)
  const capMap = Object.fromEntries(capPair.map((r) => [r[0], Number(r[1])]))
  must(run, '能力事件成对（MT-10/15）', capMap['down'] === 1 && capMap['restored'] === 1, JSON.stringify(capPair))

  // ---- 8) 修复后复检 pass 轮次（引用计划 v1 版本快照 + 关联工单）+ 超期消隐 ----
  const passRound = await httpStep(run, '修复后复检 pass（关联工单，仍引用 v1 快照）',
    'POST', '/maintenance/rounds',
    {
      planKey, version: 1, executedAt: `${today}T02:10:00Z`, shiftDate: today, result: 'pass',
      orderId: a13OrderId, reason: 'A13 验收修复后复检', operationId: `${s.run}-a13-round-pass`,
    },
    [200, 201])
  must(run, 'pass 轮次：无建议、关联工单、双存班次日', passRound.body?.data?.result === 'pass' && passRound.body?.data?.shiftDate === today, JSON.stringify(passRound.body?.data))

  // 计划 v2（检查项模板变更）→ 已执行轮次不回写（MT-12 版本快照）
  const v2 = await httpStep(run, '计划 v2（检查项模板扩展）',
    'POST', '/maintenance/plans/create-version',
    { equipmentCode: s.eqMtCode, planKey, kind: 'inspection', cycle: { everyDays: 3 }, checkItems: ['主轴承温度', '润滑油位', '异响目测', '联轴器对中'], effectiveFrom: today, reason: 'A13 计划版本化 v2', operationId: `${s.run}-a13-plan-v2` },
    [200, 201])
  must(run, '计划 v2 创建成功（版本推进）', v2.body?.data?.version === 2, JSON.stringify(v2.body?.data))

  const roundVer = sqlStep(run, 'SQL：轮次引用计划版本快照（v2 发布不回写已执行行）',
    `SELECT plan_version, result, order_id::text = ${q(a13OrderId)} FROM inspection_round WHERE plan_key = ${q(planKey)} ORDER BY executed_at`)
  must(run, '历史轮次仍绑 v1（计划配置变更不回写已执行记录）',
    roundVer.length === 2 && roundVer.every((r) => Number(r[0]) === 1) && roundVer[0][1] === 'fail' && roundVer[1][1] === 'pass' && roundVer[1][2] === 't',
    JSON.stringify(roundVer))

  const overdue2 = await httpStep(run, '复检后超期消隐（锚点=最近执行班次日 D，D+3 前不超期）',
    'GET', `/maintenance/plans/overdue?plantId=${plant}&equipmentId=${s.equipment[s.eqMtCode].id}&today=${today}`, undefined, 200)
  const overdueList2 = overdue2.body?.items ?? overdue2.body?.data?.items ?? []
  must(run, '超期消隐：执行后不再列入（提示随执行刷新）',
    !overdueList2.some((x) => x.planKey === planKey), JSON.stringify(overdueList2.map((x) => x.planKey)))

  // ---- 9) 排产恢复可见（A3-3 → 复机后 D+1 同载荷成功 + 设备视图 plannedTotal） ----
  const slotOk = await httpStep(run, `复机后 D+1 排产保存 → 成功`,
    'POST', '/scheduling/slots',
    { orderOperationId: s.orderCost.op1Id, equipmentId: s.equipment[s.eqMtCode].id, productionDate: tomorrow, plannedQty: '80.0000', operationId: `${s.run}-a13-slot-ok` },
    [200, 201])
  must(run, '复机后排产恢复（upserted）', slotOk.body?.data?.action === 'upserted', JSON.stringify(slotOk.body?.data))

  const deviceView = await httpStep(run, '设备视图（D+1 计划量可见）',
    'GET', `/scheduling/device-view?plantId=${plant}&workCenterId=${s.wcId}&equipmentId=${s.equipment[s.eqMtCode].id}`, undefined, 200)
  const dvEq = (deviceView.body?.equipments ?? [])[0]
  const dvCell = (dvEq?.cells ?? []).find((c) => c.productionDate === tomorrow)
  must(run, '排产恢复可见：D+1 plannedTotal=80', eqQty(dvCell?.plannedTotal, 80), JSON.stringify(dvCell))

  // ---- 10) 跨域四账对账 ----
  const eqFinal = sqlOne(`SELECT equipment_status FROM equipment WHERE id = ${q(s.equipment[s.eqMtCode].id)}`)
  const downtimeClosed = sqlOne(`SELECT count(*) FROM downtime_event WHERE order_id = ${q(a13OrderId)} AND end_at IS NOT NULL`)
  must(run, '余额对账：设备回正常(1)+停机闭口', Number(eqFinal) === 1 && Number(downtimeClosed) === 1, `eq=${eqFinal} closedDowntime=${downtimeClosed}`)

  const issueRows = sqlStep(run, 'SQL 四账二：备件单元 issue 流水累计',
    `SELECT count(*) FROM stock_transaction WHERE unit_id = ${q(s.uSpareId)} AND movement_kind = 'issue'`)
  must(run, '流水对账：issue 流水在册（A10+A13 累计）', Number(issueRows[0]?.[0]) >= 2, JSON.stringify(issueRows))

  const auditRows = sqlStep(run, 'SQL 四账四：A13 审计（计划/轮次/异常上报/工单闭环）',
    `SELECT action, count(*) FROM audit_entry WHERE action IN ('maintenance.plan.create-version','maintenance.inspection.record-round','maintenance.equipment.anomaly-report','maintenance.order.dispatch','maintenance.order.start','maintenance.order.finish-repair','maintenance.order.restart') AND actor = 'admin' GROUP BY action ORDER BY action`)
  const auditMap = Object.fromEntries(auditRows.map((r) => [r[0], Number(r[1])]))
  must(run, '审计对账：七类命令在册',
    (auditMap['maintenance.plan.create-version'] ?? 0) >= 2 && (auditMap['maintenance.inspection.record-round'] ?? 0) >= 2 &&
      (auditMap['maintenance.equipment.anomaly-report'] ?? 0) >= 1 && (auditMap['maintenance.order.dispatch'] ?? 0) >= 1 &&
      (auditMap['maintenance.order.start'] ?? 0) >= 1 && (auditMap['maintenance.order.finish-repair'] ?? 0) >= 1 &&
      (auditMap['maintenance.order.restart'] ?? 0) >= 1,
    JSON.stringify(auditRows))

  run.saveState()
  return run
}
