import { isOutOfRange } from './point-rules'
import type { QualityLevel } from './sample-rules'

/**
 * 坏点判定与可见性规则（OT-21/OT-22）：质量码 bad、量程越界（OT-08 量程外）、
 * 设备状态=维修（MD-13 字典：1=正常 2=维修）期间采集 → 坏点；
 * 坏点不参与自动质量判定、不计产量、不入 SPC、不入成本能耗归集（由样本
 * is_bad 标记 + 汇总排除承载）；坏点与"时钟偏差"样本保留可查（带原因）、
 * 不物理删除，坏点率按设备/点位统计展示（查询侧自汇总投影统计）。
 */

export const BAD_POINT_REASONS = ['quality_bad', 'out_of_range', 'equipment_under_repair'] as const
export type BadPointReason = (typeof BAD_POINT_REASONS)[number]

export const BAD_POINT_REASON_LABELS: Readonly<Record<BadPointReason, string>> = {
  quality_bad: '质量码 bad（OT-21）',
  out_of_range: '量程越界（OT-08/OT-21）',
  equipment_under_repair: '设备维修期间采集（MD-13/OT-21）',
}

export interface BadPointInput {
  qualityLevel: QualityLevel
  rawValue: number
  rangeMin: number | null
  rangeMax: number | null
  /** 设备主档状态（MD-13：1=正常 2=维修；未映射设备为 null——未映射样本先隔离，OT-07） */
  equipmentStatus: 1 | 2 | null
}

export interface BadPointResult {
  isBad: boolean
  reasons: BadPointReason[]
}

/** OT-21：坏点三源判定（任一命中即坏点，原因并列保留）。 */
export function classifyBadPoint(input: BadPointInput): BadPointResult {
  const reasons: BadPointReason[] = []
  if (input.qualityLevel === 'bad') reasons.push('quality_bad')
  if (isOutOfRange(input.rawValue, input.rangeMin, input.rangeMax)) reasons.push('out_of_range')
  if (input.equipmentStatus === 2) reasons.push('equipment_under_repair')
  return { isBad: reasons.length > 0, reasons }
}
