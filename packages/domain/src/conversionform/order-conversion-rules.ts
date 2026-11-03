import { ConversionRuleViolation } from './errors'

/**
 * 订单形态转换（协议A：本地先执行、后异步同步）纯规则 —— 冻结合同 form-conversion.md
 * FC-05/06/07/08/09/10/12（原件 形态转换/01-订单形态转换.md）。
 *
 * 协议A锚点=生产订单（转换前/后订单）；Web 建单维护明细、PDA 扫码/删码/完成转换；
 * 完成=本地先执行（二维码归属改为转换后订单），U9 同步与库存统计经 Outbox 异步。
 */

/** FC-12：转换状态 2 值（待转换/已完成）——与同步状态分列存储，不合并为单一状态。 */
export const ORDER_CONVERSION_STATUSES = ['pending', 'completed'] as const
export type OrderConversionStatus = (typeof ORDER_CONVERSION_STATUSES)[number]

/** FC-12：同步状态 3 值（未同步/同步失败/已同步）。 */
export const ORDER_SYNC_STATUSES = ['pending', 'sync_failed', 'synced'] as const
export type OrderSyncStatus = (typeof ORDER_SYNC_STATUSES)[number]

/** FC-05：数量精度 4 位、范围 0.0001～999999999.9999。 */
export const ORDER_QTY_MIN = '0.0001'
export const ORDER_QTY_MAX = '999999999.9999'

/** 十进制定点（≤4 位小数；IT-07 口径随行的本域内联校验，避免跨子目录依赖）。 */
const DECIMAL_RE = /^\d+(\.\d{1,4})?$/

export function isConversionDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_RE.test(value)
}

