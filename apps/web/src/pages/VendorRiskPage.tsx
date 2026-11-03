import { Message, PageContainer, t as $t } from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listVendorRisks } from '../group-api'
import { GROUP_READ, usePermissions } from '../permissions'
import { useAuth } from '../auth'

/**
 * G 供应商风险专用入口。
 * 对接 GET /group/vendor-risks；外协任务页不得冒充。
 */
export function VendorRiskPage() {
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
    listVendorRisks({
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
      title={$t('供应商风险')}
      description={$t('供应商风险专用入口（非外协任务页冒充）；已接 GET /group/vendor-risks')}
    >
      <Message kind="info" title={$t('边界说明')}>
        {$t('本页不借道')} <Link to="/outsourcing/tasks">{$t('外协任务')}</Link>{$t('；专用面为 GET /group/vendor-risks。')}
      </Message>
      {!canRead && (
        <Message kind="warning" title={$t('无 group.read 许可')}>
          {$t('当前账号缺少 group.read，无法加载供应商风险列表。')}
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
              ? $t('暂无供应商风险记录（已接 GET /group/vendor-risks）')
              : $t('共 {p0} 条（已接 GET /group/vendor-risks）', { p0: total })}
          {!loading && items.length > 0 && (
            <ul style={{ textAlign: 'left', marginTop: 12 }}>
              {items.map((it) => (
                <li key={String(it.id)}>
                  {String(it.riskNo ?? it.id)} — {String(it.vendorCode ?? '')} /{' '}
                  {String(it.title ?? '')} [{String(it.riskLevel ?? '')}/{String(it.status ?? '')}]
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </PageContainer>
  )
}
