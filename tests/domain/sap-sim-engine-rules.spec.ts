import { describe, expect, it } from 'vitest'
import {
  SAP_SIM_FAULT_TYPES,
  SAP_SIM_FORBIDDEN_OUTCOME_INPUT_FIELDS,
  SAP_SIM_MAPPED_TOPICS,
  SAP_SIM_TOPIC_OPERATION_MAP,
  SapSimRuleViolation,
  assertSapSimBusinessEvent,
  assertSapSimFaultScenarioConfig,
  faultScenarioMatches,
  findSapSimTopicMapping,
  formatSimSapDocumentNo,
  sha256OfPayload,
} from '@cadenza/domain'

/** R1 模拟 SAP 引擎 domain 规则：输入契约（expected_outcome 拒收）、映射标注、故障配置校验。 */

const BASE_EVENT = {
  event_key: 'R1U-EV-1',
  topic: 'MATERIAL_CONSUMPTION',
  organization_code: 'CBL01G-C100',
  plant_code: 'CN11',
  business_key: 'SAPSIM|CBL01G-C100|CN11|PRODUCTION|00001001|0010',
  payload: { order_id: 'CBL01G-MO-N1', qty: 1, unit: 'm' },
}

function expectViolation(fn: () => unknown, rule: string): void {
  try {
    fn()
    throw new Error('expected SapSimRuleViolation')
  } catch (error) {
    expect(error).toBeInstanceOf(SapSimRuleViolation)
    expect((error as SapSimRuleViolation).rule).toBe(rule)
  }
}

