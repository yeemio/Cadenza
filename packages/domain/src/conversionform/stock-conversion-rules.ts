import { ConversionRuleViolation } from './errors'
import { compareDecimal, isConversionDecimalString } from './order-conversion-rules'

/**
 * 库存形态转换（协议B：外部先成功、再本地）纯规则 —— 冻结合同 form-conversion.md
 * FC-13/14/15/16/17/18/19/20/21（原件 形态转换/02-库存形态转换.md；DM §7.2）。
 *
 * 提交链路四步（FC-13）：①保存/更新单据（预留源库存）→②调 U9（Outbox/任务驱动，
 * 业务事务不跨公网等待 IT-26）→③U9 明确成功后 MES 改码＋库存统计→④全部成功=转换成功。
 * 内部按 DM §7.2 六态实现，投影到原文三态对外展示（FC-14）。
 */

/** FC-14：内部六态（DM §7.2：待执行/外部处理中/本地处理中/完成/待恢复/人工处理）。 */
export const STOCK_INTERNAL_STATUSES = [
  'pending_execute',
  'external_processing',
  'local_processing',
  'completed',
  'pending_recovery',
  'manual_processing',
] as const
export type StockInternalStatus = (typeof STOCK_INTERNAL_STATUSES)[number]

/** FC-S3/FC-18：未完成集（internal_status ∈ 未完成集 ⇔ 明细 (二维码,物料) 占用唯一生效）。 */
export const STOCK_UNFINISHED_INTERNAL_STATUSES = STOCK_INTERNAL_STATUSES.filter((s) => s !== 'completed') as readonly StockInternalStatus[]

export function isStockUnfinished(status: StockInternalStatus): boolean {
  return status !== 'completed'
}

/** FC-14：对外三态投影（原文 02:29-35：转换失败/同步失败/转换成功）。 */
export const STOCK_DISPLAY_STATUSES = ['convert_failed', 'sync_failed', 'convert_success'] as const
export type StockDisplayStatus = (typeof STOCK_DISPLAY_STATUSES)[number]

/**
 * FC-14：内部六态 → 对外三态投影。
 * - 完成 → 转换成功；
 * - U9 已成功（u9Success）而未完成 → 同步失败（MES 改码/库存统计未完成，可重新同步）；
 * - 其余（待执行/外部处理中/待恢复-外部失败/人工处理）→ 转换失败——"转换失败"仅是
 *   待执行/外部失败态的展示名，不作为内部状态机（不以首次落单默认转换失败为内部态）。
 */
export function projectStockDisplayStatus(
  internalStatus: StockInternalStatus,
  u9Success: boolean,
): StockDisplayStatus {
  if (internalStatus === 'completed') return 'convert_success'
  return u9Success ? 'sync_failed' : 'convert_failed'
}

/** FC-16：MES 改码内容——回写销售单号/行号/批次号/段长/客户轴号、清空虚拟轴号、不改项目号。 */
export interface CodeRewriteSpec {
  unitNo: string
  oldSalesOrderNo: string | null
  oldLineNo: string | null
  oldBatchNo: string | null
  oldVirtualAxisNo: string | null
  newSalesOrderNo: string
  newLineNo: string
  newBatchNo: string
  newSegmentLength: string
  newCustomerAxisNo: string | null
  /** 清空虚拟轴号（源码有虚拟轴号时必须置位）。 */
  clearVirtualAxis: boolean
  /** 转换后项目号（只记单据、不回写码——FC-16；本字段仅用于断言其不得进入改码载荷）。 */
  targetProjectNo?: unknown
}

/** FC-16：改码形状断言——项目号不得随推改码（码上项目号不变）；虚拟轴号清空置位。 */
export function assertCodeRewriteShape(spec: CodeRewriteSpec): void {
  if (spec.targetProjectNo !== undefined && spec.targetProjectNo !== null) {
    throw new ConversionRuleViolation(
      'FC-16',
      `码 ${spec.unitNo} 改码不得包含项目号（转换后项目号只记单据、不回写码）`,
    )
  }
  if (spec.newSalesOrderNo.trim() === '' || spec.newLineNo.trim() === '' || spec.newBatchNo.trim() === '') {
    throw new ConversionRuleViolation('FC-16', `码 ${spec.unitNo} 改码后销售单号/行号/批次号必填`)
  }
  if (!isConversionDecimalString(spec.newSegmentLength) || compareDecimal(spec.newSegmentLength, '0.0001') < 0) {
    throw new ConversionRuleViolation('FC-16', `码 ${spec.unitNo} 改码后段长须为正十进制定点（≤4 位小数）`)
  }
  if (spec.oldVirtualAxisNo !== null && spec.oldVirtualAxisNo.trim() !== '' && !spec.clearVirtualAxis) {
    throw new ConversionRuleViolation('FC-16', `码 ${spec.unitNo} 原有虚拟轴号 ${spec.oldVirtualAxisNo} 须清空`)
  }
}

