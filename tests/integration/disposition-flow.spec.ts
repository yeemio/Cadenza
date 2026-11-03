import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { CommandResultStatus, ERROR_CODES, type CommandEnvelope, type CommandResult } from '@cadenza/contracts'
import type { CommandContext } from '@cadenza/application'
import { buildInventoryCommandBus } from '../../apps/api/src/inventory/inventory.composition'
import { buildDispositionCommandBus } from '../../apps/api/src/disposition/disposition.composition'
import { QD_OWNER_ID, QD_OWNER_NAME, QD_TEST_DB_NAME, prepareQdTestDatabase } from '../api/disposition-test-env'

/**
 * 质量处置集成（真容器独立库 cadenza_disposition + 真实命令总线与真实组合根，无业务桩）。
 * 冻结合同 frozen/p2/quality-disposition.md 逐条证据：
 * ① 存疑（QD-01～04）：扫码前置重校验＋存疑记录 append-only＋恢复=处置记录不覆盖原行＋高影响依据＋
 *    存疑码扣减拦截（QD-04 最小防线）
 * ② 成品异常（QD-05～10）：PDA 前置＋提交校验＋审核通过=足减依次扣＋去向必填＋不通过不扣数＋码异常状态投影
 * ③ 采购质检版本化（QD-11～18）：Web 写入范围＋PDA 追加历史生效指针＋判定版本链与 CA-4 免检判不合格＋
 *    复检至多一次/整单原子/补首检＋批次状态重汇总＋QD-16 下游使用拦截＋QD-17 退货硬拦截
 * ④ 处置四类（QD-19～23）：返工任务不产生库存量＋报废从可用量扣减＋让步保留不合格事实＋放行高影响强制理由＋
 *    QD-S1/S2 append-only 库级守卫＋QD-S3/S4 CHECK 兜底
 */

let pool: pg.Pool
let bus: ReturnType<typeof buildDispositionCommandBus>
let invBus: ReturnType<typeof buildInventoryCommandBus>
let adminCtx: CommandContext
let fx: import('../api/disposition-test-env').QdFixtures
let dbAvailable = true
const run = `qd${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`

beforeAll(async () => {
  try {
    pool = await prepareQdTestDatabase()
  } catch {
    dbAvailable = false
    console.warn(`SKIP disposition-flow: 数据库不可达。请先 docker compose up -d 再重跑（独立库 ${QD_TEST_DB_NAME}）。`)
    return
  }
  const env = await import('../api/disposition-test-env.js')
  fx = await env.seedQdFixtures(pool)
  const admin = await pool.query<{ id: string; enterprise_id: string }>(
    `SELECT id, enterprise_id FROM user_account WHERE login_name = 'admin'`,
  )
  adminCtx = {
    actorUserId: admin.rows[0]!.id,
    actorLoginName: 'admin',
    enterpriseId: admin.rows[0]!.enterprise_id,
    reason: null,
  }
  bus = buildDispositionCommandBus(pool)
  invBus = buildInventoryCommandBus(pool)
})

afterAll(async () => {
  if (pool) await pool.end()
})

function skipIfNoDb(): boolean {
  if (!dbAvailable) console.warn('SKIP：数据库不可达')
  return !dbAvailable
}

let opSeq = 0
function nextOp(tag: string): string {
  opSeq += 1
  return `${run}-${tag}-${opSeq}`
}

function envelope(operationId: string, commandType: string, payload: Record<string, unknown>): CommandEnvelope {
  return { operationId, commandType, targetId: 'new', expectedRevision: 0, payload }
}

async function qd(operationId: string, commandType: string, payload: Record<string, unknown>): Promise<CommandResult> {
  return bus.execute(envelope(operationId, commandType, payload), adminCtx)
}

async function expectRejection(r: CommandResult, rule: string): Promise<string> {
  expect(r.status).toBe('BUSINESS_REJECTION')
  expect(r.errorCode).toBe(ERROR_CODES.BUSINESS_RULE)
  expect(r.errorMessage ?? '').toContain(`[${rule}]`)
  return r.errorMessage ?? ''
}

async function qualityOf(unitId: string): Promise<string | null> {
  const r = await pool.query<{ quality_status: string | null }>(
    `SELECT quality_status FROM stock_balance WHERE unit_id = $1 AND status = 'active' LIMIT 1`,
    [unitId],
  )
  return r.rows[0]?.quality_status ?? null
}

async function qtyOf(unitId: string): Promise<string> {
  const r = await pool.query<{ quantity: string }>(
    `SELECT quantity::text AS quantity FROM stock_balance WHERE unit_id = $1 AND status = 'active' LIMIT 1`,
    [unitId],
  )
  return r.rows[0]?.quantity ?? '0.0000'
}

async function batchStatus(batchNo: string): Promise<string> {
  const r = await pool.query<{ inspection_status: string }>(
    `SELECT inspection_status FROM purchase_receipt_batch WHERE batch_no = $1`,
    [batchNo],
  )
  return r.rows[0]!.inspection_status
}

