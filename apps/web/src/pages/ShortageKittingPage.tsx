import { Message, PageContainer, t as $t } from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { listShortageKitting } from '../group-api'
import { GROUP_READ, usePermissions } from '../permissions'
import { useAuth } from '../auth'

/**
 * 缺料/齐套专用入口（G 场景）。
 * 对接 GET /group/shortage-kitting（L1 WI-L1-G-SHORTAGE-KIT-API）；
 * 不借道投料/排程/CSW/AI 问数。
 */
export function ShortageKittingPage() {
  const { has } = usePermissions()
  const { session } = useAuth()
  const canRead = has(GROUP_READ)
  const [items, setItems] = useState<Record<string, unknown>[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!canRead) {
      setLoading(false)
      return
    }
    setLoading(true)
    listShortageKitting({
      page: 1,
      pageSize: 20,
      plantId: session?.user.plantId || undefined,
    })
      .then((r) => {
        setItems(r.items)
        setTotal(r.total)
        setError(null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : $t('加载失败')))
      .finally(() => setLoading(false))
  }, [canRead, session?.user.plantId])

  return (
    <PageContainer
      title={$t('缺料/齐套')}
      description={$t('缺料核对与齐套检查专用入口（非投料、非排程、非 AI 问数相邻页冒充）')}
    >
      {!canRead && (
        <Message kind="warning" title={$t('无 group.read 许可')}>
          {$t('当前账号缺少 group.read，无法加载缺料/齐套结果。')}
        </Message>
      )}
      {error && (
        <Message kind="error" title={$t('加载失败')}>
          {error}
        </Message>
      )}
      {canRead && !error && (
        <div
          className="cz-table__empty"
          style={{
            marginTop: 16,
            padding: 24,
            border: '1px dashed var(--cz-color-border)',
            borderRadius: 8,
            textAlign: 'center',
            color: 'var(--cz-color-text-secondary)',
          }}
          role="status"
        >
          {loading
            ? $t('加载中…')
            : total === 0
              ? $t('暂无缺料/齐套结果')
              : $t('共 {p0} 条（已接 GET /group/shortage-kitting）', { p0: total })}
          {!loading && items.length > 0 && (
            <ul style={{ textAlign: 'left', marginTop: 12 }}>
              {items.map((it) => (
                <li key={String(it.id)}>
                  {String(it.orderNo ?? it.id)} — {String(it.checkStatus ?? '')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </PageContainer>
  )
}
