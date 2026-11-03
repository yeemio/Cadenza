import { useEffect, useState } from 'react'
import { ApiError, t as $t } from '@cadenza/ui'
import { formatP2ErrorTitleAndDetail } from '../../../../packages/ui/src/api/p2'

/**
 * P2 web 页面共享辅助（P2-UI 线新增，仅 P2 页面消费，零共享文件纪律不破）：
 * - useAsyncList：服务端分页列表加载态（alive 守卫；错误经 formatP2ErrorTitleAndDetail 映射）；
 * - useActionState：命令动作反馈（单主错误，PC-14/15）。
 */
export function useP2AsyncList<T>(
  fetcher: (page: number) => Promise<{ items: T[]; total: number }>,
  deps: readonly unknown[],
) {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  useEffect(() => {
    let alive = true
    setLoading(true)
    fetcher(page)
      .then((result) => {
        if (!alive) return
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatP2ErrorTitleAndDetail(err) : { title: $t('加载失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, ...deps])
  return { items, total, page, setPage, loading, error }
}

export function useP2ActionState() {
  const [actionError, setActionError] = useState<{ title: string; detail?: string } | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function run(action: () => Promise<unknown>, successText?: string): Promise<boolean> {
    setBusy(true)
    try {
      await action()
      setActionError(null)
      setActionSuccess(successText ?? $t('操作已提交'))
      return true
    } catch (err) {
      setActionError(err instanceof ApiError ? formatP2ErrorTitleAndDetail(err) : { title: $t('操作失败') })
      return false
    } finally {
      setBusy(false)
    }
  }
  return { actionError, actionSuccess, busy, run, setActionError, setActionSuccess }
}

export const P2_PAGE_SIZE = 10