async function detailQuality(unitId: string, batchNo: string): Promise<string> {
  const r = await pool.query<{ quality_status: string }>(
    `SELECT rd.quality_status FROM receipt_detail rd
     JOIN purchase_receipt_batch b ON b.id = rd.batch_id
     WHERE rd.inventory_unit_id = $1 AND b.batch_no = $2`,
    [unitId, batchNo],
  )
  return r.rows[0]!.quality_status
}

async function chainOf(batchNo: string, unitId: string): Promise<Array<{ version: number; inspection_type: string; conclusion: string; is_effective: boolean; source: string }>> {
  const r = await pool.query(
    `SELECT ir.version, ir.inspection_type, ir.conclusion, ir.is_effective, ir.source
     FROM inspection_record ir
     JOIN receipt_detail rd ON rd.id = ir.detail_id
     JOIN purchase_receipt_batch b ON b.id = ir.batch_id
     WHERE b.batch_no = $1 AND rd.inventory_unit_id = $2
     ORDER BY ir.inspection_type, ir.version`,
    [batchNo, unitId],
  )
  return r.rows as Array<{ version: number; inspection_type: string; conclusion: string; is_effective: boolean; source: string }>
}

// ============ ② 成品异常（QD-05～10；先于存疑——组① 复用 C 码做 QD-04 拦截） ============

describe('② 成品异常（QD-05～10）', () => {
  const unitC = 'U-QD-C'
  const unitD = 'U-QD-D'
  const unitG = 'U-QD-G'
  let defectCNo = ''
  let defectGNo = ''

  it('QD-05：托码拒；已入库且非线边仓拒（D 在普通仓）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const pallet = await qd(nextOp('d1'), 'disposition.defect.submit', {
      plantId: fx.szPlantId, unitNo: unitC, materialId: fx.finishedMaterialId,
      defectType: 'scrap', defectQty: '5.0000', barcodeKind: 'pallet',
    })
    await expectRejection(pallet, 'QD-05')
    const notLineSide = await qd(nextOp('d2'), 'disposition.defect.submit', {
      plantId: fx.szPlantId, unitNo: unitD, materialId: fx.finishedMaterialId,
      defectType: 'scrap', defectQty: '5.0000',
    })
    const msg = await expectRejection(notLineSide, 'QD-05')
    expect(msg).toContain('线边仓')
  })

  it('QD-06：数量大于该料品总数拒；未传不合格类型拒；提交成功=未审核＋码异常状态=异常未处理（QD-10）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const overQty = await qd(nextOp('d3'), 'disposition.defect.submit', {
      plantId: fx.szPlantId, unitNo: unitC, materialId: fx.finishedMaterialId,
      defectType: 'scrap', defectQty: '500.0000',
    })
    await expectRejection(overQty, 'QD-06')
    const noType = await qd(nextOp('d4'), 'disposition.defect.submit', {
      plantId: fx.szPlantId, unitNo: unitC, materialId: fx.finishedMaterialId,
      defectQty: '5.0000',
    })
    await expectRejection(noType, 'QD-06')

    const ok = await qd(nextOp('d5'), 'disposition.defect.submit', {
      plantId: fx.szPlantId, unitNo: unitC, materialId: fx.finishedMaterialId,
      defectType: 'scrap', defectQty: '10.0000',
    })
    expect(ok.status).toBe(CommandResultStatus.COMMITTED)
    defectCNo = ((ok.data as Record<string, unknown>).defectNo) as string
    expect(((ok.data as Record<string, unknown>).unitDefectState)).toBe('defect_open')

    const dup = await qd(nextOp('d6'), 'disposition.defect.submit', {
      plantId: fx.szPlantId, unitNo: unitC, materialId: fx.finishedMaterialId,
      defectType: 'scrap', defectQty: '1.0000',
    })
    await expectRejection(dup, 'QD-06')
  })

  it('QD-08：审核通过缺去向拒（禁止无去向扣数）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await qd(nextOp('d7'), 'disposition.defect.review', { defectNo: defectCNo, result: 'approved' })
    await expectRejection(r, 'QD-08')
  })

  it('QD-07/09：审核通过=足减依次扣＋adjust 流水（扣前/扣后）＋去向落库；重复审核拒', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const before = await qtyOf(fx.unitCId)
    const r = await qd(nextOp('d8'), 'disposition.defect.review', {
      defectNo: defectCNo, result: 'approved',
      destinationKind: 'scrap', destinationNote: '入库报废区', adjustReason: '成品抽检不合格',
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const after = await qtyOf(fx.unitCId)
    expect(Number(after)).toBe(Number(before) - 10)
    // 流水：adjust 负向、ref=异常记录、含扣前/扣后
    const tx = await pool.query(
      `SELECT st.movement_kind, st.quantity::text AS q, st.before_qty::text AS bq, st.after_qty::text AS aq, st.ref_type
       FROM stock_transaction st JOIN finished_goods_defect fgd ON fgd.id = st.ref_id
       WHERE fgd.defect_no = $1`,
      [defectCNo],
    )
    expect(tx.rowCount).toBe(1)
    expect(tx.rows[0]!.movement_kind).toBe('adjust')
    expect(tx.rows[0]!.ref_type).toBe('finished_goods_defect')
    expect(Number(tx.rows[0]!.aq)).toBe(Number(tx.rows[0]!.bq) - 10)
    // 记录去向（QD-08 落库）
    const row = await pool.query<{ review_status: string; destination_kind: string; destination_note: string }>(
      `SELECT review_status, destination_kind, destination_note FROM finished_goods_defect WHERE defect_no = $1`,
      [defectCNo],
    )
    expect(row.rows[0]!.review_status).toBe('approved')
    expect(row.rows[0]!.destination_kind).toBe('scrap')
    // 重复审核拒（QD-07）
    const again = await qd(nextOp('d9'), 'disposition.defect.review', { defectNo: defectCNo, result: 'rejected' })
    await expectRejection(again, 'QD-07')
  })

  it('QD-07：审核不通过=只清异常状态、不扣数量', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const submit = await qd(nextOp('d10'), 'disposition.defect.submit', {
      plantId: fx.szPlantId, unitNo: unitG, materialId: fx.finishedMaterialId,
      defectType: 'rework', defectQty: '5.0000',
    })
    expect(submit.status).toBe(CommandResultStatus.COMMITTED)
    defectGNo = ((submit.data as Record<string, unknown>).defectNo) as string
    const before = await qtyOf(fx.unitGId)
    const r = await qd(nextOp('d11'), 'disposition.defect.review', { defectNo: defectGNo, result: 'rejected' })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    expect(((r.data as Record<string, unknown>).quantityDeducted)).toBe('0.0000')
    expect(await qtyOf(fx.unitGId)).toBe(before)
    const tx = await pool.query(`SELECT 1 FROM stock_transaction st JOIN finished_goods_defect fgd ON fgd.id = st.ref_id WHERE fgd.defect_no = $1`, [defectGNo])
    expect(tx.rowCount).toBe(0)
  })
})