// ---------------- FC-13/15：链路步进门 ----------------

/** FC-13②：派发 U9——仅待执行可派发（已派发/已成功不重发，防 U9 侧两张单）。 */
export function assertStockPushable(input: { internalStatus: StockInternalStatus }): void {
  if (input.internalStatus !== 'pending_execute') {
    throw new ConversionRuleViolation(
      'FC-13',
      `仅待执行的单可派发 U9 形态转换（当前内部状态 ${input.internalStatus}；已派发不盲重发，防 U9 侧两张单）`,
    )
  }
}

/** FC-03/FC-13②：外部结果回填门——外部处理中（首次结果）或人工处理（未知态人工核对后回填）。 */
export function assertStockPushResultAcceptable(input: { internalStatus: StockInternalStatus }): void {
  if (input.internalStatus !== 'external_processing' && input.internalStatus !== 'manual_processing') {
    throw new ConversionRuleViolation(
      'FC-03',
      `外部结果回填仅在外部处理中/人工处理态可登记（当前内部状态 ${input.internalStatus}）`,
    )
  }
}

/** FC-15/FC-13③：本地应用门——U9 已成功且本地未完成（本地处理中或待恢复）。 */
export function assertStockLocalApplyable(input: {
  internalStatus: StockInternalStatus
  u9Success: boolean
}): void {
  if (!input.u9Success) {
    throw new ConversionRuleViolation('FC-15', 'U9 未成功不可执行 MES 改码与库存统计（外部先成功、再本地）')
  }
  if (input.internalStatus !== 'local_processing' && input.internalStatus !== 'pending_recovery') {
    throw new ConversionRuleViolation(
      'FC-15',
      `本地应用仅在本地处理中/待恢复态可执行（当前内部状态 ${input.internalStatus}）`,
    )
  }
}

/** FC-15：重新转换门——仅转换失败单（U9 未成功且未派发中/未完成；未知人工核对态不盲重发）。 */
export function assertStockReconvertable(input: {
  internalStatus: StockInternalStatus
  u9Success: boolean
}): void {
  if (input.u9Success) {
    throw new ConversionRuleViolation(
      'FC-15',
      'U9 已成功的单不可重新转换（外部已成功步骤不重做；本地未完成走重新同步）',
    )
  }
  if (input.internalStatus !== 'pending_execute' && input.internalStatus !== 'pending_recovery') {
    throw new ConversionRuleViolation(
      'FC-15',
      `重新转换仅转换失败单可执行（当前内部状态 ${input.internalStatus}；外部未知须先人工核对，不换键盲发）`,
    )
  }
}

/** FC-15：重新同步门——仅同步失败单（U9 已成功、本地未完成；只做 MES 改码与库存统计，不再推 U9）。 */
export function assertStockResyncable(input: {
  internalStatus: StockInternalStatus
  u9Success: boolean
  localApplyStatus: 'not_applied' | 'applied' | 'failed'
}): void {
  if (!input.u9Success) {
    throw new ConversionRuleViolation('FC-15', '重新同步仅同步失败单可执行（U9 未成功属转换失败，走重新转换）')
  }
  if (input.internalStatus === 'completed') {
    throw new ConversionRuleViolation('FC-15', '转换成功的单无须重新同步')
  }
  if (input.internalStatus !== 'local_processing' && input.internalStatus !== 'pending_recovery') {
    throw new ConversionRuleViolation(
      'FC-15',
      `重新同步仅在本地处理中/待恢复态可执行（当前内部状态 ${input.internalStatus}）`,
    )
  }
  if (input.localApplyStatus === 'applied') {
    throw new ConversionRuleViolation('FC-15', '本地改码已应用，无须重新同步')
  }
}

// ---------------- FC-17/18/20：提交校验 ----------------

