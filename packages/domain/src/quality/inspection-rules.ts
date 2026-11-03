import type { DecimalString } from '@cadenza/contracts'
import { QualityRuleViolation } from './errors'

/**
 * 过程/成品检验纯规则 —— 规则底稿 04 §A-T12-5（S12 显式新增：原包无独立规格）+
 * S14 版本化口径（同 purchase 域 A-7 版本链模式）。
 */

/** A-T12-5：检验阶段（S12 显式新增：过程检验/成品检验）。 */
export const INSPECTION_STAGES = ['process', 'finished'] as const
export type InspectionStage = (typeof INSPECTION_STAGES)[number]

/** A-T12-5：检验任务来源（报工提交后生成过程检验；入库/成品质检来源生成成品检验）。 */
export const INSPECTION_SOURCE_TYPES = ['work_report', 'putaway_receipt'] as const
export type InspectionSourceType = (typeof INSPECTION_SOURCE_TYPES)[number]

/** 检验单状态：待检 → 检验中（首次实测提交后）→ 已出结论（可放行/让步）；作废独立。 */
export const INSPECTION_ORDER_STATUSES = ['pending', 'in_progress', 'concluded', 'cancelled'] as const
export type InspectionOrderStatus = (typeof INSPECTION_ORDER_STATUSES)[number]

/** 检验结论（quality_test_result.conclusion）。 */
export type TestConclusion = 'pending' | 'qualified' | 'unqualified'

/** 实测/结论行种类：initial=生成时链起点（pending）；test=实测提交；re_inspection=复检提交。 */
export type TestResultKind = 'initial' | 'test' | 're_inspection'

/** 检验项实测明细（items jsonb 行元素形状；实测值追加历史由版本行承载，S14）。 */
export interface InspectionItemMeasurement {
  itemNo: string
  itemName?: string | null
  measuredValue: string
  judgement: 'pass' | 'fail' | 'not_tested'
  note?: string | null
}

/**
 * A-T12-5：检验规范引用版本化——spec_code + spec_version 必填；
 * 引用后不可改（无更新命令路径；规范变更走新任务引用新版本）。
 */
export function assertSpecReference(input: {
  specCode: string | null | undefined
  specVersion: number | null | undefined
}): void {
  if (!(input.specCode ?? '').trim()) {
    throw new QualityRuleViolation('A-T12-5', '检验任务必须引用检验规范编码（spec_code，版本化引用不可空）')
  }
  if (
    input.specVersion === null ||
    input.specVersion === undefined ||
    !Number.isInteger(input.specVersion) ||
    input.specVersion < 1
  ) {
    throw new QualityRuleViolation('A-T12-5', '检验任务必须引用检验规范版本（spec_version ≥ 1，版本化引用不可空）')
  }
}

/** A-T12-5：检验任务生成载荷校验（来源/阶段/数量）。 */
export function assertInspectionOrderGeneratable(input: {
  sourceType: string
  sourceRef: string
  inspectionStage: string
  quantity: DecimalString
  isPositive: boolean
}): void {
  if (!INSPECTION_SOURCE_TYPES.includes(input.sourceType as InspectionSourceType)) {
    throw new QualityRuleViolation('A-T12-5', `检验任务来源类型非法：${input.sourceType}（须为报工/入库来源）`)
  }
  if (!(input.sourceRef ?? '').trim()) {
    throw new QualityRuleViolation('A-T12-5', '检验任务必须携带来源引用（source_ref，来源幂等键）')
  }
  if (!INSPECTION_STAGES.includes(input.inspectionStage as InspectionStage)) {
    throw new QualityRuleViolation('A-T12-5', `检验阶段非法：${input.inspectionStage}（过程/成品）`)
  }
  if (!input.isPositive) {
    throw new QualityRuleViolation('A-T12-5', `检验任务数量必须为正的十进制定点字符串：${String(input.quantity)}`)
  }
}

/** S14：结论版本号递增（链内 max+1；生成时链起点 v1）。 */
export function nextTestResultVersion(existingVersions: readonly number[]): number {
  return existingVersions.reduce((m, v) => Math.max(m, v), 0) + 1
}

/**
 * A-T12-5：实测提交规则——items 至少一项且实测值非空；
 * 已出结论（concluded）后再次提交 = 复检（result_kind=re_inspection），允许（版本追加，
 * 不清历史）；复检提交时检验单回检验中、质量轴转待复检（由应用层同步投影）。
 */
export function assertTestResultSubmittable(input: {
  orderStatus: InspectionOrderStatus
  items: readonly InspectionItemMeasurement[]
  conclusion: TestConclusion
}): void {
  if (input.orderStatus === 'cancelled') {
    throw new QualityRuleViolation('A-T12-5', '检验单已作废，不可提交实测')
  }
  if (input.items.length === 0) {
    throw new QualityRuleViolation('A-T12-5', '实测提交至少包含一个检验项的实测值（追加历史，不清除既有记录）')
  }
  for (const item of input.items) {
    if (!(item.itemNo ?? '').trim() || !(item.measuredValue ?? '').trim()) {
      throw new QualityRuleViolation('A-T12-5', `检验项 ${item.itemNo ?? '(空)'} 缺少项号或实测值`)
    }
  }
  if (input.conclusion === 'pending') {
    throw new QualityRuleViolation(
      'A-T12-5',
      '实测提交必须携带判定结论（合格/不合格）；待检仅存在于生成时的链起点行',
    )
  }
}

/**
 * A-T12-5：实测提交后的检验单状态——实测提交即携带判定结论，检验单转入已出结论
 * （concluded）；已结论单再提交 = 复检（同样即时出新结论，版本链继续追加、历史保留）。
 * 「待复检」（re_inspection）为质量轴投影值：复检提交将库存质量先行置回待检口径
 * （由应用层投影），复检结论生效后按新结论投影。
 */
export function nextInspectionOrderStatusAfterSubmit(): InspectionOrderStatus {
  return 'concluded'
}

/** A-T12-5：实测提交后的检验单状态——见 nextInspectionOrderStatusAfterSubmit（提交即出结论）。 */