// ============ ① 存疑（QD-01～04） ============

describe('① 存疑（QD-01～04）', () => {
  it('QD-01：托码拒；码未入库拒；确认时重校验', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const pallet = await qd(nextOp('s1'), 'disposition.suspect.mark', {
      plantId: fx.szPlantId, unitNo: 'U-QD-D', barcodeKind: 'pallet',
    })
    await expectRejection(pallet, 'QD-01')
    const notReceived = await qd(nextOp('s2'), 'disposition.suspect.mark', {
      plantId: fx.szPlantId, unitNo: 'U-QD-NONE-999',
    })
    await expectRejection(notReceived, 'QD-01')
  })

  it('QD-02：标记成功=存疑记录（料品拼接/发起人/前状态）＋质量状态=存疑；重复标记拒（已存疑）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const op = nextOp('s3')
    const r = await qd(op, 'disposition.suspect.mark', { plantId: fx.szPlantId, unitNo: 'U-QD-D' })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const rec = await pool.query(
      `SELECT unit_no, material_key_joined, raised_by, previous_quality_status, current_status FROM qd_suspect_record ORDER BY raised_at DESC LIMIT 1`,
    )
    expect(rec.rows[0]!.unit_no).toBe('U-QD-D')
    expect(rec.rows[0]!.material_key_joined).toContain('MAT-QD-FIN')
    expect(rec.rows[0]!.raised_by).toBe('admin')
    expect(rec.rows[0]!.previous_quality_status).toBe('qualified')
    expect(await qualityOf(fx.unitDId)).toBe('suspect')
    // 幂等重放：同 operationId 返回原结果不重复写
    const replay = await qd(op, 'disposition.suspect.mark', { plantId: fx.szPlantId, unitNo: 'U-QD-D' })
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    const count = await pool.query(`SELECT count(*)::int AS c FROM qd_suspect_record WHERE unit_no = 'U-QD-D'`)
    expect(count.rows[0]!.c).toBe(1)
    // 重复标记（新操作）拒：码已标记存疑（QD-01）
    const dup = await qd(nextOp('s4'), 'disposition.suspect.mark', { plantId: fx.szPlantId, unitNo: 'U-QD-D' })
    await expectRejection(dup, 'QD-01')
  })

  it('QD-S1：存疑记录 append-only——直接 UPDATE 被 DB 守卫拒绝', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await expect(pool.query(`UPDATE qd_suspect_record SET current_status = 'x' WHERE unit_no = 'U-QD-D'`)).rejects.toThrow(/QD-S1/)
  })

  it('QD-03：恢复=处置记录（hold_release，关联原存疑记录）；原存疑记录保留可查；质量状态恢复前值', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const suspectBefore = await pool.query(`SELECT count(*)::int AS c FROM qd_suspect_record WHERE unit_no = 'U-QD-D'`)
    const r = await qd(nextOp('s5'), 'disposition.suspect.release', {
      plantId: fx.szPlantId, unitNo: 'U-QD-D', basis: '复检确认合格',
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    expect(((r.data as Record<string, unknown>).restoredQualityStatus)).toBe('qualified')
    expect(await qualityOf(fx.unitDId)).toBe('qualified')
    // 处置记录落库且关联原存疑记录；原存疑记录未删未改（并存可查）
    const disp = await pool.query(
      `SELECT d.disposition_kind, d.target_type, d.target_id FROM qd_disposition_record d
       WHERE d.disposition_kind = 'hold_release' AND d.target_type = 'qd_suspect_record'
       ORDER BY d.decided_at DESC LIMIT 1`,
    )
    expect(disp.rowCount).toBe(1)
    const linked = await pool.query(`SELECT count(*)::int AS c FROM qd_suspect_record WHERE id = $1`, [disp.rows[0]!.target_id])
    expect(linked.rows[0]!.c).toBe(1)
    const suspectAfter = await pool.query(`SELECT count(*)::int AS c FROM qd_suspect_record WHERE unit_no = 'U-QD-D'`)
    expect(suspectAfter.rows[0]!.c).toBe(suspectBefore.rows[0]!.c)
    // 无活动存疑再恢复拒
    const again = await qd(nextOp('s6'), 'disposition.suspect.release', { plantId: fx.szPlantId, unitNo: 'U-QD-D' })
    await expectRejection(again, 'QD-03')
  })

  it('QD-03：高影响场景（存在有效活动预留=备货/待发运）恢复必须填处置依据', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await qd(nextOp('s7'), 'disposition.suspect.mark', { plantId: fx.szPlantId, unitNo: 'U-QD-D' })
    await pool.query(
      `INSERT INTO reservation (unit_id, holder_type, holder_ref, quantity, uom_id, uom_code,
         measurement_basis, status, valid_until, plant_id, enterprise_id, created_by)
       VALUES ($1, 'order', 'SHP-TEST-1', 10.0000, '33333333-3333-4333-8333-3333333333d1', 'KG',
         'nominal', 'active', now() + interval '1 day', $2, $3, 'seed-qd')`,
      [fx.unitDId, fx.szPlantId, adminCtx.enterpriseId],
    )
    const noBasis = await qd(nextOp('s8'), 'disposition.suspect.release', { plantId: fx.szPlantId, unitNo: 'U-QD-D' })
    const msg = await expectRejection(noBasis, 'QD-03')
    expect(msg).toContain('处置依据')
    const withBasis = await qd(nextOp('s9'), 'disposition.suspect.release', {
      plantId: fx.szPlantId, unitNo: 'U-QD-D', basis: '客诉复核排除该码',
    })
    expect(withBasis.status).toBe(CommandResultStatus.COMMITTED)
  })

  it('QD-04 最小防线：存疑码成品异常审核扣减被拦截', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await qd(nextOp('s10'), 'disposition.suspect.mark', { plantId: fx.szPlantId, unitNo: 'U-QD-C' })
    const submit = await qd(nextOp('s11'), 'disposition.defect.submit', {
      plantId: fx.szPlantId, unitNo: 'U-QD-C', materialId: fx.finishedMaterialId,
      defectType: 'scrap', defectQty: '2.0000',
    })
    expect(submit.status).toBe(CommandResultStatus.COMMITTED)
    const review = await qd(nextOp('s12'), 'disposition.defect.review', {
      defectNo: ((submit.data as Record<string, unknown>).defectNo) as string, result: 'approved',
      destinationKind: 'scrap', destinationNote: 'x', adjustReason: 'x',
    })
    const msg = await expectRejection(review, 'QD-04')
    expect(msg).toContain('存疑')
    await qd(nextOp('s13'), 'disposition.suspect.release', { plantId: fx.szPlantId, unitNo: 'U-QD-C', basis: '解除测试' })
  })
})

