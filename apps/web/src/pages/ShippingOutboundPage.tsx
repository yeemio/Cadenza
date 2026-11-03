import {
  ApiError,
  Badge,
  Button,
  Field,
  Message,
  Modal,
  PageContainer,
  SHIPMENT_LINE_KIND_LABELS,
  Textarea,
  formatErrorTitleAndDetail,
  type ShipmentOrderDetailDto,
  type ShipmentOrderDto,
  t as $t,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { SHIPPING_POST, SHIPPING_READ, usePermissions } from '../permissions'

/**
 * 出库确认页（A-T14-7/8）：
 * - 待出库单应扫核对清单（逐行 已扫/应扫、料品/段长——不足行指名显示）；
 * - 确认出库（Web/PDA 双入口共用同命令；执行=已出库+出库人+完成时间+库存记已发货）；
 * - 已出库集合双回传状态列（实发轴/发货状态独立）与独立重试（不重做已成功侧）。
 */
export function ShippingOutboundPage() {
  const { has } = usePermissions()
  const canRead = has(SHIPPING_READ)
  const canPost = has(SHIPPING_POST)
  const [readyOrders, setReadyOrders] = useState<ShipmentOrderDto[]>([])
  const [shippedOrders, setShippedOrders] = useState<ShipmentOrderDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 核对清单弹窗
  const [checklist, setChecklist] = useState<ShipmentOrderDetailDto | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [retryBusy, setRetryBusy] = useState('')

  const load = useCallback(() => {
    if (!canRead) return
    setLoading(true)
    Promise.all([
      api.listShipmentOrders({ page: 1, pageSize: 20, statuses: 'ready_to_ship' }),
      api.outboundStatus({ page: 1, pageSize: 20 }),
    ])
      .then(([ready, shipped]) => {
        setReadyOrders(ready.items)
        setShippedOrders(shipped.items)
        setError(null)
      })
      .catch((err) => {
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载出库数据失败') })
      })
      .finally(() => setLoading(false))
  }, [canRead])

  useEffect(() => {
    load()
  }, [load])

  const openChecklist = async (order: ShipmentOrderDto) => {
    try {
      const view = await api.shipmentDetail(order.orderId)
      setChecklist(view)
      setReason('')
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载核对清单失败') })
    }
  }

  const confirmOutbound = async () => {
    if (!checklist) return
    setBusy(true)
    setError(null)
    try {
      // OA-29 留痕走 body.reason（服务端 shipping controller 优先 body；
      // 中文 reason 不进 x-reason 头——浏览器 fetch 头仅收 ISO-8859-1，非拉丁1会直接抛错）
      const result = await api.shipConfirm(
        { plantId: checklist.plantId, shipmentOrderId: checklist.orderId, reason: reason.trim() || undefined },
      )
      const data = (result.data ?? {}) as {
        outboundBy?: string
        outboundAt?: string
        postedUnits?: number
        actualAxisSyncStatus?: string
        shippingStatusSyncStatus?: string
      }
      setNotice(
        $t('确认出库完成：{p0}｜出库人 {p1}｜库存记已发运 {p2} 单元｜双回传（实发轴 {p3}／发货状态 {p4}）', { p0: checklist.plNo, p1: data.outboundBy ?? '—', p2: data.postedUnits ?? 0, p3: data.actualAxisSyncStatus ?? '—', p4: data.shippingStatusSyncStatus ?? '—' }),
      )
      setChecklist(null)
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('确认出库失败') })
    } finally {
      setBusy(false)
    }
  }

  const runRetry = async (order: ShipmentOrderDto, task: 'actual-axis' | 'status', outcome: 'success' | 'failure') => {
    setRetryBusy(`${order.orderId}:${task}:${outcome}`)
    setError(null)
    try {
      const fn = task === 'actual-axis' ? api.syncActualAxisRetry : api.syncStatusRetry
      const result = await fn({ plantId: order.plantId, shipmentOrderId: order.orderId, outcome })
      const data = (result.data ?? {}) as { status?: string; skipped?: boolean }
      setNotice(
        data.skipped === true
          ? $t('回传重试跳过（已成功侧不重做，当前 {p0}）', { p0: data.status ?? '—' })
          : $t('回传重试完成（{p0} → {p1}；快照重推不改当前值）', { p0: task === 'actual-axis' ? $t('实发轴') : $t('发货状态'), p1: data.status ?? '—' }),
      )
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('回传重试失败') })
    } finally {
      setRetryBusy('')
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('出库确认')}>
        <Message kind="warning" title={$t('没有发运查询许可（shipping.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('出库确认')}
      description={$t('确认出库（A-T14-7：仅待出库；任一行已扫<应扫拒并指名料品/段长；执行=已出库+出库人+库存记已发运）；双回传独立（A-T14-8）')}
      actions={
        <Button size="sm" variant="secondary" onClick={() => load()}>
          {$t('刷新')}
        </Button>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('待出库（应扫核对）')}</h3>
      <table className="cz-table" style={{ width: '100%' }} aria-label={$t('待出库单列表')}>
        <thead>
          <tr>
            <th>{$t('发货单号')}</th>
            <th>{$t('销售订单')}</th>
            <th>{$t('客户')}</th>
            <th>{$t('操作')}</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td className="cz-table__empty" colSpan={4}>{$t('加载中…')}</td>
            </tr>
          ) : readyOrders.length === 0 ? (
            <tr>
              <td className="cz-table__empty" colSpan={4}>{$t('暂无待出库发货单（备货工作台全部行扫满后进入待出库）')}</td>
            </tr>
          ) : (
            readyOrders.map((row) => (
              <tr key={row.orderId}>
                <td>
                  <b>{row.plNo}</b>
                </td>
                <td>{row.salesOrderNo}</td>
                <td>{row.customerName ?? '—'}</td>
                <td>
                  <Button size="sm" onClick={() => void openChecklist(row)}>
                    {$t('应扫核对清单')}
                  </Button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h3 style={{ fontSize: 15, margin: '18px 0 8px' }}>{$t('已出库（双回传状态列独立）')}</h3>
      <table className="cz-table" style={{ width: '100%' }} aria-label={$t('已出库单列表')}>
        <thead>
          <tr>
            <th>{$t('发货单号')}</th>
            <th>{$t('状态')}</th>
            <th>{$t('出库人')}</th>
            <th>{$t('完成时间')}</th>
            <th>{$t('实发轴回传')}</th>
            <th>{$t('发货状态回传')}</th>
            <th>{$t('回传重试（shipping.post）')}</th>
          </tr>
        </thead>
        <tbody>
          {shippedOrders.length === 0 ? (
            <tr>
              <td className="cz-table__empty" colSpan={7}>{$t('暂无已出库发货单')}</td>
            </tr>
          ) : (
            shippedOrders.map((row) => {
              const axisDone = row.actualAxisSyncStatus === 'synced' || row.actualAxisSyncStatus === 'noop_needed'
              const statusDone = row.shippingStatusSyncStatus === 'synced'
              return (
                <tr key={row.orderId}>
                  <td>
                    <b>{row.plNo}</b>
                  </td>
                  <td>
                    <Badge tone="success">{row.statusLabel}</Badge>
                  </td>
                  <td>{row.outboundBy ?? '—'}</td>
                  <td>{(row.outboundAt ?? '').slice(0, 16).replace('T', ' ')}</td>
                  <td>
                    <Badge tone={axisDone ? 'success' : row.actualAxisSyncStatus === 'sync_failed' ? 'danger' : 'default'}>
                      {row.actualAxisSyncStatusLabel}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone={statusDone ? 'success' : row.shippingStatusSyncStatus === 'sync_failed' ? 'danger' : 'default'}>
                      {row.shippingStatusSyncStatusLabel}
                    </Badge>
                  </td>
                  <td>
                    {canPost ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={axisDone}
                          loading={retryBusy === `${row.orderId}:actual-axis:success`}
                          onClick={() => void runRetry(row, 'actual-axis', 'success')}
                        >
                          {$t('实发轴重试')}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={statusDone}
                          loading={retryBusy === `${row.orderId}:status:success`}
                          onClick={() => void runRetry(row, 'status', 'success')}
                        >
                          {$t('状态重试')}
                        </Button>
                      </div>
                    ) : (
                      <span style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>{$t('需 shipping.post')}</span>
                    )}
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>

      {/* 应扫核对清单 + 确认出库 */}
      <Modal
        open={checklist !== null}
        title={checklist ? $t('应扫核对清单：{p0}', { p0: checklist.plNo }) : $t('应扫核对清单')}
        onClose={() => setChecklist(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setChecklist(null)}>{$t('取消')}</Button>
            {canPost ? (
              <Button
                loading={busy}
                disabled={checklist === null || checklist.lines.some((l) => l.scannedCount < l.requiredCount)}
                onClick={() => void confirmOutbound()}
              >
                {$t('确认出库')}
              </Button>
            ) : null}
          </>
        }
      >
        {checklist ? (
          <div>
            <p style={{ fontSize: 13.5, margin: '0 0 10px' }}>
              {checklist.salesOrderNo}{$t('｜')}{checklist.customerName ?? '—'}{$t('｜当前状态')} {checklist.statusLabel}
            </p>
            <table className="cz-table" aria-label={$t('应扫核对')}>
              <thead>
                <tr>
                  <th>{$t('行')}</th>
                  <th>{$t('类型')}</th>
                  <th>{$t('料品')}</th>
                  <th>{$t('段长')}</th>
                  <th>{$t('已扫/应扫')}</th>
                  <th>{$t('核对')}</th>
                </tr>
              </thead>
              <tbody>
                {checklist.lines.map((line) => {
                  const ok = line.scannedCount >= line.requiredCount
                  const seg = line.lineKind === 'axis_item' ? line.standardSegmentLength : line.lineKind === 'plain_item' ? line.segmentLength : null
                  return (
                    <tr key={line.lineId}>
                      <td>{line.lineNo}</td>
                      <td>{SHIPMENT_LINE_KIND_LABELS[line.lineKind] ?? line.lineKind}</td>
                      <td>{line.materialCode}</td>
                      <td>{seg ?? $t('逐轴明细')}</td>
                      <td>
                        <b>{line.scannedCount}</b>/{line.requiredCount}
                      </td>
                      <td>
                        {ok ? (
                          <Badge tone="success">{$t('扫满')}</Badge>
                        ) : (
                          <Badge tone="danger">{$t('不足：料品 {p0}（段长 {p1}，行 {p2}）已扫 {p3}/应扫 {p4}', { p0: line.materialCode, p1: seg ?? '无', p2: line.lineNo, p3: line.scannedCount, p4: line.requiredCount })}</Badge>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {checklist.lines.some((l) => l.scannedCount < l.requiredCount) ? (
              <Message kind="warning" title={$t('存在已扫<应扫的备货行：确认出库将被拒绝（A-T14-7 指名料品/段长）')} />
            ) : null}
            {canPost ? (
              <div style={{ marginTop: 12 }}>
                <Field label={$t('出库原因（留痕）')} hint={$t('随命令审计记录（OA-29 高影响操作建议填写）')}>
                  <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={$t('例如：发运出库（客户订单）')} />
                </Field>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </PageContainer>
  )
}
