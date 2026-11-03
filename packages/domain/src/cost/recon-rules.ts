import { CostRuleViolation } from './errors'
import { isValidCostDecimal, parseScaled, sub4 } from './decimals'

/**
 * 对账规则（CE-15 数量可核对/回算路径、CE-16 ERP 对账具名清单不静默吸收、
 * CE-S5 差异清单表：双侧数量+来源+处置状态，未处置不得清零）。
 */

/** 对账数量基础维度（CE-15/16：材料量/工时/能源量）。 */
export const RECON_KINDS = ['material', 'labor', 'energy'] as const
export type ReconKind = (typeof RECON_KINDS)[number]

/** 处置状态（CE-S5：open 未处置 / confirmed 已确认（差异成立待业务处理）/ adjusted 已按处置调整）。 */
export const DISPOSITION_STATUSES = ['open', 'confirmed', 'adjusted'] as const
export type DispositionStatus = (typeof DISPOSITION_STATUSES)[number]

export interface ReconImportRowInput {
  kind: string
  localQuantity: string
  erpQuantity: string
  uomCode: string
  materialCode?: string | null
  orderNo?: string | null
  erpDocumentRef?: string | null
}

/** CE-16/CE-S5：对账入站行形状（维度枚举、双侧正数量、单位非空）。 */
export function assertReconImportRow(row: ReconImportRowInput): void {
  if (!RECON_KINDS.includes(row.kind as ReconKind)) {
    throw new CostRuleViolation('CE-16', `对账维度必须为 material/labor/energy：${String(row.kind)}`)
  }
  for (const [label, value] of [['本系统侧', row.localQuantity], ['ERP 侧', row.erpQuantity]] as const) {
    if (!isValidCostDecimal(value) || parseScaled(value, 'CE-16') < 0n) {
      throw new CostRuleViolation('CE-16', `${label}数量必须为非负十进制字符串：${String(value)}`)
    }
  }
  if (typeof row.uomCode !== 'string' || row.uomCode === '') {
    throw new CostRuleViolation('CE-16', '对账行单位必填（uomCode）')
  }
  if (row.kind === 'material' && (row.materialCode ?? null) === null) {
    throw new CostRuleViolation('CE-15', '材料量对账行必须带料品（materialCode，回算路径锚点）')
  }
}

/** CE-S5：差异 = 本系统归集数量基础 − ERP 侧对应数量（有符号，如实列示不静默吸收）。 */
export function computeReconDiff(localQuantity: string, erpQuantity: string): string {
  return sub4(localQuantity, erpQuantity, 'CE-16')
}

/** 对账业务键（同键幂等：run+kind+料品/订单）。 */
export function buildReconKey(input: { runId: string; kind: ReconKind; materialCode?: string | null; orderNo?: string | null }): string {
  const scope = input.materialCode ?? input.orderNo ?? '*'
  return `${input.runId}|${input.kind}|${scope}`
}

export interface ReconResolveInput {
  currentStatus: string
  targetStatus: string
  reason?: string | null
}

/**
 * CE-S5：处置流转。open → confirmed（确认差异，须理由）；open/confirmed → adjusted
 * （按处置结果调整，须理由）；adjusted 为终态；任何流转不得清零差异行（清零=删除被库级拒绝，
 * 差异吸收只能以 adjusted+理由留痕）。无理由的流转拒绝（OA-29 同精神）。
 */
export function assertReconResolvable(input: ReconResolveInput): void {
  if (!DISPOSITION_STATUSES.includes(input.currentStatus as DispositionStatus)) {
    throw new CostRuleViolation('CE-S5', `当前处置状态非法：${input.currentStatus}`)
  }
  if (!DISPOSITION_STATUSES.includes(input.targetStatus as DispositionStatus)) {
    throw new CostRuleViolation('CE-S5', `目标处置状态非法：${input.targetStatus}`)
  }
  if (input.currentStatus === 'adjusted') {
    throw new CostRuleViolation('CE-S5', 'adjusted 为终态，不可再流转（差异吸收已留痕）')
  }
  if (input.currentStatus === input.targetStatus) {
    throw new CostRuleViolation('CE-S5', `处置状态未变化（${input.currentStatus}）`)
  }
  if (input.currentStatus === 'open' && input.targetStatus === 'adjusted') {
    // open 直达 adjusted 允许（一次性处置），但同样须理由
  }
  if ((input.reason ?? null) === null || input.reason === '') {
    throw new CostRuleViolation('CE-S5', '对账处置必须填写理由（reason，差异处置留痕）')
  }
}