// ============ ③ 采购质检结论版本化（QD-11～18） ============

describe('③ 采购质检结论版本化（QD-11～18）', () => {
  it('QD-17：已退货批次不可质检（BATCH-QD-0003）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await qd(nextOp('q1'), 'disposition.qc.write-web', {
      batchNo: fx.batch3No, items: [{ unitNo: 'U-QD-R', conclusion: 'qualified' }],
    })
    await expectRejection(r, 'QD-17')
  })

  it('QD-11/15：Web 写入两码结论→版本行＋生效指针＋码投影同步＋批次状态重汇总=部分合格', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await qd(nextOp('q2'), 'disposition.qc.write-web', {
      batchNo: fx.batch1No,
      items: [
        { unitNo: 'U-QD-A', conclusion: 'qualified' },
        { unitNo: 'U-QD-B', conclusion: 'unqualified' },
      ],
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    expect(((r.data as Record<string, unknown>).batchInspectionStatus)).toBe('partially_qualified')
    expect(await batchStatus(fx.batch1No)).toBe('partially_qualified')
    // 码投影：明细+库存余额同步
    expect(await detailQuality(fx.unitAId, fx.batch1No)).toBe('qualified')
    expect(await detailQuality(fx.unitBId, fx.batch1No)).toBe('unqualified')
    expect(await qualityOf(fx.unitAId)).toBe('qualified')
    expect(await qualityOf(fx.unitBId)).toBe('unqualified')
    const chainA = await chainOf(fx.batch1No, fx.unitAId)
    expect(chainA.length).toBeGreaterThanOrEqual(1)
    expect(chainA[chainA.length - 1]!.conclusion).toBe('qualified')
    expect(chainA[chainA.length - 1]!.is_effective).toBe(true)
  })

  it('QD-11：已有结论的码不改（再写 A 拒）；终态批次 Web 写入拒', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await qd(nextOp('q3'), 'disposition.qc.write-web', {
      batchNo: fx.batch1No, items: [{ unitNo: 'U-QD-A', conclusion: 'unqualified' }],
    })
    await expectRejection(r, 'QD-11')
    const terminal = await qd(nextOp('q4'), 'disposition.qc.write-web', {
      batchNo: fx.batch1No, items: [{ unitNo: 'U-QD-F', conclusion: 'qualified' }],
    })
    await expectRejection(terminal, 'QD-11')
  })

  it('QD-13：判合格（部分合格→整批合格）＋判定记录版本链 v1', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await qd(nextOp('q5'), 'disposition.qc.judge', {
      batchNo: fx.batch1No, judgement: 'qualified', remark: '客诉复核后整批判合格',
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    expect(((r.data as Record<string, unknown>).judgementVersion)).toBe(1)
    expect(await batchStatus(fx.batch1No)).toBe('all_qualified')
    for (const u of [fx.unitAId, fx.unitBId, fx.unitFId]) {
      const chain = await chainOf(fx.batch1No, u)
      expect(chain[chain.length - 1]!.conclusion).toBe('qualified')
      expect(chain.filter((c) => c.is_effective).length).toBe(1)
    }
  })

  it('QD-13：判不合格（全部合格→整批不合格）＋判定记录版本链 v2（新覆盖旧=版本追加）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await qd(nextOp('q6'), 'disposition.qc.judge', {
      batchNo: fx.batch1No, judgement: 'unqualified', remark: '二次抽检整批判不合格',
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    expect(((r.data as Record<string, unknown>).judgementVersion)).toBe(2)
    expect(await batchStatus(fx.batch1No)).toBe('all_unqualified')
    const judgements = await pool.query(
      `SELECT version, conclusion, is_effective FROM batch_judgement WHERE batch_id = $1 ORDER BY version`,
      [fx.batch1Id],
    )
    expect(judgements.rowCount).toBe(2)
    expect(judgements.rows[0]!.is_effective).toBe(false)
    expect(judgements.rows[1]!.is_effective).toBe(true)
  })

  it('QD-13：备注必填非纯空白（空/纯空格拒）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const bad1 = await qd(nextOp('q7'), 'disposition.qc.judge', { batchNo: fx.batch2No, judgement: 'unqualified', remark: '' })
    await expectRejection(bad1, 'QD-13')
    const bad2 = await qd(nextOp('q8'), 'disposition.qc.judge', { batchNo: fx.batch2No, judgement: 'unqualified', remark: '   ' })
    await expectRejection(bad2, 'QD-13')
  })

  it('QD-13/CA-4：免检批判不合格=追加检验记录切换（免检首检事实保留可查）；免检码 PDA 提交拒（QD-12）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 免检码不可 PDA 提交（QD-12）
    const pdaExempt = await qd(nextOp('q9'), 'disposition.qc.submit-pda', {
      batchNo: fx.batch2No, unitNo: 'U-QD-E', conclusion: 'qualified',
    })
    await expectRejection(pdaExempt, 'QD-12')
    // 免检批可判不合格（条件=exempt）
    const r = await qd(nextOp('q10'), 'disposition.qc.judge', {
      batchNo: fx.batch2No, judgement: 'unqualified', remark: '客诉追溯整批判不合格',
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    expect(await batchStatus(fx.batch2No)).toBe('all_unqualified')
    // CA-4：免检首检事实行保留可查＋新版本行切换生效（不删除免检事实）
    const chain = await chainOf(fx.batch2No, fx.unitEId)
    expect(chain.some((c) => c.conclusion === 'exempt')).toBe(true)
    expect(chain[chain.length - 1]!.conclusion).toBe('unqualified')
    expect(chain[chain.length - 1]!.is_effective).toBe(true)
    const exemptRow = chain.find((c) => c.conclusion === 'exempt')!
    expect(exemptRow.is_effective).toBe(false) // 事实保留、指针已切换
  })

  it('QD-12：PDA 追加历史＋生效指针切换（后一次覆盖前次生效）；附件>3 拒', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const before = (await chainOf(fx.batch1No, fx.unitAId)).length
    const bad = await qd(nextOp('q11'), 'disposition.qc.submit-pda', {
      batchNo: fx.batch1No, unitNo: 'U-QD-A', conclusion: 'unqualified',
      attachments: [{}, {}, {}, {}],
    })
    await expectRejection(bad, 'QD-12')
    const r = await qd(nextOp('q12'), 'disposition.qc.submit-pda', {
      batchNo: fx.batch1No, unitNo: 'U-QD-A', conclusion: 'unqualified', attachments: [{ name: 'a.jpg' }],
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const chain = await chainOf(fx.batch1No, fx.unitAId)
    expect(chain.length).toBe(before + 1)
    const effective = chain.filter((c) => c.is_effective)
    expect(effective.length).toBe(1)
    expect(effective[0]!.conclusion).toBe('unqualified')
    expect(effective[0]!.source).toBe('pda')
    expect(chain.some((c) => c.conclusion === 'qualified' && !c.is_effective)).toBe(true) // 旧结论可查
    expect(await detailQuality(fx.unitAId, fx.batch1No)).toBe('unqualified')
    expect(await qualityOf(fx.unitAId)).toBe('unqualified')
  })

  it('QD-14：复检发起=当前生效结论不合格前提（合格码拒/无记录码拒）；成功=re 链待质检＋码改待检＋批次重汇总', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // B 当前不合格（judge 后）→ 复检成功
    const ok = await qd(nextOp('q13'), 'disposition.qc.re-inspect', {
      batchNo: fx.batch1No, items: [{ unitNo: 'U-QD-B' }],
    })
    expect(ok.status).toBe(CommandResultStatus.COMMITTED)
    const chain = await chainOf(fx.batch1No, fx.unitBId)
    const reRows = chain.filter((c) => c.inspection_type === 're')
    expect(reRows.length).toBe(1)
    expect(reRows[0]!.conclusion).toBe('pending')
    expect(reRows[0]!.is_effective).toBe(true)
    expect(await detailQuality(fx.unitBId, fx.batch1No)).toBe('re_inspection')
    expect(await qualityOf(fx.unitBId)).toBe('pending_inspection')
    // 同码同批次至多一次
    const dup = await qd(nextOp('q14'), 'disposition.qc.re-inspect', {
      batchNo: fx.batch1No, items: [{ unitNo: 'U-QD-B' }],
    })
    await expectRejection(dup, 'QD-14')
  })

  it('QD-14：整单原子——items 任一不满足整单失败（已复检码+无记录码混合提交全拒，无记录码未补首检）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const before = (await chainOf(fx.batch1No, fx.unitFId)).length
    const r = await qd(nextOp('q15'), 'disposition.qc.re-inspect', {
      batchNo: fx.batch1No, items: [{ unitNo: 'U-QD-B' }, { unitNo: 'U-QD-F' }],
    })
    await expectRejection(r, 'QD-14')
    expect((await chainOf(fx.batch1No, fx.unitFId)).length).toBe(before) // 未补首检（不部分提交）
  })

  it('QD-14：无质检记录的码补首检（BATCH-QD-0006/U-QD-I 单独提交成功，first pending 生效）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const r = await qd(nextOp('q16'), 'disposition.qc.re-inspect', {
      batchNo: fx.batch6No, items: [{ unitNo: 'U-QD-I' }],
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const actions = (r.data as { reInspections: Array<{ unitNo: string; action: string }> }).reInspections
    expect(actions[0]!.action).toBe('supplement_first')
    const chain = await chainOf(fx.batch6No, fx.unitIId)
    expect(chain.length).toBe(1)
    expect(chain[0]!.conclusion).toBe('pending')
    expect(chain[0]!.is_effective).toBe(true)
  })

  it('QD-16：批次已投料下游使用→切有效结论拦截并提示转隔离/追溯处置', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // 批 5：先 Web 写合格，再经 inventory.issue-material 投料（消耗）
    const write = await qd(nextOp('q17'), 'disposition.qc.write-web', {
      batchNo: fx.batch5No, items: [{ unitNo: 'U-QD-H', conclusion: 'qualified' }],
    })
    expect(write.status).toBe(CommandResultStatus.COMMITTED)
    const issue = await invBus.execute(
      envelope(nextOp('q18'), 'inventory.issue-material', {
        unitId: fx.unitHId, quantity: '10.0000', locationId: fx.qdRackLocationId,
        ownerId: QD_OWNER_ID, ownerName: QD_OWNER_NAME, reason: 'QD-16 投料证据',
      }),
      adminCtx,
    )
    expect(issue.status).toBe(CommandResultStatus.COMMITTED)
    // 切换有效结论（PDA 提交）被拦截
    const r = await qd(nextOp('q19'), 'disposition.qc.submit-pda', {
      batchNo: fx.batch5No, unitNo: 'U-QD-H', conclusion: 'unqualified',
    })
    const msg = await expectRejection(r, 'QD-16')
    expect(msg).toContain('隔离/追溯处置')
    // 判定（整批切换）同样拦截
    const judge = await qd(nextOp('q20'), 'disposition.qc.judge', {
      batchNo: fx.batch5No, judgement: 'unqualified', remark: '投料后尝试判定',
    })
    await expectRejection(judge, 'QD-16')
  })

  it('QD-S2：检验记录版本链 append-only——事实列 UPDATE 被 0006 守卫拒绝、DELETE 拒', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const row = await pool.query(`SELECT id FROM inspection_record WHERE conclusion = 'qualified' LIMIT 1`)
    await expect(
      pool.query(`UPDATE inspection_record SET conclusion = 'unqualified' WHERE id = $1`, [row.rows[0]!.id]),
    ).rejects.toThrow()
    await expect(pool.query(`DELETE FROM inspection_record WHERE id = $1`, [row.rows[0]!.id])).rejects.toThrow()
  })
})

