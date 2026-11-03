/**
 * A05 倒轴/分盘/分托/轴号修正（rework 域，P2-A/T15）：
 * - 倒轴守恒（RS-01/07：原量=子段Σ+留存+损耗，SQL 断言 1,000=600+390+10）；
 * - 带客户轴号全量倒出约束（RS-05：两条独立拒绝——必须全量、只能一条）；
 * - 回撤受阻（RS-12：子段被投料消耗后冲销被拒，A11 可解释原因）；
 * - 分托→解绑（RS-13③/17/19/20/23：装入即锁定、非车间须选库位、确认改绑+移库、
 *   解绑清托码位置不变）；
 * - 轴号修正核权重分配（RS-27/30/29/32：占用轴号需权限+强制理由、清占用+改值+扣减、回撤恢复）。
 */
import { must, httpStep, sqlStep, sqlOne, sql, q, eqQty, receiveUnit, seedAxisState, unitIdOf, ensureAdminPermissions, api } from '../lib.mjs'

export async function run(run) {
  run.setScenario('A05')
  const s = run.state
  const plant = s.szPlantId
  const lineLoc = s.loc.whLine
  const lineLocCode = s.loc.whLineCode
  // 本场景起始时刻：审计对账按此收窄（共享 dev 库被全量测试重置后无历史残行，
  // 原按 actor 全表计数依赖 R1–R3 累积行，净库单 run 永不成立——P23FIX-R1 实测后自足化）
  const auditSince = new Date().toISOString()
  await ensureAdminPermissions(run) // 场景自足：并行会话 seed 可能中途重置授权
  // szws01 车间操作人授权重放（新键真实执行；setup 已授过一次，此处防中途重置）
  {
    const wsUserId = sqlOne(`SELECT id FROM user_account WHERE login_name = 'szws01'`)
    await api('POST', '/org/grants', {
      principalType: 'user', principalId: wsUserId, scopeType: 'plant', scopeObjectId: plant,
      permissions: ['rework.read', 'rework.post'],
      reason: `P2/P3 验收（${s.run}）：车间操作人分托命令授权（a05 重放）`,
      operationId: `${s.run}-a05-grant-szws01-${Date.now()}`,
    })
  }

  // ================================================================
  // 1) 倒轴守恒（RS-01/07 + A05 样例：1,000 = 600 + 390 + 10 损耗）
  // ================================================================
  const src1 = `AE${s.run}-S1`
  await receiveUnit(run, `倒轴源收货 ${src1}（1,000 M 合格，线边）`, {
    plantId: plant, unitNo: src1, materialId: s.mat['MAT-P23-FIN'], materialCode: 'MAT-P23-FIN',
    locationId: lineLoc, locationCode: lineLocCode,
  })
  const scan1 = await httpStep(run, '倒出轴扫码查询（RS-03 只读）',
    'GET', `/rework/reel-split/scan?plantId=${plant}&unitNo=${encodeURIComponent(src1)}`, undefined, 200)
  must(run, '扫码返回同码合计基数 1,000、无客户轴号不强制全量',
    eqQty(scan1.body?.balanceQty, 1000) && scan1.body?.requireFullPour === false, JSON.stringify(scan1.body))

  const split1 = await httpStep(run, '倒轴执行：600 + 390 + 10 损耗（RS-01 守恒样例）',
    'POST', '/rework/reel-split/execute',
    {
      sourceUnitNo: src1,
      pourLines: [{ unitNo: `${src1}-T1`, quantity: '600.0000' }, { unitNo: `${src1}-T2`, quantity: '390.0000' }],
      lossQty: '10.0000', lossReason: '端头损耗',
      operationId: `${s.run}-a05-split1`,
    },
    [200, 201])
  const order1 = split1.body?.data?.orderId ?? null
  s.a05 = { order1 }
  must(run, '倒轴执行成功且源扣尽关闭', split1.body?.data?.sourceAfterQty === '0.0000' && split1.body?.data?.sourceBalanceClosed === true, JSON.stringify(split1.body?.data))

  // SQL 守恒对账：original = Σ子段 + retained + loss（四列直读 + 子段余额）
  const consRows = sqlStep(run, 'SQL 守恒对账：主表四列 + 子段余额 + 留存',
    `SELECT o.original_qty::text, o.retained_qty::text, o.loss_qty::text,
       (SELECT COALESCE(SUM(quantity),0)::text FROM reel_split_line l JOIN inventory_unit u ON u.unit_no = l.target_unit_no AND u.plant_id = o.plant_id WHERE l.order_id = o.id),
       (SELECT COALESCE(SUM(b.quantity),0)::text FROM stock_balance b WHERE b.unit_id = (SELECT id FROM inventory_unit WHERE plant_id = o.plant_id AND unit_no = o.source_unit_no) AND b.status = 'active')
     FROM reel_split_order o WHERE o.id = ${q(order1)}`)
  const [orig, retained, loss, childSum, srcRemain] = consRows[0] ?? []
  must(run, 'RS-01 守恒（SQL）：原量 1,000 = 子段Σ 990 + 留存 0 + 损耗 10',
    eqQty(orig, 1000) && eqQty(childSum, 990) && eqQty(retained, 0) && eqQty(loss, 10) && eqQty(Number(retained) + Number(childSum) + Number(loss), Number(orig)),
    `original=${orig} childSum=${childSum} retained=${retained} loss=${loss} srcActiveRemain=${srcRemain}`)

  const t1Bal = sqlOne(`SELECT quantity::text FROM stock_balance b JOIN inventory_unit u ON u.id = b.unit_id WHERE u.unit_no = ${q(`${src1}-T1`)} AND b.status = 'active'`)
  const t2Bal = sqlOne(`SELECT quantity::text FROM stock_balance b JOIN inventory_unit u ON u.id = b.unit_id WHERE u.unit_no = ${q(`${src1}-T2`)} AND b.status = 'active'`)
  must(run, '子轴生成 600/390（RS-09 倒入侧码数量）', eqQty(t1Bal, 600) && eqQty(t2Bal, 390), `T1=${t1Bal} T2=${t2Bal}`)

  const src1Status = sqlOne(`SELECT status FROM inventory_unit WHERE unit_no = ${q(src1)} AND plant_id = ${q(plant)}`)
  const edges = sqlOne(`SELECT count(*) FROM genealogy_edge ge WHERE ge.edge_kind = 'consumption' AND ge.from_id = ${q(unitIdOf(plant, src1))}`)
  must(run, 'RS-10 扣尽关闭不删档（exhausted + 档案行在）+ 谱系 2 边（IT-34 同族）',
    src1Status === 'exhausted' && Number(edges) === 2, `status=${src1Status} edges=${edges}`)

  // 守恒拒绝反例：倒入合计+损耗超过原量（RS-02）
  const src1b = `AE${s.run}-S1B`
  await receiveUnit(run, `倒轴反例源收货 ${src1b}（1,000 M，线边）`, {
    plantId: plant, unitNo: src1b, materialId: s.mat['MAT-P23-FIN'], materialCode: 'MAT-P23-FIN',
    locationId: lineLoc, locationCode: lineLocCode,
  })
  const over = await httpStep(run, '守恒拒绝：倒入 600+391+损耗 10 > 1,000 → 422 [RS-02]',
    'POST', '/rework/reel-split/execute',
    {
      sourceUnitNo: src1b,
      pourLines: [{ unitNo: `${src1b}-T1`, quantity: '600.0000' }, { unitNo: `${src1b}-T2`, quantity: '391.0000' }],
      lossQty: '10.0000', lossReason: '端头损耗',
      operationId: `${s.run}-a05-split-over`,
    },
    422)
  must(run, '守恒拒绝（RS-02）', String(over.body?.message ?? '').includes('RS-02'), JSON.stringify(over.body?.message))

  // ================================================================
  // 2) 带客户轴号：必须全量倒出且只能一条（RS-05 两条独立拒绝）
  // ================================================================
  const src2 = `AF${s.run}-S2`
  await receiveUnit(run, `客户轴段源收货 ${src2}（1,000 M，线边）`, {
    plantId: plant, unitNo: src2, materialId: s.mat['MAT-P23-FIN'], materialCode: 'MAT-P23-FIN',
    locationId: lineLoc, locationCode: lineLocCode,
  })
  seedAxisState(unitIdOf(plant, src2), src2, `SO-${s.run}-009`, 'KZH-P23-9', '600', '9')
  const scan2 = await httpStep(run, '带客户轴号源扫码（RS-05 标志）',
    'GET', `/rework/reel-split/scan?plantId=${plant}&unitNo=${encodeURIComponent(src2)}`, undefined, 200)
  must(run, '扫码返回 requireFullPour=true 且 requireSingleLine=true',
    scan2.body?.requireFullPour === true && scan2.body?.requireSingleLine === true, JSON.stringify(scan2.body))

  const twoLines = await httpStep(run, 'RS-05 拒绝一：全量但两条倒入 → 422',
    'POST', '/rework/reel-split/execute',
    {
      sourceUnitNo: src2,
      pourLines: [{ unitNo: `${src2}-T1`, quantity: '600.0000' }, { unitNo: `${src2}-T2`, quantity: '400.0000' }],
      lossQty: '0.0000', operationId: `${s.run}-a05-rs5-two`,
    },
    422)
  must(run, '带客户轴号两条倒入被拒（RS-05 只能一条）', String(twoLines.body?.message ?? '').includes('RS-05'), JSON.stringify(twoLines.body?.message))

  const partial = await httpStep(run, 'RS-05 拒绝二：单条但非全量（600 ≠ 1,000）→ 422',
    'POST', '/rework/reel-split/execute',
    { sourceUnitNo: src2, pourLines: [{ unitNo: `${src2}-T1`, quantity: '600.0000' }], lossQty: '0.0000', operationId: `${s.run}-a05-rs5-partial` },
    422)
  must(run, '带客户轴号部分倒出被拒（RS-05 必须全量）', String(partial.body?.message ?? '').includes('RS-05'), JSON.stringify(partial.body?.message))

  const full = await httpStep(run, 'RS-05 正例：单条全量 1,000 倒出 → 成功',
    'POST', '/rework/reel-split/execute',
    { sourceUnitNo: src2, pourLines: [{ unitNo: `${src2}-TF`, quantity: '1000.0000' }], lossQty: '0.0000', operationId: `${s.run}-a05-rs5-full` },
    [200, 201])
  must(run, '单条全量倒出成功', Boolean(full.body?.data?.orderId), JSON.stringify(full.body?.data))

  // ================================================================
  // 3) 回撤受阻（RS-12：子段被消耗后冲销被拒——A11 可解释原因）
  // ================================================================
  const src3 = `AE${s.run}-S3`
  await receiveUnit(run, `回撤受阻源收货 ${src3}（1,000 M，线边）`, {
    plantId: plant, unitNo: src3, materialId: s.mat['MAT-P23-FIN'], materialCode: 'MAT-P23-FIN',
    locationId: lineLoc, locationCode: lineLocCode,
  })
  const split3 = await httpStep(run, '倒轴：600 + 390 + 10 损耗（回撤受阻用）',
    'POST', '/rework/reel-split/execute',
    {
      sourceUnitNo: src3,
      pourLines: [{ unitNo: `${src3}-C1`, quantity: '600.0000' }, { unitNo: `${src3}-C2`, quantity: '390.0000' }],
      lossQty: '10.0000', lossReason: '端头损耗',
      operationId: `${s.run}-a05-split3`,
    },
    [200, 201])
  const order3 = split3.body?.data?.orderId ?? null
  const c1Id = unitIdOf(plant, `${src3}-C1`)

  // 子段经真实投料命令消耗（D-1 修复后链路：线边合格单元可投料）
  const feed = await httpStep(run, '子段 C1 投料消耗（真实 POST /execution/feeds → FEED 订单）',
    'POST', '/execution/feeds',
    {
      orderId: s.orderFeed.orderId, orderOperationId: s.orderFeed.op1Id,
      lines: [{
        unitId: c1Id, quantity: '600.0000', salesOrderNo: `SO-${s.run}-001`, salesLineNo: '10',
        confirmed: true, deviationReason: 'P23 验收：倒轴子段投料（RS-12 下游事实构造）',
      }],
      operationId: `${s.run}-a05-feed-c1`,
    },
    [200, 201])
  must(run, '子段投料成功', Boolean(feed.body?.data), JSON.stringify(feed.body?.data ?? feed.body))
  const issueTx = sqlOne(`SELECT count(*) FROM stock_transaction WHERE unit_id = ${q(c1Id)} AND movement_kind = 'issue'`)
  must(run, '子段 issue 流水在册（被消耗事实）', Number(issueTx) >= 1, `issue=${issueTx}`)

  const blocked = await httpStep(run, '冲销被拒：子段已消费 → 422 [RS-12]',
    'POST', '/rework/reel-split/reverse',
    { sourceOrderId: order3, reason: 'P23 验收：子段已消费冲销反证', operationId: `${s.run}-a05-rev-blocked` },
    422)
  must(run, '回撤受阻（RS-12 可解释原因）', String(blocked.body?.message ?? '').includes('RS-12'), JSON.stringify(blocked.body?.message))
  const stillThere = sqlOne(`SELECT count(*) FROM reel_split_reversal WHERE source_order_id = ${q(order3)}`)
  must(run, '受阻冲销不留冲销事实行', Number(stillThere) === 0, `reversals=${stillThere}`)

  // ================================================================
  // 4) 分托 → 解绑（RS-13③/17/19/20/23；admin=非车间：在库可扫、确认前须选库位）
  // ================================================================
  // 环境残留清理（dev 库语义）：分托任务「同操作人同类型进行中唯一」（RS-14）——本验收系列
  // 脚本此前失败轮次可能为 admin 留下进行中任务，占位会导致新任务复用旧扫入行而触发
  // [RS-22] 跨仓拒绝。将 admin 的进行中分托/解绑任务置 abandoned（仅清脚本自身工作文档，
  // 不触碰任何业务事实行）。
  sqlStep(run, 'SQL：清理本脚本系列残留的 admin 进行中分托任务（RS-14 占位）',
    `UPDATE pallet_task SET status = 'abandoned'
     WHERE operator = 'admin' AND status = 'in_progress'
       AND task_no LIKE 'PT-%'
     RETURNING task_no, task_type`)
  // 同步释放其残留作业预留（IT-23 释放记录语义；holder_ref=任务号）
  sqlStep(run, 'SQL：释放残留分托锁定（reservation → released）',
    `UPDATE reservation SET status = 'released', released_at = now(), released_by = 'p23-acceptance',
       release_reason = '验收脚本残留分托任务清理释放'
     WHERE status = 'active' AND holder_type = 'task' AND holder_ref IN (
       SELECT task_no FROM pallet_task WHERE status = 'abandoned' AND operator = 'admin')
     RETURNING id`)
  const pltCode = `PLT-${s.run}-A`
  const scanTarget = await httpStep(run, '分托：扫分入托码（新托）',
    'POST', '/rework/pallet/scan-target', { carrierCode: pltCode, operationId: `${s.run}-a05-plt-target` }, [200, 201])
  must(run, '新托判定 + 任务建立', scanTarget.body?.data?.palletKind === 'new', JSON.stringify(scanTarget.body?.data))

  await httpStep(run, '分托：扫料品码（A05 子段 TF，装入即锁定 RS-17）',
    'POST', '/rework/pallet/scan-item', { taskType: 'split_pallet', unitNo: `${src2}-TF`, operationId: `${s.run}-a05-plt-item` }, [200, 201])
  const tfUnitId = unitIdOf(plant, `${src2}-TF`)
  const resv = sqlStep(run, 'SQL：装入即锁定（reservation 四要素 RS-S4）',
    `SELECT holder_type, holder_ref, status FROM reservation WHERE unit_id = ${q(tfUnitId)} ORDER BY acquired_at DESC LIMIT 1`)
  must(run, '锁定落 reservation（holder_type=task、active）', resv[0]?.[0] === 'task' && resv[0]?.[2] === 'active', JSON.stringify(resv))

  const confirmNoLoc = await httpStep(run, '非车间未选库位确认 → 422 [RS-19]',
    'POST', '/rework/pallet/confirm', { taskType: 'split_pallet', operationId: `${s.run}-a05-plt-confirm-noloc` }, 422)
  must(run, '未选库位确认被拒（RS-19）', String(confirmNoLoc.body?.message ?? '').includes('RS-19'), JSON.stringify(confirmNoLoc.body?.message))

  await httpStep(run, '非车间选库位（普通仓 9xxx0101）',
    'POST', '/rework/pallet/set-location',
    { locationId: s.loc.whMain, locationCode: s.loc.whMainCode, warehouseId: s.wh.whMain, operationId: `${s.run}-a05-plt-setloc` },
    [200, 201])
  const confirm = await httpStep(run, '分托确认（RS-20：改绑托码+改仓库/货架/库位+解除锁定+已完成）',
    'POST', '/rework/pallet/confirm', { taskType: 'split_pallet', operationId: `${s.run}-a05-plt-confirm` }, [200, 201])
  must(run, '分托确认成功', Boolean(confirm.body?.data), JSON.stringify(confirm.body?.data))

  const bindRows = sqlStep(run, 'SQL：组托绑定 + 位置迁移 + 锁定释放 + 任务完成',
    `SELECT (SELECT count(*) FROM carrier_binding cb JOIN carrier c ON c.id = cb.carrier_id WHERE cb.unit_id = ${q(tfUnitId)} AND c.carrier_code = ${q(pltCode)} AND cb.effective_to IS NULL),
       (SELECT l.code FROM stock_balance b JOIN storage_location l ON l.id = b.location_id WHERE b.unit_id = ${q(tfUnitId)} AND b.status = 'active'),
       (SELECT count(*) FROM reservation WHERE unit_id = ${q(tfUnitId)} AND status = 'active'),
       (SELECT status FROM pallet_task WHERE id = ${q(scanTarget.body?.data?.taskId)})`)
  must(run, 'RS-20 执行后：绑定成立 + 位置迁普通仓 + 锁定释放 + 任务已完成',
    Number(bindRows[0]?.[0]) === 1 && bindRows[0]?.[1] === s.loc.whMainCode && Number(bindRows[0]?.[2]) === 0 && bindRows[0]?.[3] === 'completed',
    JSON.stringify(bindRows))

  // 解绑（RS-22/23：清托码、位置不变；车间/非车间校验相同、均不需托码与库位）——
  // 车间分叉由车间操作人 szws01 承载（RS-13① 车间人员的码不得在仓库：解绑对象须在
  // 非仓库位；非车间操作人解绑见验收报告 O-2 登记——set-location 仅支持分托任务，
  // 非车间解绑确认无法满足选库位前置）。
  const unbindUnit = `AP${s.run}-U2`
  await receiveUnit(run, `解绑用单元收货 ${unbindUnit}（1,000 M，线边）`, {
    plantId: plant, unitNo: unbindUnit, materialId: s.mat['MAT-P23-FIN'], materialCode: 'MAT-P23-FIN',
    locationId: lineLoc, locationCode: lineLocCode,
  })
  const unbindUnitId = unitIdOf(plant, unbindUnit)
  // 组托事实造数（carrier + carrier_binding；rework 线 tests 同款环境事实——分托解绑前置）
  const pltBind = `PLT-${s.run}-B`
  sql(
    `INSERT INTO carrier (carrier_code, carrier_kind, status, plant_id, enterprise_id, created_by)
     VALUES (${q(pltBind)}, 'tray', 'in_service', ${q(plant)}, ${q(s.entId)}, 'p23-acceptance')
     ON CONFLICT DO NOTHING`,
  )
  sql(
    `INSERT INTO carrier_binding (carrier_id, unit_id, effective_from, plant_id, enterprise_id, created_by)
     SELECT c.id, ${q(unbindUnitId)}, now(), ${q(plant)}, ${q(s.entId)}, 'p23-acceptance'
     FROM carrier c WHERE c.carrier_code = ${q(pltBind)} AND c.plant_id = ${q(plant)}
       AND NOT EXISTS (SELECT 1 FROM carrier_binding cb WHERE cb.carrier_id = c.id AND cb.unit_id = ${q(unbindUnitId)} AND cb.effective_to IS NULL)`,
  )
  const bindBefore = sqlOne(
    `SELECT count(*) FROM carrier_binding cb JOIN carrier c ON c.id = cb.carrier_id WHERE cb.unit_id = ${q(unbindUnitId)} AND c.carrier_code = ${q(pltBind)} AND cb.effective_to IS NULL`,
  )
  must(run, '解绑对象已组托（造数绑定成立）', Number(bindBefore) === 1, `binding=${bindBefore}`)

  await httpStep(run, '解绑：车间操作人扫料品码（unbind_pallet，szws01）',
    'POST', '/rework/pallet/scan-item',
    { taskType: 'unbind_pallet', unitNo: unbindUnit, operationId: `${s.run}-a05-unbind-item` },
    [200, 201], { user: 'szws01' })
  const unbind = await httpStep(run, '解绑确认（车间：清托码、仓库/货架/库位不变 RS-23）',
    'POST', '/rework/pallet/confirm',
    { taskType: 'unbind_pallet', operationId: `${s.run}-a05-unbind-confirm` },
    [200, 201], { user: 'szws01' })
  must(run, '解绑确认成功', Boolean(unbind.body?.data), JSON.stringify(unbind.body?.data))
  const afterUnbind = sqlStep(run, 'SQL：解绑后绑定清空 + 位置不变（仍线边）',
    `SELECT (SELECT count(*) FROM carrier_binding WHERE unit_id = ${q(unbindUnitId)} AND effective_to IS NULL),
       (SELECT l.code FROM stock_balance b JOIN storage_location l ON l.id = b.location_id WHERE b.unit_id = ${q(unbindUnitId)} AND b.status = 'active')`)
  must(run, 'RS-23：托码解绑且位置不变',
    Number(afterUnbind[0]?.[0]) === 0 && afterUnbind[0]?.[1] === lineLocCode, JSON.stringify(afterUnbind))

  // ================================================================
  // 5) 轴号修正核权重分配（RS-27/30/29 + RS-32 回撤恢复）
  // ================================================================
  const corT = `AM${s.run}-T`
  const corO = `AM${s.run}-O`
  await receiveUnit(run, `修正目标码收货 ${corT}（1,000 M，线边）`, {
    plantId: plant, unitNo: corT, materialId: s.mat['MAT-P23-FIN'], materialCode: 'MAT-P23-FIN',
    locationId: lineLoc, locationCode: lineLocCode,
  })
  await receiveUnit(run, `占用码收货 ${corO}（1,000 M，线边）`, {
    plantId: plant, unitNo: corO, materialId: s.mat['MAT-P23-FIN'], materialCode: 'MAT-P23-FIN',
    locationId: lineLoc, locationCode: lineLocCode,
  })
  const corTId = unitIdOf(plant, corT)
  const corOId = unitIdOf(plant, corO)
  const soCor = `SO-${s.run}-COR`
  // RS-26：原码须带客户轴号才提供可选列表；带段长则只保留同段长项（T 现值 T0/600/8；
  // O 为同订单同段长已占用项 C1/600/9 —— used 期望 true）
  seedAxisState(corTId, corT, soCor, 'KZH-P23-T0', '600', '8')
  seedAxisState(corOId, corO, soCor, 'KZH-P23-C1', '600', '9')

  const corScan = await httpStep(run, '修正扫码（RS-25/26：可选列表按订单范围构建）',
    'GET', `/rework/axis-correction/scan?plantId=${plant}&unitNo=${encodeURIComponent(corT)}`, undefined, 200)
  const opt = (corScan.body?.options ?? []).find((o) => o.segmentLength === '600' && o.virtualAxisNo === '9')
  must(run, '可选列表含已占用轴号项（used=true、occupiedBy 标注）',
    Boolean(opt) && opt.used === true && opt.occupiedByUnitNo === corO, JSON.stringify(corScan.body?.options))

  const noReason = await httpStep(run, '占用轴号提交无强制理由 → 422 [RS-30]',
    'POST', '/rework/axis-correction/submit',
    {
      unitNo: corT, cutQty: '100.0000',
      newCustomerAxisNo: 'KZH-P23-C1', newSegmentLength: '600', newVirtualAxisNo: '9',
      operationId: `${s.run}-a05-cor-noreason`,
    },
    422)
  must(run, '核权拒绝（RS-30 权限+强制理由）', String(noReason.body?.message ?? '').includes('RS-30'), JSON.stringify(noReason.body?.message))

  const corSubmit = await httpStep(run, '占用轴号提交（带权限+强制理由）→ 清占用+改值+扣减（RS-29）',
    'POST', '/rework/axis-correction/submit',
    {
      unitNo: corT, cutQty: '100.0000',
      newCustomerAxisNo: 'KZH-P23-C1', newSegmentLength: '600', newVirtualAxisNo: '9',
      reassignReason: 'P23 验收：占用轴号重新分配（客户通知）',
      operationId: `${s.run}-a05-cor-submit`,
    },
    [200, 201])
  const correctionId = corSubmit.body?.data?.correctionId ?? null
  s.a05.correctionId = correctionId
  must(run, '修正提交成功且登记占用来源（tookOverUnitNo）', corSubmit.body?.data?.tookOverUnitNo === corO && eqQty(corSubmit.body?.data?.newQty, 900),
    JSON.stringify(corSubmit.body?.data))

  const corRows = sqlStep(run, 'SQL：核权重分配结果（占用码清空 / 目标码新值 / 数量扣减 900）',
    `SELECT (SELECT COALESCE(customer_axis_no || '/' || segment_length || '/' || virtual_axis_no, 'null') FROM axis_no_state WHERE unit_id = ${q(corOId)}),
       (SELECT COALESCE(customer_axis_no || '/' || segment_length || '/' || virtual_axis_no, 'null') FROM axis_no_state WHERE unit_id = ${q(corTId)}),
       (SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(corTId)} AND status = 'active'),
       (SELECT status FROM axis_no_correction WHERE id = ${q(correctionId)})`)
  must(run, 'RS-29 执行后：O 轴号清空 / T 得新轴号 / T 余额 900 / 记录已完成',
    corRows[0]?.[0] === 'null' && corRows[0]?.[1] === 'KZH-P23-C1/600/9' && eqQty(corRows[0]?.[2], 900) && corRows[0]?.[3] === 'completed',
    JSON.stringify(corRows))

  // RS-32 回撤恢复（修正前值 + 加回截取数量）
  const withdraw = await httpStep(run, '修正回撤（RS-32：恢复修正前值并加回截取数量）',
    'POST', '/rework/axis-correction/withdraw',
    { correctionId, reason: 'P23 验收：修正回撤恢复', operationId: `${s.run}-a05-cor-withdraw` },
    [200, 201])
  must(run, '回撤成功', Boolean(withdraw.body?.data), JSON.stringify(withdraw.body?.data))
  const afterWithdraw = sqlStep(run, 'SQL：回撤后恢复（T 余额 1,000、记录已撤销）',
    `SELECT (SELECT quantity::text FROM stock_balance WHERE unit_id = ${q(corTId)} AND status = 'active'),
       (SELECT status FROM axis_no_correction WHERE id = ${q(correctionId)})`)
  must(run, 'RS-32 回撤恢复：数量回 1,000、记录 withdrawn',
    eqQty(afterWithdraw[0]?.[0], 1000) && afterWithdraw[0]?.[1] === 'withdrawn', JSON.stringify(afterWithdraw))

  // ================================================================
  // 6) 跨域四账对账（余额/流水/Outbox/审计——lib.mjs 口径）
  // ================================================================
  const balRows = sqlStep(run, 'SQL 四账一：A05 涉及单元活动余额',
    `SELECT u.unit_no, b.quantity::text, b.status FROM stock_balance b JOIN inventory_unit u ON u.id = b.unit_id
     WHERE u.plant_id = ${q(plant)} AND b.status = 'active' AND u.unit_no IN (
       ${q(`${src1}-T1`)}, ${q(`${src1}-T2`)}, ${q(`${src2}-TF`)}, ${q(`${src3}-C2`)}, ${q(corT)})
     ORDER BY u.unit_no`)
  must(run, '余额对账：T1=600 / T2=390 / TF=1000（解绑后在普通仓）/ C2=390 / T 回 1000',
    balRows.length === 5 &&
      eqQty(balRows.find((r) => r[0] === `${src1}-T1`)?.[1], 600) &&
      eqQty(balRows.find((r) => r[0] === `${src1}-T2`)?.[1], 390) &&
      eqQty(balRows.find((r) => r[0] === `${src2}-TF`)?.[1], 1000) &&
      eqQty(balRows.find((r) => r[0] === `${src3}-C2`)?.[1], 390) &&
      eqQty(balRows.find((r) => r[0] === corT)?.[1], 1000),
    JSON.stringify(balRows))

  const txRows = sqlStep(run, 'SQL 四账二：A05 流水（split/adjust/issue/move 各类齐备）',
    `SELECT movement_kind, count(*) FROM stock_transaction t JOIN inventory_unit u ON u.id = t.unit_id
     WHERE u.plant_id = ${q(plant)} AND u.unit_no IN (${q(src1)}, ${q(`${src1}-T1`)}, ${q(`${src1}-T2`)}, ${q(src3)}, ${q(`${src3}-C1`)}, ${q(corT)}, ${q(`${src2}-TF`)})
     GROUP BY movement_kind ORDER BY movement_kind`)
  const txMap = Object.fromEntries(txRows.map((r) => [r[0], Number(r[1])]))
  must(run, '流水对账：split（倒轴）/ issue（投料消耗）/ adjust（修正+回撤）/ move（分托移库）四类在册',
    txMap.split >= 4 && txMap.issue >= 1 && txMap.adjust >= 2 && txMap.move >= 2, JSON.stringify(txRows))

  const outboxRows = sqlStep(run, 'SQL 四账三：A05 Outbox（修正提交/回撤事件）',
    `SELECT task_kind, count(*) FROM outbox WHERE task_kind LIKE 'rework.%' AND payload->>'correctionNo' IN (
       SELECT correction_no FROM axis_no_correction WHERE id = ${q(correctionId)})
     GROUP BY task_kind`)
  must(run, 'Outbox 对账：修正提交+回撤两事件', outboxRows.length === 2, JSON.stringify(outboxRows))

  const auditRows = sqlStep(run, 'SQL 四账四：A05 审计（rework 四命令在册，本 run 窗口内）',
    `SELECT action, count(*) FROM audit_entry WHERE action LIKE 'rework.%' AND actor = 'admin' AND created_at >= ${q(auditSince)} GROUP BY action ORDER BY action`)
  const auditMap = Object.fromEntries(auditRows.map((r) => [r[0], Number(r[1])]))
  must(run, '审计对账：倒轴执行/分托确认/修正提交/回撤在册',
    (auditMap['rework.reel-split.execute'] ?? 0) >= 3 && (auditMap['rework.pallet.confirm'] ?? 0) >= 1 &&
      (auditMap['rework.axis-correction.submit'] ?? 0) >= 1 && (auditMap['rework.axis-correction.withdraw'] ?? 0) >= 1,
    JSON.stringify(auditRows))

  run.saveState()
  return run
}
