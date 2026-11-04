import { describe, expect, it } from 'vitest'
import { assertShipmentPhysicalMatch, assertShipmentScanCoverage, ShippingRuleViolation } from '@cadenza/domain'

const valid = () => ({
  unitNo: 'REAL-U1', unitEnterpriseId: 'E1', unitPlantId: 'P1', unitMaterialId: 'M1', unitMaterialCode: 'COPPER',
  unitUomCode: 'M', balanceUomCode: 'M', balanceQuantity: '20.0000', actualSegmentLength: '20.0000',
  origin: { enterpriseId: 'E1', plantId: 'P1', materialId: 'M1', salesOrderNo: 'SO1', salesOrderLineNo: '10', uomCode: 'M' },
  order: { enterpriseId: 'E1', plantId: 'P1', salesOrderNo: 'SO1' },
  line: { materialId: 'M1', materialCode: 'COPPER', salesOrderLineNo: '10', lineKind: 'plain_item', segmentLength: '20.0000' },
})
describe('PR04 server physical facts must match the commercial line', () => {
  for (const lineKind of ['plain_item', 'axis_item', 'pallet']) it(`accepts a verified ${lineKind} physical item`, () => {
    const input = valid(); input.line.lineKind = lineKind
    expect(() => assertShipmentPhysicalMatch(input)).not.toThrow()
  })
  it('accepts equal decimal strings without float conversion', () => {
    expect(() => assertShipmentPhysicalMatch({ ...valid(), claimedSegmentLength: '20' })).not.toThrow()
  })
  it('rejects unknown sales ownership even with a selected line', () => {
    expect(() => assertShipmentPhysicalMatch({ ...valid(), origin: null })).toThrow('UNKNOWN')
  })
  const mutations: Array<[string, (x: ReturnType<typeof valid>) => void]> = [
    ['enterprise', x => { x.unitEnterpriseId = 'E2' }], ['plant', x => { x.unitPlantId = 'P2' }],
    ['origin plant', x => { x.origin.plantId = 'P2' }], ['material ID', x => { x.unitMaterialId = 'M2' }],
    ['material code', x => { x.unitMaterialCode = 'STEEL' }], ['origin material', x => { x.origin.materialId = 'M2' }],
    ['sales order', x => { x.origin.salesOrderNo = 'SO2' }], ['sales line', x => { x.origin.salesOrderLineNo = '20' }],
    ['unit UOM', x => { x.unitUomCode = 'KG' }], ['origin UOM', x => { x.origin.uomCode = 'KG' }],
    ['commercial length', x => { x.line.segmentLength = '19' }], ['partial quantity', x => { x.balanceQuantity = '19' }],
    ['extra quantity', x => { x.balanceQuantity = '21' }], ['zero segment', x => { x.actualSegmentLength = '0' }],
    ['malformed segment', x => { x.actualSegmentLength = 'NaN' }],
  ]
  for (const [name, mutate] of mutations) it(`rejects ${name} mismatch`, () => {
    const input = valid(); mutate(input); expect(() => assertShipmentPhysicalMatch(input)).toThrow(ShippingRuleViolation)
  })
  it('rejects a fabricated client length', () => {
    expect(() => assertShipmentPhysicalMatch({ ...valid(), claimedSegmentLength: '19' })).toThrow('客户端')
  })
})
describe('PR04 every registered count needs one unique physical item', () => {
  const lines = [{ id: 'L1', requiredCount: 2, scannedCount: 2 }]
  it('accepts a load and a resolved supplementary unit', () => {
    expect(() => assertShipmentScanCoverage(lines, [{ lineId: 'L1', unitId: 'U1' }, { lineId: 'L1', unitId: 'U2' }])).not.toThrow()
  })
  it('rejects unresolved supplementary registration', () => {
    expect(() => assertShipmentScanCoverage(lines, [{ lineId: 'L1', unitId: 'U1' }, { lineId: 'L1', unitId: null }])).toThrow('未解析')
  })
  it('rejects double-counting one unit', () => {
    expect(() => assertShipmentScanCoverage(lines, [{ lineId: 'L1', unitId: 'U1' }, { lineId: 'L1', unitId: 'U1' }])).toThrow('重复')
  })
  it('rejects a forged progress counter with too few physical scans', () => {
    expect(() => assertShipmentScanCoverage(lines, [{ lineId: 'L1', unitId: 'U1' }])).toThrow('不一致')
  })
  it('rejects a scan belonging to another line', () => {
    expect(() => assertShipmentScanCoverage(lines, [{ lineId: 'L2', unitId: 'U1' }, { lineId: 'L1', unitId: 'U2' }])).toThrow('商业行')
  })
  it('rejects an empty shipment', () => { expect(() => assertShipmentScanCoverage([], [])).toThrow('真实实物') })
})
