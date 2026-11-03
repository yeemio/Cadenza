import { Message, PageContainer, t as $t } from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listScanBlockEvents } from '../scan-block-api'
import { SCAN_BLOCK_READ, usePermissions } from '../permissions'
import { useAuth } from '../auth'

/**
 * E09 SCAN-BLOCK 扫描拦截专用入口。
 * 对接 GET /scan-block/events；通用扫码/报工/条码/备货不得冒充。
 */
export function ScanBlockPage() {
  const { has } = usePermissions()
  const { session } = useAuth()
  const canRead = has(SCAN_BLOCK_READ)
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
    listScanBlockEvents({
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
      title={$t('扫描拦截（SCAN-BLOCK）')}
      description={$t('E09 扫描拦截专用阻断入口（非通用扫码壳冒充）；已接 GET /scan-block/events')}
    >
      <Message kind="info" title={$t('边界说明')}>
        {$t('本页不借道')} <Link to="/inventory/barcode">{$t('条码解析')}</Link>{$t('、')}
        <Link to="/production/workbench">{$t('报工工作台')}</Link>{$t('、')}
        <Link to="/shipping/packing">{$t('备货工作台')}</Link>{$t('；专用面为 GET /scan-block/events。')}
      </Message>
      {!canRead && (
        <Message kind="warning" title={$t('无 scan_block.read 许可')}>
          {$t('当前账号缺少 scan_block.read，无法加载扫描拦截事件。')}
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
              ? $t('暂无扫描拦截事件（已接 GET /scan-block/events）')
              : $t('共 {p0} 条（已接 GET /scan-block/events）', { p0: total })}
          {!loading && items.length > 0 && (
            <ul style={{ textAlign: 'left', marginTop: 12 }}>
              {items.map((it) => (
                <li key={String(it.id)}>
                  {String(it.eventNo ?? it.id)} — {String(it.policyCode ?? '')} /{' '}
                  {String(it.scanCode ?? '')} [{String(it.status ?? '')}]
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </PageContainer>
  )
}
