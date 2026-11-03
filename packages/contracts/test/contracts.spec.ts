import { describe, expect, it } from 'vitest'
import {
  CommandResultStatus,
  DECIMAL_STRING_REGEX,
  ERROR_CODES,
  ERROR_CODE_VALUES,
  isDecimalString,
} from '../src'

describe('contracts 错误码', () => {
  it('错误码字符串值两两互不重复（唯一性）', () => {
    expect(new Set(ERROR_CODE_VALUES).size).toBe(ERROR_CODE_VALUES.length)
  })

  it('七个平台错误码与合同规定一致', () => {
    expect(Object.values(ERROR_CODES).sort()).toEqual(
      [
        'ERR_AUTH_REQUIRED',
        'ERR_FORBIDDEN_SCOPE',
        'ERR_NOT_FOUND',
        'ERR_VERSION_CONFLICT',
        'ERR_IDEMPOTENT_PAYLOAD_MISMATCH',
        'ERR_INSUFFICIENT_STOCK',
        'ERR_BUSINESS_RULE',
      ].sort(),
    )
  })
})

describe('contracts 命令结果状态', () => {
  it('恰好五种可区分状态', () => {
    const values = Object.values(CommandResultStatus)
    expect(new Set(values).size).toBe(values.length)
    expect(values.sort()).toEqual(
      [
        'BUSINESS_REJECTION',
        'COMMITTED',
        'DRAFT_SAVED',
        'UNKNOWN_PENDING_QUERY',
        'VERSION_CONFLICT',
      ].sort(),
    )
  })
})

describe('contracts 数量十进制字符串约定', () => {
  it('接受 scale≤4 的十进制定点字符串', () => {
    for (const ok of ['0', '12', '123.45', '123.4500', '-0.0012', '999999.9999']) {
      expect(isDecimalString(ok), ok).toBe(true)
    }
  })

  it('拒绝 number、科学计数法、越界小数位与非法字符', () => {
    for (const bad of [12.5, '', '12a', '1.2.3', '1,234', '1e3', '.5', '1.00000', ' 12']) {
      expect(isDecimalString(bad), String(bad)).toBe(false)
    }
  })

  it('正则与守卫判定一致（禁 number 的静态防线）', () => {
    expect(DECIMAL_STRING_REGEX.test('10.5')).toBe(true)
    expect(DECIMAL_STRING_REGEX.test('10.55555')).toBe(false)
  })
})
