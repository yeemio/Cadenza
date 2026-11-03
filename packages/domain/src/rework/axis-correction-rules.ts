/**
 * 轴号修正（段/号修正）规则（RS-25～RS-33）——冻结合同
 * architecture/contracts/frozen/p2/rework-split.md §3。
 *
 * 纯规则面。轴号事实（客户轴号/段长/虚拟轴号当前值）存本域 axis_no_state
 * （0011 迁移，不改共享表）；修正记录 axis_no_correction（RS-S5）。
 */
// no-restricted-imports 对 domain 包内子目录场景过宽（同 reverse/reporting/trace 先例）；单行豁免留痕。
// eslint-disable-next-line no-restricted-imports
import { cmpQty, isValidQuantityString } from '../inventory/quantity'
import { ReworkRuleViolation } from './errors'

/** 修正扫码事实（RS-25 拒绝链由装配方折叠）。 */
export interface CorrectionScanFacts {
  /** 已传二维码（未传拒绝） */
  qrPassed: boolean
  unitNo: string
  exists: boolean
  /** 托码 */
  isPalletCode: boolean
  /** 一码多物 */
  multiMaterial: boolean
  /** 码所在仓库属物流部（dept_category=3） */
  inLogisticsWarehouse: boolean
  /** 已销售 */
  sold: boolean
  /** 质检尚未完成 */
  qualityPending: boolean
  /** 报工未审核 */
  reportUnreviewed: boolean
  /** 异常未处理 */
  anomalyOpen: boolean
  /** 已锁定 */
  locked: boolean
  /** 没有订单 */
  hasOrder: boolean
  /** 中转轴存在未审核的成品轴信息（GAP-F6：中转轴概念定义未裁，按布尔事实装配） */
  transitAxisPending: boolean
}

/**
 * RS-25 扫码前置拒绝链（任一命中拒绝；扫码只查询不改数据）：
 * 未传二维码 → 托码 → 码不存在 → 一码多物 → 物流部仓库 → 已销售 → 质检尚未完成 →
 * 报工未审核 → 异常未处理 → 已锁定 → 没有订单 → 中转轴未审核成品轴信息。
 */
export function assertCorrectionScannable(f: CorrectionScanFacts): void {
  if (!f.qrPassed) {
    throw new ReworkRuleViolation('RS-25', '未传二维码，不能查询轴号修正')
  }
  if (f.isPalletCode) {
    throw new ReworkRuleViolation('RS-25', '该码为托码，不能进行轴号修正')
  }
  if (!f.exists) {
    throw new ReworkRuleViolation('RS-25', '码不存在')
  }
  if (f.multiMaterial) {
    throw new ReworkRuleViolation('RS-25', '一码多物，不能进行轴号修正')
  }
  if (f.inLogisticsWarehouse) {
    throw new ReworkRuleViolation('RS-25', '码所在仓库属物流部，不能修正')
  }
  if (f.sold) {
    throw new ReworkRuleViolation('RS-25', '该码已销售，不能修正')
  }
  if (f.qualityPending) {
    throw new ReworkRuleViolation('RS-25', '该轴质检尚未完成，不能修正')
  }
  if (f.reportUnreviewed) {
    throw new ReworkRuleViolation('RS-25', '该轴报工未审核，不能修正')
  }
  if (f.anomalyOpen) {
    throw new ReworkRuleViolation('RS-25', '该轴存在未处理异常，不能修正')
  }
  if (f.locked) {
    throw new ReworkRuleViolation('RS-25', '该轴已锁定，不能修正')
  }
  if (!f.hasOrder) {
    throw new ReworkRuleViolation('RS-25', '该码没有订单，不能修正')
  }
  if (f.transitAxisPending) {
    throw new ReworkRuleViolation('RS-25', '中转轴存在未审核的成品轴信息，不能修正')
  }
}

