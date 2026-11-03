import { SapReconRuleViolation } from './errors'

/** G-B02 fixture 分类口径（兼入口 OPEN/DIFF/QUARANTINED）。 */
export const SAP_RECON_MATCH_STATUSES = [
  'OPEN',
  'MATCH',
  'DIFF',
  'OUTCOME_UNKNOWN',
  'QUARANTINED',
  'CLASSIFICATION_DIFFERENCE',
  'QUALITY_STATUS_DIFFERENCE',
] as const
export type SapReconMatchStatus = (typeof SAP_RECON_MATCH_STATUSES)[number]

/** 差异分类子集（全量 RECON 演示至少 MATCH + 一类差异）。 */
export const SAP_RECON_DIFF_CLASSIFICATIONS = [
  'CLASSIFICATION_DIFFERENCE',
  'QUALITY_STATUS_DIFFERENCE',
  'OUTCOME_UNKNOWN',
  'DIFF',
] as const

function asNonEmpty(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new SapReconRuleViolation('SAP-RECON-1', `缺少必填字段 ${field}`)
  }
  return v.trim()
}

/** POST /sap/reconciliation 创建差异项：plantId + objectCode + title + reason */
export function assertSapReconCreatePayload(payload: Record<string, unknown>): {
  plantId: string
  objectCode: string
  title: string
  reason: string
  objectName?: string
  momQty?: string
  sapQty?: string
  diffQty?: string
  currencyCode?: string
  matchStatus?: SapReconMatchStatus
  reconNo?: string
  sapStockState?: string
  momHold?: boolean
  unknownSliceQty?: string
} {
  const plantId = asNonEmpty(payload['plantId'], 'plantId')
  const objectCode = asNonEmpty(payload['objectCode'] ?? payload['object_code'], 'objectCode')
  const title = asNonEmpty(payload['title'], 'title')
  const reason = asNonEmpty(payload['reason'], 'reason')
  const opt = (k: string, alt?: string) => {
    const v = payload[k] ?? (alt ? payload[alt] : undefined)
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  }
  // classification 与 matchStatus 同义（G-B02 status 列）
  const matchRaw = opt('matchStatus', 'match_status') ?? opt('classification')
  let matchStatus: SapReconMatchStatus | undefined
  if (matchRaw) {
    if (!(SAP_RECON_MATCH_STATUSES as readonly string[]).includes(matchRaw)) {
      throw new SapReconRuleViolation(
        'SAP-RECON-1',
        `matchStatus/classification 须为 ${SAP_RECON_MATCH_STATUSES.join('/')}`,
      )
    }
    matchStatus = matchRaw as SapReconMatchStatus
  }
  const holdRaw = payload['momHold'] ?? payload['mom_hold']
  let momHold: boolean | undefined
  if (typeof holdRaw === 'boolean') momHold = holdRaw
  else if (holdRaw === 'true' || holdRaw === 'True' || holdRaw === '1') momHold = true
  else if (holdRaw === 'false' || holdRaw === 'False' || holdRaw === '0') momHold = false

  return {
    plantId,
    objectCode,
    title,
    reason,
    objectName: opt('objectName', 'object_name'),
    momQty: opt('momQty', 'mom_qty'),
    sapQty: opt('sapQty', 'sap_qty'),
    diffQty: opt('diffQty', 'diff_qty'),
    currencyCode: opt('currencyCode', 'currency_code'),
    matchStatus,
    reconNo: opt('reconNo', 'recon_no'),
    sapStockState: opt('sapStockState', 'sap_stock_state'),
    momHold,
    unknownSliceQty: opt('unknownSliceQty', 'unknown_slice_qty'),
  }
}
