import { useEffect, useState } from 'react'
import { formatP3Error } from '../../../../packages/ui/src/api/p3'
import { t as $t } from '@cadenza/ui'

/**
 * P3 web 页面共享辅助（P3-UI 线新增，仅 P3 页面消费，零共享文件纪律不破；镜像 P2 shared.ts）：
 * - useP3AsyncList：服务端分页列表加载态（alive 守卫；错误经 formatP3Error 映射；PC-16 总计以服务端为准）；
 * - P3_PAGE_SIZE：列表页大小。
 */
export function useP3AsyncList<T>(
  fetcher: (page: number) => Promise<{ items: T[]; total: number }>,
  deps: readonly unknown[],
) {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
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
      .catch((err: unknown) => {
        if (!alive) return
        setError(
          err instanceof Error && 'code' in err
            ? formatP3Error(err as { code?: string; message?: string; requestId?: string })
            : { title: $t('加载失败') },
        )
        setItems([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, reloadKey, ...deps])
  /** 首载（无数据）才整表加载态；命令后刷新不清空已展示行（PC-17：返回/刷新保留适用数据，不闪空表） */
  return {
    items,
    total,
    page,
    setPage,
    loading: loading && items.length === 0,
    busy: loading,
    error,
    reload: () => setReloadKey((k) => k + 1),
  }
}

export const P3_PAGE_SIZE = 10
