import { CswRuleViolation } from './errors'
import { assertQtyPositive, cmpQty } from './shared'

/**
 * csw 外协任务规则（T22 冻结合同 §4：CS-19～CS-25；外协业务原件输入为零、显式 [合同新造]）。
 *
 * [CS-19] 状态机 草稿→待发送→已发送（在外加工）→回厂接收→检验→关闭；取消另记
 * （已发送后取消走收回流程，回厂后取消走退回处置）；状态由具名命令驱动，每步留操作者与时间。
 * [CS-20] 材料所有权保留：所有者不变、库存状态转入 外协在途（in_transit 分支）、不作出库报废。
 * [CS-21] 库存交接沿用调拨两段原子步模式（IT-25）：发送＝来源减＋外协在途增；
 * 回厂接收＝外协在途减＋目的增；两段各自原子，库存域唯一记账方（IT-18）。
 * [CS-22] 回厂检验：默认全部必检（检验结论与放行走 T12/T18 质量合同）。
 * [CS-23] 外协谱系：发送批次→回厂批次父子边（genealogy_edge 追加）。
 * [CS-24] 商务结算归 ERP：本系统不记应付/加工费/发票；加工数量事实可导出/回传（模拟适配器先行）。
 * [CS-25] 外协挂接订单工序（外协期间本厂设备不排产）；完成判定走报工/接收事实，不以已发送充当完成。
 */

// ---------------------------------------------------------------------------
// CS-19 状态机
// ---------------------------------------------------------------------------

export type OutsourcingStatus =
  | 'draft'
  | 'pending_send'
  | 'sent'
  | 'return_received'
  | 'inspecting'
  | 'closed'
  | 'recalled'
  | 'return_disposed'

export const OUTSOURCING_STATUS_VALUES: readonly OutsourcingStatus[] = [
  'draft',
  'pending_send',
  'sent',
  'return_received',
  'inspecting',
  'closed',
  'recalled',
  'return_disposed',
]

export const OUTSOURCING_STATUS_LABELS: Readonly<Record<OutsourcingStatus, string>> = {
  draft: '草稿',
  pending_send: '待发送',
  sent: '已发送（在外加工）',
  return_received: '回厂接收',
  inspecting: '检验',
  closed: '关闭',
  recalled: '已收回（已发送后取消）',
  return_disposed: '退回处置（回厂后取消）',
}

/** 具名驱动命令（每步留操作者与时间）。 */
export type OutsourcingAction =
  | 'submit' // 草稿 → 待发送
  | 'send' // 待发送 → 已发送（在外加工）＋ 发送段库存交接
  | 'receive' // 已发送 → 回厂接收 ＋ 回厂段库存交接
  | 'inspect' // 回厂接收 → 检验
  | 'close' // 检验 → 关闭（检验通过）
  | 'recall' // 已发送 → 已收回（收回流程：余量回厂段库存交接）
  | 'dispose' // 回厂接收/检验 → 退回处置（回厂后取消）

export const OUTSOURCING_TRANSITIONS: Readonly<
  Record<OutsourcingAction, { from: readonly OutsourcingStatus[]; to: OutsourcingStatus }>
> = {
  submit: { from: ['draft'], to: 'pending_send' },
  send: { from: ['pending_send'], to: 'sent' },
  receive: { from: ['sent'], to: 'return_received' },
  inspect: { from: ['return_received'], to: 'inspecting' },
  close: { from: ['inspecting'], to: 'closed' },
  recall: { from: ['sent'], to: 'recalled' },
  dispose: { from: ['return_received', 'inspecting'], to: 'return_disposed' },
}

/** [CS-19] 具名命令驱动状态迁移校验（不匹配即拒）。 */
export function assertOutsourcingTransition(
  action: OutsourcingAction,
  current: OutsourcingStatus,
): OutsourcingStatus {
  const t = OUTSOURCING_TRANSITIONS[action]
  if (t === undefined) {
    throw new CswRuleViolation('CS-19', `未知外协命令：${action}（状态由具名命令驱动）`)
  }
  if (!t.from.includes(current)) {
    throw new CswRuleViolation(
      'CS-19',
      `外协命令 ${action} 不允许在状态「${OUTSOURCING_STATUS_LABELS[current]}」执行（允许起点：${t.from
        .map((f) => OUTSOURCING_STATUS_LABELS[f])
        .join('→')}）`,
    )
  }
  return t.to
}

/** 终态判定（关闭/已收回/退回处置后不再迁移）。 */
export function isOutsourcingTerminal(status: OutsourcingStatus): boolean {
  return status === 'closed' || status === 'recalled' || status === 'return_disposed'
}

// ---------------------------------------------------------------------------
// CS-20/CS-21 所有权保留与两段原子交接
// ---------------------------------------------------------------------------

/**
 * [CS-20] 外协发送后材料法律/业务所有者不变（IT-02 三分存储不变）：发送段 fromOwner==toOwner
 * 强校验（不作出库报废、不变更所有者；库存状态转入 外协在途＝in_transit 的具名细分）。
 */
