// @vitest-environment jsdom
/**
 * 错误提示测试（错误码中文映射 + Message 组件，PC-14/PC-15）：
 * - 平台错误码逐码中文文案（集中资源、中文首发）；
 * - 未知码回退通用文案；
 * - Message：一个主错误 + detail 保留关联信息（role=alert 可达性）。
 */
import { render, screen } from '@testing-library/react'
import { ERROR_CODES } from '@cadenza/contracts'
import { Message, errorText, formatErrorTitleAndDetail, UNKNOWN_ERROR_ZH } from '@cadenza/ui'
import { describe, expect, it } from 'vitest'

describe('错误码中文映射（PC-15 集中资源）', () => {
  const cases: Array<[string, string]> = [
    [ERROR_CODES.AUTH_REQUIRED, '请先登录：会话缺失或已过期，请重新登录'],
    [ERROR_CODES.FORBIDDEN_SCOPE, '没有该操作的数据范围权限，请联系管理员调整授权'],
    [ERROR_CODES.NOT_FOUND, '请求的对象不存在或已被删除'],
    [ERROR_CODES.VERSION_CONFLICT, '数据已被他人修改（版本冲突），请刷新后重试'],
    [ERROR_CODES.IDEMPOTENT_PAYLOAD_MISMATCH, '该操作号已提交过且内容不一致，请勿用同一操作号重复提交不同内容'],
    [ERROR_CODES.INSUFFICIENT_STOCK, '库存不足，无法完成本次出库'],
    [ERROR_CODES.BUSINESS_RULE, '业务规则校验未通过，请检查输入内容'],
  ]
  it.each(cases)('%s → %s', (code, text) => {
    expect(errorText(code)).toBe(text)
  })

  it('未知码与空码回退通用文案', () => {
    expect(errorText('ERR_SOMETHING_NEW')).toBe(UNKNOWN_ERROR_ZH)
    expect(errorText(undefined)).toBe(UNKNOWN_ERROR_ZH)
  })

  it('formatErrorTitleAndDetail：主文案为可行动指引，服务端 message 并入 detail（PC-14）', () => {
    const { title, detail } = formatErrorTitleAndDetail({
      code: ERROR_CODES.VERSION_CONFLICT,
      message: 'expectedRevision mismatch: 12 vs 15',
      requestId: 'req-abc',
    })
    expect(title).toBe('数据已被他人修改（版本冲突），请刷新后重试')
    expect(detail).toContain('expectedRevision mismatch: 12 vs 15')
    expect(detail).toContain('请求标识：req-abc')
  })
})

describe('Message 组件（单主错误展示）', () => {
  it('错误消息 role=alert，主文案与关联信息分层呈现', () => {
    render(
      <Message
        kind="error"
        title="数据已被他人修改（版本冲突），请刷新后重试"
        detail="expectedRevision mismatch；请求标识：req-abc"
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('数据已被他人修改')
    expect(alert).toHaveTextContent('请求标识：req-abc')
  })

  it('成功消息 role=status', () => {
    render(<Message kind="success" title="保存成功" />)
    expect(screen.getByRole('status')).toHaveTextContent('保存成功')
  })
})
