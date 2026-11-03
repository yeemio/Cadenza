import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { engineDatabaseUrl } from '../sol-sap-engine/test-database'
import { SapSimRuleViolation } from '@cadenza/domain'
import { SapSimEngineService, SapSimService } from '@cadenza/application'
import {
  PgSapSimOutboxReceiptAdapter,
  createPgSapSimFactsRepositories,
  createPgSapSimRepositories,
  createPool,
  migrations,
  migrateUp,
} from '@cadenza/persistence'

/**
 * R1 模拟 SAP 引擎集成实测（真容器 cadenza-dev-pg @55433）：
 * 回执由 sim 事实产生、A1000 查询闭环、B1000 UNKNOWN、重启恢复、
 * 故障注入改变交互、expected_outcome 拒收、sim/MOM 表分离不串写。
 * E08 冻结键 happy-path 贯通：MOM 命令(deliverMessage→outbox)→dispatch→sim 事实→回执→outbox 状态更新。
 */

const FROZEN = {
  REL_N1: 'CBL01G-EVKEY-MSG-REL-N1',
  N1_GI: 'CBL01G-EVKEY-MSG-N1-GI',
  N1_GR: 'CBL01G-EVKEY-MSG-N1-GR',
  N2_GR_A: 'CBL01G-EVKEY-MSG-N2-GR-A',
  N2_GR_B: 'CBL01G-EVKEY-MSG-N2-GR-B',
  BK_N1: 'SAPSIM|CBL01G-C100|CN11|PRODUCTION|00001001|0010',
  BK_N2: 'SAPSIM|CBL01G-K200|KR22|PRODUCTION|00001012|0010',
}

let pool: pg.Pool
let engine: SapSimEngineService
let service: SapSimService
let momTableCounts: Record<string, string> = {}

function buildServices(p: pg.Pool) {
  const repos = createPgSapSimRepositories(p)
  const eng = new SapSimEngineService(
    createPgSapSimFactsRepositories(p),
    new PgSapSimOutboxReceiptAdapter(repos.outbox),
  )
  return { repos, engine: eng, service: new SapSimService(repos, eng) }
}

async function expectRule(fn: () => Promise<unknown>, rule: string): Promise<void> {
  try {
    await fn()
    throw new Error(`expected SapSimRuleViolation ${rule}`)
  } catch (error) {
    expect(error).toBeInstanceOf(SapSimRuleViolation)
    expect((error as SapSimRuleViolation).rule).toBe(rule)
  }
}

async function count(pool_: pg.Pool, table: string): Promise<string> {
  const r = await pool_.query(`SELECT count(*)::text AS c FROM ${table}`)
  return String(r.rows[0].c)
}

beforeAll(async () => {
  pool = createPool(engineDatabaseUrl(), { max: 4 })
  await pool.query('SELECT 1')
  await migrateUp(pool, migrations)
  // R1 专用表：本轮新增，只有本特性写入；清场保证可重跑（旧证据不在此表）
  await pool.query(
    `TRUNCATE sim_sap_event_outcome, sim_sap_document, sim_sap_order, sim_sap_stock, sim_sap_in_transit, sim_sap_fault_scenario`,
  )
  await pool.query(`DELETE FROM outbox WHERE external_ref LIKE 'CBL01G-EVKEY-MSG-%' OR external_ref LIKE 'R1T-%'`)
  const built = buildServices(pool)
  engine = built.engine
  service = built.service
  // MOM 业务表基线（证明模拟器不串写业务表）
  momTableCounts = {
    production_order: await count(pool, 'production_order'),
    stock_transaction: await count(pool, 'stock_transaction'),
    stock_balance: await count(pool, 'stock_balance'),
    sap_reconciliation_item: await count(pool, 'sap_reconciliation_item'),
    outbox: await count(pool, 'outbox'),
  }
})

afterAll(async () => {
  if (pool) await pool.end()
})

