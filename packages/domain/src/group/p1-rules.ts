/**
 * P1 回抛四单载荷校验（成品召回 / 投料竞争 / SCAN-BLOCK / 供应商风险）。
 * 缺必填字段抛 RuleViolation → 命令面 422。
 */

export class P1RuleViolation extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message)
    this.name = 'P1RuleViolation'
  }
}

function asNonEmpty(v: unknown, key: string, rulePrefix: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new P1RuleViolation(rulePrefix, `命令载荷缺少必填字段 ${key}`)
  }
  return v.trim()
}

/** 成品/批次召回：plantId + title + reason + recallScope；batchNo 与 materialCode 至少其一。 */
export function assertProductRecallCreatePayload(payload: Record<string, unknown>): {
  plantId: string
  title: string
  reason: string
  recallScope: 'batch' | 'finished_product'
  batchNo?: string
  materialCode?: string
  recallNo?: string
} {
  const plantId = asNonEmpty(payload['plantId'], 'plantId', 'G-R1')
  const title = asNonEmpty(payload['title'], 'title', 'G-R1')
  const reason = asNonEmpty(payload['reason'], 'reason', 'G-R1')
  const recallScopeRaw = asNonEmpty(payload['recallScope'], 'recallScope', 'G-R1')
  if (recallScopeRaw !== 'batch' && recallScopeRaw !== 'finished_product') {
    throw new P1RuleViolation('G-R1', 'recallScope 必须为 batch 或 finished_product')
  }
  const batchNo =
    typeof payload['batchNo'] === 'string' && payload['batchNo'].trim() !== ''
      ? payload['batchNo'].trim()
      : undefined
  const materialCode =
    typeof payload['materialCode'] === 'string' && payload['materialCode'].trim() !== ''
      ? payload['materialCode'].trim()
      : undefined
  if (!batchNo && !materialCode) {
    throw new P1RuleViolation('G-R1', 'batchNo 与 materialCode 至少填写其一')
  }
  const recallNo =
    typeof payload['recallNo'] === 'string' && payload['recallNo'].trim() !== ''
      ? payload['recallNo'].trim()
      : undefined
  return { plantId, title, reason, recallScope: recallScopeRaw, batchNo, materialCode, recallNo }
}

/** 投料竞争/计划部分/迟修订：plantId + title + reason + planKind */
export function assertFeedRacePlanCreatePayload(payload: Record<string, unknown>): {
  plantId: string
  title: string
  reason: string
  planKind: 'race' | 'partial' | 'late_revision'
  planNo?: string
} {
  const plantId = asNonEmpty(payload['plantId'], 'plantId', 'E09-F1')
  const title = asNonEmpty(payload['title'], 'title', 'E09-F1')
  const reason = asNonEmpty(payload['reason'], 'reason', 'E09-F1')
  const planKindRaw = asNonEmpty(payload['planKind'], 'planKind', 'E09-F1')
  if (planKindRaw !== 'race' && planKindRaw !== 'partial' && planKindRaw !== 'late_revision') {
    throw new P1RuleViolation('E09-F1', 'planKind 必须为 race / partial / late_revision')
  }
  const planNo =
    typeof payload['planNo'] === 'string' && payload['planNo'].trim() !== ''
      ? payload['planNo'].trim()
      : undefined
  return { plantId, title, reason, planKind: planKindRaw, planNo }
}

/** SCAN-BLOCK 事件：plantId + policyCode + scanCode + blockReason */
export function assertScanBlockEventCreatePayload(payload: Record<string, unknown>): {
  plantId: string
  policyCode: string
  scanCode: string
  blockReason: string
  severity?: 'warn' | 'block' | 'escalate'
  eventNo?: string
} {
  const plantId = asNonEmpty(payload['plantId'], 'plantId', 'E09-S1')
  const policyCode = asNonEmpty(payload['policyCode'], 'policyCode', 'E09-S1')
  const scanCode = asNonEmpty(payload['scanCode'], 'scanCode', 'E09-S1')
  const blockReason = asNonEmpty(payload['blockReason'], 'blockReason', 'E09-S1')
  let severity: 'warn' | 'block' | 'escalate' | undefined
  if (typeof payload['severity'] === 'string' && payload['severity'].trim() !== '') {
    const s = payload['severity'].trim()
    if (s !== 'warn' && s !== 'block' && s !== 'escalate') {
      throw new P1RuleViolation('E09-S1', 'severity 必须为 warn / block / escalate')
    }
    severity = s
  }
  const eventNo =
    typeof payload['eventNo'] === 'string' && payload['eventNo'].trim() !== ''
      ? payload['eventNo'].trim()
      : undefined
  return { plantId, policyCode, scanCode, blockReason, severity, eventNo }
}

