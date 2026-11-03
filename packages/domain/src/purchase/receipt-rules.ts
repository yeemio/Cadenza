import type { DecimalString } from '@cadenza/contracts'
// 包内子目录引用被过宽的包逃逸 eslint 规则误伤（同 trace/genealogy.ts 先例，不逃逸出 domain 包）。
// eslint-disable-next-line no-restricted-imports
import { addQty, cmpQty, isPositiveQty, isValidQuantityString, mulQtyByUint, subQty } from '../inventory/quantity'
// eslint-disable-next-line no-restricted-imports
import { sumQty } from '../inventory/posting'
import { PurchaseRuleViolation } from './errors'

/**
 * 采购收货扫码/确认规则 [底稿 A-2 / A-3 / A-5]（PRD 采购批次 §3.1）。
 *
 * [A-2] 分批收货：原料行只收 R 码、成品行只收 E/F 码；空码校验=码已存在非采购收货来源记录则拒绝；
 *       同码允许多次收货（PI S13 一码多批合法）。
 * [A-3] 明细唯一键：同一收货单内「二维码+厂家批号+牌号/线径」三元组唯一；同批次入库仓库一致；
 *       同厂家批号生产日期一致；数量>0；已收+本次>采购上限整单拒绝。
 * [A-5] 包装换算：收货总量=包装单位总量×码数，换算项引用后不可改、变更走新版本。
 */

/** 物料分类（0003 material.material_type，PRD 料品管理 §1 字典：1 原材料 / 2 半成品 / 3 成品）。 */
export type PurchaseMaterialType = 1 | 2 | 3

/** 扫码码型判定（PRD 采购批次 §3.1 扫码：R 原材料 / E 自制成品 / F 外购成品）。 */
export type PurchaseBarcodeKind = 'raw_material' | 'finished_goods' | 'unknown'

export function guessPurchaseBarcodeKind(barcodeValue: string): PurchaseBarcodeKind {
  if (/^R[0-9A-Za-z]{9}$/.test(barcodeValue)) return 'raw_material'
  if (/^E[0-9A-Za-z]{9}$/.test(barcodeValue) || /^F[0-9A-Za-z]{9}$/.test(barcodeValue)) {
    return 'finished_goods'
  }
  return 'unknown'
}

/**
 * [A-2] 码型与订单行物料分类匹配：收原料的行只接受 R 码，收成品的行只接受 E/F 码
 * （半成品按原料口径收 R 码；PRD 扫码文案口径）。
 * 料品类型字典以 PRD 料品管理 §1 为准：1=原材料 / 2=半成品 / 3=成品
 * （R2 修复：原实现误按 1原料/2成品/3半成品 取值，成品行(3)被当原料行、半成品行(2)被当成品行）。
 */
export function assertBarcodeKindMatchesMaterialType(input: {
  barcodeValue: string
  materialType: number
}): void {
  const kind = guessPurchaseBarcodeKind(input.barcodeValue)
  const rawLine = input.materialType === 1 || input.materialType === 2
  if (rawLine && kind !== 'raw_material') {
    throw new PurchaseRuleViolation(
      'A-2',
      `收原料只能扫描 R 类型（原材料）料品码，拒收 ${input.barcodeValue}`,
    )
  }
  if (!rawLine && kind !== 'finished_goods') {
    throw new PurchaseRuleViolation(
      'A-2',
      `收成品只能扫描 E/F 类型（自制成品/外购成品）料品码，拒收 ${input.barcodeValue}`,
    )
  }
  if (kind === 'unknown') {
    throw new PurchaseRuleViolation('A-2', `请扫描 E/F/R 类型料品二维码，拒收 ${input.barcodeValue}`)
  }
}

/** 明细三元组键（空值规范化为空串，与 0006 唯一约束 COALESCE 语义一致）。 */
export function detailTripleKey(input: {
  barcodeValue: string
  supplierLotNo?: string | null
  grade?: string | null
}): string {
  return `${input.barcodeValue}\u0000${input.supplierLotNo ?? ''}\u0000${input.grade ?? ''}`
}

export interface ReceiptDetailInput {
  barcodeValue: string
  supplierLotNo?: string | null
  grade?: string | null
  productionDate?: string | null
  /** 每行数量（=包装单位总量，PRD 扫码录入 §逻辑「每行收货数量 = 包装单位总量」） */
  quantity: DecimalString
  locationId?: string | null
}

/**
 * [A-3] 同一收货单内「二维码+厂家批号+牌号/线径」三元组唯一。
 */
export function assertDetailTripleUnique(details: readonly ReceiptDetailInput[]): void {
  const seen = new Map<string, string>()
  for (const d of details) {
    const key = detailTripleKey(d)
    const prev = seen.get(key)
    if (prev !== undefined) {
      throw new PurchaseRuleViolation(
        'A-3',
        `同一收货单内，相同二维码、厂家批号、牌号/线径不可重复扫描：${d.barcodeValue}`,
      )
    }
    seen.set(key, d.barcodeValue)
  }
}

/**
 * [A-3] 同一厂家批号的生产日期必须一致（PRD 扫码录入保存校验）。
 */
