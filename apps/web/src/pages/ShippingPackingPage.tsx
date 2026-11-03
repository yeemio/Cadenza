import {
  ApiError,
  Badge,
  Button,
  Field,
  Input,
  Message,
  PageContainer,
  ScanInput,
  Select,
  SHIPMENT_LINE_KIND_LABELS,
  formatErrorTitleAndDetail,
  type PackingOrderDto,
  type ShipmentOrderDetailDto,
  t as $t,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { SHIPPING_POST, SHIPPING_READ, usePermissions } from '../permissions'

/** 调入库位选项：从主数据加载本厂 active 库位（live=真实库位；mock 同构演示库位） */
const FALLBACK_LOCATION_OPTIONS = [
  { value: 'loc-01030001|01030001', label: '成品一库 01030001' },
  { value: 'loc-01030002|01030002', label: '成品一库 01030002' },
]

/**
 * 备货工作台（A-T14-3/4/5）：
 * - 三类行（托盘/有轴/无轴）逐行扫码装入（五拒一成）、删码（不满足退回待装箱）、
 *   无轴行补码（缺产品轴号补登记）；行扫满→已装箱，全部行扫满→待出库；
 * - 打包任务：先扫托码+选调入库位创建（挂托盘行）→ 逐行扫满 → 绑定托码（bound 只读）；
 * - 打包看板：托码/调入库位/逐行进度/绑定状态。
 */
export function ShippingPackingPage() {
  const { has } = usePermissions()
  const { session } = useAuth()
  const canRead = has(SHIPPING_READ)
  const canPost = has(SHIPPING_POST)
  const [orders, setOrders] = useState<Array<{ orderId: string; plNo: string; status: string; statusLabel: string }>>([])
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<ShipmentOrderDetailDto | null>(null)
  const [packings, setPackings] = useState<PackingOrderDto[]>([])
  const [activeLineId, setActiveLineId] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 打包创建
  const [packingFormOpen, setPackingFormOpen] = useState(false)
  const [palletCode, setPalletCode] = useState('PLT-2026-A01')
  const [locationOptions, setLocationOptions] = useState(FALLBACK_LOCATION_OPTIONS)
  const [toLocation, setToLocation] = useState(FALLBACK_LOCATION_OPTIONS[0]!.value)

  const loadLocations = useCallback(() => {
    api
      .listLocations({ page: 1, pageSize: 50, plantId: session?.user.plantId ?? undefined })
      .then((result) => {
        const active = result.items.filter((l) => l.status === 'active')
        if (active.length === 0) return // 保持演示回落选项（无库位主数据时创建会被服务端拒）
        const options = active.map((l) => ({ value: `${l.id}|${l.code}`, label: $t('{p0}（{p1}库位）', { p0: l.code, p1: l.locationKind === 'RACK' ? $t('货架') : $t('普通') }) }))
        setLocationOptions(options)
        setToLocation((prev) => (options.some((o) => o.value === prev) ? prev : options[0]?.value ?? prev))
      })
      .catch(() => {
        /* 主数据读取失败保持演示回落选项 */
      })
  }, [session?.user.plantId])

  const loadOrders = useCallback(() => {
    if (!canRead) return
    api
      .listShipmentOrders({ page: 1, pageSize: 20, statuses: 'pending_packing,ready_to_ship' })
      .then((result) => {
        setOrders(result.items.map((o) => ({ orderId: o.orderId, plNo: o.plNo, status: o.status, statusLabel: o.statusLabel })))
        // 工作台落点即作业：未手工选择时默认选中首张待备货单（PC-04 减少空态点击）
        setSelectedId((prev) => prev || result.items[0]?.orderId || '')
        setError(null)
      })
      .catch((err) => {
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载发货单失败') })
      })
  }, [canRead])

  const loadPackings = useCallback(() => {
    if (!canRead) return
    api
      .packingBoard({ page: 1, pageSize: 10 })
      .then((result) => setPackings(result.items))
      .catch(() => setPackings([]))
  }, [canRead])

  const loadDetail = useCallback(
    async (orderId: string) => {
      if (!orderId) {
        setDetail(null)
        return
      }
      try {
        const view = await api.shipmentDetail(orderId)
        setDetail(view)
        setActiveLineId((prev) => (view.lines.some((l) => l.lineId === prev) ? prev : view.lines[0]?.lineId ?? ''))
        setError(null)
      } catch (err) {
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载发货单详情失败') })
      }
    },
    [],
  )

  useEffect(() => {
    loadOrders()
    loadPackings()
    loadLocations()
  }, [loadOrders, loadPackings, loadLocations])

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId)
  }, [selectedId, loadDetail])

  const refreshAll = async () => {
    loadOrders()
    loadPackings()
    if (selectedId) await loadDetail(selectedId)
  }

  /** 扫码装入/补码（A-T14-3/5）：按当前行类型自动选择命令 */
  const onScan = async (code: string) => {
    if (!detail || !activeLineId) {
      setError({ title: $t('请先选择发货单与备货行') })
      return
    }
    const line = detail.lines.find((l) => l.lineId === activeLineId)
    if (!line) return
    setActionBusy(true)
    setError(null)
    setNotice(null)
    try {
      const isPlain = line.lineKind === 'plain_item'
      const result = isPlain
        ? await api.shippingScanSupplement({ plantId: detail.plantId, shipmentOrderId: detail.orderId, lineId: line.lineId, unitNo: code })
        : await api.shippingScanLoad({ plantId: detail.plantId, shipmentOrderId: detail.orderId, lineId: line.lineId, unitNo: code })
      const data = (result.data ?? {}) as { scannedCount?: number; requiredCount?: number; lineStatus?: string; orderStatus?: string }
      await refreshAll()
      setNotice(
        $t('{p0}成功：{p1}｜行进度 {p2}/{p3}（{p4}）｜单状态 {p5}', { p0: isPlain ? $t('补码') : $t('装入'), p1: code, p2: data.scannedCount ?? '?', p3: data.requiredCount ?? '?', p4: data.lineStatus === 'packed' ? $t('已装箱') : $t('待装箱'), p5: data.orderStatus === 'ready_to_ship' ? $t('待出库') : data.orderStatus === 'shipped' ? $t('已出库') : $t('待装箱') }),
      )
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('扫码装入失败') })
    } finally {
      setActionBusy(false)
    }
  }

  const deleteScan = async (scanId: string) => {
    if (!detail) return
    setActionBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.shippingScanDelete({ plantId: detail.plantId, shipmentOrderId: detail.orderId, scanId })
      const data = (result.data ?? {}) as { scannedCount?: number; lineStatus?: string; orderStatus?: string }
      await refreshAll()
      setNotice($t('删码完成（行退回 {p0}；单 {p1}）', { p0: data.lineStatus === 'packed' ? '已装箱' : '待装箱', p1: data.orderStatus === 'ready_to_ship' ? '待出库' : '待装箱' }))
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('删码失败') })
    } finally {
      setActionBusy(false)
    }
  }

  const createPacking = async () => {
    if (!detail) return
    const [toLocationId, toLocationCode] = toLocation.split('|')
    setActionBusy(true)
    setError(null)
    try {
      const result = await api.packingCreate({
        plantId: detail.plantId,
        shipmentOrderId: detail.orderId,
        palletCode: palletCode.trim(),
        toLocationId,
        toLocationCode,
      })
      const data = (result.data ?? {}) as { packingNo?: string; linkedLines?: string[] }
      setPackingFormOpen(false)
      await refreshAll()
      setNotice($t('打包任务已创建（{p0}，挂接托盘行 {p1} 条；逐行扫满后绑定托码）', { p0: data.packingNo ?? '', p1: data.linkedLines?.length ?? 0 }))
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('创建打包任务失败') })
    } finally {
      setActionBusy(false)
    }
  }

  const bindPallet = async (packingId: string) => {
    if (!detail) return
    setActionBusy(true)
    setError(null)
    try {
      const result = await api.packingBind({ plantId: detail.plantId, packingOrderId: packingId })
      const data = (result.data ?? {}) as { status?: string; palletCode?: string }
      await refreshAll()
      setNotice(data.status === 'bound' ? $t('托码 {p0} 已绑定（打包完成；已打包托码库位只读）', { p0: data.palletCode ?? '' }) : $t('绑定返回 {p0}', { p0: data.status ?? '—' }))
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('绑定托码失败') })
    } finally {
      setActionBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('备货工作台')}>
        <Message kind="warning" title={$t('没有发运查询许可（shipping.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('备货工作台')}
      description={$t('三类行扫码备货（A-T14-3 五拒一成：未审核/存疑/被锁定/未关联行/无段长拒收；行扫满→已装箱）＋补码（A-T14-5 无轴行）＋打包绑定托码（A-T14-4）')}
      actions={
        <>
          <Select
            style={{ width: 240 }}
            aria-label={$t('选择发货单')}
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            options={[
              { value: '', label: $t('选择待备货发货单…') },
              ...orders.map((o) => ({ value: o.orderId, label: $t('{p0}（{p1}）', { p0: o.plNo, p1: o.statusLabel }) })),
            ]}
          />
          {canPost && detail && detail.status !== 'shipped' ? (
            <Button size="sm" variant="secondary" onClick={() => setPackingFormOpen(true)}>
              {$t('创建打包任务')}
            </Button>
          ) : null}
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      {!detail ? (
        <Message kind="info" title={$t('选择待备货发货单')}>
          {orders.length === 0
            ? $t('当前无待装箱/待出库发货单（可从「发货单列表」模拟入站）')
            : orders.map((o) => `${o.plNo}（${o.statusLabel}）`).join('；')}
        </Message>
      ) : (
        <>
          <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>
            {detail.plNo}{$t('（')}{detail.statusLabel}{$t('）｜')}{detail.salesOrderNo}
            {detail.compositionMissing ? <Badge tone="warning">{$t('缺组成')}</Badge> : null}
          </h3>

          {/* 扫码区（装入/补码；PC-03 按钮与回车同入口） */}
          {canPost && detail.status !== 'shipped' ? (
            <section style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 12, background: 'var(--cz-color-bg-surface)', marginBottom: 14 }}>
              <Field label={$t('扫入目标行（托盘/有轴行=扫码装入；无轴行=补码登记）')} required>
                <Select
                  aria-label={$t('扫入目标行选择')}
                  value={activeLineId}
                  onChange={(e) => setActiveLineId(e.target.value)}
                  options={detail.lines.map((l) => ({
                    value: l.lineId,
                    label: `行${l.lineNo} ${SHIPMENT_LINE_KIND_LABELS[l.lineKind] ?? l.lineKind} ${l.materialCode}（${l.scannedCount}/${l.requiredCount}）`,
                    disabled: l.scannedCount >= l.requiredCount,
                  }))}
                />
              </Field>
              <div style={{ marginTop: 8 }}>
                <ScanInput
                  onScan={(code) => void onScan(code)}
                  hint={
                    (detail.lines.find((l) => l.lineId === activeLineId)?.lineKind ?? '') === 'plain_item'
                      ? $t('无轴行补码（A-T14-5）：扫描/输入产品轴号登记，计入已扫件数；演示码：SHPU-OK-002')
                      : $t('扫码装入（A-T14-3 五拒一成）；演示码：SHPU-OK-001（合格）、SHPU-PEND-001（待检拒）、SHPU-SUS-001（存疑拒）、SHPU-LOCK-001（锁定拒）')
                  }
                  buttonLabel={detail.lines.find((l) => l.lineId === activeLineId)?.lineKind === 'plain_item' ? $t('补码') : $t('装入')}
                  disabled={actionBusy}
                />
              </div>
            </section>
          ) : null}

          {/* 三类行进度 */}
          <table className="cz-table" aria-label={$t('备货行进度')} style={{ width: '100%' }}>
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
                <tr key={line.lineId} style={line.lineId === activeLineId ? { background: 'var(--cz-color-bg-hover)' } : undefined}>
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

          {/* 扫码记录（删码入口） */}
          <h4 style={{ fontSize: 13.5, margin: '14px 0 6px' }}>{$t('扫码记录（删码不满足退回待装箱，A-T14-3）')}</h4>
          <table className="cz-table" aria-label={$t('工作台扫码记录')} style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>{$t('码')}</th>
                <th>{$t('行')}</th>
                <th>{$t('种类')}</th>
                <th>{$t('实际段长')}</th>
                <th>{$t('扫码人/时间')}</th>
                <th>{$t('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.scans.length === 0 ? (
                <tr>
                  <td className="cz-table__empty" colSpan={6}>{$t('暂无扫码记录')}</td>
                </tr>
              ) : (
                detail.scans.map((scan) => {
                  const line = detail.lines.find((l) => l.lineId === scan.shipmentLineId)
                  return (
                    <tr key={scan.scanId} style={scan.deleted ? { opacity: 0.55 } : undefined}>
                      <td>{scan.unitNo}</td>
                      <td>{line ? $t('行{p0}', { p0: line.lineNo }) : scan.shipmentLineId}</td>
                      <td>{scan.scanKind === 'supplement' ? $t('补码') : $t('装入')}</td>
                      <td>{scan.actualSegmentLength ?? '—'}</td>
                      <td>{scan.scannedBy}{$t('｜')}{scan.scannedAt.slice(0, 16).replace('T', ' ')}</td>
                      <td>
                        {scan.deleted ? (
                          <span>{$t('已删码')}</span>
                        ) : canPost && detail.status !== 'shipped' ? (
                          <Button size="sm" variant="secondary" loading={actionBusy} onClick={() => void deleteScan(scan.scanId)}>
                            {$t('删码')}
                          </Button>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>

          {/* 本单打包任务 */}
          {detail.packings.length > 0 ? (
            <>
              <h4 style={{ fontSize: 13.5, margin: '14px 0 6px' }}>{$t('本单打包任务（扫满后绑定托码）')}</h4>
              <table className="cz-table" aria-label={$t('本单打包任务')} style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>{$t('打包号')}</th>
                    <th>{$t('托码')}</th>
                    <th>{$t('调入库位')}</th>
                    <th>{$t('行进度')}</th>
                    <th>{$t('状态')}</th>
                    <th>{$t('操作')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.packings.map((pk) => (
                    <tr key={pk.packingId}>
                      <td>{pk.packingNo}</td>
                      <td>{pk.palletCode}</td>
                      <td>{pk.toLocationCode ?? '—'}</td>
                      <td>
                        {pk.lines.map((l) => `${l.lineNo}:${l.scannedCount}/${l.requiredCount}`).join('；') || '—'}
                      </td>
                      <td>
                        <Badge tone={pk.status === 'bound' ? 'success' : 'info'}>{pk.statusLabel}</Badge>
                      </td>
                      <td>
                        {canPost && pk.status === 'pending' ? (
                          <Button size="sm" variant="secondary" loading={actionBusy} onClick={() => void bindPallet(pk.packingId)}>
                            {$t('绑定托码')}
                          </Button>
                        ) : (
                          <span>{pk.status === 'bound' ? $t('只读') : '—'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </>
      )}

      {/* 打包看板 */}
      <h3 style={{ fontSize: 15, margin: '18px 0 8px' }}>{$t('打包看板（托码+调入库位+逐行扫满+绑定状态）')}</h3>
      <table className="cz-table" aria-label={$t('打包看板')} style={{ width: '100%' }}>
        <thead>
          <tr>
            <th>{$t('打包号')}</th>
            <th>{$t('发货单')}</th>
            <th>{$t('托码')}</th>
            <th>{$t('调入库位')}</th>
            <th>{$t('行进度')}</th>
            <th>{$t('状态')}</th>
            <th>{$t('绑定人/时间')}</th>
          </tr>
        </thead>
        <tbody>
          {packings.length === 0 ? (
            <tr>
              <td className="cz-table__empty" colSpan={7}>{$t('暂无打包任务')}</td>
            </tr>
          ) : (
            packings.map((pk) => (
              <tr key={pk.packingId}>
                <td>{pk.packingNo}</td>
                <td>{orders.find((o) => o.orderId === pk.shipmentOrderId)?.plNo ?? pk.shipmentOrderId}</td>
                <td>{pk.palletCode}</td>
                <td>{pk.toLocationCode ?? '—'}</td>
                <td>{pk.lines.map((l) => `${l.lineNo}:${l.scannedCount}/${l.requiredCount}`).join('；') || '—'}</td>
                <td>
                  <Badge tone={pk.status === 'bound' ? 'success' : 'info'}>{pk.statusLabel}</Badge>
                </td>
                <td>{pk.boundBy ? $t('{p0}｜{p1}', { p0: pk.boundBy, p1: (pk.boundAt ?? '').slice(0, 16).replace('T', ' ') }) : '—'}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* 打包任务创建（先扫托码+选调入库位） */}
      {packingFormOpen && detail ? (
        <section style={{ marginTop: 14, border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 12, background: 'var(--cz-color-bg-surface)' }}>
          <h4 style={{ fontSize: 14, margin: '0 0 8px' }}>{$t('创建打包任务（')}{detail.plNo}{$t('；至少一条托盘行）')}</h4>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label={$t('托码（先扫托码）')} required>
              <Input style={{ width: 200 }} value={palletCode} onChange={(e) => setPalletCode(e.target.value)} />
            </Field>
            <Field label={$t('调入库位（货架码+层数拼位）')} required>
              <Select
                style={{ width: 200 }}
                aria-label={$t('调入库位选择')}
                value={toLocation}
                onChange={(e) => setToLocation(e.target.value)}
                options={locationOptions}
              />
            </Field>
            <Button size="sm" loading={actionBusy} onClick={() => void createPacking()}>
              {$t('创建（挂接未打包托盘行）')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setPackingFormOpen(false)}>
              {$t('取消')}
            </Button>
          </div>
        </section>
      ) : null}
    </PageContainer>
  )
}