/** 供应商风险：plantId + vendorCode + riskLevel + title + reason */
export function assertVendorRiskCreatePayload(payload: Record<string, unknown>): {
  plantId: string
  vendorCode: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  title: string
  reason: string
  vendorName?: string
  riskNo?: string
} {
  const plantId = asNonEmpty(payload['plantId'], 'plantId', 'G-V1')
  const vendorCode = asNonEmpty(payload['vendorCode'], 'vendorCode', 'G-V1')
  const title = asNonEmpty(payload['title'], 'title', 'G-V1')
  const reason = asNonEmpty(payload['reason'], 'reason', 'G-V1')
  const riskLevelRaw = asNonEmpty(payload['riskLevel'], 'riskLevel', 'G-V1')
  if (
    riskLevelRaw !== 'low' &&
    riskLevelRaw !== 'medium' &&
    riskLevelRaw !== 'high' &&
    riskLevelRaw !== 'critical'
  ) {
    throw new P1RuleViolation('G-V1', 'riskLevel 必须为 low / medium / high / critical')
  }
  const vendorName =
    typeof payload['vendorName'] === 'string' && payload['vendorName'].trim() !== ''
      ? payload['vendorName'].trim()
      : undefined
  const riskNo =
    typeof payload['riskNo'] === 'string' && payload['riskNo'].trim() !== ''
      ? payload['riskNo'].trim()
      : undefined
  return { plantId, vendorCode, riskLevel: riskLevelRaw, title, reason, vendorName, riskNo }
}

/** 返工写命令入口：plantId + title + reason；unitNo|batchNo|materialCode 至少其一。≠ disposition 库存联动。 */
export function assertReworkWriteCreatePayload(payload: Record<string, unknown>): {
  plantId: string
  title: string
  reason: string
  unitNo?: string
  batchNo?: string
  materialCode?: string
  reworkNo?: string
} {
  const plantId = asNonEmpty(payload['plantId'], 'plantId', 'G-RW1')
  const title = asNonEmpty(payload['title'], 'title', 'G-RW1')
  const reason = asNonEmpty(payload['reason'], 'reason', 'G-RW1')
  const unitNo =
    typeof payload['unitNo'] === 'string' && payload['unitNo'].trim() !== ''
      ? payload['unitNo'].trim()
      : undefined
  const batchNo =
    typeof payload['batchNo'] === 'string' && payload['batchNo'].trim() !== ''
      ? payload['batchNo'].trim()
      : undefined
  const materialCode =
    typeof payload['materialCode'] === 'string' && payload['materialCode'].trim() !== ''
      ? payload['materialCode'].trim()
      : undefined
  if (!unitNo && !batchNo && !materialCode) {
    throw new P1RuleViolation('G-RW1', 'unitNo / batchNo / materialCode 至少填一项')
  }
  const reworkNo =
    typeof payload['reworkNo'] === 'string' && payload['reworkNo'].trim() !== ''
      ? payload['reworkNo'].trim()
      : undefined
  return { plantId, title, reason, unitNo, batchNo, materialCode, reworkNo }
}

/** 报废写命令入口：plantId + title + reason；unitNo|batchNo|materialCode 至少其一。≠ disposition 库存扣减。 */
export function assertScrapWriteCreatePayload(payload: Record<string, unknown>): {
  plantId: string
  title: string
  reason: string
  unitNo?: string
  batchNo?: string
  materialCode?: string
  scrapQty?: string
  scrapNo?: string
} {
  const plantId = asNonEmpty(payload['plantId'], 'plantId', 'G-SC1')
  const title = asNonEmpty(payload['title'], 'title', 'G-SC1')
  const reason = asNonEmpty(payload['reason'], 'reason', 'G-SC1')
  const unitNo =
    typeof payload['unitNo'] === 'string' && payload['unitNo'].trim() !== ''
      ? payload['unitNo'].trim()
      : undefined
  const batchNo =
    typeof payload['batchNo'] === 'string' && payload['batchNo'].trim() !== ''
      ? payload['batchNo'].trim()
      : undefined
  const materialCode =
    typeof payload['materialCode'] === 'string' && payload['materialCode'].trim() !== ''
      ? payload['materialCode'].trim()
      : undefined
  if (!unitNo && !batchNo && !materialCode) {
    throw new P1RuleViolation('G-SC1', 'unitNo / batchNo / materialCode 至少填一项')
  }
  const scrapQty =
    typeof payload['scrapQty'] === 'string' && payload['scrapQty'].trim() !== ''
      ? payload['scrapQty'].trim()
      : undefined
  const scrapNo =
    typeof payload['scrapNo'] === 'string' && payload['scrapNo'].trim() !== ''
      ? payload['scrapNo'].trim()
      : undefined
  return { plantId, title, reason, unitNo, batchNo, materialCode, scrapQty, scrapNo }
}