/** 订单范围内某码的轴号当前值（RS-26 可选列表数据源）。 */
export interface AxisNoStateFacts {
  unitId: string
  unitNo: string
  salesOrderNo: string
  orderLineNo: string | null
  customerAxisNo: string | null
  segmentLength: string | null
  virtualAxisNo: string | null
}

/** RS-26 可选新轴号项。 */
export interface CorrectionOption {
  customerAxisNo: string | null
  segmentLength: string | null
  virtualAxisNo: string | null
  /** 已使用 = 同订单范围内已有码占用相同"段长＋虚拟轴号" */
  used: boolean
  occupiedByUnitId: string | null
  occupiedByUnitNo: string | null
}

/**
 * RS-26 可选新轴号范围：该码销售订单行相关的订单分段明细；原码已有段长则只保留
 * 同段长项；"已使用"= 同订单范围内已有码占用相同"段长＋虚拟轴号"（已使用项仍可选中）；
 * 无客户轴号仅有段长的原码列表为空、不提供点选入口。
 */
export function buildCorrectionOptions(
  orderAxisStates: readonly AxisNoStateFacts[],
  sourceUnitId: string,
): CorrectionOption[] {
  const source = orderAxisStates.find((s) => s.unitId === sourceUnitId)
  if (source === undefined) return []
  // 无客户轴号仅有段长的原码：列表为空、不提供点选入口
  if (source.customerAxisNo === null || source.customerAxisNo === '') return []
  const distinct = new Map<string, CorrectionOption>()
  for (const state of orderAxisStates) {
    if (state.customerAxisNo === null || state.customerAxisNo === '') continue
    // 原码已有段长则只保留同段长项
    if (source.segmentLength !== null && source.segmentLength !== '' &&
        state.segmentLength !== source.segmentLength) {
      continue
    }
    const key = `${state.customerAxisNo ?? ''}||${state.segmentLength ?? ''}||${state.virtualAxisNo ?? ''}`
    const occupiedByOther = state.unitId !== sourceUnitId
    const existing = distinct.get(key)
    const option: CorrectionOption = {
      customerAxisNo: state.customerAxisNo,
      segmentLength: state.segmentLength,
      virtualAxisNo: state.virtualAxisNo,
      used: occupiedByOther,
      occupiedByUnitId: occupiedByOther ? state.unitId : null,
      occupiedByUnitNo: occupiedByOther ? state.unitNo : null,
    }
    if (existing === undefined || (option.used && !existing.used)) {
      distinct.set(key, option)
    }
  }
  return [...distinct.values()]
}

/** 修正提交载荷。 */
export interface CorrectionSubmitInput {
  cutQty: unknown
  newCustomerAxisNo: string | null
  newSegmentLength: string | null
  newVirtualAxisNo: string | null
}

/** 修正提交事实（RS-27 校验链数据源）。 */
export interface CorrectionSubmitFacts {
  /** 码当前数量 */
  currentQty: string
  /** 码最大单次报工数量（RS-27 截取数量上限） */
  maxSingleReportQty: string
  /** 可选列表（RS-26；空列表=无点选入口） */
  options: readonly CorrectionOption[]
  /** 码当前客户轴号（有客户轴号则必须传修正后客户轴号） */
  currentCustomerAxisNo: string | null
  /** 码当前段长（有段长则必须传修正后段长） */
  currentSegmentLength: string | null
  /** 解绑占用码时占用码已入非线边仓 */
  occupiedUnitInWarehouse: boolean
  /** 解绑占用码时占用码已销售 */
  occupiedUnitSold: boolean
  /** 解绑占用码时占用码已锁定 */
  occupiedUnitLocked: boolean
}

/**
 * RS-27 提交校验链（任一命中拒绝；按合同罗列顺序）。
 * 返回规整后的截取数量。
 */
