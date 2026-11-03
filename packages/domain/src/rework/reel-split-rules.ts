/**
 * 倒轴（分盘）规则（RS-01～RS-12）——冻结合同 architecture/contracts/frozen/p2/rework-split.md §1。
 *
 * 本文件为纯规则面：facts 由应用层装配（扫码事实/库存余额/客户轴段），断言违例抛
 * ReworkRuleViolation（规则码 [RS-xx]）。守恒式与 P1 IT-28 分盘守恒同族但按本域口径独立冻结
 * （含损耗项，RS-01）；记账复用 inventory-posting 同一记账序（等价服务见 application 层，
 * 协议第 3 条）。
 */
// no-restricted-imports 对 domain 包内子目录场景过宽（同 reverse/reporting/trace 先例）；单行豁免留痕。
// eslint-disable-next-line no-restricted-imports
import { addQty, cmpQty, isPositiveQty, isValidQuantityString, subQty } from '../inventory/quantity'
// eslint-disable-next-line no-restricted-imports
import { sumQty } from '../inventory/posting'
import { ReworkRuleViolation } from './errors'

/** 载具码格式（RS-03）：码第 2 位为 E/F/M/P（倒轴扫码只接受载具码；格式细则 GAP-A1 待裁）。 */
export function isCarrierCodeFormat(unitNo: string): boolean {
  return /^[0-9A-Za-z][EFMP]/.test(unitNo)
}

/** 托码判定（facts.isPalletCode 由装配方按码绑定关系/码类型给出；本函数兜底格式口径）。 */
export function looksLikePalletCode(code: string): boolean {
  // P1 码格式细则未裁（GAP-A1）：以 T07 标签域托码前缀 TL/托盘码约定兜底；事实装配优先。
  return /^(TL|PLT|TP)[-0-9]/i.test(code)
}

/** 倒出轴扫码事实（RS-03/RS-04：一码多条库存记录时由装配方折叠为同码合计）。 */
export interface ReelSplitSourceFacts {
  unitNo: string
  /** 码存在（inventory_unit 行存在且有活动余额） */
  exists: boolean
  /** 码为托码（拒绝链第一项） */
  isPalletCode: boolean
  /** 已被锁定（活动 reservation 挂在其它业务上） */
  locked: boolean
  /** 质检未完成 */
  qualityPending: boolean
  /** 报工未审核 */
  reportUnreviewed: boolean
  /** 异常未处理 */
  anomalyOpen: boolean
  /** 已入物流部仓库（仓库所属部门类别=3 物流部） */
  inLogisticsWarehouse: boolean
  /** 一码多物（同码多条库存记录且料品不一致） */
  multiMaterial: boolean
  /** 同码合计数量（RS-04：同料品时按同码合计作为倒出量基数） */
  balanceQty: string
  /** 料品（RS-09：倒入码已有料品且与倒出不一致时整体失败） */
  materialId: string
  materialCode: string
  /** 客户轴号（RS-05：带客户轴号时必须全量倒出且只能一条倒入） */
  customerAxisNo: string | null
  /** 段长（RS-05 同上） */
  segmentLength: string | null
}

/**
 * RS-03 倒出轴扫码前置拒绝链（任一命中拒绝；顺序按合同罗列）：
 * 托码 → 码不存在 → 已锁定 → 质检未完成 → 报工未审核 → 异常未处理 →
 * 已入物流部仓库 → 一码多物 → 码格式须为载具码（第 2 位 E/F/M/P）。
 */
export function assertReelSplitSourceScannable(f: ReelSplitSourceFacts): void {
  if (f.isPalletCode) {
    throw new ReworkRuleViolation('RS-03', '该码为托码，不能作为倒出轴扫码')
  }
  if (!f.exists) {
    throw new ReworkRuleViolation('RS-03', '码不存在，请核对倒出轴码')
  }
  if (f.locked) {
    throw new ReworkRuleViolation('RS-03', '该轴已被其它业务锁定，不能倒轴')
  }
  if (f.qualityPending) {
    throw new ReworkRuleViolation('RS-03', '该轴质检未完成，不能倒轴')
  }
  if (f.reportUnreviewed) {
    throw new ReworkRuleViolation('RS-03', '该轴报工未审核，不能倒轴')
  }
  if (f.anomalyOpen) {
    throw new ReworkRuleViolation('RS-03', '该轴存在未处理异常，不能倒轴')
  }
  if (f.inLogisticsWarehouse) {
    throw new ReworkRuleViolation('RS-03', '该轴已入物流部仓库，不能倒轴')
  }
  if (f.multiMaterial) {
    throw new ReworkRuleViolation('RS-03', '一码多物，不能倒轴')
  }
  if (!isCarrierCodeFormat(f.unitNo)) {
    throw new ReworkRuleViolation('RS-03', '倒出轴码格式须为载具码（第 2 位 E/F/M/P）')
  }
}