/** FC-18：提交前校验输入（命令层事实收集后调用）。 */
export interface StockSubmitInput {
  materialCode: string
  /** 料品类型（须成品=3，FC-17）。 */
  materialType: number
  /** 该成品当前库存数量合计（须 > 0，FC-17）。 */
  materialStockQty: string
  targetProjectNo: string | null
  targetSalesOrderNo: string
  targetLineNo: string
  targetBatchNo: string
  lines: ReadonlyArray<{
    unitNo: string
    segmentLength: string
    customerAxisNo: string | null
    quantity: string
    materialId: string
    /** 锁定中的码（活动作业预留——含协议A扫码锁定），FC-20。 */
    lockedByOther: boolean
    /** 该"二维码＋物料"存在未转换成功单据占用（含本单以外的库存转换单），FC-18/20。 */
    occupiedUnfinished: boolean
  }>
}

const MAX_TEXT_50 = 50

function assertText50(value: string, label: string, rule: string): void {
  if (value.length > MAX_TEXT_50) {
    throw new ConversionRuleViolation(rule, `${label}最长 ${MAX_TEXT_50} 字符（当前 ${value.length}）`)
  }
}

/**
 * FC-17/18：提交前校验——料品=成品且当前库存>0；右侧至少 1 条明细；
 * 转换后销售单号/行号/批次号必填（项目号非必填，均最长 50）；每行段长必填
 * （数值、精度 4、最小 0.0001）；客户轴号非必填（≤50）；
 * 同一"二维码＋物料"存在未转换成功的单据不可再次添加；锁定中的码不可转换。
 */
export function assertStockSubmitShape(input: StockSubmitInput): void {
  if (input.materialType !== 3) {
    throw new ConversionRuleViolation('FC-17', `转换料品须为成品（料品类型 ${input.materialType} ≠ 3）`)
  }
  if (compareDecimal(input.materialStockQty, '0.0000') <= 0) {
    throw new ConversionRuleViolation('FC-17', `料品 ${input.materialCode} 当前库存不大于 0，无可转换库存`)
  }
  if (input.lines.length === 0) {
    throw new ConversionRuleViolation('FC-18', '右侧转换清单至少 1 条明细方可提交')
  }
  if (input.targetSalesOrderNo.trim() === '') {
    throw new ConversionRuleViolation('FC-18', '转换后销售单号必填')
  }
  if (input.targetLineNo.trim() === '') {
    throw new ConversionRuleViolation('FC-18', '转换后行号必填')
  }
  if (input.targetBatchNo.trim() === '') {
    throw new ConversionRuleViolation('FC-18', '转换后批次号必填')
  }
  assertText50(input.targetSalesOrderNo, '转换后销售单号', 'FC-18')
  assertText50(input.targetLineNo, '转换后行号', 'FC-18')
  assertText50(input.targetBatchNo, '转换后批次号', 'FC-18')
  if (input.targetProjectNo !== null) assertText50(input.targetProjectNo, '转换后项目号', 'FC-18')

  const seenUnits = new Set<string>()
  for (const [index, line] of input.lines.entries()) {
    const no = `明细 ${index + 1}（${line.unitNo}）`
    if (seenUnits.has(line.unitNo)) {
      throw new ConversionRuleViolation('FC-18', `${no}：同一二维码不可重复加入本单清单`)
    }
    seenUnits.add(line.unitNo)
    if (!isConversionDecimalString(line.segmentLength) || compareDecimal(line.segmentLength, '0.0001') < 0) {
      throw new ConversionRuleViolation('FC-18', `${no}段长必填且须为不小于 0.0001 的十进制定点（精度 4 位）`)
    }
    if (line.customerAxisNo !== null) assertText50(line.customerAxisNo, `${no}客户轴号`, 'FC-18')
    if (!isConversionDecimalString(line.quantity) || compareDecimal(line.quantity, '0.0001') < 0) {
      throw new ConversionRuleViolation('FC-18', `${no}数量须为正十进制定点`)
    }
    if (line.lockedByOther) {
      throw new ConversionRuleViolation('FC-20', `${no}锁定中的码不可转换（扫码锁定期间其它业务操作该码被拒）`)
    }
    if (line.occupiedUnfinished) {
      throw new ConversionRuleViolation(
        'FC-18',
        `${no}同一二维码＋物料存在未转换成功的单据，不可再次添加`,
      )
    }
  }
}
