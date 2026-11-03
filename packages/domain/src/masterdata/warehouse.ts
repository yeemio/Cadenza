import { MasterDataRuleViolation } from './errors'

/**
 * 仓库 / 库位 / 货架纯规则 —— 对应冻结合合同 master-data.md §4：MD-22～MD-33。
 *
 * 部门类型字典与 org 域共用（1=车间、2=质检部、3=物流部，PRD 仓库管理 §1.2）；
 * 为满足包内 eslint 边界规则（禁 `..` 相对导入）在本文件内以本地常量对齐，不跨目录引用。
 */

/** 部门类型字典（与 org 域 DEPT_CATEGORY 同值：1=车间 2=质检部 3=物流部）。 */
export const MD_DEPT_CATEGORY = { WORKSHOP: 1, QUALITY: 2, LOGISTICS: 3 } as const

/** MD-23：仓库类型字典——仓库、线边仓。 */
export const WAREHOUSE_TYPE = { WAREHOUSE: 'WAREHOUSE', LINE_SIDE: 'LINE_SIDE' } as const

export type WarehouseTypeValue = (typeof WAREHOUSE_TYPE)[keyof typeof WAREHOUSE_TYPE]

export const WAREHOUSE_TYPE_VALUES: readonly WarehouseTypeValue[] = [
  WAREHOUSE_TYPE.WAREHOUSE,
  WAREHOUSE_TYPE.LINE_SIDE,
]

/** 料品类型字典（PRD 仓库管理 §1.2：1=原料 2=半成品 3=成品）。 */
export const MATERIAL_TYPE = { RAW: 1, SEMI: 2, FINISHED: 3 } as const

export const MATERIAL_TYPE_VALUES: readonly number[] = [
  MATERIAL_TYPE.RAW,
  MATERIAL_TYPE.SEMI,
  MATERIAL_TYPE.FINISHED,
]

/**
 * MD-23：仓库类型限定该仓可收的料品类型集合
 * （仓库→原料/成品；线边仓→原料/半成品/成品；PRD 仓库管理 §2.1 联动逻辑）。
 */
export const ALLOWED_MATERIAL_TYPES_BY_WAREHOUSE_TYPE: Readonly<
  Record<WarehouseTypeValue, readonly number[]>
> = {
  [WAREHOUSE_TYPE.WAREHOUSE]: [MATERIAL_TYPE.RAW, MATERIAL_TYPE.FINISHED],
  [WAREHOUSE_TYPE.LINE_SIDE]: [MATERIAL_TYPE.RAW, MATERIAL_TYPE.SEMI, MATERIAL_TYPE.FINISHED],
}

export function assertMaterialTypesAllowedForWarehouseType(
  warehouseType: WarehouseTypeValue,
  materialTypes: readonly number[],
): void {
  if (materialTypes.length === 0) {
    throw new MasterDataRuleViolation('MD-23', '仓库必须配置至少一种可收料品类型')
  }
  const allowed = ALLOWED_MATERIAL_TYPES_BY_WAREHOUSE_TYPE[warehouseType]
  const illegal = materialTypes.filter((t) => !allowed.includes(t))
  if (illegal.length > 0) {
    throw new MasterDataRuleViolation(
      'MD-23',
      `料品类型 ${illegal.join('/')} 不在仓库类型 ${warehouseType} 允许范围内`,
    )
  }
}

/**
 * MD-24：建仓部门类型约束（配置化，不写死字典值）：
 * 物流部部门只能建「仓库」、车间部门只能建「线边仓」；其余部门类型不受限。
 * 调用方可传入自定义规则表覆盖默认（首期默认 = 原文基线）。
 */
export type DeptWarehouseTypeRule = ReadonlyMap<number, readonly WarehouseTypeValue[]>

export const DEFAULT_DEPT_WAREHOUSE_TYPE_RULE: DeptWarehouseTypeRule = new Map([
  [MD_DEPT_CATEGORY.LOGISTICS, [WAREHOUSE_TYPE.WAREHOUSE]],
  [MD_DEPT_CATEGORY.WORKSHOP, [WAREHOUSE_TYPE.LINE_SIDE]],
])

