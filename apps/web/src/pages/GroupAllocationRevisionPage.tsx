import { Message, PageContainer, t as $t } from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { listAllocationRevisions } from '../group-api'
import { GROUP_READ, usePermissions } from '../permissions'
import { useAuth } from '../auth'

/**
 * 集团分配修订入口（G 场景；非成本分摊 /cost/allocation-versions）。
 * 对接 GET /group/allocation-revisions（L1 WI-L1-G-ALLOC-REV-API）。
 */
export function GroupAllocationRevisionPage() {
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
    listAllocationRevisions({
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
      title={$t('分配修订')}
      description={$t('集团需求/产能分配修订专用入口（非成本分摊版本；成本域 /cost/allocation-versions 不得冒充）')}
    >
      {!canRead && (
        <Message kind="warning" title={$t('无 group.read 许可')}>
          {$t('当前账号缺少 group.read，无法加载分配修订列表。')}
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
              ? $t('暂无分配修订记录')
              : $t('共 {p0} 条（已接 GET /group/allocation-revisions）', { p0: total })}
          {!loading && items.length > 0 && (
            <ul style={{ textAlign: 'left', marginTop: 12 }}>
              {items.map((it) => (
                <li key={String(it.id)}>
                  {String(it.revisionNo ?? it.id)} — {String(it.title ?? '')} [{String(it.status ?? '')}]
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </PageContainer>
  )
}