export function assertOwnershipRetainedOnSend(input: {
  fromOwnerId: string
  toOwnerId: string
  unitNo: string
}): void {
  if (input.fromOwnerId !== input.toOwnerId) {
    throw new CswRuleViolation(
      'CS-20',
      `外协发送不得变更材料所有者（单元 ${input.unitNo}：${input.fromOwnerId} → ${input.toOwnerId}；所有权保留，库存状态仅转入外协在途）`,
    )
  }
}

/** [CS-21] 发送行形状：单元存在、数量>0、行内单元不重复（两段各自原子，IT-25 锁序由记账服务承担）。 */
export function assertSendLinesShape(
  lines: ReadonlyArray<{ unitId: string; quantity: string }>,
): void {
  if (lines.length === 0) {
    throw new CswRuleViolation('CS-21', '外协发送至少一行（发送＝来源减＋外协在途增，两段各自原子）')
  }
  const seen = new Set<string>()
  for (const [i, l] of lines.entries()) {
    if (!l.unitId) {
      throw new CswRuleViolation('CS-21', `发送行[${i}] 缺少 unitId`)
    }
    if (seen.has(l.unitId)) {
      throw new CswRuleViolation('CS-21', `发送行重复单元 ${l.unitId}（同单元合并为一行）`)
    }
    seen.add(l.unitId)
    assertQtyPositive(l.quantity, `发送行[${i}] 数量`, 'CS-S4')
  }
}

/** [CS-21] 回厂行形状：行内单元不重复、数量>0；回厂量不得超过该单元发送余量（装配层按链接行核对）。 */
export function assertReceiveLinesShape(
  lines: ReadonlyArray<{ unitId: string; quantity: string }>,
): void {
  assertSendLinesShape(lines) // 同形状口径
}

// ---------------------------------------------------------------------------
// CS-22 回厂检验（默认全部必检）
// ---------------------------------------------------------------------------

/** [CS-22] 回厂接收后默认全部必检：回厂目的余额质量状态必须落 待检（强制级别 → CA-15 待裁）。 */
export function assertReturnEntersPendingInspection(qualityStatus: string): void {
  if (qualityStatus !== 'pending_inspection') {
    throw new CswRuleViolation(
      'CS-22',
      `回厂接收默认全部必检：目的余额质量状态须为待检（pending_inspection），实际 ${qualityStatus}（按供应方等级抽检为配置扩展，强制级别 → CA-15 待裁）`,
    )
  }
}

/** [CS-25] 关闭须检验通过（不以"已发送"充当完成；完成判定走报工/接收事实）。 */
export function assertCloseRequiresInspectionPassed(inspectionResult: 'pending' | 'passed' | 'rejected' | null): void {
  if (inspectionResult !== 'passed') {
    throw new CswRuleViolation(
      'CS-25',
      `外协任务关闭须回厂检验通过（当前检验结论 ${inspectionResult ?? '未记录'}；已发送不充当工序完成，完成判定走报工/接收事实）`,
    )
  }
}

// ---------------------------------------------------------------------------
// CS-23 外协谱系 / CS-24 商务结算归 ERP
// ---------------------------------------------------------------------------

/** [CS-23] 回厂批次父子边形状：声明了与发送批次不同的回厂批次时必须落 genealogy_edge。 */
export function assertGenealogyEdgeRequired(input: {
  sendLotId: string
  returnLotNo: string | null
  unitNo: string
}): { edgeRequired: boolean } {
  if (input.returnLotNo === null || input.returnLotNo.trim() === '') return { edgeRequired: false }
  return { edgeRequired: true }
}

/** [CS-24] 商务结算归 ERP：本系统不记应付/加工费/发票——载荷携带金额/发票字段即拒（越界防护）。 */
export function assertNoSettlementFields(payload: Record<string, unknown>): void {
  const forbidden = ['amount', 'fee', 'invoiceNo', 'unitPrice', 'payable']
  const hit = forbidden.filter((k) => payload[k] !== undefined)
  if (hit.length > 0) {
    throw new CswRuleViolation(
      'CS-24',
      `外协载荷不得携带商务结算字段（${hit.join('/')}）：应付/加工费/发票归 ERP，本系统仅导出加工数量事实`,
    )
  }
}

/** [CS-24] 加工数量事实（导出/回传供 ERP 结算核对；接口族无样例 → 模拟适配器先行）。 */
export interface OutsourcingSettlementFact {
  taskNo: string
  supplierCode: string | null
  supplierName: string
  orderNo: string
  operationName: string
  sentQty: string
  returnedQty: string
  uom: string
  sentAt: string | null
  receivedAt: string | null
  closedAt: string | null
}

export function buildSettlementFact(input: {
  taskNo: string
  supplierCode: string | null
  supplierName: string
  orderNo: string
  operationName: string
  sentQty: string
  returnedQty: string
  uom: string
  sentAt: string | null
  receivedAt: string | null
  closedAt: string | null
}): OutsourcingSettlementFact {
  if (cmpQty(input.returnedQty, input.sentQty) > 0) {
    throw new CswRuleViolation('CS-S4', `回厂量 ${input.returnedQty} 超发送量 ${input.sentQty}，事实不可导出`)
  }
  return { ...input }
}
