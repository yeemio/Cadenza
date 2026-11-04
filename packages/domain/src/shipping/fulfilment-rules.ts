import { cmpQty, isPositiveQty, isValidQuantityString } from '../inventory/quantity'
import { ShippingRuleViolation } from './errors'

/** All fields are server-loaded facts; explicit row selection grants no bypass. */
export function assertShipmentPhysicalMatch(input: {
  unitNo: string
  unitEnterpriseId: string
  unitPlantId: string
  unitMaterialId: string
  unitMaterialCode: string
  unitUomCode: string
  balanceUomCode: string
  balanceQuantity: string
  actualSegmentLength: string | null
  origin: { enterpriseId: string; plantId: string; materialId: string; salesOrderNo: string; salesOrderLineNo: string; uomCode: string } | null
  order: { enterpriseId: string; plantId: string; salesOrderNo: string }
  line: { materialId: string | null; materialCode: string; salesOrderLineNo: string; lineKind: string; segmentLength: string | null }
  claimedSegmentLength?: string
}): void {
  const fail = (message: string): never => { throw new ShippingRuleViolation('A-T14-FULFILMENT', `单元 ${input.unitNo}：${message}`) }
  const origin = input.origin
  if (origin === null) fail('实际销售归属 UNKNOWN/不唯一；须提供受验证的产出/谱系，不能凭指定行放行')
  if (input.unitEnterpriseId !== input.order.enterpriseId || input.unitPlantId !== input.order.plantId ||
      origin!.enterpriseId !== input.unitEnterpriseId || origin!.plantId !== input.unitPlantId) fail('实际企业/工厂与发货单不一致')
  if (input.unitMaterialCode !== input.line.materialCode ||
      (input.line.materialId !== null && input.line.materialId !== input.unitMaterialId) || origin!.materialId !== input.unitMaterialId) fail('实际料品与商业行不一致')
  if (origin!.salesOrderNo !== input.order.salesOrderNo || origin!.salesOrderLineNo !== input.line.salesOrderLineNo) fail('实际销售订单/行归属不匹配')
  if (origin!.uomCode !== input.balanceUomCode || input.unitUomCode !== input.balanceUomCode) fail('产出与现存量计量单位不一致，未获换算依据')
  const actual = input.actualSegmentLength
  if (!isValidQuantityString(actual) || !isPositiveQty(actual)) fail('没有真实正段长')
  if (!isValidQuantityString(input.balanceQuantity) || !isPositiveQty(input.balanceQuantity) || cmpQty(input.balanceQuantity, actual!) !== 0) fail('当前实物数量与真实段长不一致；整码出库不能吞掉额外数量或以不足量充数')
  if (input.line.lineKind !== 'pallet' && (!isValidQuantityString(input.line.segmentLength) ||
      !isPositiveQty(input.line.segmentLength) || cmpQty(input.line.segmentLength, actual!) !== 0)) fail('实际段长与下达的商业行快照不一致')
  if (input.claimedSegmentLength !== undefined && (!isValidQuantityString(input.claimedSegmentLength) || cmpQty(input.claimedSegmentLength, actual!) !== 0)) fail('客户端/历史扫码段长与当前真实段长不一致')
}

/** Every counted physical item must resolve exactly once, including supplementary scans. */
export function assertShipmentScanCoverage(lines: readonly { id: string; requiredCount: number; scannedCount: number }[],
  scans: readonly { lineId: string; unitId: string | null }[]): void {
  if (lines.length === 0 || scans.length === 0) throw new ShippingRuleViolation('A-T14-FULFILMENT', '发货单没有可出库的真实实物')
  const lineIds = new Set(lines.map((l) => l.id)); const units = new Set<string>()
  for (const s of scans) {
    if (!lineIds.has(s.lineId) || s.unitId === null) throw new ShippingRuleViolation('A-T14-FULFILMENT', '扫码商业行或库存身份未解析，禁止完成出库')
    if (units.has(s.unitId)) throw new ShippingRuleViolation('A-T14-FULFILMENT', '同一库存单元被重复计作多个实物，禁止出库')
    units.add(s.unitId)
  }
  for (const line of lines) {
    const count = scans.filter((s) => s.lineId === line.id).length
    if (!Number.isInteger(line.requiredCount) || line.requiredCount < 1 || count !== line.requiredCount || count !== line.scannedCount) {
      throw new ShippingRuleViolation('A-T14-FULFILMENT', `商业行 ${line.id} 的实物数、应扫数和登记数不一致`)
    }
  }
}
