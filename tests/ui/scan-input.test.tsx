// @vitest-environment jsdom
/**
 * 扫码输入组件测试（@cadenza/ui ScanInput，PC-03/04/05/09）：
 * - 空码/纯空白回车不提交（PC-09）；
 * - 有效码回车提交并清空输入（PC-05 不残留）；
 * - 键盘楔入模式：焦点不在输入框时，扫码枪快速键入+回车被全局捕获为一次扫码；
 * - 页内"扫码"按钮与回车共用同一提交入口（PC-03）。
 */
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScanInput } from '@cadenza/ui'
import { describe, expect, it, vi } from 'vitest'

describe('ScanInput 扫码输入', () => {
  it('空码与纯空白码不提交（PC-09），输入保持可继续操作', async () => {
    const user = userEvent.setup()
    const onScan = vi.fn()
    render(<ScanInput onScan={onScan} />)
    const input = screen.getByLabelText('扫码输入')
    await user.type(input, '   ') // 纯空白
    await user.keyboard('{Enter}')
    expect(onScan).not.toHaveBeenCalled()
    expect(input).toHaveValue('   ') // 未被清除，仍可编辑
    await user.clear(input)
    await user.keyboard('{Enter}') // 空码
    expect(onScan).not.toHaveBeenCalled()
  })

  it('有效码回车提交后清空输入，不残留上一码（PC-05）', async () => {
    const user = userEvent.setup()
    const onScan = vi.fn()
    render(<ScanInput onScan={onScan} />)
    const input = screen.getByLabelText('扫码输入')
    await user.type(input, 'MO-2026-1027-001')
    await user.keyboard('{Enter}')
    expect(onScan).toHaveBeenCalledTimes(1)
    expect(onScan).toHaveBeenCalledWith('MO-2026-1027-001')
    expect(input).toHaveValue('') // 提交后清空
  })

  it('页内"扫码"按钮与回车共用同一入口（PC-03）：按钮提交后同样清空', async () => {
    const user = userEvent.setup()
    const onScan = vi.fn()
    render(<ScanInput onScan={onScan} />)
    const input = screen.getByLabelText('扫码输入')
    await user.type(input, 'LOC-A-01-02')
    await user.click(screen.getByRole('button', { name: '扫码' }))
    expect(onScan).toHaveBeenCalledWith('LOC-A-01-02')
    expect(input).toHaveValue('')
  })

  it('键盘楔入模式：焦点在页面（非输入框）时，快速键入+回车被捕获为一次扫码', () => {
    const onScan = vi.fn()
    render(<ScanInput onScan={onScan} />)
    // 焦点未进入输入框（autoFocus 下仍向 body 派发楔入序列模拟扫码枪）
    const body = document.body
    for (const ch of 'MO-77') fireEvent.keyDown(body, { key: ch })
    fireEvent.keyDown(body, { key: 'Enter' })
    expect(onScan).toHaveBeenCalledTimes(1)
    expect(onScan).toHaveBeenCalledWith('MO-77')
    // 输入框不受污染
    expect(screen.getByLabelText('扫码输入')).toHaveValue('')
  })
})