/** 倒入行输入（RS-02：数量与码约束）。 */
export interface ReelSplitPourLine {
  unitNo: string
  quantity: unknown
}

/**
 * RS-02 倒入数量与码约束：
 * 仅数字与一位小数点、小数最多 4 位；每条倒入数量 > 0 且已填；
 * 倒入码互不重复且不得等于倒出码。
 */
export function assertReelSplitPourLines(lines: readonly ReelSplitPourLine[], sourceUnitNo: string): string[] {
  const seen = new Set<string>()
  const quantities: string[] = []
  lines.forEach((line, index) => {
    const no = (line.unitNo ?? '').trim()
    if (no === '') {
      throw new ReworkRuleViolation('RS-02', `第 ${index + 1} 条倒入行未填倒入码`)
    }
    if (!isValidQuantityString(line.quantity)) {
      throw new ReworkRuleViolation(
        'RS-02',
        `倒入轴 ${no} 数量仅允许数字与一位小数点、小数最多 4 位`,
      )
    }
    const qty = line.quantity as string
    if (!isPositiveQty(qty)) {
      throw new ReworkRuleViolation('RS-02', `倒入轴 ${no} 数量必须大于 0 且已填写`)
    }
    if (seen.has(no)) {
      throw new ReworkRuleViolation('RS-02', `倒入码 ${no} 重复`)
    }
    if (no === sourceUnitNo) {
      throw new ReworkRuleViolation('RS-02', `倒入码 ${no} 不得等于倒出码`)
    }
    seen.add(no)
    quantities.push(qty)
  })
  return quantities
}

/** RS-11 损耗登记（[合同新造·建议]）：默认 0、4 位小数、≥0；损耗 > 0 时原因必填。 */
export function normalizeReelSplitLoss(lossQty: unknown, lossReason: string | null | undefined): string {
  if (lossQty === undefined || lossQty === null || (lossQty as string) === '') return '0.0000'
  if (!isValidQuantityString(lossQty)) {
    throw new ReworkRuleViolation('RS-11', '损耗量仅允许数字与一位小数点、小数最多 4 位')
  }
  const qty = lossQty as string
  if (cmpQty(qty, '0.0000') < 0) {
    throw new ReworkRuleViolation('RS-11', '损耗量必须 ≥ 0')
  }
  if (isPositiveQty(qty) && (lossReason ?? '').trim() === '') {
    throw new ReworkRuleViolation('RS-11', '登记损耗时损耗原因必填（损耗数量＋原因）')
  }
  return qty
}

/**
 * RS-01 倒轴守恒式（本域口径）：倒出轴原量 = 全部倒入合计 + 倒出轴留存量 + 本次已登记损耗量。
 * 样例（A05）：1,000 m = 600 m + 390 m + 10 m 损耗。任一提交不满足即拒绝；
 * 留存量 < 0（即倒入合计＋损耗 > 原量）同链拒绝（RS-02 尾部"倒入合计 > 倒出数量时拒绝"）。
 */
export function assertReelSplitConservation(input: {
  originalQty: string
  pourQtyList: readonly string[]
  lossQty: string
}): string {
  const pourTotal = sumQty([...input.pourQtyList])
  const lossPlusPour = addQty(pourTotal, input.lossQty)
  if (cmpQty(lossPlusPour, input.originalQty) > 0) {
    throw new ReworkRuleViolation(
      'RS-02',
      `倒入合计 ${pourTotal} 加损耗 ${input.lossQty} 超过倒出数量 ${input.originalQty}，拒绝`,
    )
  }
  return subQty(input.originalQty, lossPlusPour)
}

/**
 * RS-05 客户轴号/段长约束：倒出轴带客户轴号或段长时——
 * ①必须全量倒出（倒入合计＋损耗 = 倒出数量，即留存 0）；②倒入轴只能有一条。
 * 两条约束各自独立拒绝并给出对应提示。
 */
