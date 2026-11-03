import { CswRuleViolation } from './errors'
import { assertProductionDateValid, dateRangesOverlap, diffDays } from './shared'

/**
 * csw 冻结窗口规则（T22 冻结合同 CS-11 / CS-S2）。
 *
 * [CS-11] 冻结对象为 设备×生产日期 的槽位集合（可细至单槽位）；窗口内槽位对自动重排只读；
 * 解冻须具名权限（csw.unfreeze）＋理由并留痕。冻结期默认长度与解冻角色 → GAP-E9（现场）
 * ＋建议默认 1 个生产日。[CS-S2] 冻结记录表：(冻结对象, 生效区间) 不重叠；
 * 解冻行含 操作者/时间/理由。
 */

/** 冻结对象粒度：设备×日期区间 / 单槽位。 */
export type FreezeScope = 'equipment_date_range' | 'slot'

export const FREEZE_SCOPE_VALUES: readonly FreezeScope[] = ['equipment_date_range', 'slot']

/** [GAP-E9 建议默认] 冻结期默认长度：1 个生产日（现场裁定前的建议取值）。 */
export const DEFAULT_FREEZE_DAYS = 1

/** 活动冻结行（生效中；status='active'）。 */
export interface FreezeRecordView {
  id: string
  scope: FreezeScope
  equipmentId: string
  productionDateFrom: string
  productionDateTo: string
  /** slot 粒度必填（该槽位自身）；equipment 粒度为 null。 */
  slotId: string | null
  status: 'active' | 'ended'
}

/** [CS-11] 冻结创建形状：日期真实且 from ≤ to；slot 粒度须单日区间 + slotId。 */
export function assertFreezeShape(input: {
  scope: FreezeScope
  equipmentId: string
  productionDateFrom: string
  productionDateTo: string
  slotId: string | null
}): void {
  if (!input.equipmentId) {
    throw new CswRuleViolation('CS-11', '冻结创建需要 equipmentId（冻结对象为 设备×生产日期 的槽位集合）')
  }
  assertProductionDateValid(input.productionDateFrom, '冻结起始生产日期', 'CS-11')
  assertProductionDateValid(input.productionDateTo, '冻结结束生产日期', 'CS-11')
  if (diffDays(input.productionDateFrom, input.productionDateTo) < 0) {
    throw new CswRuleViolation('CS-11', `冻结区间倒置（${input.productionDateFrom} > ${input.productionDateTo}）`)
  }
  if (input.scope === 'slot') {
    if (input.slotId === null || input.slotId === '') {
      throw new CswRuleViolation('CS-11', '单槽位冻结必须携带 slotId（冻结可细至单槽位）')
    }
    if (input.productionDateFrom !== input.productionDateTo) {
      throw new CswRuleViolation('CS-11', '单槽位冻结的区间必须为单生产日（与槽位生产日期一致）')
    }
  }
}

/**
 * [CS-S2] 冻结对象生效区间不重叠：同设备的活动 equipment_date_range 区间两两不重叠；
 * 同槽位至多一条活动 slot 冻结（slot 与其所在设备区间的重叠不视为违规——细粒度叠加语义，
 * 解冻单槽位不影响设备区间其余槽位）。
 */
export function assertNoActiveFreezeOverlap(
  candidate: Pick<FreezeRecordView, 'scope' | 'equipmentId' | 'productionDateFrom' | 'productionDateTo' | 'slotId'>,
  existingActive: readonly FreezeRecordView[],
): void {
  for (const row of existingActive) {
    if (row.equipmentId !== candidate.equipmentId) continue
    if (candidate.scope === 'slot' && row.scope === 'slot') {
      if (row.slotId === candidate.slotId) {
        throw new CswRuleViolation(
          'CS-S2',
          `槽位 ${candidate.slotId} 已存在活动冻结（冻结对象生效区间不重叠；同槽位至多一条活动冻结）`,
        )
      }
      continue
    }
    if (candidate.scope === 'slot' || row.scope === 'slot') continue
    if (
      dateRangesOverlap(
        { from: candidate.productionDateFrom, to: candidate.productionDateTo },
        { from: row.productionDateFrom, to: row.productionDateTo },
      )
    ) {
      throw new CswRuleViolation(
        'CS-S2',
        `设备 ${candidate.equipmentId} 冻结区间 ${candidate.productionDateFrom}~${candidate.productionDateTo}`
          + ` 与已有活动冻结 ${row.productionDateFrom}~${row.productionDateTo} 重叠（(冻结对象, 生效区间) 不重叠）`,
      )
    }
  }
}

/** 槽位被冻结判定：设备区间包含其生产日期，或 slot 粒度命中其 id（[CS-11] 窗口内槽位对重排只读）。 */
export function isSlotFrozen(
  slot: { id: string; equipmentId: string; productionDate: string },
  activeFreezes: readonly FreezeRecordView[],
): boolean {
  return activeFreezes.some(
    (f) =>
      f.equipmentId === slot.equipmentId &&
      slot.productionDate >= f.productionDateFrom &&
      slot.productionDate <= f.productionDateTo &&
      (f.scope === 'equipment_date_range' || f.slotId === slot.id),
  )
}

/** 设备×生产日期被冻结判定（自动排程在该 (设备,日期) 上不落新槽位——冻结期口径从严）。 */
export function isEquipmentDateFrozen(
  equipmentId: string,
  productionDate: string,
  activeFreezes: readonly FreezeRecordView[],
): boolean {
  return activeFreezes.some(
    (f) =>
      f.equipmentId === equipmentId &&
      productionDate >= f.productionDateFrom &&
      productionDate <= f.productionDateTo,
  )
}

/** [CS-11/CS-26] 解冻须理由（具名权限 csw.unfreeze 由守卫与处理器二道防线承担）。 */
export function assertUnfreezeReasonProvided(reason: string | null | undefined): asserts reason is string {
  if (reason === null || reason === undefined || reason.trim() === '') {
    throw new CswRuleViolation('CS-11', '解冻必须填写理由并留痕（解冻须具名权限＋理由，操作者/时间/理由落冻结记录）')
  }
}