/** 定点数值比较（同 scale 4；返回 -1/0/1）。 */
export function compareDecimal(a: string, b: string): number {
  const scale = (v: string): bigint => {
    const [intPart, fracPart = ''] = v.split('.')
    return BigInt(intPart + (fracPart + '0000').slice(0, 4))
  }
  const x = scale(a)
  const y = scale(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** FC-05：建单明细行规格输入（转换前后订单事实由命令层查实后填入）。 */
export interface OrderConversionLineSpec {
  sourceOrderId: string
  sourceSalesOrderNo: string
  sourceLineNo: string
  sourceProjectNo: string | null
  targetOrderId: string
  targetSalesOrderNo: string
  targetProjectNo: string
  /** 转换前订单料品 id（命令层自查；转换后订单料品 id 须与之相同）。 */
  sourceMaterialId: string
  targetMaterialId: string
  materialCode: string
  /** 计划转换数量（十进制定点字符串）。 */
  quantity: string
  uom: string
}

/**
 * FC-05 建单规则断言：
 * - 至少 1 条明细；每条已选转换后订单（targetOrderId/targetProjectNo 非空）；
 * - 转换后订单须与转换前同料品且非同一订单；
 * - 同一"销售单号＋行号"不可重复加入明细；
 * - 数量必填、精度 4 位、范围 0.0001～999999999.9999。
 */
export function assertOrderConversionLines(lines: readonly OrderConversionLineSpec[]): void {
  if (lines.length === 0) {
    throw new ConversionRuleViolation('FC-05', '转换单至少保留 1 条明细方可提交')
  }
  const seenSalesLine = new Set<string>()
  for (const [index, line] of lines.entries()) {
    const no = `第 ${index + 1} 行`
    if (line.sourceSalesOrderNo.trim() === '' || line.sourceLineNo.trim() === '') {
      throw new ConversionRuleViolation('FC-05', `${no}缺少转换前销售单号/行号（明细仅可选生产订单行）`)
    }
    if (line.targetOrderId.trim() === '' || line.targetProjectNo.trim() === '') {
      throw new ConversionRuleViolation('FC-05', `${no}须已选转换后订单并填写转换后项目号`)
    }
    if (line.targetOrderId === line.sourceOrderId) {
      throw new ConversionRuleViolation('FC-05', `${no}转换后订单与转换前为同一订单（须选不同订单）`)
    }
    if (line.targetMaterialId !== line.sourceMaterialId) {
      throw new ConversionRuleViolation('FC-05', `${no}转换后订单须与转换前同料品（${line.materialCode}）`)
    }
    const salesLineKey = `${line.sourceSalesOrderNo}|${line.sourceLineNo}`
    if (seenSalesLine.has(salesLineKey)) {
      throw new ConversionRuleViolation(
        'FC-05',
        `同一销售单号＋行号不可重复加入明细（${line.sourceSalesOrderNo}＋${line.sourceLineNo}）`,
      )
    }
    seenSalesLine.add(salesLineKey)
    if (!isConversionDecimalString(line.quantity)) {
      throw new ConversionRuleViolation('FC-05', `${no}数量必填且须为十进制定点字符串（精度 4 位）`)
    }
    if (compareDecimal(line.quantity, ORDER_QTY_MIN) < 0 || compareDecimal(line.quantity, ORDER_QTY_MAX) > 0) {
      throw new ConversionRuleViolation(
        'FC-05',
        `${no}数量范围须为 ${ORDER_QTY_MIN}～${ORDER_QTY_MAX}（当前 ${line.quantity}）`,
      )
    }
  }
}

// ---------------- FC-07：PDA 扫码（载具码准入 + 选择项） ----------------

/** FC-07：载具码类型位 E/F/M/P（不含 R——删码模式不校验该规则）。 */
export const CONVERSION_CARRIER_CODE_LENGTH = 10
export const CONVERSION_CARRIER_SECOND_CHARS = ['E', 'F', 'M', 'P'] as const

export function isConversionCarrierCode(barcodeValue: string): boolean {
  return (
    barcodeValue.length === CONVERSION_CARRIER_CODE_LENGTH &&
    CONVERSION_CARRIER_SECOND_CHARS.includes(barcodeValue[1]! as (typeof CONVERSION_CARRIER_SECOND_CHARS)[number])
  )
}

/** FC-07：扫码模式校验载具码规则（10 位且第 2 位类型位 ∈ E/F/M/P；R 型托码等拒绝）。 */
export function assertConversionCarrierCode(barcodeValue: string): void {
  if (!isConversionCarrierCode(barcodeValue)) {
    throw new ConversionRuleViolation(
      'FC-07',
      `扫码只接受载具码类型位 E/F/M/P（10 位第 2 位，不含 R）：${barcodeValue} 不是可转换载具码`,
    )
  }
}

/** FC-07：扫码选择项（命中后弹层选择段长或客户轴号；至少选一）。 */
export function assertScanChoicePresent(input: {
  unitNo: string
  segmentLength: string | null
  customerAxisNo: string | null
}): void {
  const hasSegment = input.segmentLength !== null && isConversionDecimalString(input.segmentLength) && compareDecimal(input.segmentLength, '0.0001') >= 0
  const hasAxis = input.customerAxisNo !== null && input.customerAxisNo.trim() !== ''
  if (!hasSegment && !hasAxis) {
    throw new ConversionRuleViolation(
      'FC-07',
      `码 ${input.unitNo} 扫码须选择段长或客户轴号（至少一项，段长须为正十进制定点）`,
    )
  }
}

/** FC-07：已用段长/客户轴号不可再选（同转换单内其它未删扫码已占用）。 */
export function assertScanChoiceNotUsed(input: {
  unitNo: string
  segmentLength: string | null
  customerAxisNo: string | null
  usedSegmentLengths: ReadonlySet<string>
  usedCustomerAxisNos: ReadonlySet<string>
}): void {
  if (input.segmentLength !== null && input.usedSegmentLengths.has(input.segmentLength)) {
    throw new ConversionRuleViolation('FC-07', `段长 ${input.segmentLength} 已被本转换单其它扫码选用，不可再选`)
  }
  if (input.customerAxisNo !== null && input.usedCustomerAxisNos.has(input.customerAxisNo)) {
    throw new ConversionRuleViolation('FC-07', `客户轴号 ${input.customerAxisNo} 已被本转换单其它扫码选用，不可再选`)
  }
}

/** FC-07：扫码业务校验事实（命令层收集后调用；实扫 ≥ 计划仅换卡片完成样式，不拒——GAP-F7）。 */
export interface OrderScanFacts {
  unitNo: string
  /** 库存单元状态（须在库）。 */
  unitStatus: string
  /** 有活动余额。 */
  balanceExists: boolean
  /** 码归属的生产订单 id（report_output 反查；null=不属于任何订单产出）。 */
  unitOwnerOrderId: string | null
  /** 本明细行的转换前订单 id。 */
  sourceOrderId: string
  /** 存在其它业务的活动作业预留（锁定中）。 */
  lockedByOther: boolean
  /** 该码存在未完成的库存形态转换单占用（FC-20 跨协议复核）。 */
  occupiedByStockConversion: boolean
  /** 同码在本单已有未删扫码。 */
  alreadyScannedInOrder: boolean
}

/** FC-07：码须属于转换前订单对应库存且满足业务校验，否则失败不入库。 */
export function assertOrderScanAdmissible(facts: OrderScanFacts): void {
  if (facts.alreadyScannedInOrder) {
    throw new ConversionRuleViolation('FC-07', `码 ${facts.unitNo} 已扫入本单且未删除，拒绝重复扫码`)
  }
  if (facts.unitStatus !== 'in_stock') {
    throw new ConversionRuleViolation('FC-07', `码 ${facts.unitNo} 不在库（当前 ${facts.unitStatus}），不可转换`)
  }
  if (!facts.balanceExists) {
    throw new ConversionRuleViolation('FC-07', `码 ${facts.unitNo} 无活动库存余额，不可转换`)
  }
  if (facts.unitOwnerOrderId !== facts.sourceOrderId) {
    throw new ConversionRuleViolation(
      'FC-07',
      `码 ${facts.unitNo} 不属于转换前订单对应库存（归属订单 ${facts.unitOwnerOrderId ?? '无'} ≠ 转换前订单 ${facts.sourceOrderId}），失败不入库`,
    )
  }
  if (facts.lockedByOther) {
    throw new ConversionRuleViolation('FC-07', `码 ${facts.unitNo} 被其它业务锁定（活动作业预留），不可扫入`)
  }
  if (facts.occupiedByStockConversion) {
    throw new ConversionRuleViolation(
      'FC-20',
      `码 ${facts.unitNo} 存在未转换成功的库存形态转换单占用，后提交方冲突拒绝`,
    )
  }
}

// ---------------- FC-06：编辑/删除门 ----------------

/** FC-06：仅"待转换且该单尚无任何扫码"可编辑或删除；已完成或已有扫码不可。 */
export function assertOrderMutableForEdit(input: {
  status: OrderConversionStatus
  activeScanCount: number
  action: 'edit' | 'delete'
}): void {
  const label = input.action === 'edit' ? '编辑' : '删除'
  if (input.status !== 'pending') {
    throw new ConversionRuleViolation('FC-06', `转换单已完成，不可${label}（仅待转换可${label}）`)
  }
  if (input.activeScanCount > 0) {
    throw new ConversionRuleViolation('FC-06', `转换单已有扫码记录，不可${label}（仅待转换且尚无扫码可${label}）`)
  }
}

// ---------------- FC-08：完成转换 ----------------

/** FC-08：完成转换可执行 = 当前为待转换且每条明细已扫轴数 > 0。 */
export function assertOrderCompletable(input: {
  status: OrderConversionStatus
  lines: ReadonlyArray<{ lineId: string; scannedAxes: number }>
}): void {
  if (input.status !== 'pending') {
    throw new ConversionRuleViolation('FC-08', `仅待转换单可完成转换（当前 ${input.status}）`)
  }
  const empty = input.lines.filter((l) => l.scannedAxes <= 0)
  if (empty.length > 0) {
    throw new ConversionRuleViolation(
      'FC-08',
      `完成转换须每条明细已扫轴数 > 0（明细 ${empty.map((l) => l.lineId).join('、')} 已扫轴数为 0）`,
    )
  }
}

/** FC-08：轴号/虚拟轴号校验——完成前逐扫码行复核（选择项齐备、数量为正），不过则失败、状态不变。 */
export function assertCompletionScansValid(
  scans: ReadonlyArray<{ unitNo: string; quantity: string; segmentLength: string | null; customerAxisNo: string | null }>,
): void {
  for (const scan of scans) {
    if (!isConversionDecimalString(scan.quantity) || compareDecimal(scan.quantity, '0.0001') < 0) {
      throw new ConversionRuleViolation('FC-08', `码 ${scan.unitNo} 实扫数量非法（${scan.quantity}），完成转换失败、状态不变`)
    }
    const hasSegment = scan.segmentLength !== null && scan.segmentLength.trim() !== ''
    const hasAxis = scan.customerAxisNo !== null && scan.customerAxisNo.trim() !== ''
    if (!hasSegment && !hasAxis) {
      throw new ConversionRuleViolation(
        'FC-08',
        `码 ${scan.unitNo} 轴号/段长校验不过（既无段长也无客户轴号），完成转换失败、状态不变`,
      )
    }
  }
}

// ---------------- FC-09/FC-10：重试与外部失败语义 ----------------

/** FC-09：重试仅"已完成且同步失败"可执行（成功后同步状态=已同步）。 */
export function assertOrderSyncRetryable(input: {
  status: OrderConversionStatus
  syncStatus: OrderSyncStatus
}): void {
  if (input.status !== 'completed') {
    throw new ConversionRuleViolation('FC-09', `仅已完成的转换单可重试同步（当前转换状态 ${input.status}）`)
  }
  if (input.syncStatus !== 'sync_failed') {
    throw new ConversionRuleViolation('FC-09', `仅同步失败的单可重试（当前同步状态 ${input.syncStatus}）`)
  }
}