export function assertReelSplitCustomerSegmentFullPour(input: {
  source: ReelSplitSourceFacts
  pourQtyList: readonly string[]
  lossQty: string
  retainedQty: string
}): void {
  const hasCustomerIdentity = input.source.customerAxisNo !== null || input.source.segmentLength !== null
  if (!hasCustomerIdentity) return
  if (input.pourQtyList.length > 1) {
    throw new ReworkRuleViolation(
      'RS-05',
      `倒出轴带客户轴号/段长（${input.source.customerAxisNo ?? input.source.segmentLength}），倒入轴只能有一条`,
    )
  }
  if (cmpQty(input.retainedQty, '0.0000') !== 0) {
    throw new ReworkRuleViolation(
      'RS-05',
      `倒出轴带客户轴号/段长（${input.source.customerAxisNo ?? input.source.segmentLength}），必须全量倒出（留存 ${input.retainedQty} ≠ 0）`,
    )
  }
}

/** RS-12 冲销前置下游引用事实：任一命中即拒绝冲销。 */
export interface ReelSplitReversalDownstreamFacts {
  /** 任一子段已入库 */
  anyChildStocked: boolean
  /** 任一子段已被消耗 */
  anyChildConsumed: boolean
  /** 任一子段已被转换 */
  anyChildConverted: boolean
  /** 任一子段已发运 */
  anyChildShipped: boolean
  /** 任一子段已形成生效质量结果 */
  anyChildQualityEffective: boolean
}

/**
 * RS-12 倒轴冲销（[合同新造]）：纠正走反向流水＋新建纠正事实（关联原倒轴单）；
 * 冲销前置校验下游引用——600 m 子轴已发运时回撤原倒轴必须受阻（A11）。
 * 冲销单据形态与允许时间窗 → GAP-F2。
 */
export function assertReelSplitReversible(d: ReelSplitReversalDownstreamFacts): void {
  if (d.anyChildStocked) {
    throw new ReworkRuleViolation('RS-12', '子轴已入库，倒轴单不可冲销（纠正走逆序冲销）')
  }
  if (d.anyChildConsumed) {
    throw new ReworkRuleViolation('RS-12', '子轴已被消耗，倒轴单不可冲销（纠正走逆序冲销）')
  }
  if (d.anyChildConverted) {
    throw new ReworkRuleViolation('RS-12', '子轴已被转换，倒轴单不可冲销（纠正走逆序冲销）')
  }
  if (d.anyChildShipped) {
    throw new ReworkRuleViolation('RS-12', '子轴已发运，倒轴单不可冲销（纠正走逆序冲销）')
  }
  if (d.anyChildQualityEffective) {
    throw new ReworkRuleViolation('RS-12', '子轴已形成生效质量结果，倒轴单不可冲销（纠正走逆序冲销）')
  }
}

/** RS-02 可执行条件汇总：已扫倒出轴 + 至少一条倒入 + 全部码/量约束成立。 */
export function assertReelSplitExecutable(input: {
  sourceScanned: boolean
  source: ReelSplitSourceFacts
  pourLines: readonly ReelSplitPourLine[]
}): { pourQtyList: string[] } {
  if (!input.sourceScanned) {
    throw new ReworkRuleViolation('RS-02', '尚未扫描倒出轴，不可执行倒轴')
  }
  if (input.pourLines.length === 0) {
    throw new ReworkRuleViolation('RS-02', '至少填写一条倒入轴，不可执行倒轴')
  }
  const pourQtyList = assertReelSplitPourLines(input.pourLines, input.source.unitNo)
  return { pourQtyList }
}

/**
 * RS-01/02/05/11 提交时统一校验（RS-06：全部业务规则在提交时统一校验）。
 * 返回留存量与倒入数量列表供记账装配。
 */
export function validateReelSplitSubmission(input: {
  sourceScanned: boolean
  source: ReelSplitSourceFacts
  pourLines: readonly ReelSplitPourLine[]
  lossQty: unknown
  lossReason: string | null | undefined
}): { pourQtyList: string[]; lossQty: string; retainedQty: string; pourTotal: string } {
  assertReelSplitSourceScannable(input.source)
  const { pourQtyList } = assertReelSplitExecutable({
    sourceScanned: input.sourceScanned,
    source: input.source,
    pourLines: input.pourLines,
  })
  const lossQty = normalizeReelSplitLoss(input.lossQty, input.lossReason)
  const retainedQty = assertReelSplitConservation({
    originalQty: input.source.balanceQty,
    pourQtyList,
    lossQty,
  })
  assertReelSplitCustomerSegmentFullPour({
    source: input.source,
    pourQtyList,
    lossQty,
    retainedQty,
  })
  return { pourQtyList, lossQty, retainedQty, pourTotal: sumQty([...pourQtyList]) }
}
