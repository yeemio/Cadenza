import { useState } from 'react'
import { ApiError, t as $t } from '@cadenza/ui'
import { formatP2ErrorTitleAndDetail } from '../../../../packages/ui/src/api/p2'

/**
 * P2 PDA 页面共享辅助（P2-UI 线新增，仅 P2 PDA 页面消费）：
 * - 扫码会话态：PC-05 错码即清上一码旧对象；PC-04 成功/失败各一种反馈；
 * - 命令动作反馈：单主错误（PC-14/15）。
 */
export interface PdaScanSession<T> {
  code: string
  object: T
}

export function usePdaAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  async function run(action: () => Promise<unknown>, successText: string): Promise<boolean> {
    setBusy(true)
    setSuccess(null)
    try {
      await action()
      setError(null)
      setSuccess(successText)
      return true
    } catch (err) {
      // PC-14/15：规则码中文映射为可行动文案
      setError(err instanceof ApiError ? formatP2ErrorTitleAndDetail(err) : { title: $t('操作失败') })
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, success, run, clearFeedback: () => { setError(null); setSuccess(null) } }
}
