import { QualityRuleViolation } from './errors'

/**
 * 质量存疑纯规则 —— 规则底稿 04 §A-T12-3（原件 质量存疑 全文）+ B-9/C-5 最小处置记录。
 */

/** 码种类（存疑扫码对象判定：单品码可存疑，托码拒——托须先解绑到单品）。 */
export type SuspectCodeKind = 'unit' | 'pallet' | 'unknown'

/**
 * A-T12-3：存疑登记校验——PDA 扫产品轴号：
 * 须 ①在库（库存状态轴 in_stock）②在库位（有具体库位，非在途/已发运）
 * ③未存疑（无活动存疑记录）④托码拒（只可对单品码/轴号存疑）。
 * 通过后：生成存疑记录 + 码质量状态=存疑；记录保留发起人/时间/生产部门
 * （取轴所属生产订单部门，由事件/载荷携带）。
 */
export function assertSuspectRegistratable(input: {
  barcodeKind: SuspectCodeKind
  unitStatus: string
  hasLocation: boolean
  hasActiveSuspect: boolean
  unitNo?: string
}): void {
  if (input.barcodeKind === 'pallet') {
    throw new QualityRuleViolation(
      'A-T12-3',
      '托码不可直接登记质量存疑（托码拒）：请扫描托内单品码/产品轴号逐码存疑',
    )
  }
  if (input.unitStatus !== 'in_stock') {
    throw new QualityRuleViolation(
      'A-T12-3',
      `单元 ${input.unitNo ?? ''}库存状态为 ${input.unitStatus}，仅对在库单元可登记存疑`,
    )
  }
  if (!input.hasLocation) {
    throw new QualityRuleViolation(
      'A-T12-3',
      `单元 ${input.unitNo ?? ''}不在具体库位（在途/无库位），仅对在库位单元可登记存疑`,
    )
  }
  if (input.hasActiveSuspect) {
    throw new QualityRuleViolation(
      'A-T12-3',
      `单元 ${input.unitNo ?? ''}已存在活动存疑记录，不可重复登记（Web 恢复后可再次登记）`,
    )
  }
}

/**
 * A-T12-3 + B-9/C-5：存疑恢复最小处置记录——恢复必须留处置依据（disposition_note）、
 * 恢复人、恢复时间（授权角色属 C-5 缺口，由许可体系 quality.post 承担，此处校验记录完整性）。
 * 恢复后：存疑记录置 released、码回 hold 前质量状态（previous_quality_status）。
 */
export function assertSuspectRestorable(input: {
  holdStatus: string
  releasedBy: string | null | undefined
  dispositionNote: string | null | undefined
  unitNo?: string
}): void {
  if (input.holdStatus !== 'active') {
    throw new QualityRuleViolation('A-T12-3', `单元 ${input.unitNo ?? ''}无活动存疑记录，无须恢复`)
  }
  if (!(input.releasedBy ?? '').trim()) {
    throw new QualityRuleViolation('A-T12-3', '存疑恢复必须记录恢复人（最小处置记录）')
  }
  if (!(input.dispositionNote ?? '').trim()) {
    throw new QualityRuleViolation(
      'A-T12-3',
      '存疑恢复必须填写处置依据（disposition_note，最小处置记录：B-9 裁定方向，禁止一键无据恢复）',
    )
  }
}

/** A-T12-2：隔离种类（quality_hold.hold_kind）——待检/不合格/存疑不可用，隔离与处置独立。 */
export const HOLD_KINDS = ['pending_inspection', 'unqualified', 'suspect'] as const
export type HoldKind = (typeof HOLD_KINDS)[number]

/** A-T12-2：隔离不可用断言（待检/不合格/存疑不得进入可用量与发运——hold 侧口径）。 */
export function assertHoldNotBlockingUse(input: {
  activeHoldKind: HoldKind | null
  unitNo?: string
}): void {
  if (input.activeHoldKind !== null) {
    throw new QualityRuleViolation(
      'A-T12-2',
      `单元 ${input.unitNo ?? ''}存在活动隔离（${input.activeHoldKind}），隔离与处置独立记账：待检/不合格/存疑不可用`,
    )
  }
}