export function assertWarehouseTypeAllowedForDept(
  deptCategory: number,
  warehouseType: WarehouseTypeValue,
  rule: DeptWarehouseTypeRule = DEFAULT_DEPT_WAREHOUSE_TYPE_RULE,
): void {
  const allowed = rule.get(deptCategory)
  if (allowed !== undefined && !allowed.includes(warehouseType)) {
    throw new MasterDataRuleViolation(
      'MD-24',
      `该部门类型仅允许创建${allowed
        .map((t) => (t === WAREHOUSE_TYPE.WAREHOUSE ? '仓库' : '线边仓'))
        .join('/')}`,
    )
  }
}

/** MD-22：仓库编码为 4 位数字；仓库名称全局唯一（查重由仓储层执行）。 */
export function assertWarehouseCode(code: string): void {
  if (!/^\d{4}$/.test(code)) {
    throw new MasterDataRuleViolation('MD-22', '仓库编码必须为 4 位数字')
  }
}

/** MD-25：存在普通库位的仓库不可修改仓库编码。 */
export function assertWarehouseCodeImmutable(facts: {
  activeNormalLocations: number
  codeChanged: boolean
}): void {
  if (facts.codeChanged && facts.activeNormalLocations > 0) {
    throw new MasterDataRuleViolation('MD-25', '该仓库下已有普通库位，不允许修改仓库编码')
  }
}

/**
 * MD-26：被二维码（库位码）占用的仓库：不可改仓库类型/料品类型，不可删除。
 * patch 传入意图修改的字段；undefined 表示不修改。
 */
export function assertQrBoundWarehouseEditable(
  facts: { qrBound: boolean },
  patch: { warehouseType?: string; materialTypes?: readonly number[] },
): void {
  if (!facts.qrBound) return
  if (patch.warehouseType !== undefined || patch.materialTypes !== undefined) {
    throw new MasterDataRuleViolation(
      'MD-26',
      '仓库已被二维码占用，不允许修改仓库类型或料品类型',
    )
  }
}

/**
 * MD-27：仓库删除/失效 retire 语义——
 * 有库存余额或流水引用即拒删（MD-37 同判）；被二维码占用不可删（MD-26）；
 * 无引用时下级普通库位随之级联失效（不物理删行）。
 */
export interface WarehouseRetireFacts {
  qrBound: boolean
  stockRefs: number
}

export function assertWarehouseRetirable(facts: WarehouseRetireFacts): void {
  if (facts.qrBound) {
    throw new MasterDataRuleViolation('MD-26', '仓库已被二维码占用，不可删除')
  }
  if (facts.stockRefs > 0) {
    throw new MasterDataRuleViolation('MD-27', '仓库存在库存余额或流水引用，不可删除')
  }
}

/**
 * MD-28：普通库位编码 8 位数字 = 仓库码 4 位 + 库位码 4 位；前缀必须匹配所属仓库；同工厂内唯一。
 */
export function buildNormalLocationCode(warehouseCode: string, locationSeq: string): string {
  return `${warehouseCode}${locationSeq}`
}

export function assertNormalLocationCode(code: string, warehouseCode: string): void {
  if (!/^\d{8}$/.test(code)) {
    throw new MasterDataRuleViolation('MD-28', '普通库位编码必须为 8 位数字（仓库码 4 位 + 库位码 4 位）')
  }
  if (!code.startsWith(warehouseCode)) {
    throw new MasterDataRuleViolation('MD-28', `库位编码前 4 位必须为所属仓库编码（${warehouseCode}）`)
  }
}

/** MD-29：被二维码占用的库位不可改码、不可删。 */
export function assertQrBoundLocationMutable(facts: {
  qrBound: boolean
  codeChanged: boolean
}): void {
  if (facts.qrBound && facts.codeChanged) {
    throw new MasterDataRuleViolation('MD-29', '库位已被二维码占用，不允许修改库位编码')
  }
}

