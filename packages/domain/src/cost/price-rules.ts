import { CostRuleViolation } from './errors'
import { parseScaled } from './decimals'

/**
 * 材料价格版本规则（CE-14 价格版本化、价格主权归上游只引用标版本、缺价不得填默认价格）。
 */

/** 价格取数来源（CE-14：标准成本 / ERP 采购实际价——价格主权归上游，本系统只引用）。 */
export const PRICE_SOURCES = ['standard_cost', 'erp_actual'] as const
export type PriceSource = (typeof PRICE_SOURCES)[number]

export interface PriceItemInput {
  materialCode: string
  unitPrice: string
  uomCode: string
}

export interface PriceVersionShapeInput {
  versionNo: number
  priceSource: string
  items: readonly PriceItemInput[]
}

/** CE-14/CE-S1：价格版本形状（来源枚举、单价>0、料品不重复、单位非空）。 */
export function assertPriceVersionShape(input: PriceVersionShapeInput): void {
  if (!Number.isInteger(input.versionNo) || input.versionNo < 1) {
    throw new CostRuleViolation('CE-14', `价格版本号必须为正整数：${String(input.versionNo)}`)
  }
  if (!PRICE_SOURCES.includes(input.priceSource as PriceSource)) {
    throw new CostRuleViolation('CE-14', `价格来源必须为 standard_cost/erp_actual：${input.priceSource}`)
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new CostRuleViolation('CE-14', '价格版本必须包含至少一行价格行（items）')
  }
  const seen = new Set<string>()
  for (const item of input.items) {
    if (typeof item.materialCode !== 'string' || item.materialCode === '') {
      throw new CostRuleViolation('CE-14', '价格行料品编码必填（materialCode）')
    }
    if (seen.has(item.materialCode)) {
      throw new CostRuleViolation('CE-14', `价格行料品重复：${item.materialCode}（同版本同料品一行）`)
    }
    seen.add(item.materialCode)
    if (typeof item.unitPrice !== 'string' || parseScaled(item.unitPrice, 'CE-14', 6) <= 0n) {
      throw new CostRuleViolation('CE-14', `价格行单价必须为正十进制字符串：${item.materialCode}=${String(item.unitPrice)}`)
    }
    if (typeof item.uomCode !== 'string' || item.uomCode === '') {
      throw new CostRuleViolation('CE-14', '价格行单位必填（uomCode）')
    }
  }
}

export interface ResolvedPrice {
  unitPrice: string
  uomCode: string
}

/**
 * CE-14：按料品取价。命中 → 单价+单位；未命中 → 返回 null（调用方标 price_missing，
 * 成本行列示数量＋缺价标注；**不得填默认价格**——null 是唯一缺价表达）。
 */
export function resolvePriceForMaterial(
  items: readonly PriceItemInput[],
  materialCode: string,
): ResolvedPrice | null {
  const hit = items.find((i) => i.materialCode === materialCode)
  if (hit === undefined) return null
  return { unitPrice: hit.unitPrice, uomCode: hit.uomCode }
}
