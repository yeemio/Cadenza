import { Message, PageContainer, t as $t } from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listProductRecalls } from '../group-api'
import { GROUP_READ, usePermissions } from '../permissions'
import { useAuth } from '../auth'

/**
 * 返工/报废/召回可发现入口。
 * 返工/报废复用 P2；成品/批次召回接 GET /group/recalls（≠ CSW 外协 recall）。
 */
export function ReworkScrapRecallHubPage() {
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
    listProductRecalls({
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
      title={$t('返工/报废/召回')}
      description={$t('G REWORK-SCRAP-RECALL 专用入口：返工/报废走 P2；成品/批次召回接 GET /group/recalls（≠ CSW 外协 recall）')}
    >
      <Message kind="info" title={$t('已挂可发现路径（返工/报废）')}>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li>
            {$t('返工台账 / 轴码治理：')}<Link to="/p2/rework">/p2/rework</Link>
          </li>
          <li>
            {$t('处置决定（含返工/报废/让步/放行）：')}
            <Link to="/p2/quality/disposition">/p2/quality/disposition</Link>
          </li>
          <li>
            {$t('成品异常：')}<Link to="/p2/quality/defect">/p2/quality/defect</Link>
          </li>
        </ul>
      </Message>
      {!canRead && (
        <Message kind="warning" title={$t('无 group.read 许可')}>
          {$t('当前账号缺少 group.read，无法加载成品/批次召回列表。')}
        </Message>
      )}
      {error && (
        <Message kind="error" title={$t('召回列表加载失败')}>
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
              ? $t('暂无成品/批次召回记录（已接 GET /group/recalls；≠ CSW 外协 recall）')
              : $t('共 {p0} 条（已接 GET /group/recalls）', { p0: total })}
          {!loading && items.length > 0 && (
            <ul style={{ textAlign: 'left', marginTop: 12 }}>
              {items.map((it) => (
                <li key={String(it.id)}>
                  {String(it.recallNo ?? it.id)} — {String(it.title ?? '')} [
                  {String(it.recallScope ?? '')}/{String(it.status ?? '')}]
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </PageContainer>
  )
}
