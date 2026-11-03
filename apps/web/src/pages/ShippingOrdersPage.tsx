import {
  ApiError,
  Badge,
  Button,
  Field,
  Input,
  Message,
  Modal,
  PageContainer,
  PL_STATUS_LABELS,
  PL_STATUS_STEPS,
  SCAN_KIND_LABELS,
  Select,
  SHIPMENT_LINE_KIND_LABELS,
  formatErrorTitleAndDetail,
  type ShipmentOrderDetailDto,
  type ShipmentOrderDto,
  t as $t,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { SHIPPING_POST, SHIPPING_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10

/**
 * 发货单列表（A-T14-1 状态轴：待装箱→待出库→已出库）：
 * - 状态轴步骤条 + 出库人/完成时间 + 双回传状态列（实发轴/发货状态独立，A-T14-8）；
 * - 详情弹窗：三类行（托盘/有轴/无轴）快照与进度、扫码记录（装入/补码/删码）、打包任务、附件；
 * - 模拟入站（shipping.pl.inbound / dc-composition.inbound）：演示外部下发通道（PL 外部下发
 *   禁手工新增——本入口语义=外部报文模拟落库，页面明示）。
 */
export function ShippingOrdersPage() {
  const { has } = usePermissions()
  const { session } = useAuth()
  const canRead = has(SHIPPING_READ)
  const canPost = has(SHIPPING_POST)
  const [items, setItems] = useState<ShipmentOrderDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statuses, setStatuses] = useState('')
  const [plNoLike, setPlNoLike] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [detail, setDetail] = useState<ShipmentOrderDetailDto | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [retryBusy, setRetryBusy] = useState(false)
  // 模拟入站
  const [inboundOpen, setInboundOpen] = useState(false)
  const [inboundForm, setInboundForm] = useState({
    dcId: 'DC-2026-1028-02',
    salesOrderNo: 'SO-2026-1028-SHIP',
    plNo: 'PL-2026-1028-101',
    customerName: '演示客户',
    axisNo: 'CAX-D-01',
    standardSegmentLength: '600.0000',
    palletAxes: '1',
    segmentLength: '200.0000',
    pieces: '2',
    materialCode: 'YJV-3X70',
  })
  const [inboundBusy, setInboundBusy] = useState(false)

  const load = useCallback(() => {
    if (!canRead) return
    setLoading(true)
    api
      .listShipmentOrders({
        page,
        pageSize: PAGE_SIZE,
        statuses: statuses || undefined,
        plNoLike: plNoLike.trim() || undefined,
      })
      .then((result) => {
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载发货单失败') })
      })
      .finally(() => setLoading(false))
  }, [canRead, page, statuses, plNoLike])

  useEffect(() => {
    load()
  }, [load])

  const openDetail = async (id: string) => {
    setDetailBusy(true)
    try {
      const view = await api.shipmentDetail(id)
      setDetail(view)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载发货单详情失败') })
    } finally {
      setDetailBusy(false)
    }
  }

  const runRetry = async (order: ShipmentOrderDto, task: 'actual-axis' | 'status', outcome?: 'success' | 'failure') => {
    setRetryBusy(true)
    setError(null)
    try {
      const fn = task === 'actual-axis' ? api.syncActualAxisRetry : api.syncStatusRetry
      const result = await fn({ plantId: order.plantId, shipmentOrderId: order.orderId, outcome })
      const data = (result.data ?? {}) as { status?: string; skipped?: boolean }
      setNotice(
        data.skipped === true
          ? $t('回传重试跳过（已成功侧不重做，当前 {p0}）', { p0: data.status ?? '—' })
          : $t('回传重试完成（{p0} → {p1}）', { p0: task === 'actual-axis' ? $t('实发轴') : $t('发货状态'), p1: data.status ?? '—' }),
      )
      load()
      if (detail?.orderId === order.orderId) await openDetail(order.orderId)
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('回传重试失败') })
    } finally {
      setRetryBusy(false)
    }
  }

  const submitInbound = async () => {
    setInboundBusy(true)
    setError(null)
    try {
      const f = inboundForm
      // 入站归属=当前会话工厂（live 模式 plantId 为库内真实节点；mock 会话同构）
      const plantId = session?.user.plantId ?? ''
      if (!plantId) {
        setError({ title: $t('会话缺少工厂上下文，无法模拟入站') })
        return
      }
      // 先 DC 组成入站（组成数据 received），再 PL 入站（三类行：有轴 + 无轴 + 托盘）
      const dc = await api.dcCompositionInbound({
        dcId: f.dcId.trim(),
        salesOrderNo: f.salesOrderNo.trim(),
        lineNo: 10,
        plantId,
        composition: { segmentLength: `${f.standardSegmentLength.trim()}`, segmentQty: 1 },
      })
      const dcData = (dc.data ?? {}) as { syncStatus?: string }
      const pl = await api.plInbound({
        plNo: f.plNo.trim(),
        salesOrderNo: f.salesOrderNo.trim(),
        plantId,
        customerName: f.customerName.trim() || undefined,
        lines: [
          { lineNo: 1, lineKind: 'axis_item', materialCode: f.materialCode.trim(), salesOrderLineNo: '10', customerAxisNo: f.axisNo.trim(), standardSegmentLength: f.standardSegmentLength.trim() },
          { lineNo: 2, lineKind: 'plain_item', materialCode: f.materialCode.trim(), salesOrderLineNo: '11', segmentLength: f.segmentLength.trim(), pieces: Number(f.pieces) },
          { lineNo: 3, lineKind: 'pallet', materialCode: f.materialCode.trim(), salesOrderLineNo: '10', totalAxes: Number(f.palletAxes) },
        ],
      })
      const plData = (pl.data ?? {}) as { orderId?: string; compositionMissing?: boolean; skipped?: boolean }
      setNotice(
        `模拟入站完成：DC 组成 ${dcData.syncStatus ?? '—'}；PL ${f.plNo.trim()}${plData.skipped === true ? '（已存在，幂等跳过）' : `（${plData.orderId ?? ''}，${plData.compositionMissing === true ? '缺组成标记' : '组成齐备'}）`}`,
      )
      setInboundOpen(false)
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('模拟入站失败') })
    } finally {
      setInboundBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('发货单列表')}>
        <Message kind="warning" title={$t('没有发运查询许可（shipping.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('发货单列表')}
      description={$t('PL 状态机（A-T14-1）：待装箱→待出库→已出库；双回传状态列独立（A-T14-8：实发轴/发货状态互不影响）；PL 由外部系统下发（模拟入站为演示通道）')}
      actions={
        <>
          <Input
            style={{ width: 190 }}
            placeholder={$t('按发货单号搜索（plNoLike）')}
            value={plNoLike}
            onChange={(e) => {
              setPage(1)
              setPlNoLike(e.target.value)
            }}
          />
          <Select
            style={{ width: 120 }}
            placeholder={$t('全部状态')}
            value={statuses}
            onChange={(e) => {
              setPage(1)
              setStatuses(e.target.value)
            }}
            options={Object.entries(PL_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          />
          {canPost ? (
            <Button size="sm" variant="secondary" onClick={() => setInboundOpen(true)}>
              {$t('模拟入站（DC+PL）')}
            </Button>
          ) : null}
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <table className="cz-table" style={{ width: '100%' }} aria-label={$t('发货单列表')}>
        <thead>
          <tr>
            <th>{$t('发货单号')}</th>
            <th>{$t('销售订单')}</th>
            <th>{$t('客户')}</th>
            <th>{$t('状态机')}</th>
            <th>{$t('组成')}</th>
            <th>{$t('出库人/时间')}</th>
            <th>{$t('实发轴回传')}</th>
            <th>{$t('发货状态回传')}</th>
            <th>{$t('操作')}</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td className="cz-table__empty" colSpan={9}>{$t('加载中…')}</td>
            </tr>
          ) : items.length === 0 ? (
            <tr>
              <td className="cz-table__empty" colSpan={9}>{$t('暂无发货单（等待外部 PL 下发或模拟入站）')}</td>
            </tr>
          ) : (
            items.map((row) => {
              const current = PL_STATUS_STEPS.indexOf(row.status)
              return (
                <tr key={row.orderId}>
                  <td>
                    <b>{row.plNo}</b>
                  </td>
                  <td>{row.salesOrderNo}</td>
                  <td>{row.customerName ?? '—'}</td>
                  <td>
                    <div aria-label={$t('状态机：{p0}', { p0: row.statusLabel })} style={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                      {PL_STATUS_STEPS.map((step, i) => (
                        <span
                          key={step}
                          title={PL_STATUS_LABELS[step]}
                          style={{
                            width: 20,
                            height: 8,
                            borderRadius: 4,
                            background: i <= current ? 'var(--cz-color-primary)' : 'var(--cz-color-border)',
                          }}
                        />
                      ))}
                      <Badge tone={row.status === 'shipped' ? 'success' : row.status === 'ready_to_ship' ? 'info' : 'default'}>{row.statusLabel}</Badge>
                    </div>
                  </td>
                  <td>
                    {row.compositionMissing ? <Badge tone="warning">{$t('缺组成')}</Badge> : <span style={{ color: 'var(--cz-color-text-secondary)' }}>{$t('齐备')}</span>}
                  </td>
                  <td>{row.outboundBy ? $t('{p0}｜{p1}', { p0: row.outboundBy, p1: (row.outboundAt ?? '').slice(0, 16).replace('T', ' ') }) : '—'}</td>
                  <td>
                    <Badge tone={row.actualAxisSyncStatus === 'synced' || row.actualAxisSyncStatus === 'noop_needed' ? 'success' : row.actualAxisSyncStatus === 'sync_failed' ? 'danger' : 'default'}>
                      {row.actualAxisSyncStatusLabel}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone={row.shippingStatusSyncStatus === 'synced' ? 'success' : row.shippingStatusSyncStatus === 'sync_failed' ? 'danger' : 'default'}>
                      {row.shippingStatusSyncStatusLabel}
                    </Badge>
                  </td>
                  <td>
                    <Button size="sm" variant="secondary" loading={detailBusy} onClick={() => void openDetail(row.orderId)}>
                      {$t('详情')}
                    </Button>
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
      <nav className="cz-pagination" aria-label={$t('分页')}>
        <span className="cz-pagination__info">
          {$t('共')} <b>{total}</b> {$t('条 / 第')} {page} {$t('页（每页')} {PAGE_SIZE} {$t('条）')}
        </span>
        <span className="cz-pagination__pages">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {$t('上一页')}
          </Button>
          <Button size="sm" variant="secondary" disabled={page * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>
            {$t('下一页')}
          </Button>
        </span>
      </nav>

      {/* 发货单详情 */}
      <Modal
        open={detail !== null}
        title={detail ? $t('发货单 {p0}（{p1}）', { p0: detail.plNo, p1: detail.statusLabel }) : $t('发货单详情')}
        onClose={() => setDetail(null)}
        size="lg"
      >
        {detail ? (
          <div>
            <p style={{ fontSize: 13.5, margin: '0 0 8px' }}>
              {detail.salesOrderNo}{$t('｜')}{detail.customerName ?? '—'}{$t('｜')}
              {detail.compositionMissing ? <Badge tone="warning">{$t('缺组成')}</Badge> : $t('组成齐备')}{$t('｜')}
              {detail.outboundBy ? $t('出库人 {p0}｜{p1}', { p0: detail.outboundBy, p1: (detail.outboundAt ?? '').slice(0, 16).replace('T', ' ') }) : $t('未出库')}
            </p>
            <p style={{ fontSize: 13.5, margin: '0 0 10px' }}>
              {$t('双回传：实发轴')} <b>{detail.actualAxisSyncStatusLabel}</b>{$t('（')}{detail.actualAxisSyncStatus}{$t('）｜发货状态')} <b>{detail.shippingStatusSyncStatusLabel}</b>{$t('（')}{detail.shippingStatusSyncStatus}{$t('）')}
            </p>
            {canPost && detail.status === 'shipped' ? (
              <div style={{ display: 'flex', gap: 8, margin: '0 0 12px' }}>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={retryBusy}
                  disabled={detail.actualAxisSyncStatus === 'synced' || detail.actualAxisSyncStatus === 'noop_needed'}
                  onClick={() => void runRetry(detail, 'actual-axis')}
                >
                  {$t('实发轴回传重试')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={retryBusy}
                  disabled={detail.shippingStatusSyncStatus === 'synced'}
                  onClick={() => void runRetry(detail, 'status')}
                >
                  {$t('发货状态回传重试')}
                </Button>
              </div>
            ) : null}
            <h4 style={{ fontSize: 13.5, margin: '12px 0 6px' }}>{$t('备货行（三类行 A-T14-3）')}</h4>
            <table className="cz-table" aria-label={$t('备货行')}>
              <thead>
                <tr>
                  <th>{$t('行')}</th>
                  <th>{$t('类型')}</th>
                  <th>{$t('料品')}</th>
                  <th>{$t('客户轴号')}</th>
                  <th>{$t('段长快照')}</th>
                  <th>{$t('已扫/应扫')}</th>
                  <th>{$t('行状态')}</th>
                  <th>{$t('打包')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => (
                  <tr key={line.lineId}>
                    <td>{line.lineNo}</td>
                    <td>{SHIPMENT_LINE_KIND_LABELS[line.lineKind] ?? line.lineKind}</td>
                    <td>{line.materialCode}</td>
                    <td>{line.customerAxisNo ?? '—'}</td>
                    <td>
                      {line.lineKind === 'axis_item'
                        ? $t('标准 {p0}{p1}', { p0: line.standardSegmentLength ?? '—', p1: line.actualSegmentLength ? $t('／实发 {p0}', { p0: line.actualSegmentLength }) : '' })
                        : line.lineKind === 'plain_item'
                          ? (line.segmentLength ?? '—')
                          : $t('逐轴明细')}
                    </td>
                    <td>
                      {line.scannedCount}/{line.requiredCount}
                    </td>
                    <td>
                      <Badge tone={line.lineStatus === 'packed' ? 'success' : 'default'}>{line.lineStatusLabel}</Badge>
                    </td>
                    <td>{line.packingStatus ? <Badge tone={line.packingStatus === 'bound' ? 'success' : 'info'}>{line.packingStatus === 'bound' ? $t('已绑定') : $t('待打包')}</Badge> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4 style={{ fontSize: 13.5, margin: '12px 0 6px' }}>{$t('扫码记录')}</h4>
            <table className="cz-table" aria-label={$t('扫码记录')}>
              <thead>
                <tr>
                  <th>{$t('码')}</th>
                  <th>{$t('种类')}</th>
                  <th>{$t('实际段长')}</th>
                  <th>{$t('扫码人/时间')}</th>
                  <th>{$t('状态')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.scans.length === 0 ? (
                  <tr>
                    <td className="cz-table__empty" colSpan={5}>{$t('暂无扫码记录')}</td>
                  </tr>
                ) : (
                  detail.scans.map((scan) => (
                    <tr key={scan.scanId} style={scan.deleted ? { opacity: 0.55 } : undefined}>
                      <td>{scan.unitNo}</td>
                      <td>{SCAN_KIND_LABELS[scan.scanKind] ?? scan.scanKind}</td>
                      <td>{scan.actualSegmentLength ?? '—'}</td>
                      <td>{scan.scannedBy}{$t('｜')}{scan.scannedAt.slice(0, 16).replace('T', ' ')}</td>
                      <td>{scan.deleted ? <span>{$t('已删码（')}{scan.deletedBy ?? '—'}{$t('）')}</span> : <Badge tone="success">{$t('有效')}</Badge>}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {detail.packings.length > 0 ? (
              <>
                <h4 style={{ fontSize: 13.5, margin: '12px 0 6px' }}>{$t('打包任务')}</h4>
                <table className="cz-table" aria-label={$t('打包任务')}>
                  <thead>
                    <tr>
                      <th>{$t('打包号')}</th>
                      <th>{$t('托码')}</th>
                      <th>{$t('调入库位')}</th>
                      <th>{$t('状态')}</th>
                      <th>{$t('绑定人/时间')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.packings.map((pk) => (
                      <tr key={pk.packingId}>
                        <td>{pk.packingNo}</td>
                        <td>{pk.palletCode}</td>
                        <td>{pk.toLocationCode ?? '—'}</td>
                        <td>
                          <Badge tone={pk.status === 'bound' ? 'success' : 'info'}>{pk.statusLabel}</Badge>
                        </td>
                        <td>{pk.boundBy ? $t('{p0}｜{p1}', { p0: pk.boundBy, p1: (pk.boundAt ?? '').slice(0, 16).replace('T', ' ') }) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
            {detail.photos.length > 0 ? (
              <p style={{ fontSize: 13, margin: '12px 0 0' }}>
                {$t('装箱图附件（')}{detail.photos.length}{$t('）：')}{detail.photos.map((ph) => ph.fileName).join('、')}
              </p>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* 模拟入站（演示外部下发通道） */}
      <Modal
        open={inboundOpen}
        title={$t('模拟入站（DC 组成 + PL 下发；演示外部系统报文通道）')}
        onClose={() => setInboundOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setInboundOpen(false)}>{$t('取消')}</Button>
            <Button loading={inboundBusy} onClick={() => void submitInbound()}>
              {$t('模拟下发')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label={$t('销售订单号')} required>
            <Input value={inboundForm.salesOrderNo} onChange={(e) => setInboundForm({ ...inboundForm, salesOrderNo: e.target.value })} />
          </Field>
          <Field label={$t('DC 组成标识（dcId）')} required hint={$t('IF-04：dcId+销售订单号+行号幂等；组成数据 received')}>
            <Input value={inboundForm.dcId} onChange={(e) => setInboundForm({ ...inboundForm, dcId: e.target.value })} />
          </Field>
          <Field label={$t('发货单号（plNo）')} required hint={$t('IF-05：发货单号幂等（重复下发跳过）')}>
            <Input value={inboundForm.plNo} onChange={(e) => setInboundForm({ ...inboundForm, plNo: e.target.value })} />
          </Field>
          <Field label={$t('客户名称')}>
            <Input value={inboundForm.customerName} onChange={(e) => setInboundForm({ ...inboundForm, customerName: e.target.value })} />
          </Field>
          <Field label={$t('有轴行：客户轴号 + 标准段长')} required hint={$t('A-T14-3：有轴单品=客户轴号+标准段长，应扫固定 1')}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input value={inboundForm.axisNo} onChange={(e) => setInboundForm({ ...inboundForm, axisNo: e.target.value })} />
              <Input value={inboundForm.standardSegmentLength} onChange={(e) => setInboundForm({ ...inboundForm, standardSegmentLength: e.target.value })} />
            </div>
          </Field>
          <Field label={$t('无轴行：段长 + 件数')} required hint={$t('A-T14-3：无轴单品=段长×件数（=应扫数），无客户轴号')}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input value={inboundForm.segmentLength} onChange={(e) => setInboundForm({ ...inboundForm, segmentLength: e.target.value })} />
              <Input value={inboundForm.pieces} onChange={(e) => setInboundForm({ ...inboundForm, pieces: e.target.value })} />
            </div>
          </Field>
          <Field label={$t('托盘行：总轴数')} required hint={$t('A-T14-4：托盘行挂打包任务（先扫托码+选调入库位→逐行扫满→绑定）')}>
            <Input value={inboundForm.palletAxes} onChange={(e) => setInboundForm({ ...inboundForm, palletAxes: e.target.value })} />
          </Field>
          <Field label={$t('料品编码')} required>
            <Input value={inboundForm.materialCode} onChange={(e) => setInboundForm({ ...inboundForm, materialCode: e.target.value })} />
          </Field>
          <Message kind="info" title={$t('PL 由外部系统下发（A-T14-1 禁手工新增）：本入口=外部报文模拟落库（演示/联调通道），非 MES 手工建单')} />
        </div>
      </Modal>
    </PageContainer>
  )
}