export function assertCorrectionSubmitAcceptable(
  input: CorrectionSubmitInput,
  facts: CorrectionSubmitFacts,
): string {
  if (input.cutQty === undefined || input.cutQty === null || !isValidQuantityString(input.cutQty)) {
    throw new ReworkRuleViolation('RS-27', '未传截断数量或格式不合法（数字、小数最多 4 位）')
  }
  const cutQty = input.cutQty as string
  if (cmpQty(cutQty, '0.0000') < 0) {
    throw new ReworkRuleViolation('RS-27', '截断数量不能小于 0')
  }
  const hasOptions = facts.options.length > 0
  const noAxisPassed =
    (input.newCustomerAxisNo ?? '') === '' &&
    (input.newSegmentLength ?? '') === '' &&
    (input.newVirtualAxisNo ?? '') === ''
  if (!hasOptions) {
    if (!noAxisPassed) {
      throw new ReworkRuleViolation('RS-27', '无可选轴号列表，不能传入新客户轴号/段长/虚拟轴号')
    }
    if (cmpQty(cutQty, '0.0000') === 0) {
      throw new ReworkRuleViolation('RS-27', '无可选列表且截取数量为 0，无变化，拒绝提交')
    }
  }
  const hasCustomerAxis = (facts.currentCustomerAxisNo ?? '') !== ''
  const hasSegment = (facts.currentSegmentLength ?? '') !== ''
  if (hasCustomerAxis && (input.newCustomerAxisNo ?? '') === '') {
    throw new ReworkRuleViolation('RS-27', '有客户轴号时必须传修正后客户轴号')
  }
  if (hasSegment && (input.newSegmentLength ?? '') === '') {
    throw new ReworkRuleViolation('RS-27', '有段长时必须传修正后段长')
  }
  // 仅段长场景待分配虚拟轴号不足/未传修正后虚拟轴号
  if (!hasCustomerAxis && hasSegment) {
    if ((input.newVirtualAxisNo ?? '') === '') {
      throw new ReworkRuleViolation('RS-27', '仅段长场景必须传修正后虚拟轴号')
    }
  }
  if (hasOptions) {
    const inOptions = facts.options.some(
      (o) =>
        (o.customerAxisNo ?? '') === (input.newCustomerAxisNo ?? '') &&
        (o.segmentLength ?? '') === (input.newSegmentLength ?? '') &&
        (o.virtualAxisNo ?? '') === (input.newVirtualAxisNo ?? ''),
    )
    if (!noAxisPassed && !inOptions) {
      throw new ReworkRuleViolation('RS-27', '传入的轴号信息不在可选列表内')
    }
  }
  const axisChanged =
    (input.newCustomerAxisNo ?? '') !== (facts.currentCustomerAxisNo ?? '') ||
    (input.newSegmentLength ?? '') !== (facts.currentSegmentLength ?? '') ||
    (input.newVirtualAxisNo ?? '') !== ''
  if (!axisChanged && cmpQty(cutQty, '0.0000') === 0) {
    throw new ReworkRuleViolation('RS-27', '三字段均未变且截取数量为 0，拒绝提交')
  }
  if (cmpQty(cutQty, facts.maxSingleReportQty) > 0) {
    throw new ReworkRuleViolation(
      'RS-27',
      `截取数量 ${cutQty} 超出码的最大单次报工数量 ${facts.maxSingleReportQty}`,
    )
  }
  if (cmpQty(cutQty, facts.currentQty) > 0) {
    throw new ReworkRuleViolation('RS-27', `截取数量 ${cutQty} 超过码当前数量 ${facts.currentQty}`)
  }
  return cutQty
}

/**
 * RS-30 占用核权（S15 目标口径）：选中"已使用"轴号时执行需客户轴段重新分配权限
 * （OA-29 首期高影响清单），强制理由＋审计；不自动抢走他人已占用的客户轴号。
 * 权限点定义 → GAP-F4（本域最小机制：rework.axis-correction.reassign）。
 */
export const AXIS_REASSIGN_PERMISSION = 'rework.axis-correction.reassign'

