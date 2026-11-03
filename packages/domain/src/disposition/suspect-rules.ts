import { DispositionRuleViolation } from './errors'

/**
 * 质量存疑规则（QD-01～QD-04，frozen/p2/quality-disposition.md §1）。
 * 扫码（PDA 预检）只查询不改数据；确认时按扫码规则重校验（QD-01）。
 * 存疑记录 append-only（QD-S1）；恢复=追加处置记录、不覆盖原存疑记录（QD-03）。
 */

/** PDA 存疑扫码预检结论（QD-01：任一命中拒绝；只查询）。 */
export type SuspectScanCheck =
  | { ok: true; unitId: string; unitNo: string; hasSuspect: boolean }
  | { ok: false; reason: 'no_material' | 'pallet_code' | 'not_received' | 'no_location' | 'already_suspect' }

/** QD-01：PDA 标记前置（任一命中拒绝）。扫码查询事实由应用层装载，本函数只做判定。 */
export function checkSuspectScan(input: {
  /** 该轴是否存在关联料品 */
  hasLinkedMaterial: boolean
  /** 扫的是否托码（托码=载具/托盘码，非产品轴码） */
  isPalletCode: boolean
  /** 码是否已入库（存在于库存单元） */
  isReceived: boolean
  /** 码是否有库位（存在活动余额/库位事实） */
  hasLocation: boolean
  /** 码是否已标记存疑 */
  alreadySuspect: boolean
}): 'ok' | 'no_material' | 'pallet_code' | 'not_received' | 'no_location' | 'already_suspect' {
  if (!input.hasLinkedMaterial) return 'no_material'
  if (input.isPalletCode) return 'pallet_code'
  if (!input.isReceived) return 'not_received'
  if (!input.hasLocation) return 'no_location'
  if (input.alreadySuspect) return 'already_suspect'
  return 'ok'
}

/** QD-01：把扫码结论转违例（确认时按扫码规则重校验）。 */
export function assertSuspectMarkAllowed(scanResult: ReturnType<typeof checkSuspectScan>, unitNo: string): void {
  if (scanResult === 'ok') return
  const label: Record<Exclude<ReturnType<typeof checkSuspectScan>, 'ok'>, string> = {
    no_material: '该轴不存在关联料品',
    pallet_code: '扫的是托码，不能标记产品轴存疑',
    not_received: '码未入库',
    no_location: '码没有库位',
    already_suspect: '码已标记存疑',
  }
  throw new DispositionRuleViolation('QD-01', `存疑标记前置不满足（${label[scanResult]}，轴号 ${unitNo}）`)
}

/** QD-02：存疑记录去重拼接的料品标识（编号/名称/规格/颜色去重拼接）。 */
export function joinMaterialKey(parts: Array<{ code: string; name: string; spec: string | null; color: string | null }>): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    const key = `${p.code}|${p.name}|${p.spec ?? ''}|${p.color ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push([p.code, p.name, p.spec, p.color].filter((s) => s !== null && s !== '').join('/'))
  }
  return out.join(';')
}

/** QD-03：恢复处置的最低记录字段（操作者、时间、处置结论=恢复正常、关联存疑记录 ID）。 */
export interface SuspectRecoveryDecision {
  operator: string
  occurredAt: Date
  suspectRecordId: string
  /** 处置依据（高影响场景必填） */
  basis: string | null
}

/** QD-03：恢复校验——恢复保留一键入口，落库为处置记录，不覆盖原存疑记录。 */
export function assertSuspectRecovery(input: {
  suspectRecordId: string | null
  operator: string
  occurredAt: Date | null
  basis: string | null
  /** 高影响场景：码已进入备货/待发运 */
  highImpact: boolean
}): SuspectRecoveryDecision {
  if (input.suspectRecordId === null || input.suspectRecordId === '') {
    throw new DispositionRuleViolation('QD-03', '存疑恢复必须关联原存疑记录（找不到活动存疑记录）')
  }
  if (input.operator === '') throw new DispositionRuleViolation('QD-03', '存疑恢复缺少操作者')
  if (input.occurredAt === null) throw new DispositionRuleViolation('QD-03', '存疑恢复缺少操作时间')
  if (input.highImpact && (input.basis === null || input.basis.trim() === '')) {
    throw new DispositionRuleViolation('QD-03', '码已进入备货/待发运，恢复必须填写处置依据（高影响场景）')
  }
  return {
    operator: input.operator,
    occurredAt: input.occurredAt,
    suspectRecordId: input.suspectRecordId,
    basis: input.basis,
  }
}

/** QD-04：消费/移动库存命令的质量状态检查（服务端事务内；GAP-F18 拦截点清单待裁）。
 * 纯判定：给定码当前质量状态，存疑拒绝并给出可解释提示。 */
export function assertUnitNotSuspectForConsumption(qualityStatus: string | null, unitNo: string): void {
  if (qualityStatus === 'suspect') {
    throw new DispositionRuleViolation(
      'QD-04',
      `码 ${unitNo} 质量状态为存疑，不得进入可用量或被投料/倒轴/入库上架/备货/发运/调拨/移库（存疑码不可消费/移动）`,
    )
  }
}

/** QD-04：存疑码不得进入可用量（IT-14 口径：可用量只由满足质量条件的余额形成）。 */
export function isAvailableQualityStatus(qualityStatus: string): boolean {
  return qualityStatus === 'qualified'
}
