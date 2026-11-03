#!/usr/bin/env node
/**
 * 试点进入条件与影子→正式切换退出标准检查（T27，DO-26～DO-32）。
 *
 * 输入：--records DIR（试点记录目录，格式见 deploy/pilot/PILOT-GUIDE.md）
 * 模式：
 *   --check                 校验记录并输出 退出标准逐项判定（DO-29 ①～⑤）
 *   --append-record '<json>' 追加一条试点事件到账本（DO-27：不可删；哈希链+锚文件）
 *
 * 规则：
 * - DO-26 进入条件：具名工厂与数据授权书；derived_from_prd=true（从 PRD 公司名称/文档提及推导）即拒绝；
 * - DO-27 试点记录：账本链完整（含尾部截断锚），失败/绕行事件必须有处置；按五元组口径登记（DO-25）；
 * - DO-28 双轨＝记录并行＋对账，不是双主账：须有单写入方声明与旧系统停止记账承诺；
 * - DO-29 五条退出标准全部满足方可切换；
 * - DO-31 业务接受记录具名（接受人、范围、保留项、边界、观察周期）；
 * - DO-32 无授权边界：授权缺失/无效时一切按 SITE_PENDING 报告，不产生任何 PASS 冒充。
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { appendRecord, ledgerHead, verifyLedger } from './lib/ledger.mjs'
import { nowIso } from './lib/util.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]?.replace(/^--/, '')
    if (!key) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      i += 1
    } else {
      args[key] = ''
    }
  }
  return args
}

async function readJson(file) {
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, 'utf8'))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const recordsDir = args['records']
  if (!recordsDir) {
    console.error('用法：pilot-exit-check.mjs --records DIR [--check | --append-record <json>]')
    process.exit(2)
  }

  const ledgerPath = path.join(recordsDir, 'pilot-ledger.jsonl')
  const anchorPath = path.join(recordsDir, 'ledger-anchor.json')

  if (args['append-record'] !== undefined) {
    const record = JSON.parse(args['append-record'])
    for (const field of ['playbook_id', 'position_id', 'task', 'outcome']) {
      if (record[field] === undefined) {
        console.error(`[DO-27] 试点事件缺字段 ${field}（五元组口径见 PILOT-GUIDE）`)
        process.exit(2)
      }
    }
    if ((record.outcome === 'failure' || record.outcome === 'manual_workaround') && !record.disposition) {
      console.error('[DO-27] 失败/绕行事件必须带处置（disposition）；未记录绕行的试点证据不合格')
      process.exit(2)
    }
    const entry = await appendRecord(ledgerPath, record)
    const head = await ledgerHead(ledgerPath)
    await writeFile(anchorPath, `${JSON.stringify(head, null, 2)}\n`, 'utf8')
    console.log(`[DO-27] 已追加试点事件 seq=${String(entry.seq)}；账本锚已更新（count=${String(head.count)}）`)
    return
  }

  // --check
  const authorization = await readJson(path.join(recordsDir, 'authorization.json'))
  const ledger = await verifyLedger(ledgerPath)
  const anchor = await readJson(anchorPath)
  const singleWriter = await readJson(path.join(recordsDir, 'single-writer.json'))
  const initialRecon = await readJson(path.join(recordsDir, 'initial-reconciliation.json'))
  const ifaceRecon = await readJson(path.join(recordsDir, 'interface-reconciliation.json'))
  const drillRef = await readJson(path.join(recordsDir, 'drill-reference.json'))
  const switchPlan = await readJson(path.join(recordsDir, 'switch-plan.json'))
  const acceptance = await readJson(path.join(recordsDir, 'acceptance.json'))

  const lines = []
  const emit = (s) => {
    lines.push(s)
    console.log(s)
  }
  let hardFail = false

  emit(`# 试点退出标准检查（DO-26～32）时间=${nowIso()}`)
  emit('')

  // DO-26 进入条件（授权是一切的前提）
  let entryOk = false
  if (!authorization || !authorization.factory || !authorization.data_authorization_doc) {
    emit('- [DO-26] 进入条件：FAIL——无具名工厂/数据授权书记录')
    hardFail = true
  } else if (authorization.derived_from_prd === true) {
    emit(`- [DO-26] 进入条件：FAIL——授权记录声明 derived_from_prd（不得从 PRD 公司名称（河北华通）或文档提及推导接入授权，GAP-E34）`)
    hardFail = true
  } else {
    entryOk = true
    emit(`- [DO-26] 进入条件：PASS——工厂=${authorization.factory}；授权书=${authorization.data_authorization_doc}（${String(authorization.authorization_date ?? '')}）`)
  }

  // DO-32 无授权边界：授权无效即全部 SITE_PENDING，不产生 PASS
  if (!entryOk) {
    emit('')
    emit('## 按 DO-32：授权未到位，试点/切换项全部 SITE_PENDING／BLOCKED_EXTERNAL——不删除等待项、不另造第四功能包、不以 mock 伪造 SITE_ACCEPT。')
    await writeFile(path.join(recordsDir, `exit-criteria-${nowIso().replace(/[:.]/g, '-')}.md`), lines.join('\n'), 'utf8')
    process.exit(3)
  }

  // DO-27 记录完整性（链+锚+处置）
  let recordsOk = false
  const ledgerEvents = []
  if (!ledger.ok) {
    emit(`- [DO-27] 试点记录：FAIL——账本链断裂（${String(ledger.reason)}，断点 seq=${String(ledger.brokenAtSeq)}）；绕行记录不可删`)
    hardFail = true
  } else if (anchor && ledger.count < anchor.count) {
    emit(`- [DO-27] 试点记录：FAIL——账本条数 ${String(ledger.count)} 少于锚 ${String(anchor.count)}（尾部截断）`)
    hardFail = true
  } else {
    const text = await readFile(ledgerPath, 'utf8')
    for (const line of text.split('\n').filter((l) => l.trim() !== '')) {
      ledgerEvents.push(JSON.parse(line).record)
    }
    const missingDisposition = ledgerEvents.filter(
      (e) => (e.outcome === 'failure' || e.outcome === 'manual_workaround') && !e.disposition)
    if (missingDisposition.length > 0) {
      emit(`- [DO-27] 试点记录：FAIL——${String(missingDisposition.length)} 条失败/绕行事件无处置记录`)
      hardFail = true
    } else {
      recordsOk = true
      const completed = ledgerEvents.filter((e) => e.outcome === 'completed_in_system').length
      const workaround = ledgerEvents.filter((e) => e.outcome === 'manual_workaround').length
      const failure = ledgerEvents.filter((e) => e.outcome === 'failure').length
      emit(`- [DO-27] 试点记录：PASS——事件 ${String(ledgerEvents.length)} 条（系统内完成 ${String(completed)}／人工绕行 ${String(workaround)}／失败 ${String(failure)}），失败与绕行全部有处置；账本链+锚完整`)
    }
  }

  // DO-28 双轨（单写入方）
  const dualTrackOk = singleWriter !== null
    && (singleWriter.ledger_owner === 'MOM' || singleWriter.ledger_owner === 'legacy')
    && singleWriter.legacy_stop_booking_commitment === true
  emit(`- [DO-28] 双轨核对：${dualTrackOk ? `PASS——单写入方=${String(singleWriter?.ledger_owner)}，旧系统停止记账承诺已登记（记录并行+对账，非双主账）` : 'FAIL——缺单写入方声明或旧系统停止记账承诺'}`)
  if (!dualTrackOk) hardFail = true

  // DO-29 ①～⑤
  const c1 = recordsOk && ledgerEvents.length > 0
  emit(`- [DO-29①] 约定范围剧本全部可执行（失败有处置/豁免）：${c1 ? 'PASS' : 'FAIL——无剧本执行事件或记录不合格'}`)
  const c2 = initialRecon !== null && (initialRecon.final_state === 'zero_diff'
    || (initialRecon.final_state === 'accepted' && initialRecon.accepted_by))
  emit(`- [DO-29②] 期初对账差异清零或业务负责人书面接受：${c2 ? `PASS（${String(initialRecon?.final_state)}${initialRecon?.accepted_by ? `，接受人 ${String(initialRecon.accepted_by)}` : ''}）` : 'FAIL/PENDING——缺期初对账结论记录'}`)
  const c3 = ifaceRecon !== null && ifaceRecon.all_explained === true
  emit(`- [DO-29③] 外部接口对账差异可解释：${c3 ? 'PASS' : `FAIL/PENDING——${ifaceRecon ? `未解释 ${String((ifaceRecon.unexplained ?? []).length)} 项` : '缺接口对账记录'}`}`)
  const c4 = drillRef !== null && drillRef.result === 'PASS' && drillRef.drill_record
  emit(`- [DO-29④] 恢复演练（DO-16）通过：${c4 ? `PASS（演练记录 ${String(drillRef.drill_record)}）` : 'FAIL/PENDING——缺通过态演练记录引用'}`)
  const c5 = switchPlan !== null && switchPlan.window && switchPlan.restore_source && switchPlan.rollback_plan && switchPlan.approved_by
  emit(`- [DO-29⑤] 切换窗口、恢复源与回退方案获批：${c5 ? `PASS（窗口 ${String(switchPlan.window)}，批准人 ${String(switchPlan.approved_by)}）` : 'FAIL/PENDING——缺获批切换方案'}`)

  const exitMet = c1 && c2 && c3 && c4 && c5
  emit('')
  emit(`## 结论：影子→正式切换退出标准 ${exitMet ? '全部满足（方可按 DO-30 执行切换：冻结点→期初导入核对→增量补齐→开账；不能从测试环境推导生产就绪）' : '未全部满足——未通过项处置完毕并复检后方可切换'}`)

  // DO-31 业务接受（切换后）
  const acceptanceOk = acceptance !== null && acceptance.accepter && acceptance.scope
      && Array.isArray(acceptance.reservations) && acceptance.observation_period_days
  emit(`- [DO-31] 业务接受记录：${acceptanceOk ? `PASS（接受人 ${String(acceptance.accepter)}，范围 ${String(acceptance.scope)}，观察周期 ${String(acceptance.observation_period_days)} 天）` : 'PENDING——切换后由真实岗位完成约定业务后具名登记；未提供的现场条件明确保留，不冒充接受'}`)

  const reportPath = path.join(recordsDir, `exit-criteria-${nowIso().replace(/[:.]/g, '-')}.md`)
  await writeFile(reportPath, lines.join('\n'), 'utf8')
  emit(`报告：${reportPath}`)

  if (hardFail || !exitMet) process.exitCode = 1
}

main().catch((error) => {
  console.error('试点退出检查失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})