export function assertCorrectionReassignAllowed(input: {
  options: readonly CorrectionOption[]
  newCustomerAxisNo: string | null
  newSegmentLength: string | null
  newVirtualAxisNo: string | null
  hasPermission: boolean
  reason: string | null | undefined
}): void {
  const target = input.options.find(
    (o) =>
      (o.customerAxisNo ?? '') === (input.newCustomerAxisNo ?? '') &&
      (o.segmentLength ?? '') === (input.newSegmentLength ?? '') &&
      (o.virtualAxisNo ?? '') === (input.newVirtualAxisNo ?? ''),
  )
  if (target === undefined || !target.used) return
  if (!input.hasPermission) {
    throw new ReworkRuleViolation(
      'RS-30',
      '选中已使用的客户轴号需客户轴段重新分配权限（修改将解绑原轴号）',
    )
  }
  if ((input.reason ?? '').trim() === '') {
    throw new ReworkRuleViolation('RS-30', '占用客户轴号重分配必须填写强制理由')
  }
}

/** RS-31 截取数量单位随物料主计量单位，不固定"米"。 */
export function assertCorrectionUomFollowsMaterial(submittedUomCode: string, materialPrimaryUomCode: string): void {
  if (submittedUomCode !== materialPrimaryUomCode) {
    throw new ReworkRuleViolation(
      'RS-31',
      `截取数量单位须随物料主计量单位（${materialPrimaryUomCode}），不固定"米"`,
    )
  }
}

/** 修正记录状态（RS-S5）。 */
export type CorrectionStatus = 'completed' | 'withdrawn'

/** 回撤下游事实（RS-33）。 */
export interface CorrectionWithdrawDownstreamFacts {
  /** 截取后的数量已被倒轴拆分 */
  splitAfterCorrection: boolean
  /** 已发运 */
  shipped: boolean
  /** 已转换 */
  converted: boolean
  /** 已形成生效质量结果 */
  qualityEffective: boolean
}

/**
 * RS-33 回撤下游拦截（[合同新造]）：截取后的数量或客户轴段已被下游使用时回撤受阻
 * 并给出可解释原因，纠正走逆序冲销；按对象关系检查而非"全部入库"类整单标记。
 */
export function assertCorrectionWithdrawNotBlocked(d: CorrectionWithdrawDownstreamFacts): void {
  if (d.splitAfterCorrection) {
    throw new ReworkRuleViolation('RS-33', '截取后的数量已被倒轴拆分，回撤受阻（纠正走逆序冲销）')
  }
  if (d.shipped) {
    throw new ReworkRuleViolation('RS-33', '该码已发运，回撤受阻（纠正走逆序冲销）')
  }
  if (d.converted) {
    throw new ReworkRuleViolation('RS-33', '该码已被转换，回撤受阻（纠正走逆序冲销）')
  }
  if (d.qualityEffective) {
    throw new ReworkRuleViolation('RS-33', '该码已形成生效质量结果，回撤受阻（纠正走逆序冲销）')
  }
}

/**
 * RS-32 回撤可执行：记录状态为已完成且操作人有回撤权限；已撤销不可重复回撤。
 */
export function assertCorrectionWithdrawable(
  status: CorrectionStatus,
  hasWithdrawPermission: boolean,
): void {
  if (status === 'withdrawn') {
    throw new ReworkRuleViolation('RS-32', '该修正记录已撤销，不可重复回撤')
  }
  if (!hasWithdrawPermission) {
    throw new ReworkRuleViolation('RS-32', '操作人无轴号修正回撤权限')
  }
}

/** RS-27：解绑占用码校验（占用码已入非线边仓/已销售/已锁定时拒绝）。 */
export function assertOccupiedUnitClearable(facts: CorrectionSubmitFacts): void {
  if (facts.occupiedUnitInWarehouse) {
    throw new ReworkRuleViolation('RS-27', '占用码已入非线边仓，不能解绑占用')
  }
  if (facts.occupiedUnitSold) {
    throw new ReworkRuleViolation('RS-27', '占用码已销售，不能解绑占用')
  }
  if (facts.occupiedUnitLocked) {
    throw new ReworkRuleViolation('RS-27', '占用码已锁定，不能解绑占用')
  }
}