describe('R1 sim engine domain rules', () => {
  it('expected_outcome 族字段出现即拒（SAP-SIMENG-1）——输出不可由调用方申报', () => {
    for (const field of ['expected_outcome', 'expectedOutcome', 'outcome', 'attempt_outcome', 'declared_outcome', 'declaredOutcome']) {
      expectViolation(() => assertSapSimBusinessEvent({ ...BASE_EVENT, [field]: 'CONFIRMED' }), 'SAP-SIMENG-1')
    }
    expect(SAP_SIM_FORBIDDEN_OUTCOME_INPUT_FIELDS.length).toBeGreaterThanOrEqual(9)
  })

  it('合法业务事件通过并归一（版本/序列可选）', () => {
    const event = assertSapSimBusinessEvent({
      ...BASE_EVENT,
      source_version: 2,
      parent_version: 1,
      sequence: '3',
    })
    expect(event.eventKey).toBe('R1U-EV-1')
    expect(event.sourceVersion).toBe(2)
    expect(event.parentVersion).toBe(1)
    expect(event.sequence).toBe(3)
    expect(event.payload['order_id']).toBe('CBL01G-MO-N1')
  })

  it('缺必填字段（event_key/topic/org/plant）分别 422', () => {
    expectViolation(() => assertSapSimBusinessEvent({ ...BASE_EVENT, event_key: '' }), 'SAP-SIMENG-2')
    expectViolation(() => assertSapSimBusinessEvent({ ...BASE_EVENT, topic: '' }), 'SAP-SIMENG-3')
    expectViolation(() => assertSapSimBusinessEvent({ ...BASE_EVENT, organization_code: '' }), 'SAP-SIMENG-5')
    expectViolation(() => assertSapSimBusinessEvent({ ...BASE_EVENT, plant_code: '' }), 'SAP-SIMENG-5')
  })

  it('未映射 topic 拒（SAP-SIMENG-4）；映射表覆盖冻结 topic 且逐条标注', () => {
    expectViolation(() => assertSapSimBusinessEvent({ ...BASE_EVENT, topic: 'NOT_IN_SUBSET' }), 'SAP-SIMENG-4')
    expect(findSapSimTopicMapping('NOT_IN_SUBSET')).toBeNull()
    const tags = new Set(['SAP_STANDARD', 'CADENZA_EXTENSION', 'SIM_ASSUMPTION'])
    for (const m of SAP_SIM_TOPIC_OPERATION_MAP) {
      expect(tags.has(m.mapping_tag)).toBe(true)
      expect(m.sap_api.length).toBeGreaterThan(0)
      expect(m.handler.length).toBeGreaterThan(0)
    }
    // 冻结 56 消息出现的 15 个 topic 全部在映射内
    expect(SAP_SIM_MAPPED_TOPICS).toEqual(
      expect.arrayContaining([
        'PRODUCTION_RELEASE', 'PRODUCTION_REVISION', 'MASTER_VERSION_BUNDLE',
        'MATERIAL_CONSUMPTION', 'PRODUCTION_OUTPUT', 'INTERMEDIATE_OUTPUT',
        'STOCK_TRANSFER_ISSUE', 'STOCK_TRANSFER_RECEIPT', 'SHIPMENT_CONFIRM',
        'SCRAP_CONFIRM', 'QUANTITY_RECONCILIATION', 'EXECUTION_BUNDLE',
        'QUALITY_STOCK_BLOCK', 'REWORK_RECLASSIFICATION', 'CANCEL_REQUEST',
      ]),
    )
    expect(SAP_SIM_MAPPED_TOPICS).toHaveLength(15)
  })

  it('故障场景配置校验：类型/匹配/次数/延迟/乱序顺序', () => {
    expectViolation(
      () => assertSapSimFaultScenarioConfig({ scenario_no: 'S1', fault_type: 'NOPE', match_topic: 'T', count: 1 }),
      'SAP-SIMENG-6',
    )
    expectViolation(
      () => assertSapSimFaultScenarioConfig({ scenario_no: 'S1', fault_type: 'DELAY', count: 1 }),
      'SAP-SIMENG-6',
    )
    expectViolation(
      () => assertSapSimFaultScenarioConfig({ scenario_no: 'S1', fault_type: 'DELAY', match_topic: 'T', count: -1 }),
      'SAP-SIMENG-6',
    )
    expectViolation(
      () =>
        assertSapSimFaultScenarioConfig({ scenario_no: 'S1', fault_type: 'DELAY', match_topic: 'T', count: 1, delay_ms: 9000 }),
      'SAP-SIMENG-6',
    )
    expectViolation(
      () => assertSapSimFaultScenarioConfig({ scenario_no: 'S1', fault_type: 'REORDER', match_topic: 'T', count: 1 }),
      'SAP-SIMENG-6',
    )
    const ok = assertSapSimFaultScenarioConfig({
      scenario_no: 'S1',
      fault_type: 'REORDER',
      match_topic: 'EXECUTION_BUNDLE',
      count: 1,
      reorder_keys: ['K1', 'K2', 'K3'],
    })
    expect(ok.reorder_keys).toEqual(['K1', 'K2', 'K3'])
    expect(SAP_SIM_FAULT_TYPES).toHaveLength(8)
  })

  it('faultScenarioMatches：事件键精确匹配 / topic 匹配 / 非活动不命中', () => {
    const scenario = { faultType: 'RESPONSE_LOST', matchEventKey: 'K-1', matchTopic: null, active: true }
    expect(faultScenarioMatches(scenario, { eventKey: 'K-1', topic: 'X' })).toBe(true)
    expect(faultScenarioMatches(scenario, { eventKey: 'K-2', topic: 'X' })).toBe(false)
    const byTopic = { faultType: 'DELAY', matchEventKey: null, matchTopic: 'PRODUCTION_OUTPUT', active: true }
    expect(faultScenarioMatches(byTopic, { eventKey: 'A', topic: 'PRODUCTION_OUTPUT' })).toBe(true)
    expect(faultScenarioMatches({ ...byTopic, active: false }, { eventKey: 'A', topic: 'PRODUCTION_OUTPUT' })).toBe(false)
  })

  it('payload 哈希稳定（键序无关）；单据号格式为 SIM 前缀+7 位号码段', () => {
    const a = sha256OfPayload({ qty: 1, unit: 'm', material: 'X' })
    const b = sha256OfPayload({ material: 'X', unit: 'm', qty: 1 })
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
    expect(formatSimSapDocumentNo('MATERIAL_DOCUMENT', 1)).toBe('SIMMD0000001')
    expect(formatSimSapDocumentNo('PRODUCTION_CONFIRMATION', 42)).toBe('SIMPC0000042')
  })
})
