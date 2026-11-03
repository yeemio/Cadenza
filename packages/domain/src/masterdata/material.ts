import { MasterDataRuleViolation } from './errors'

/**
 * 料品与单位换算纯规则 —— 对应冻结合同 master-data.md §1：MD-01～MD-08。
 */

/** MD-01：料品主数据由 U9/ERP 同步写入；本系统料品页无新增、无删除入口；仅换算行可编辑。 */
export const MATERIAL_SYNC_OWNED = 'U9' as const

/**
 * MD-02：料品主表业务字段与「是否质检」标志同步后不可在本系统修改
 * （字段主权清单，见 common.ts MD-34；本系统写路径仅换算子表）。
 */
export const MATERIAL_IMMUTABLE_FIELDS: readonly string[] = [
  'name',
  'code',
  'companyOrgCode',
  'materialGroupCode',
  'materialGroupName',
  'descriptionZh',
  'descriptionEn',
  'voltage',
  'standard',
  'customer',
  'materialType',
  'spec',
  'color',
  'baseUom',
  'qcFlag',
  'remark',
]

/** MD-03：料品唯一键 = (org_scope, code)（同组织内料品编号唯一）。 */
export function materialNaturalKey(orgScopeId: string, code: string): string {
  return `${orgScopeId}:${code}`
}

/**
 * MD-04：换算行数值约束——非负；整数部分 ≤9 位；小数 ≤4 位。
 * 输入为十进制字符串（contracts 约定：数量字段一律 DecimalString，禁 number）。
 */
export function assertConversionFactorInput(input: string): void {
  const text = input.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new MasterDataRuleViolation('MD-04', `换算数量须为非负数字：${input}`)
  }
  const [intPart, decPart = ''] = text.split('.')
  if (intPart.length > 9) {
    throw new MasterDataRuleViolation('MD-04', `换算数量整数部分不得超过 9 位：${input}`)
  }
  if (decPart.length > 4) {
    throw new MasterDataRuleViolation('MD-04', `换算数量小数部分不得超过 4 位：${input}`)
  }
}

/** MD-04 数值约束的谓词形式（供表单/同步侧预检）。 */
export function isValidConversionFactorInput(input: string): boolean {
  try {
    assertConversionFactorInput(input)
    return true
  } catch {
    return false
  }
}

/** 换算单位名最长 100（PRD 料品管理 §2.1 编辑表单）。 */
export const CONVERSION_UNIT_NAME_MAX = 100

export function assertConversionUnitName(unitName: string): void {
  if (unitName.length === 0 || unitName.length > CONVERSION_UNIT_NAME_MAX) {
    throw new MasterDataRuleViolation(
      'MD-04',
      `换算单位名必填且最长 ${CONVERSION_UNIT_NAME_MAX} 字符`,
    )
  }
}

/** MD-05：换算行被采购收货引用（referenced=true）后不可修改、不可删除。 */
export function assertConversionLineMutable(line: { referenced: boolean }): void {
  if (line.referenced) {
    throw new MasterDataRuleViolation(
      'MD-05',
      '换算行已被采购收货引用，不可修改或删除；如需变更请生成新版本',
    )
  }
}

/**
 * MD-06：自定义包装单位口径——1 个新单位 = N 个主单位（N 满足 MD-04 数值约束）；
 * 创建后全局用于该料品后续收货（单位主数据表 is_custom 行挂 material_id）。
 */
export const CUSTOM_UNIT_SEMANTICS = '1 个自定义包装单位 = N 个主计量单位' as const

/**
 * MD-07：上游料品停用/删除传导语义——上游停用映射为本系统失效标志（retired），
 * 不物理删除、不级联清理业务历史；上游删除报文按停用处理。
 * 增量/全量口径未裁定（GAP-B9），由集成块按裁定时补。
 */
export function mapUpstreamMaterialLifecycle(
  upstream: 'active' | 'disabled' | 'deleted',
): 'active' | 'retired' {
  if (upstream === 'active') return 'active'
  return 'retired' // disabled 与 deleted 均按停用（retire 语义）处理，不物理删
}

/**
 * MD-08：单位主数据来源与主权未定义（GAP-A6），P1 实施前须裁定；
 * 本域不冒充已有 uom 主数据主权（表结构最小占位，无主权断言规则）。
 */
export const UOM_SOVEREIGNTY_PENDING_GAP = 'GAP-A6' as const
