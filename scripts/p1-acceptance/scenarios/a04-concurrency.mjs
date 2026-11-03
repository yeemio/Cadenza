/**
 * A04 并发余额竞争（P1 REWORK 补差场景，对应 P1 README §3.3）：
 * 原量 100 m，两个并发操作分别要求 70 m、50 m——
 * - 恰一 COMMITTED（200）、恰一 409 ERR_INSUFFICIENT_STOCK（IT-14/30 行锁串行后实时校验）；
 * - 库无负数（余额=100−胜者量，全局无负余额行）；
 * - 被拒方同 operationId 重放返回原拒绝（回执原样回放，不重算不换结果）；
 * - 胜者同 operationId 重放不重复扣（issue 流水仍 1 行、余额不变）。
 * 通道：POST /inventory/issue（inventory.issue-material，控制器将余量竞争映射 409）。
 * 并发实现：两个裸 fetch 同令牌同时发出（lib.api 含登录串行逻辑，不用于并发窗口本身）。
 */
import { must, httpStep, sqlStep, sqlOne, q, UOM_M_ID, UOM_M, OWNER_NAME, api, login, API_BASE, ensureAdminPermissions } from '../lib.mjs'

export async function run(run) {
  run.setScenario('A04-CONC')
  const s = run.state
  // 每次执行唯一 nonce：同 tag 重跑（如测试清库后）不与历史回执/单元冲突
  const nonce = Date.now().toString(36)

  // 授权自足：sysadmin 合并 inventory.read/post（真实 /org/grants 命令，幂等）
  await ensureAdminPermissions(run, ['inventory.read', 'inventory.post'])

  // ---- 1) 竞争单元：直收 100m（qualified，物流成品仓 91010101）----
  const unitNo = `U-${s.run}-A04C-${nonce}`
  const recv = await httpStep(run, `竞争单元直收：${unitNo} 100m`,
    'POST', '/inventory/receive',
    {
      plantId: s.szPlantId, lotNo: `LOT-${s.run}-A04C-${nonce}`, unitNo,
      materialId: s.mat['MAT-P1-RAW'], materialCode: 'MAT-P1-RAW',
      uomId: UOM_M_ID, uomCode: UOM_M, quantity: '100.0000', measurementBasis: 'nominal',
      locationId: s.loc.sz9101['91010101'], locationCode: '91010101',
      ownerId: s.entId, ownerName: OWNER_NAME, qualityStatus: 'qualified',
      operationId: `${s.run}-a04c-recv-${nonce}`,
    },
    [200, 201])
  const unitId = recv.body?.data?.unitId ?? null
  must(run, '竞争单元就绪（100m qualified 在库）', Boolean(unitId), JSON.stringify(recv.body?.data))

  // ---- 2) 并发两请求：70 / 50 同单元同时发（不同 operationId）----
  const op70 = `${s.run}-a04c-70-${nonce}`
  const op50 = `${s.run}-a04c-50-${nonce}`
  const token = await login('admin')
  const fire = (quantity, operationId) =>
    fetch(`${API_BASE}/inventory/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ unitId, quantity, reason: `P1 并发余额竞争（申请 ${quantity}m）`, operationId }),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))

  await api('GET', '/auth/me') // 预热（不进并发窗口）
  const [r70, r50] = await Promise.all([fire('70.0000', op70), fire('50.0000', op50)])
  run.log('http', '并发两请求（70/50 同单元）结果对', true,
    `70m→${r70.status}（${r70.body?.code ?? r70.body?.data?.afterQty ?? ''}） ; 50m→${r50.status}（${r50.body?.code ?? r50.body?.data?.afterQty ?? ''}）`)

  const committed = (r) => r.status === 200 || r.status === 201 // issue 路由提交成功缺省 201
  const winner = committed(r70) ? { res: r70, qty: 70, op: op70, replayQty: '70.0000' }
    : { res: r50, qty: 50, op: op50, replayQty: '50.0000' }
  const loser = committed(r70) ? { res: r50, qty: 50, op: op50, replayQty: '50.0000' }
    : { res: r70, qty: 70, op: op70, replayQty: '70.0000' }
  must(run, '恰一 COMMITTED（200/201）、恰一 409 ERR_INSUFFICIENT_STOCK',
    committed(r70) !== committed(r50) &&
      [r70, r50].some((r) => r.status === 409 && r.body?.code === 'ERR_INSUFFICIENT_STOCK'),
    JSON.stringify({ r70: { status: r70.status, code: r70.body?.code }, r50: { status: r50.status, code: r50.body?.code } }))

  // ---- 3) 库无负数：单元余额 = 100 − 胜者量；全局负余额行为 0 ----
  const bal = sqlOne(`SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(unitId)} AND status = 'active'`)
  const negAll = sqlOne(`SELECT count(*) FROM stock_balance WHERE quantity < 0`)
  must(run, `余额恰为胜者扣后（100−${winner.qty}=${100 - winner.qty}）且库无负数（全局负余额行=${negAll}）`,
    Number(bal) === 100 - winner.qty && Number(negAll) === 0, `balance=${bal} negativeRows=${negAll}`)

  // ---- 4) 被拒方同键重放：返回原拒绝（同 code/同 message，不重算）----
  const loserReplay = await fire(loser.replayQty, loser.op)
  must(run, '被拒方同 operationId 重放返回原拒绝（409 同码同文案）',
    loserReplay.status === 409 && loserReplay.body?.code === 'ERR_INSUFFICIENT_STOCK' &&
      loserReplay.body?.message === loser.res.body?.message,
    `replay=${JSON.stringify(loserReplay.body)} original=${JSON.stringify(loser.res.body)}`)

  // ---- 5) 胜者同键重放：返回原结果，不重复扣 ----
  const winnerReplay = await fire(winner.replayQty, winner.op)
  const issueLines = sqlOne(`SELECT count(*) FROM stock_transaction WHERE unit_id = ${q(unitId)} AND movement_kind = 'issue'`)
  const balAfterReplay = sqlOne(`SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(unitId)} AND status = 'active'`)
  must(run, '胜者同 operationId 重放不重复扣（回原结果、issue 流水仍 1 行、余额不变）',
    committed(winnerReplay) && winnerReplay.body?.data?.afterQty === winner.res.body?.data?.afterQty &&
      Number(issueLines) === 1 && Number(balAfterReplay) === 100 - winner.qty,
    `replay.afterQty=${winnerReplay.body?.data?.afterQty} issueLines=${issueLines} balance=${balAfterReplay}`)

  // ---- 6) 底账：两命令回执各 1 行（失败侧也有幂等底账）----
  sqlStep(run, 'SQL：两并发命令回执（各 1 行，失败侧 status=BUSINESS_REJECTION）',
    `SELECT operation_id, status FROM command_receipt WHERE operation_id IN (${q(op70)}, ${q(op50)}) ORDER BY operation_id`)
  const receipts = sqlOne(
    `SELECT count(*) FROM command_receipt WHERE operation_id IN (${q(op70)}, ${q(op50)})`)
  must(run, '两命令回执各 1 行（合计 2，重放不新增）', Number(receipts) === 2, `receipts=${receipts}`)

  run.saveState()
  return run
}
