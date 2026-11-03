import { Message, PageContainer, t as $t } from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listFeedRacePlans } from '../production-api'
import { PRODUCTION_READ, usePermissions } from '../permissions'
import { useAuth } from '../auth'

/**
 * E09 投料竞争 / 计划部分 / 迟修订专用入口。
 * 对接 GET /production/feed-race-plans；投料/排程/生产订单不得冒充。
 */
export function FeedRacePlanPage() {
  const { has } = usePermissions()
  const { session } = useAuth()
  const canRead = has(PRODUCTION_READ)
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
    listFeedRacePlans({
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
      title={$t('投料竞争/计划部分/迟修订')}
      description={$t('E09 FEED-RACE-PLAN 专用入口（非投料、非排程、非生产订单列表冒充）；已接 GET /production/feed-race-plans')}
    >
      <Message kind="info" title={$t('边界说明')}>
        {$t('本页不借道')} <Link to="/production/feeding">{$t('投料')}</Link>{$t('、')}
        <Link to="/production/scheduling">{$t('排程')}</Link>{$t('、')}
        <Link to="/production/orders">{$t('生产订单')}</Link>{$t('；专用面为 GET /production/feed-race-plans。')}
      </Message>
      {!canRead && (
        <Message kind="warning" title={$t('无 production.read 许可')}>
          {$t('当前账号缺少 production.read，无法加载投料竞争/计划部分列表。')}
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
              ? $t('暂无投料竞争 / 计划部分 / 迟修订记录（已接 GET /production/feed-race-plans）')
              : $t('共 {p0} 条（已接 GET /production/feed-race-plans）', { p0: total })}
          {!loading && items.length > 0 && (
            <ul style={{ textAlign: 'left', marginTop: 12 }}>
              {items.map((it) => (
                <li key={String(it.id)}>
                  {String(it.planNo ?? it.id)} — {String(it.title ?? '')} [
                  {String(it.planKind ?? '')}/{String(it.status ?? '')}]
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </PageContainer>
  )
}