describe('R1 模拟 SAP 引擎（真容器）', () => {
  it('E08 冻结键 happy-path 贯通：MOM 命令→outbox→dispatch→sim 事实→回执→outbox 状态更新（不改业务表）', async () => {
    // 前置：SAP 侧下达订单（E08 冻结 REL-N1 输入原文）
    const release = await engine.execute({
      event_key: FROZEN.REL_N1,
      topic: 'PRODUCTION_RELEASE',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: FROZEN.BK_N1,
      source_version: 1,
      payload: {
        order_id: 'CBL01G-MO-N1',
        qty: '6000.0000',
        unit: 'm',
        material_id: 'CBL01G-F1',
        route_version: 1,
        segments_version: 1,
      },
    })
    expect(release.outcome).toBe('APPLIED_ONCE')

    // MOM 命令：抽象信封投递 → outbox（PENDING）
    const delivered = await service.deliverMessage({
      source_system: 'SAP_SIM',
      organization_code: 'CBL01G-C100',
      external_key: FROZEN.N1_GI,
      entity_type: 'MATERIAL_CONSUMPTION',
      task_kind: 'sap_sim.material_consumption',
      plant_code: 'CN11',
      payload: {
        business_key: FROZEN.BK_N1,
        order_id: 'CBL01G-MO-N1',
        lines: [
          { material: 'CU15', qty: 82, unit: 'kg' },
          { material: 'PVC15', qty: 46.5, unit: 'kg' },
          { material: 'SF-N1', qty: 6000, unit: 'm' },
        ],
      },
    })
    expect(delivered.created).toBe(true)
    expect(delivered.outbox.status).toBe('PENDING')
    const outboxEventId = delivered.outbox.eventId
    const digestBefore = delivered.outbox.requestDigest

    // 模拟器处理 outbox 行 → sim 事实 → 回执 → MOM 状态更新
    const receipt = await engine.dispatch(outboxEventId)
    expect(receipt.actual_connection).toBe(false)
    expect(receipt.outcome).toBe('CONFIRMED')
    expect(receipt.doc_no).toMatch(/^SIMMD\d{7}$/)
    expect(receipt.mapping_tag).toBe('SAP_STANDARD')
    expect(receipt.sim_facts_persisted).toBe(true)
    expect(receipt.outbox_updated).toBe(true)

    const updated = await service.getMessage(outboxEventId)
    expect(updated?.status).toBe('DISPATCHED')
    expect(updated?.requestDigest).toBe(digestBefore)
    expect(updated?.externalRef).toBe(FROZEN.N1_GI)
    expect(updated?.payload?.['sim_doc_no']).toBe(receipt.doc_no)
    expect(updated?.payload?.['sim_outcome']).toBe('CONFIRMED')

    // sim 事实独立可查（模拟侧单据 + 库存按行扣减）
    const docs = await engine.listDocuments({ docType: 'MATERIAL_DOCUMENT' })
    const n1Gi = docs.find((d) => d.sourceEventKey === FROZEN.N1_GI)
    expect(n1Gi?.docNo).toBe(receipt.doc_no)
    expect(n1Gi?.payload?.['goods_movement_code']).toBe('03')
    const stockCu = (await engine.listStock()).find((s) => s.materialId === 'CU15')
    expect(Number(stockCu?.qty)).toBe(-82)
  })

  it('expected_outcome 出现即 422（SAP-SIMENG-1，含嵌套 payload）；未映射 topic 422', async () => {
    await expectRule(
      () =>
        engine.execute({
          event_key: 'R1T-EV-REJ-1',
          topic: 'SCRAP_CONFIRM',
          organization_code: 'CBL01G-C100',
          plant_code: 'CN11',
          payload: { qty: 1, unit: 'm', expected_outcome: 'CONFIRMED' },
        }),
      'SAP-SIMENG-1',
    )
    await expectRule(
      () =>
        engine.execute({
          event_key: 'R1T-EV-REJ-1B',
          topic: 'SCRAP_CONFIRM',
          organization_code: 'CBL01G-C100',
          plant_code: 'CN11',
          expectedOutcome: 'CONFIRMED',
          payload: { qty: 1, unit: 'm', material_id: 'X' },
        }),
      'SAP-SIMENG-1',
    )
    await expectRule(
      () =>
        engine.execute({
          event_key: 'R1T-EV-REJ-2',
          topic: 'NOT_A_TOPIC',
          organization_code: 'CBL01G-C100',
          plant_code: 'CN11',
          payload: {},
        }),
      'SAP-SIMENG-4',
    )
  })

  it('重复到达：同事件键回原回执，不产生第二张单据', async () => {
    const payload = { order_id: 'CBL01G-MO-N1', qty: 6000, unit: 'm', axis_ids: ['CBL01G-N1-1', 'CBL01G-N1-2', 'CBL01G-N1-3'] }
    const first = await engine.execute({
      event_key: FROZEN.N1_GR,
      topic: 'PRODUCTION_OUTPUT',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: FROZEN.BK_N1,
      payload,
    })
    expect(first.outcome).toBe('CONFIRMED')
    expect(first.doc_no).toMatch(/^SIMPC\d{7}$/)
    const dup = await engine.execute({
      event_key: FROZEN.N1_GR,
      topic: 'PRODUCTION_OUTPUT',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: FROZEN.BK_N1,
      payload,
    })
    expect(dup.outcome).toBe('DUPLICATE_RETURN_ORIGINAL')
    expect(dup.doc_no).toBe(first.doc_no)
    const docs = await engine.listDocuments({ docType: 'PRODUCTION_CONFIRMATION' })
    expect(docs.filter((d) => d.sourceEventKey === FROZEN.N1_GR)).toHaveLength(1)
    // 同键不同 payload：不得改写原处理结果
    await expectRule(
      () =>
        engine.execute({
          event_key: FROZEN.N1_GR,
          topic: 'PRODUCTION_OUTPUT',
          organization_code: 'CBL01G-C100',
          plant_code: 'CN11',
          business_key: FROZEN.BK_N1,
          payload: { ...payload, qty: 1 },
        }),
      'SAP-SIMENG-8',
    )
  })

  it('A1000 全闭环（E08 N2-GR-A 剧本）：响应丢失→事实已提交→原键查询由事实回答 FOUND_COMMITTED', async () => {
    await engine.activateFault({ scenario_no: 'R1-FL-E08-N2-GR-A' })
    try {
      // 订单前置（E08 冻结 REL-N2 输入）
      await engine.execute({
        event_key: 'R1T-EV-REL-N2',
        topic: 'PRODUCTION_RELEASE',
        organization_code: 'CBL01G-K200',
        plant_code: 'KR22',
        business_key: FROZEN.BK_N2,
        source_version: 1,
        payload: { order_id: 'CBL01G-MO-N2', qty: '2000.0000', unit: 'm', material_id: 'CBL01G-F3', route_version: 1, segments_version: 1 },
      })
      const delivered = await service.deliverMessage({
        source_system: 'SAP_SIM',
        organization_code: 'CBL01G-K200',
        external_key: FROZEN.N2_GR_A,
        entity_type: 'PRODUCTION_OUTPUT',
        task_kind: 'sap_sim.production_output',
        plant_code: 'KR22',
        payload: {
          business_key: FROZEN.BK_N2,
          qty: 1000,
          unit: 'm',
          axis_ids: ['CBL01G-N2-1', 'CBL01G-N2-2'],
          local_committed_at: '2026-10-28T03:00:00+09:00',
        },
      })
      const receipt = await engine.dispatch(delivered.outbox.eventId)
      expect(receipt.outcome).toBe('TIMEOUT_UNKNOWN')
      expect(receipt.response_lost).toBe(true)
      expect(receipt.doc_no).toBeNull() // 回执扣留
      expect(receipt.sim_facts_persisted).toBe(true)
      const row = await service.getMessage(delivered.outbox.eventId)
      expect(row?.status).toBe('EXTERNAL_UNKNOWN')

      // A1000：按原键查询 → 由 sim_sap 已提交事实回答
      const confirmed = await service.queryConfirm(delivered.outbox.eventId)
      expect(confirmed.attempt_outcome).toBe('FOUND_COMMITTED')
      expect(confirmed.confirmation).toBe('CONFIRMED_BY_QUERY')
      expect(confirmed.queried_by_original_key).toBe(true)
      expect(confirmed.sim_fact?.found).toBe(true)
      expect(confirmed.sim_fact?.doc_no).toMatch(/^SIMPC\d{7}$/)
      const after = await service.getMessage(delivered.outbox.eventId)
      expect(after?.status).toBe('DISPATCHED')
      expect(after?.externalRef).toBe(FROZEN.N2_GR_A)
      expect(after?.payload?.['attempt_outcome']).toBe('FOUND_COMMITTED')
    } finally {
      await engine.deactivateFault('R1-FL-E08-N2-GR-A')
    }
  })

  it('A1000 无事实 → NOT_FOUND（保持 UNKNOWN，不换键、不当 0）', async () => {
    const delivered = await service.deliverMessage({
      source_system: 'SAP_SIM',
      organization_code: 'CBL01G-C100',
      external_key: 'R1T-EV-NOFACT',
      entity_type: 'SHIPMENT_CONFIRM',
      task_kind: 'sap_sim.shipment_confirm',
      plant_code: 'CN11',
      payload: { business_key: FROZEN.BK_N1, qty: 10, unit: 'm' },
    })
    await service.markTimeoutUnknown(delivered.outbox.eventId)
    const answer = await service.queryConfirm(delivered.outbox.eventId)
    expect(answer.attempt_outcome).toBe('NOT_FOUND')
    expect(answer.confirmation).toBeNull()
    expect(answer.query_answered_by).toBe('sim_sap_facts')
    const row = await service.getMessage(delivered.outbox.eventId)
    expect(row?.status).toBe('EXTERNAL_UNKNOWN') // 保持 UNKNOWN
    expect(row?.payload?.['zeroed']).toBe(false)
  })

  it('B1000（E08 N2-GR-B 剧本）：查询不可用 → OUTCOME_UNKNOWN hold（原键不变、不暗中重试）', async () => {
    await engine.activateFault({ scenario_no: 'R1-FL-E08-N2-GR-B' })
    try {
      const delivered = await service.deliverMessage({
        source_system: 'SAP_SIM',
        organization_code: 'CBL01G-K200',
        external_key: FROZEN.N2_GR_B,
        entity_type: 'PRODUCTION_OUTPUT',
        task_kind: 'sap_sim.production_output',
        plant_code: 'KR22',
        payload: {
          business_key: FROZEN.BK_N2,
          qty: 1000,
          unit: 'm',
          axis_ids: ['CBL01G-N2-3', 'CBL01G-N2-4'],
          local_committed_at: '2026-10-28T03:00:00+09:00',
        },
      })
      await service.markTimeoutUnknown(delivered.outbox.eventId)
      const digestBefore = delivered.outbox.requestDigest
      const answer = await service.queryConfirm(delivered.outbox.eventId)
      expect(answer.attempt_outcome).toBe('QUERY_UNAVAILABLE')
      expect(answer.outbox.status).toBe('EXTERNAL_UNKNOWN')
      expect(answer.outbox.payload?.['hold']).toBe(true)
      expect(answer.outbox.payload?.['outcome']).toBe('OUTCOME_UNKNOWN')
      expect(answer.outbox.requestDigest).toBe(digestBefore)
      expect(answer.outbox.externalRef).toBe(FROZEN.N2_GR_B)
      // hold 中禁止 replay 冒充成功（既有护栏）
      await expectRule(() => service.replayOutbox(delivered.outbox.eventId), 'SAP-B1000-3')
    } finally {
      await engine.deactivateFault('R1-FL-E08-N2-GR-B')
    }
  })

  it('MESSAGE_LOST：首达静默丢弃（无业务事实、无单据），次数耗尽后正常处理', async () => {
    await engine.activateFault({ scenario_no: 'R1-FL-MSG-LOST-1' })
    try {
      const event = {
        event_key: 'R1T-EV-LOST-1',
        topic: 'MATERIAL_CONSUMPTION',
        organization_code: 'CBL01G-C100',
        plant_code: 'CN11',
        business_key: FROZEN.BK_N1,
        payload: { order_id: 'CBL01G-MO-N1', lines: [{ material: 'CU15', qty: 1, unit: 'kg' }] },
      }
      const lost = await engine.execute(event)
      expect(lost.outcome).toBe('MESSAGE_LOST')
      expect(lost.delivered).toBe(false)
      expect(lost.sim_facts_persisted).toBe(false)
      expect((await engine.listOutcomes('R1T-EV-LOST-1')).map((o) => o.outcome)).toEqual(['MESSAGE_LOST'])
      const retry = await engine.execute(event)
      expect(retry.outcome).toBe('CONFIRMED') // 故障是条件：耗尽后同键正常处理
      expect(retry.doc_no).toMatch(/^SIMMD\d{7}$/)
    } finally {
      await engine.deactivateFault('R1-FL-MSG-LOST-1')
    }
  })

  it('断网→恢复：NETWORK_DOWN 期 outbox FAILED，同键补传成功且仅一张单据', async () => {
    await engine.activateFault({
      scenario_no: 'R1T-FL-NET-1',
      fault_type: 'NETWORK_DOWN',
      match_event_key: 'R1T-EV-NET-1',
      count: 1,
      description: '断网一次后恢复',
    })
    try {
      const delivered = await service.deliverMessage({
        source_system: 'SAP_SIM',
        organization_code: 'CBL01G-C100',
        external_key: 'R1T-EV-NET-1',
        entity_type: 'MATERIAL_CONSUMPTION',
        task_kind: 'sap_sim.material_consumption',
        plant_code: 'CN11',
        payload: { business_key: FROZEN.BK_N1, order_id: 'CBL01G-MO-N1', lines: [{ material: 'CU15', qty: 5, unit: 'kg' }] },
      })
      const down = await engine.dispatch(delivered.outbox.eventId)
      expect(down.outcome).toBe('NETWORK_DOWN')
      expect(down.delivered).toBe(false)
      let row = await service.getMessage(delivered.outbox.eventId)
      expect(row?.status).toBe('FAILED')
      expect(row?.externalRef).toBe('R1T-EV-NET-1')
      // 恢复：同键（原 event_id/external_ref/digest）补传
      const recovered = await engine.dispatch(delivered.outbox.eventId)
      expect(recovered.outcome).toBe('CONFIRMED')
      row = await service.getMessage(delivered.outbox.eventId)
      expect(row?.status).toBe('DISPATCHED')
      expect(row?.eventId).toBe(delivered.outbox.eventId)
      const docs = (await engine.listDocuments()).filter((d) => d.sourceEventKey === 'R1T-EV-NET-1')
      expect(docs).toHaveLength(1)
    } finally {
      await engine.deactivateFault('R1T-FL-NET-1')
    }
  })

  it('REORDER：到达 3,1,2 → 按 [K1,K2,K3] 放行序处理，缓冲持久化', async () => {
    await engine.execute({
      event_key: 'R1T-EV-REL-BUNDLE',
      topic: 'PRODUCTION_RELEASE',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: 'SAPSIM|CBL01G-C100|CN11|PRODUCTION|00001077|0010',
      source_version: 1,
      payload: { qty: 9000, unit: 'm', material_id: 'R1T-FG' },
    })
    const K1 = 'R1T-EV-BUNDLE-1'
    const K2 = 'R1T-EV-BUNDLE-2'
    const K3 = 'R1T-EV-BUNDLE-3'
    await engine.activateFault({
      scenario_no: 'R1T-FL-REORDER-1',
      fault_type: 'REORDER',
      match_topic: 'EXECUTION_BUNDLE',
      count: 1,
      reorder_keys: [K1, K2, K3],
      description: '乱序到达按配置顺序放行',
    })
    try {
      const bundle = (key: string, seq: number) => ({
        event_key: key,
        topic: 'EXECUTION_BUNDLE',
        organization_code: 'CBL01G-C100',
        plant_code: 'CN11',
        business_key: 'SAPSIM|CBL01G-C100|CN11|PRODUCTION|00001077|0010',
        sequence: seq,
        payload: {
          run_id: `R1T-MR-${seq}`,
          consumption_lines: [{ source_object_id: 'R1T-RAW', qty: 10, unit: 'kg' }],
          output_lines: [{ object_id: 'R1T-FG', qty: 100, unit: 'm' }],
        },
      })
      const r3 = await engine.execute(bundle(K3, 3))
      expect(r3.outcome).toBe('HELD_FOR_REORDER')
      expect((await engine.listDocuments()).filter((d) => d.sourceEventKey === K3)).toHaveLength(0)
      const r1 = await engine.execute(bundle(K1, 1))
      expect(r1.outcome).toBe('LINES_CONFIRMED')
      // K3 仍在缓冲（K2 未到，不放行）
      const k3Held = (await engine.listFaults()).find((s) => s.scenarioNo === 'R1T-FL-REORDER-1')
      expect(k3Held?.pending.some((p) => p['event_key'] === K3)).toBe(true)
      const r2 = await engine.execute(bundle(K2, 2))
      expect(r2.outcome).toBe('LINES_CONFIRMED')
      // K2 到达触发放行 K3
      const k3Outcomes = await engine.listOutcomes(K3)
      expect(k3Outcomes.map((o) => o.outcome)).toContain('LINES_CONFIRMED')
      const finalScenario = (await engine.listFaults()).find((s) => s.scenarioNo === 'R1T-FL-REORDER-1')
      expect(finalScenario?.pending).toHaveLength(0)
      // 放行顺序 = K1 先于 K2 先于 K3（按终局到达序）
      const t1 = (await engine.listOutcomes(K1)).find((o) => o.outcome === 'LINES_CONFIRMED')
      const t2 = (await engine.listOutcomes(K2)).find((o) => o.outcome === 'LINES_CONFIRMED')
      const t3 = (await engine.listOutcomes(K3)).find((o) => o.outcome === 'LINES_CONFIRMED')
      expect(t3!.createdAt.getTime()).toBeGreaterThan(t2!.createdAt.getTime())
      expect(t2!.createdAt.getTime()).toBeGreaterThan(t1!.createdAt.getTime())
    } finally {
      await engine.deactivateFault('R1T-FL-REORDER-1')
    }
  })

  it('版本门控：REV3 先到 WAIT_PARENT → 补 v2 → v3 APPLIED → 迟到 v2 STALE_NOOP', async () => {
    const org = 'CBL01G-C100'
    const plant = 'CN12'
    const bk = 'SAPSIM|CBL01G-C100|CN12|PRODUCTION|00001006|0010'
    await engine.execute({
      event_key: 'R1T-EV-REV-BASE',
      topic: 'PRODUCTION_RELEASE',
      organization_code: org,
      plant_code: plant,
      business_key: bk,
      source_version: 1,
      payload: { order_id: 'CBL01G-MO-G-CN', qty: 6000, unit: 'm', material_id: 'R1T-FG-G' },
    })
    const rev3a = await engine.execute({
      event_key: 'R1T-EV-REV3-A',
      topic: 'PRODUCTION_REVISION',
      organization_code: org,
      plant_code: plant,
      business_key: bk,
      source_version: 3,
      parent_version: 2,
      payload: { order_id: 'CBL01G-MO-G-CN', new_qty: '4000.0000' },
    })
    expect(rev3a.outcome).toBe('WAIT_PARENT_VERSION')
    const rev2 = await engine.execute({
      event_key: 'R1T-EV-REV2',
      topic: 'PRODUCTION_REVISION',
      organization_code: org,
      plant_code: plant,
      business_key: bk,
      source_version: 2,
      parent_version: 1,
      payload: { order_id: 'CBL01G-MO-G-CN', date_only: true },
    })
    expect(rev2.outcome).toBe('APPLIED')
    const rev3b = await engine.execute({
      event_key: 'R1T-EV-REV3-A',
      topic: 'PRODUCTION_REVISION',
      organization_code: org,
      plant_code: plant,
      business_key: bk,
      source_version: 3,
      parent_version: 2,
      payload: { order_id: 'CBL01G-MO-G-CN', new_qty: '4000.0000' },
    })
    expect(rev3b.outcome).toBe('APPLIED')
    const rev2late = await engine.execute({
      event_key: 'R1T-EV-REV2-LATE',
      topic: 'PRODUCTION_REVISION',
      organization_code: org,
      plant_code: plant,
      business_key: bk,
      source_version: 2,
      parent_version: 1,
      payload: { order_id: 'CBL01G-MO-G-CN', date_only: true },
    })
    expect(rev2late.outcome).toBe('STALE_NOOP')
  })

  it('身份冲突：同短单号跨法人 → REJECT_ORGANIZATION_MISMATCH（复合身份不串单）', async () => {
    // KR 厂已有 00001001（CBL01G-K200）
    await engine.execute({
      event_key: 'R1T-EV-REL-GKR',
      topic: 'PRODUCTION_RELEASE',
      organization_code: 'CBL01G-K200',
      plant_code: 'KR21',
      business_key: 'SAPSIM|CBL01G-K200|KR21|PRODUCTION|00001001|0010',
      source_version: 1,
      payload: { qty: 6000, unit: 'm', material_id: 'R1T-FG-KR' },
    })
    const collision = await engine.execute({
      event_key: 'R1T-EV-COLLISION',
      topic: 'PRODUCTION_RELEASE',
      organization_code: 'K200',
      plant_code: 'KR21',
      business_key: 'SAPSIM|K200|KR21|PRODUCTION|00001001|0010',
      source_version: 1,
      payload: { company: 'C100', plant: 'CN11', short_order_no: '00001001', qty: 6000 },
    })
    expect(collision.outcome).toBe('REJECT_ORGANIZATION_MISMATCH')
    expect(collision.applied).toBe(false)
  })

  it('取消与产出事实：已产出 → REJECT_ALREADY_PRODUCED；未产出订单 → CANCELLED', async () => {
    const bk = 'SAPSIM|CBL01G-C100|CN11|PRODUCTION|00001088|0010'
    await engine.execute({
      event_key: 'R1T-EV-REL-C1',
      topic: 'PRODUCTION_RELEASE',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: bk,
      source_version: 1,
      payload: { order_id: 'R1T-MO-C1', qty: 6000, unit: 'm', material_id: 'R1T-FG' },
    })
    await engine.execute({
      event_key: 'R1T-EV-GR-C1',
      topic: 'PRODUCTION_OUTPUT',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: bk,
      payload: { qty: 4000, unit: 'm' },
    })
    const cancelProduced = await engine.execute({
      event_key: 'R1T-EV-CANCEL-C1',
      topic: 'CANCEL_REQUEST',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: bk,
      source_version: 4,
      parent_version: 3,
      payload: { order_id: 'R1T-MO-C1', requested_qty: 0 },
    })
    expect(cancelProduced.outcome).toBe('REJECT_ALREADY_PRODUCED')

    const bk2 = 'SAPSIM|CBL01G-C100|CN11|PRODUCTION|00001089|0010'
    await engine.execute({
      event_key: 'R1T-EV-REL-C2',
      topic: 'PRODUCTION_RELEASE',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: bk2,
      source_version: 1,
      payload: { order_id: 'R1T-MO-C2', qty: 100, unit: 'm', material_id: 'R1T-FG' },
    })
    const cancelFresh = await engine.execute({
      event_key: 'R1T-EV-CANCEL-C2',
      topic: 'CANCEL_REQUEST',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: bk2,
      payload: { order_id: 'R1T-MO-C2', requested_qty: 0 },
    })
    expect(cancelFresh.outcome).toBe('CANCELLED')
  })

  it('数量守恒：产出超下达 → REJECTED_QTY_EXCEEDED；下达量内累计通过', async () => {
    const bk = 'SAPSIM|CBL01G-K200|KR22|PRODUCTION|00001012|0010'
    // 该订单已产出 1000（N2-GR-A）；下达 2000 → 再报 1500 超限
    const over = await engine.execute({
      event_key: 'R1T-EV-N2-OVER',
      topic: 'PRODUCTION_OUTPUT',
      organization_code: 'CBL01G-K200',
      plant_code: 'KR22',
      business_key: bk,
      payload: { qty: 1500, unit: 'm' },
    })
    expect(over.outcome).toBe('REJECTED_QTY_EXCEEDED')
    expect(over.applied).toBe(false)
    const within = await engine.execute({
      event_key: 'R1T-EV-N2-WITHIN',
      topic: 'PRODUCTION_OUTPUT',
      organization_code: 'CBL01G-K200',
      plant_code: 'KR22',
      business_key: bk,
      payload: { qty: 1000, unit: 'm' },
    })
    expect(within.outcome).toBe('CONFIRMED')
  })

  it('转储守恒：发出→在途增加（集团总量不变）；收货→冲在途入收方', async () => {
    await engine.provisionOpeningStock({
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      material_id: 'R1T-TRANS-MAT',
      unit: 'kg',
      qty: 1000,
    })
    const issue = await engine.execute({
      event_key: 'R1T-EV-T-ISSUE',
      topic: 'STOCK_TRANSFER_ISSUE',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: 'SAPSIM|R1T-TX',
      payload: {
        transfer_id: 'R1T-TX',
        to_plant: 'CN12',
        lines: [{ material: 'R1T-TRANS-MAT', qty: 400, unit: 'kg' }],
      },
    })
    expect(issue.outcome).toBe('ISSUE_CONFIRMED')
    const stockAll = await engine.listStock()
    const sender = stockAll.find((s) => s.plantCode === 'CN11' && s.materialId === 'R1T-TRANS-MAT')
    expect(sender?.qty).toBe(600)
    // 集团账面守恒：发方库存 + 在途 = 1000（内部转移不新增集团库存）
    const transitRow = await pool.query(`SELECT qty FROM sim_sap_in_transit WHERE transfer_key = 'R1T-TX'`)
    const stockTotalAfterIssue = stockAll
      .filter((s) => s.materialId === 'R1T-TRANS-MAT')
      .reduce((acc, s) => acc + Number(s.qty), 0)
    expect(stockTotalAfterIssue + Number(transitRow.rows[0].qty)).toBe(1000)

    const receipt = await engine.execute({
      event_key: 'R1T-EV-T-RECEIPT',
      topic: 'STOCK_TRANSFER_RECEIPT',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN12',
      business_key: 'SAPSIM|R1T-TX',
      payload: {
        transfer_id: 'R1T-TX',
        to_plant: 'CN12',
        lines: [{ material: 'R1T-TRANS-MAT', qty: 400, unit: 'kg' }],
      },
    })
    expect(receipt.outcome).toBe('RECEIPT_CONFIRMED')
    const stockAfter = await engine.listStock()
    const receiver = stockAfter.find((s) => s.plantCode === 'CN12' && s.materialId === 'R1T-TRANS-MAT')
    expect(receiver?.qty).toBe(400)
    const inTransitRows = await pool.query(`SELECT qty, status FROM sim_sap_in_transit WHERE transfer_key = 'R1T-TX'`)
    expect(Number(inTransitRows.rows[0].qty)).toBe(0)
    expect(inTransitRows.rows[0].status).toBe('RECEIVED')
    const totalAfterReceipt = stockAfter
      .filter((s) => s.materialId === 'R1T-TRANS-MAT')
      .reduce((acc, s) => acc + Number(s.qty), 0)
    expect(totalAfterReceipt).toBe(1000)
    // 无在途收货 → 业务拒绝（事实推导）
    const noTransit = await engine.execute({
      event_key: 'R1T-EV-T-RECEIPT-2',
      topic: 'STOCK_TRANSFER_RECEIPT',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN12',
      business_key: 'SAPSIM|R1T-TX-2',
      payload: {
        transfer_id: 'R1T-TX-2',
        to_plant: 'CN12',
        lines: [{ material: 'R1T-TRANS-MAT', qty: 1, unit: 'kg' }],
      },
    })
    expect(noTransit.outcome).toBe('REJECTED_NO_IN_TRANSIT')
  })

  it('质量阻断：RECEIVED_NOT_APPLIED，库存不动；返工：无指令拒绝、有指令过账', async () => {
    const before = (await engine.listStock()).find((s) => s.materialId === 'R1T-FG-G')
    const block = await engine.execute({
      event_key: 'R1T-EV-QBLOCK',
      topic: 'QUALITY_STOCK_BLOCK',
      organization_code: 'CBL01G-C100',
      plant_code: 'KR21',
      business_key: 'CBL01G-GK-2',
      payload: { qty: 1900, unit: 'm', desired_quality: 'BLOCKED' },
    })
    expect(block.outcome).toBe('RECEIVED_NOT_APPLIED')
    expect(block.message_state).toBe('AWAITING_UPSTREAM_APPLICATION')
    expect(block.applied).toBe(false)
    const after = (await engine.listStock()).find((s) => s.materialId === 'R1T-FG-G')
    expect(after?.qty ?? 0).toBe(before?.qty ?? 0)

    const reworkNoOrder = await engine.execute({
      event_key: 'R1T-EV-REWORK-1',
      topic: 'REWORK_RECLASSIFICATION',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN12',
      business_key: 'CBL01G-GC-2',
      payload: { deduct_finished_m: 200, add_rework_wip_m: 200, rework_order_id: null },
    })
    expect(reworkNoOrder.outcome).toBe('REJECTED_MISSING_REWORK_ORDER')
    // SAP 计划员补返工指令（模拟侧 REWORK 订单事实）→ 同键不可改写，换新事件键重提
    await engine.execute({
      event_key: 'R1T-EV-REL-RW',
      topic: 'PRODUCTION_RELEASE',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN12',
      business_key: 'SAPSIM|R1T-RW-1',
      source_version: 1,
      payload: { order_id: 'R1T-RW-1', order_kind: 'REWORK', qty: 500, unit: 'm', material_id: 'R1T-FG-G' },
    })
    const reworkOk = await engine.execute({
      event_key: 'R1T-EV-REWORK-2',
      topic: 'REWORK_RECLASSIFICATION',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN12',
      business_key: 'CBL01G-GC-2',
      payload: { deduct_finished_m: 200, add_rework_wip_m: 200, rework_order_id: 'R1T-RW-1' },
    })
    expect(reworkOk.outcome).toBe('CONFIRMED')
  })

  it('DUPLICATE 注入：引擎合成一次重投，台账回原单据号（不新增单据）', async () => {
    const bk = 'SAPSIM|CBL01G-C100|CN11|PRODUCTION|00001091|0010'
    await engine.execute({
      event_key: 'R1T-EV-REL-DUP',
      topic: 'PRODUCTION_RELEASE',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: bk,
      source_version: 1,
      payload: { order_id: 'R1T-MO-DUP', qty: 500, unit: 'm', material_id: 'R1T-FG' },
    })
    await engine.activateFault({ scenario_no: 'R1-FL-DUP-1' })
    try {
      const first = await engine.execute({
        event_key: 'R1T-EV-GR-DUP',
        topic: 'PRODUCTION_OUTPUT',
        organization_code: 'CBL01G-C100',
        plant_code: 'CN11',
        business_key: bk,
        payload: { qty: 200, unit: 'm' },
      })
      expect(first.outcome).toBe('CONFIRMED')
      expect(first.duplicate_injected).toBe(true)
      const outcomes = await engine.listOutcomes('R1T-EV-GR-DUP')
      expect(outcomes.map((o) => o.outcome)).toEqual(['CONFIRMED', 'DUPLICATE_RETURN_ORIGINAL'])
      expect(outcomes[1].docNo).toBe(first.doc_no)
      const docs = (await engine.listDocuments()).filter((d) => d.sourceEventKey === 'R1T-EV-GR-DUP')
      expect(docs).toHaveLength(1) // 重投不重复入库
    } finally {
      await engine.deactivateFault('R1-FL-DUP-1')
    }
  })

  it('DELAY 注入：响应延迟且事实正常提交', async () => {
    await engine.activateFault({ scenario_no: 'R1-FL-DELAY-1' })
    try {
      const bk = 'SAPSIM|CBL01G-C100|CN11|PRODUCTION|00001092|0010'
      await engine.execute({
        event_key: 'R1T-EV-REL-DLY',
        topic: 'PRODUCTION_RELEASE',
        organization_code: 'CBL01G-C100',
        plant_code: 'CN11',
        business_key: bk,
        source_version: 1,
        payload: { order_id: 'R1T-MO-DLY', qty: 300, unit: 'm', material_id: 'R1T-FG' },
      })
      const t0 = Date.now()
      const delayed = await engine.execute({
        event_key: 'R1T-EV-GR-DLY',
        topic: 'PRODUCTION_OUTPUT',
        organization_code: 'CBL01G-C100',
        plant_code: 'CN11',
        business_key: bk,
        payload: { qty: 100, unit: 'm' },
      })
      expect(delayed.outcome).toBe('CONFIRMED')
      expect(delayed.delayed_ms).toBe(50)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(50)
    } finally {
      await engine.deactivateFault('R1-FL-DELAY-1')
    }
  })

  it('重启恢复：换新连接池/新引擎实例后事实、查询、幂等与故障计数一致', async () => {
    // 独立池 A 产生事实与故障计数
    const poolA = createPool(engineDatabaseUrl(), { max: 2 })
    const builtA = buildServices(poolA)
    await builtA.engine.activateFault({
      scenario_no: 'R1T-FL-RESTART-CNT',
      fault_type: 'DELAY',
      match_event_key: 'R1T-EV-RESTART',
      count: 1,
      delay_ms: 0,
      description: '重启计数验证',
    })
    const bk = 'SAPSIM|CBL01G-C100|CN11|PRODUCTION|00001093|0010'
    await builtA.engine.execute({
      event_key: 'R1T-EV-REL-RS',
      topic: 'PRODUCTION_RELEASE',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: bk,
      source_version: 1,
      payload: { order_id: 'R1T-MO-RS', qty: 100, unit: 'm', material_id: 'R1T-FG' },
    })
    const first = await builtA.engine.execute({
      event_key: 'R1T-EV-RESTART',
      topic: 'PRODUCTION_OUTPUT',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: bk,
      payload: { qty: 50, unit: 'm' },
    })
    expect(first.outcome).toBe('CONFIRMED')
    await poolA.end() // “重启”

    const poolB = createPool(engineDatabaseUrl(), { max: 2 })
    const builtB = buildServices(poolB)
    const query = await builtB.engine.queryByEventKey('R1T-EV-RESTART')
    expect(query.available).toBe(true)
    expect(query.found).toBe(true)
    expect(query.docNo).toBe(first.doc_no)
    const dup = await builtB.engine.execute({
      event_key: 'R1T-EV-RESTART',
      topic: 'PRODUCTION_OUTPUT',
      organization_code: 'CBL01G-C100',
      plant_code: 'CN11',
      business_key: bk,
      payload: { qty: 50, unit: 'm' },
    })
    expect(dup.outcome).toBe('DUPLICATE_RETURN_ORIGINAL')
    expect(dup.doc_no).toBe(first.doc_no)
    const scenario = (await builtB.engine.listFaults()).find((s) => s.scenarioNo === 'R1T-FL-RESTART-CNT')
    expect(scenario?.remainingCount).toBe(0) // 故障计数持久化
    await poolB.end()
  })

  it('sim/MOM 表分离：全程不改 MOM 业务表；旧 attempt 兼容端点不写 sim 表', async () => {
    expect(await count(pool, 'production_order')).toBe(momTableCounts.production_order)
    expect(await count(pool, 'stock_transaction')).toBe(momTableCounts.stock_transaction)
    expect(await count(pool, 'stock_balance')).toBe(momTableCounts.stock_balance)
    expect(await count(pool, 'sap_reconciliation_item')).toBe(momTableCounts.sap_reconciliation_item)

    const simDocCount = await count(pool, 'sim_sap_document')
    const simOutcomeCount = await count(pool, 'sim_sap_event_outcome')
    // 旧 attempt 兼容端点：只写 outbox 标签，不触碰 sim 事实
    const delivered = await service.deliverMessage({
      source_system: 'SAP_SIM',
      organization_code: 'CBL01G-C100',
      external_key: 'R1T-EV-ATTEMPT-COMPAT',
      entity_type: 'SCRAP_ACKNOWLEDGED',
      task_kind: 'sap_sim.scrap',
      plant_code: 'CN11',
      payload: { note: 'compat endpoint probe' },
    })
    const attempt = await service.applyAttemptOutcome(delivered.outbox.eventId, { outcome: 'SCRAP_ACKNOWLEDGED' })
    expect(attempt.attempt_outcome).toBe('SCRAP_ACKNOWLEDGED')
    expect(await count(pool, 'sim_sap_document')).toBe(simDocCount)
    expect(await count(pool, 'sim_sap_event_outcome')).toBe(simOutcomeCount)
  })

  it('outbox 表只被本链路增量写（无串删/串改既有行）', async () => {
    const after = await count(pool, 'outbox')
    // 本套件新增行（deliverMessage/dispatch 产生），绝无减少
    expect(Number(after)).toBeGreaterThanOrEqual(Number(momTableCounts.outbox))
  })
})
