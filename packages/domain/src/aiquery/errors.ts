import type { DecimalString } from '@cadenza/contracts'

/**
 * aiquery 域规则违约（全中文错误带规则码 [AQ-xx-x]，capability-contract.md 机制总则）。
 * 违约码格式：[AQ-REG-x]（机制）/[AQ-AMB-x]（歧义）/[AQ-AUTH-x]（权限）/[AQ-Cn-x]（能力）。
 */
export class AiQueryRuleViolation extends Error {
  constructor(
    /** 规则编号（如 'AQ-C1-1'） */
    readonly rule: string,
    message: string,
  ) {
    super(`[${rule}] ${message}`)
    this.name = 'AiQueryRuleViolation'
  }
}

/** 生成 [AQ-xx-x] 前缀可理解文案（信封 message 与审计共用口径）。 */
export function aiQueryMessage(rule: string, message: string): string {
  return `[${rule}] ${message}`
}

/** 数量字符串（≤4 位小数定点）——domain 内复判用（真源 @cadenza/contracts decimal.ts）。 */
export type AiDecimalString = DecimalString
