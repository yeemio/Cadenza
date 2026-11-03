import { DispositionRuleViolation } from './errors'

/**
 * 本域共享小工具（不依赖 domain 共享 index——零共享文件，L0 整合前本域自持）。
 * 数量口径随 IT-07：十进制定点字符串、≤4 位小数、禁 number 存储。
 */

/** 校验十进制数量格式：非空、可解析、非负、≤4 位小数（违反抛 [rule]）。 */
export function checkDecimalScale(value: string, rule: string, field: string): string {
  const v = value.trim()
  if (v === '') throw new DispositionRuleViolation(rule, `${field}为空`)
  if (!/^-?\d+(\.\d{1,4})?$/.test(v)) {
    throw new DispositionRuleViolation(rule, `${field}格式非法（须为十进制定点且最多 4 位小数，收到 ${value}）`)
  }
  return v
}

/** 校验正数量（>0、≤4 位小数）。 */
export function checkPositiveQty(value: string, rule: string, field: string): string {
  checkDecimalScale(value, rule, field)
  if (Number(value) <= 0) throw new DispositionRuleViolation(rule, `${field}必须大于 0`)
  return value
}

/** 备注/说明非纯空白校验（≤200）。 */
export function checkRemark(remark: string | null, rule: string, field: string, maxLength = 200): string {
  if (remark === null || remark.trim() === '') {
    throw new DispositionRuleViolation(rule, `${field}必填（非纯空白）`)
  }
  if (remark.trim().length > maxLength) {
    throw new DispositionRuleViolation(rule, `${field}长度超限（>${maxLength} 字）`)
  }
  return remark
}

/** 附件数量校验（≤3）。 */
export function checkAttachments(attachments: unknown[], rule: string): unknown[] {
  if (attachments.length > 3) {
    throw new DispositionRuleViolation(rule, '附件数量超过上限（≤3）')
  }
  return attachments
}

/** 数值比较（DecimalString；4 位小数定点语义）。 */
export function num(value: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new DispositionRuleViolation('QD-09', `数量不可解析：${value}`)
  return n
}