export function assertLocationRetirable(facts: { qrBound: boolean; stockRefs: number }): void {
  if (facts.qrBound) {
    throw new MasterDataRuleViolation('MD-29', '库位已被二维码占用，不可删除')
  }
  if (facts.stockRefs > 0) {
    throw new MasterDataRuleViolation('MD-37', '库位存在库存余额或流水引用，不可删除')
  }
}

/** MD-30：货架编号 2 位数字，同工厂内唯一（工厂取所属仓库的所属工厂）。 */
export function assertRackCode(code: string): void {
  if (!/^\d{2}$/.test(code)) {
    throw new MasterDataRuleViolation('MD-30', '货架编号必须为 2 位数字')
  }
}

/** MD-31：区域数/层数范围（1–99，PRD 货架管理 §2.1）。 */
export function assertRackGridSize(zones: number, layers: number): void {
  if (!Number.isInteger(zones) || zones < 1 || zones > 99) {
    throw new MasterDataRuleViolation('MD-31', '区域数量必须为 1–99 的整数')
  }
  if (!Number.isInteger(layers) || layers < 1 || layers > 99) {
    throw new MasterDataRuleViolation('MD-31', '货架层数必须为 1–99 的整数')
  }
}

/** MD-31：区域编码 = 货架编号（2 位）+ 区域序号（2 位，从 01 起）。 */
export function buildZoneCode(rackCode: string, zoneSeq: number): string {
  return `${rackCode}${String(zoneSeq).padStart(2, '0')}`
}

/**
 * MD-31：货架库位编号 = 货架编号（2 位）+ 区域序号（2 位）+ 层号（2 位，从 01 起）。
 * （货架库位编号不含仓库码前缀，同工厂内唯一；PRD 货架管理 §2.1 货架库位表单。）
 */
export function buildRackLocationCode(rackCode: string, zoneSeq: number, layerSeq: number): string {
  return `${rackCode}${String(zoneSeq).padStart(2, '0')}${String(layerSeq).padStart(2, '0')}`
}

/** MD-31：层数在编辑时不可改。 */
export function assertRackLayersImmutable(layersChanged: boolean): void {
  if (layersChanged) {
    throw new MasterDataRuleViolation('MD-31', '货架层数在编辑时不可修改')
  }
}

/** MD-31：货架下已有货架库位时不可修改货架编号（PRD 货架管理 §2.1 编辑逻辑）。 */
export function assertRackCodeImmutable(facts: {
  activeLocations: number
  codeChanged: boolean
}): void {
  if (facts.codeChanged && facts.activeLocations > 0) {
    throw new MasterDataRuleViolation('MD-31', '该货架下已有货架库位，不允许修改货架编号')
  }
}

/**
 * MD-31：货架已被二维码占用时不可修改区域数量、货架层数或所属仓库
 * （编辑实际可改项仅为备注等非结构字段；PRD 货架管理 §2.1）。
 */
export function assertQrBoundRackEditable(
  facts: { qrBound: boolean },
  patch: { zones?: number; layers?: number; warehouseId?: string },
): void {
  if (!facts.qrBound) return
  if (patch.zones !== undefined || patch.layers !== undefined || patch.warehouseId !== undefined) {
    throw new MasterDataRuleViolation(
      'MD-31',
      '货架已被二维码占用，不允许修改区域数量、货架层数或所属仓库',
    )
  }
}

/**
 * MD-32：区域完整码 = 仓库所属工厂编码 + 区域编码；
 * 区域随库位增删自动维护，不提供手工增删入口（无区域表，由库位行派生）。
 */
export function zoneFullCode(plantCode: string, zoneCode: string): string {
  return `${plantCode}${zoneCode}`
}

/**
 * MD-33：货架删除（retire 语义）——有库位被二维码占用或有库存引用即拒删。
 */
export interface RackRetireFacts {
  qrBoundLocations: number
  stockRefs: number
}

export function assertRackRetirable(facts: RackRetireFacts): void {
  if (facts.qrBoundLocations > 0) {
    throw new MasterDataRuleViolation('MD-33', '货架下存在被二维码占用的库位，不可删除')
  }
  if (facts.stockRefs > 0) {
    throw new MasterDataRuleViolation('MD-33', '货架存在库存余额或流水引用，不可删除')
  }
}
