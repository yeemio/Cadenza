import { DispositionRuleViolation } from './errors'
import { checkPositiveQty, num } from './decimal-util'

/**
 * 处置、返工、报废、让步规则（QD-19～QD-23，frozen/p2/quality-disposition.md §4；
 * S12 显式新增、无原件——[合同新造]，GAP-F16/17 相关最小机制，未裁定项不扩展）。
 * 证书/客诉/召回三对象随 GAP-F16 裁定，裁定前不建（QD-S5）。
 */

/** QD-20：处置记录首期四类 + 存疑恢复处置（QD-03 落库为处置记录）。 */
export type DispositionKindValue = 'rework' | 'scrap' | 'concession' | 'release' | 'hold_release'

/** QD-20：处置决定最低字段（决定人、时间、依据、关联检验或异常记录、去向指针）。 */
export interface DispositionDecisionInput {
  dispositionKind: DispositionKindValue | string
  decidedBy: string
  decidedAt: Date | null
  basis: string | null
  /** 关联对象类型/ID（检验结果/异常记录/存疑记录等） */
  targetType: string | null
  targetId: string | null
}

/** QD-20：处置决定校验——四类枚举 + 最低字段；放行与报废为高影响操作：强制理由＋审计（OA-29 精神）。 */
export function assertDispositionDecision(input: DispositionDecisionInput): DispositionKindValue {
  const kinds: DispositionKindValue[] = ['rework', 'scrap', 'concession', 'release', 'hold_release']
  if (!kinds.includes(input.dispositionKind as DispositionKindValue)) {
    throw new DispositionRuleViolation(
      'QD-20',
      `处置类型非法（${input.dispositionKind}）：首期为 返工/报废/让步/放行（另有存疑恢复处置）`,
    )
  }
  const kind = input.dispositionKind as DispositionKindValue
  if (input.decidedBy === '') throw new DispositionRuleViolation('QD-20', '处置决定缺少决定人')
  if (input.decidedAt === null) throw new DispositionRuleViolation('QD-20', '处置决定缺少决定时间')
  if ((kind === 'release' || kind === 'scrap') && (input.basis === null || input.basis.trim() === '')) {
    throw new DispositionRuleViolation('QD-20', `高影响操作（${kind === 'release' ? '放行' : '报废'}）必须填写处置依据/理由`)
  }
  if (input.targetType === null || input.targetId === null || input.targetId === '') {
    throw new DispositionRuleViolation('QD-20', '处置决定必须关联检验或异常/存疑记录（关联对象指针）')
  }
  return kind
}

/** QD-21：返工处置校验——返工任务须关联原工序/订单/码；产出走报工命令与谱系（不在库存账凭空生成数量）。 */
export function assertReworkTaskLink(input: {
  originUnitNo: string | null
  originProcessOrderNo: string | null
  originOperation: string | null
}): { originUnitNo: string; originProcessOrderNo: string; originOperation: string | null } {
  if (input.originUnitNo === null || input.originUnitNo === '') {
    throw new DispositionRuleViolation('QD-21', '返工任务必须关联原码（产品轴号）')
  }
  if (input.originProcessOrderNo === null || input.originProcessOrderNo === '') {
    throw new DispositionRuleViolation('QD-21', '返工任务必须关联原工序/订单')
  }
  return {
    originUnitNo: input.originUnitNo,
    originProcessOrderNo: input.originProcessOrderNo,
    originOperation: input.originOperation ?? null,
  }
}

/** QD-22：报废处置校验——报废数量必须可从可用量足额扣减（数量从可用量移除；报废数量不可再进入可用量与发运）。 */
export function assertScrapQty(input: {
  scrapQty: string | null
  availableQty: string
  unitNo: string
}): string {
  const qty = checkPositiveQty(input.scrapQty ?? '', 'QD-22', '报废数量')
  if (num(qty) > num(input.availableQty)) {
    throw new DispositionRuleViolation(
      'QD-22',
      `码 ${input.unitNo} 可用量不足：报废 ${qty} > 可用量 ${input.availableQty}（报废从可用量移除，不得为负）`,
    )
  }
  return qty
}

/** QD-23：让步范围（批次/数量/期限；让步范围外数量仍按不合格拦截）。 */
export interface ConcessionScope {
  batchNo: string | null
  qty: string | null
  expiresAt: Date | null
}

/** QD-23：让步审批校验——保留原不合格事实的放行决定，附审批人与让步范围（三者必填）。 */
export function assertConcession(input: {
  approver: string | null
  scope: ConcessionScope | null
  /** 让步范围内当前是否超出（数量超限拒） */
  requestedQty?: string | null
}): { approver: string; scope: Required<Pick<ConcessionScope, 'batchNo' | 'qty'>> & { expiresAt: Date | null } } {
  if (input.approver === null || input.approver.trim() === '') {
    throw new DispositionRuleViolation('QD-23', '让步放行必须附审批人')
  }
  if (input.scope === null) throw new DispositionRuleViolation('QD-23', '让步放行必须附让步范围（批次/数量/期限）')
  if (input.scope.batchNo === null || input.scope.batchNo === '') {
    throw new DispositionRuleViolation('QD-23', '让步范围缺少批次')
  }
  const qty = checkPositiveQty(input.scope.qty ?? '', 'QD-23', '让步范围数量')
  if (input.requestedQty !== undefined && input.requestedQty !== null && num(input.requestedQty) > num(qty)) {
    throw new DispositionRuleViolation(
      'QD-23',
      `让步放行数量 ${input.requestedQty} 超出让步范围 ${qty}（范围外数量仍按不合格拦截）`,
    )
  }
  return { approver: input.approver, scope: { batchNo: input.scope.batchNo, qty, expiresAt: input.scope.expiresAt ?? null } }
}

/** QD-19：处置与放行分离总则（结构约束）——"审核通过"≠"质检合格"；隔离与处置独立。
 * 本域实现口径：检验事实（qd_inspection_result / finished_goods_defect）与处置决定（qd_disposition_record）
 * 分表存储；放行/让步只追加处置记录并引用检验事实版本，不改写事实行（append-only 由库级守卫保证）。 */
export function releaseKeepsFactsNote(): string {
  return 'QD-19：检验事实与有效判定分开存储；放行/让步保留关联和审批，让步保留原不合格事实（事实行不覆盖）'
}
