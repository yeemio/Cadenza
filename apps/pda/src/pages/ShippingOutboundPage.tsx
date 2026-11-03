import { ApiError, Badge, Button, Message, PageContainer, formatErrorTitleAndDetail, type ShipmentOrderDto, t as $t } from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { SHIPPING_POST, usePermissions } from '../permissions'

/**
 * PDA 出库确认简化页（A-T14-7/8）：
 * 待出库单列表（应扫/已扫合计核对）→ 确认出库；已出库双回传状态展示与独立重试。
 */
export function ShippingOutboundPage() {
  const { has } = usePermissions()
  const canPost = has(SHIPPING_POST)
  const [readyOrders, setReadyOrders] = useState<ShipmentOrderDto[]>([])
  const [shippedOrders, setShippedOrders] = useState<ShipmentOrderDto[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    Promise.all([
      api.listShipmentOrders({ page: 1, pageSize: 20, statuses: 'ready_to_ship' }),
      api.outboundStatus({ page: 1, pageSize: 20 }),
    ])
      .then(([ready, shipped]) => {
        setReadyOrders(ready.items)
        setShippedOrders(shipped.items)
      })
      .catch((err) => {
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载出库数据失败') })
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const confirm = async (order: ShipmentOrderDto) => {
    setBusy(order.orderId)
    setError(null)
    setNotice(null)
    try {
      const result = await api.shipConfirm({ plantId: order.plantId, shipmentOrderId: order.orderId })
      const data = (result.data ?? {}) as { outboundBy?: string; postedUnits?: number; actualAxisSyncStatus?: string; shippingStatusSyncStatus?: string }
      setNotice($t('已出库：{p0}（{p1}；发运 {p2} 单元；回传 {p3}/{p4}）', { p0: order.plNo, p1: data.outboundBy ?? '—', p2: data.postedUnits ?? 0, p3: data.actualAxisSyncStatus ?? '—', p4: data.shippingStatusSyncStatus ?? '—' }))
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('确认出库失败') })
    } finally {
      setBusy('')
    }
  }

  const retry = async (order: ShipmentOrderDto, task: 'actual-axis' | 'status') => {
    setBusy(`${order.orderId}:${task}`)
    setError(null)
    try {
      const fn = task === 'actual-axis' ? api.syncActualAxisRetry : api.syncStatusRetry
      const result = await fn({ plantId: order.plantId, shipmentOrderId: order.orderId })
      const data = (result.data ?? {}) as { status?: string; skipped?: boolean }
      setNotice(data.skipped === true ? $t('重试跳过（已成功侧不重做；当前 {p0}）', { p0: data.status ?? '—' }) : $t('回传重试完成 → {p0}', { p0: data.status ?? '—' }))
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('回传重试失败') })
    } finally {
      setBusy('')
    }
  }

  return (
    <PageContainer title={$t('出库确认')} description={$t('待出库单确认出库（A-T14-7）；已出库双回传状态独立（A-T14-8）')}>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>{$t('待出库')}</h3>
      {readyOrders.length === 0 ? (
        <Message kind="info" title={$t('暂无待出库发货单')} />
      ) : (
        readyOrders.map((order) => (
          <div key={order.orderId} style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 10, marginBottom: 8, background: 'var(--cz-color-bg-surface)' }}>
            <p style={{ fontSize: 13.5, margin: '0 0 6px' }}>
              <b>{order.plNo}</b>{$t('（')}{order.customerName ?? '—'}{$t('）')}
            </p>
            {canPost ? (
              <Button block size="lg" loading={busy === order.orderId} onClick={() => void confirm(order)}>
                {$t('确认出库')}
              </Button>
            ) : (
              <Badge tone="warning">{$t('需 shipping.post 许可')}</Badge>
            )}
          </div>
        ))
      )}

      <h3 style={{ fontSize: 14, margin: '14px 0 8px' }}>{$t('已出库（双回传）')}</h3>
      {shippedOrders.length === 0 ? (
        <Message kind="info" title={$t('暂无已出库发货单')} />
      ) : (
        shippedOrders.map((order) => {
          const axisDone = order.actualAxisSyncStatus === 'synced' || order.actualAxisSyncStatus === 'noop_needed'
          const statusDone = order.shippingStatusSyncStatus === 'synced'
          return (
            <div key={order.orderId} style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 10, marginBottom: 8, background: 'var(--cz-color-bg-surface)' }}>
              <p style={{ fontSize: 13.5, margin: '0 0 4px' }}>
                <b>{order.plNo}</b>{$t('｜出库')} {order.outboundBy ?? '—'}
              </p>
              <p style={{ fontSize: 13, margin: '0 0 6px' }}>
                {$t('实发轴')} <Badge tone={axisDone ? 'success' : order.actualAxisSyncStatus === 'sync_failed' ? 'danger' : 'default'}>{order.actualAxisSyncStatusLabel}</Badge>{' '}
                {$t('发货状态')} <Badge tone={statusDone ? 'success' : order.shippingStatusSyncStatus === 'sync_failed' ? 'danger' : 'default'}>{order.shippingStatusSyncStatusLabel}</Badge>
              </p>
              {canPost && !(axisDone && statusDone) ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button size="sm" variant="secondary" disabled={axisDone} loading={busy === `${order.orderId}:actual-axis`} onClick={() => void retry(order, 'actual-axis')}>
                    {$t('实发轴重试')}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={statusDone} loading={busy === `${order.orderId}:status`} onClick={() => void retry(order, 'status')}>
                    {$t('状态重试')}
                  </Button>
                </div>
              ) : null}
            </div>
          )
        })
      )}
    </PageContainer>
  )
}