export function assertSameProductionDatePerSupplierLot(details: readonly ReceiptDetailInput[]): void {
  const seen = new Map<string, string>()
  for (const d of details) {
    const lotNo = d.supplierLotNo ?? ''
    if (lotNo === '') continue
    const date = d.productionDate ?? ''
    const prev = seen.get(lotNo)
    if (prev !== undefined && prev !== date) {
      throw new PurchaseRuleViolation(
        'A-3',
        `同一厂家批号 ${lotNo} 的生产日期必须一致（${prev || '空'} vs ${date || '空'}）`,
      )
    }
    seen.set(lotNo, date)
  }
}

/**
 * [A-3] 数量必须大于 0（且为合法十进制定点字符串，IT-07 口径随行）。
 */
export function assertDetailQuantityPositive(details: readonly ReceiptDetailInput[]): void {
  for (const [index, d] of details.entries()) {
    if (!isValidQuantityString(d.quantity) || !isPositiveQty(d.quantity)) {
      throw new PurchaseRuleViolation('A-3', `第 ${index + 1} 条明细数量必须大于 0`)
    }
  }
}

/** 收货总量 = 各明细数量之和（PRD 收货页「收货总量=已扫列表各行收货数量相加，保留四位小数」）。 */
export function computeTotalReceiptQty(details: readonly ReceiptDetailInput[]): DecimalString {
  return sumQty(details.map((d) => d.quantity))
}

/**
 * [A-5] 包装换算：单明细收货数量 = 包装单位总量 × 码数（换算项引用 conversion_revision_id 随行固化，
 * 引用后不可改、变更走新版本——由表结构 referenced 闩锁（0003）+ 明细快照列共同承载）。
 */
export function computeDetailQuantityFromPackage(input: {
  packageUnitQty: DecimalString
  codeCount: number
}): DecimalString {
  if (!isValidQuantityString(input.packageUnitQty) || !isPositiveQty(input.packageUnitQty)) {
    throw new PurchaseRuleViolation('A-5', '包装单位总量必须大于 0')
  }
  if (!Number.isInteger(input.codeCount) || input.codeCount < 1) {
    throw new PurchaseRuleViolation('A-5', '二维码数量（码数）必须为正整数')
  }
  return mulQtyByUint(input.packageUnitQty, input.codeCount)
}

/**
 * [A-2] 空码校验：码查无活动绑定 → 空码可收（本次绑定）；已有绑定且来源为采购收货
 * （inventory_unit + lot.kind='purchase'）→ 允许继续收货（PI S13 一码多批合法，弹确认口径）；
 * 存在非采购收货来源记录（载具/库位/批次绑定，或生产来源库存单元）→ 拒绝。
 *
 * 返回是否为本码首次采购收货（true → 调用方在 receiveGoods 中携带 barcodeValue 完成绑定；
 * false → 已有采购绑定，S13 同码多批：不再重复绑定，数量入新库存单元）。
 */
export function resolveEmptyBarcodeDisposition(input: {
  barcodeValue: string
  activeBinding: { boundType: string; boundId: string } | null
  boundUnitLotKind?: 'purchase' | 'production' | null
}): { firstPurchaseReceipt: boolean } {
  if (input.activeBinding === null) {
    return { firstPurchaseReceipt: true } // 空码：可收
  }
  if (input.activeBinding.boundType === 'inventory_unit') {
    if (input.boundUnitLotKind === 'purchase') {
      return { firstPurchaseReceipt: false } // S13：同码多批合法（后续批次不重复绑定）
    }
    throw new PurchaseRuleViolation(
      'A-2',
      `二维码 ${input.barcodeValue} 已存在非采购收货来源记录（生产批次），拒绝收货`,
    )
  }
  throw new PurchaseRuleViolation(
    'A-2',
    `二维码 ${input.barcodeValue} 已存在非采购收货来源记录（${input.activeBinding.boundType}），拒绝收货`,
  )
}

/**
 * [A-3] 同批次入库仓库一致 + 同码多条明细的库位一致（PRD 确认收货校验；
 * 批次表单仓库列承载前者，此处校验后者——同码（不同批号/线径）明细的库位不得冲突）。
 */
export function assertSameLocationPerBarcode(details: readonly ReceiptDetailInput[]): void {
  const seen = new Map<string, string>()
  for (const d of details) {
    if (d.locationId === undefined || d.locationId === null) continue // 库位缺省继承批次
    const prev = seen.get(d.barcodeValue)
    if (prev !== undefined && prev !== d.locationId) {
      throw new PurchaseRuleViolation(
        'A-3',
        `同一二维码 ${d.barcodeValue} 多条明细的库位必须一致（${prev} vs ${d.locationId}）`,
      )
    }
    seen.set(d.barcodeValue, d.locationId)
  }
}

/** 退货扣减订单行已收数量（A-1 已收=有效批次汇总，退货剔除）：已收 − 退货量（不为负）。 */
export function subtractReturnedQty(input: {
  receivedQty: DecimalString
  returnedQty: DecimalString
}): DecimalString {
  const after = subQty(input.receivedQty, input.returnedQty)
  return cmpQty(after, '0') < 0 ? '0.0000' : after
}

/** 便利：两数量相加（复用 inventory 定点算术，供应用层汇总使用）。 */
export function addPurchaseQty(a: DecimalString, b: DecimalString): DecimalString {
  return addQty(a, b)
}