// ============ ④ 处置四类（QD-19～23） ============

describe('④ 处置、返工、报废、让步、放行（QD-19～23）', () => {
  it('QD-21：返工处置——缺原工序/订单拒；成功=处置记录+返工任务+不在库存账生成数量', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const noOrder = await qd(nextOp('r1'), 'disposition.disposition.rework', {
      plantId: fx.szPlantId, unitNo: 'U-QD-A', basis: '返工',
    })
    await expectRejection(noOrder, 'QD-21')
    const before = await qtyOf(fx.unitAId)
    const r = await qd(nextOp('r2'), 'disposition.disposition.rework', {
      plantId: fx.szPlantId, unitNo: 'U-QD-A',
      originProcessOrderNo: 'PO-2026-001', originOperation: 'OP-10 绞制',
      basis: '外径超差可返工', note: '返工后重新报工',
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    expect(((r.data as Record<string, unknown>).stockQuantityGenerated)).toBe('0.0000')
    expect(await qtyOf(fx.unitAId)).toBe(before) // 不在库存账凭空生成数量
    const task = await pool.query(
      `SELECT t.task_no, t.origin_process_order_no, t.origin_operation, d.disposition_kind
       FROM qd_rework_task t JOIN qd_disposition_record d ON d.id = t.disposition_id
       WHERE t.origin_unit_no = 'U-QD-A'`,
    )
    expect(task.rowCount).toBe(1)
    expect(task.rows[0]!.origin_process_order_no).toBe('PO-2026-001')
    expect(task.rows[0]!.disposition_kind).toBe('rework')
  })

  it('QD-20/22：报废——缺依据拒；超可用量拒；成功=从可用量扣减+adjust 流水 ref=处置记录+去向落库；报废量不可再进入可用量（余额上限收紧）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const noBasis = await qd(nextOp('r3'), 'disposition.disposition.scrap', {
      plantId: fx.szPlantId, unitNo: 'U-QD-D', scrapQty: '10.0000', destinationNote: '报废区',
    })
    await expectRejection(noBasis, 'QD-20')
    const noDest = await qd(nextOp('r4'), 'disposition.disposition.scrap', {
      plantId: fx.szPlantId, unitNo: 'U-QD-D', scrapQty: '10.0000', basis: '绝缘击穿',
    })
    await expectRejection(noDest, 'QD-22')
    const over = await qd(nextOp('r5'), 'disposition.disposition.scrap', {
      plantId: fx.szPlantId, unitNo: 'U-QD-D', scrapQty: '999.0000', basis: 'x', destinationNote: 'x',
    })
    await expectRejection(over, 'QD-22')

    const before = await qtyOf(fx.unitDId)
    const op = nextOp('r6')
    const r = await qd(op, 'disposition.disposition.scrap', {
      plantId: fx.szPlantId, unitNo: 'U-QD-D', scrapQty: '20.0000',
      basis: '绝缘击穿不可修复', destinationNote: '转入废铜回收区',
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    const after = await qtyOf(fx.unitDId)
    expect(Number(after)).toBe(Number(before) - 20)
    const tx = await pool.query(
      `SELECT st.movement_kind, st.ref_type, st.reason FROM stock_transaction st
       JOIN qd_disposition_record d ON d.id = st.ref_id
       WHERE d.disposition_kind = 'scrap' AND st.ref_type = 'qd_disposition_record'`,
    )
    expect(tx.rowCount).toBeGreaterThanOrEqual(1)
    expect(tx.rows[0]!.reason).toContain('绝缘击穿')
    // 幂等重放不重复扣减
    const replay = await qd(op, 'disposition.disposition.scrap', {
      plantId: fx.szPlantId, unitNo: 'U-QD-D', scrapQty: '20.0000',
      basis: '绝缘击穿不可修复', destinationNote: '转入废铜回收区',
    })
    expect(replay.status).toBe(CommandResultStatus.COMMITTED)
    expect(await qtyOf(fx.unitDId)).toBe(after)
    // 报废后量不可再进入可用量：余额为 after，再报废超量拒
    const over2 = await qd(nextOp('r7'), 'disposition.disposition.scrap', {
      plantId: fx.szPlantId, unitNo: 'U-QD-D', scrapQty: String(Number(after) + 1), basis: 'x', destinationNote: 'x',
    })
    await expectRejection(over2, 'QD-22')
  })

  it('QD-23：让步放行——审批人必填；范围（批次/数量）必填；范围外数量拒；保留原不合格事实（检验链不动）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    // U-QD-B 当前 pending_inspection（复检后）……用 U-QD-E（batch2 判不合格后 unqualified）
    expect(await qualityOf(fx.unitEId)).toBe('unqualified')
    const noApprover = await qd(nextOp('r8'), 'disposition.disposition.concession', {
      plantId: fx.szPlantId, unitNo: 'U-QD-E', scopeBatchNo: fx.batch2No, scopeQty: '10.0000',
    })
    await expectRejection(noApprover, 'QD-23')
    const noScope = await qd(nextOp('r9'), 'disposition.disposition.concession', {
      plantId: fx.szPlantId, unitNo: 'U-QD-E', approver: '质量总监', scopeQty: '10.0000',
    })
    await expectRejection(noScope, 'QD-23')
    const outOfScope = await qd(nextOp('r10'), 'disposition.disposition.concession', {
      plantId: fx.szPlantId, unitNo: 'U-QD-E', approver: '质量总监',
      scopeBatchNo: fx.batch2No, scopeQty: '10.0000', requestedQty: '12.0000',
    })
    await expectRejection(outOfScope, 'QD-23')

    const chainBefore = await chainOf(fx.batch2No, fx.unitEId)
    const r = await qd(nextOp('r11'), 'disposition.disposition.concession', {
      plantId: fx.szPlantId, unitNo: 'U-QD-E', approver: '质量总监',
      scopeBatchNo: fx.batch2No, scopeQty: '50.0000', requestedQty: '50.0000',
      expiresAt: '2027-06-30T00:00:00Z', basis: '客户让步接收函 RF-2026-11',
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    expect(await qualityOf(fx.unitEId)).toBe('qualified')
    // 原不合格事实保留：检验链不动（仍含 unqualified 生效行）
    const chainAfter = await chainOf(fx.batch2No, fx.unitEId)
    expect(chainAfter.length).toBe(chainBefore.length)
    expect(chainAfter[chainAfter.length - 1]!.conclusion).toBe('unqualified')
    const fact = await pool.query(
      `SELECT approver, concession_scope FROM qd_disposition_record WHERE disposition_kind = 'concession' ORDER BY decided_at DESC LIMIT 1`,
    )
    expect(fact.rows[0]!.approver).toBe('质量总监')
    expect(JSON.stringify(fact.rows[0]!.concession_scope)).toContain('BATCH-QD-0002')
  })

  it('QD-19/20：放行——高影响强制理由＋关联检验/异常记录指针；成功=放行决定（事实保留）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const noBasis = await qd(nextOp('r12'), 'disposition.disposition.release', {
      plantId: fx.szPlantId, unitNo: 'U-QD-B', targetType: 'inspection_record', targetId: '11111111-1111-4111-8111-111111111101',
    })
    await expectRejection(noBasis, 'QD-20')
    const noTarget = await qd(nextOp('r13'), 'disposition.disposition.release', {
      plantId: fx.szPlantId, unitNo: 'U-QD-B', basis: '复检合格放行',
    })
    await expectRejection(noTarget, 'QD-20')
    const r = await qd(nextOp('r14'), 'disposition.disposition.release', {
      plantId: fx.szPlantId, unitNo: 'U-QD-B', basis: '工艺评审放行（记录在案）',
      targetType: 'inspection_record', targetId: '11111111-1111-4111-8111-111111111102',
    })
    expect(r.status).toBe(CommandResultStatus.COMMITTED)
    expect(((r.data as Record<string, unknown>).releasedTo)).toBe('qualified')
    expect(await qualityOf(fx.unitBId)).toBe('qualified')
    // "审核通过"≠"质检合格"：检验链 unqualified/pending 事实未被改写
    const chain = await chainOf(fx.batch1No, fx.unitBId)
    expect(chain.some((c) => c.inspection_type === 're' && c.conclusion === 'pending')).toBe(true)
  })

  it('QD-S3：放行/报废 reason 非空库级 CHECK 兜底（直接 INSERT 拒）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    await expect(
      pool.query(
        `INSERT INTO qd_disposition_record (disposition_no, disposition_kind, target_type, target_id,
           decided_by, decided_at, reason, plant_id, enterprise_id)
         VALUES ('QD-DISP-CHECK-1', 'release', 'inventory_unit', $1, 't', now(), NULL, $2, $3)`,
        [fx.unitDId, fx.szPlantId, adminCtx.enterpriseId],
      ),
    ).rejects.toThrow()
    await expect(
      pool.query(
        `INSERT INTO qd_disposition_record (disposition_no, disposition_kind, target_type, target_id,
           decided_by, decided_at, reason, plant_id, enterprise_id)
         VALUES ('QD-DISP-CHECK-2', 'scrap', 'inventory_unit', $1, 't', now(), '   ', $2, $3)`,
        [fx.unitDId, fx.szPlantId, adminCtx.enterpriseId],
      ),
    ).rejects.toThrow()
  })

  it('QD-S4：approved→去向必填库级 CHECK 兜底（直接 UPDATE 为 approved+空去向拒）', async (ctx) => {
    if (skipIfNoDb()) return ctx.skip()
    const row = await pool.query(`SELECT id FROM finished_goods_defect WHERE review_status = 'rejected' LIMIT 1`)
    await expect(
      pool.query(
        `UPDATE finished_goods_defect SET review_status = 'approved', destination_kind = NULL WHERE id = $1`,
        [row.rows[0]!.id],
      ),
    ).rejects.toThrow()
  })
})
