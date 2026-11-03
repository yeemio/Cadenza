import {
  ApiError,
  Badge,
  Button,
  Message,
  PageContainer,
  ScanInput,
  Select,
  SHIPMENT_LINE_KIND_LABELS,
  formatErrorTitleAndDetail,
  type ShipmentOrderDetailDto,
  t as $t,
  tx as $tx,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { SHIPPING_POST, usePermissions } from '../permissions'

/**
 * PDA 扫码备货页（发运 Tab 主页；A-T14-3/4/5）：
 * 选发货单 → 选行（三类）→ 扫码装入（五拒一成）/无轴行补码 → 行扫满流转；
 * 打包任务创建（先扫托码+选调入库位）与绑定在「打包绑定」折叠区。
 */
export function ShippingScanPage() {
  const { has } = usePermissions()
  const canPost = has(SHIPPING_POST)
  const [orders, setOrders] = useState<Array<{ orderId: string; plNo: string; statusLabel: string }>>([])
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<ShipmentOrderDetailDto | null>(null)
  const [activeLineId, setActiveLineId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 打包（简化：托码 + 固定调入库位演示选项）
  const [packingOpen, setPackingOpen] = useState(false)
  const [palletCode, setPalletCode] = useState('PLT-2026-P01')
  const [toLocation, setToLocation] = useState('loc-01030001|01030001')

  const loadOrders = useCallback(() => {
    api
      .listShipmentOrders({ page: 1, pageSize: 20, statuses: 'pending_packing,ready_to_ship' })
      .then((result) => setOrders(result.items.map((o) => ({ orderId: o.orderId, plNo: o.plNo, statusLabel: o.statusLabel }))))
      .catch(() => setOrders([]))
  }, [])

  const loadDetail = useCallback(async (orderId: string) => {
    if (!orderId) {
      setDetail(null)
      return
    }
    try {
      const view = await api.shipmentDetail(orderId)
      setDetail(view)
      setActiveLineId((prev) => (view.lines.some((l) => l.lineId === prev) ? prev : view.lines[0]?.lineId ?? ''))
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载发货单失败') })
    }
  }, [])

  useEffect(() => {
    loadOrders()
  }, [loadOrders])

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId)
  }, [selectedId, loadDetail])

  const refresh = async () => {
    loadOrders()
    if (selectedId) await loadDetail(selectedId)
  }

  const onScan = async (code: string) => {
    if (!detail || !activeLineId) {
      setError({ title: $t('请先选择发货单与备货行') })
      return
    }
    const line = detail.lines.find((l) => l.lineId === activeLineId)
    if (!line) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const isPlain = line.lineKind === 'plain_item'
      const result = isPlain
        ? await api.shippingScanSupplement({ plantId: detail.plantId, shipmentOrderId: detail.orderId, lineId: line.lineId, unitNo: code })
        : await api.shippingScanLoad({ plantId: detail.plantId, shipmentOrderId: detail.orderId, lineId: line.lineId, unitNo: code })
      const data = (result.data ?? {}) as { scannedCount?: number; requiredCount?: number; lineStatus?: string; orderStatus?: string }
      setNotice(
        $t('{p0}成功 {p1}：{p2}/{p3}（{p4}；单{p5}）', { p0: isPlain ? $t('补码') : $t('装入'), p1: code, p2: data.scannedCount ?? '?', p3: data.requiredCount ?? '?', p4: data.lineStatus === 'packed' ? $t('行已装箱') : $t('行待装箱'), p5: data.orderStatus === 'ready_to_ship' ? $t('待出库') : $t('待装箱') }),
      )
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('扫码失败') })
    } finally {
      setBusy(false)
    }
  }

  const deleteScan = async (scanId: string) => {
    if (!detail) return
    setBusy(true)
    setError(null)
    try {
      await api.shippingScanDelete({ plantId: detail.plantId, shipmentOrderId: detail.orderId, scanId })
      setNotice($t('删码完成（行退回待装箱口径）'))
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('删码失败') })
    } finally {
      setBusy(false)
    }
  }

  const createPacking = async () => {
    if (!detail) return
    const [toLocationId, toLocationCode] = toLocation.split('|')
    setBusy(true)
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
      setNotice($t('打包任务 {p0} 已创建（挂 {p1} 条托盘行；扫满后绑定）', { p0: data.packingNo ?? '', p1: data.linkedLines?.length ?? 0 }))
      setPackingOpen(false)
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('创建打包任务失败') })
    } finally {
      setBusy(false)
    }
  }

  const bindPallet = async (packingId: string) => {
    if (!detail) return
    setBusy(true)
    setError(null)
    try {
      await api.packingBind({ plantId: detail.plantId, packingOrderId: packingId })
      setNotice($t('托码已绑定（打包完成；已打包托码库位只读）'))
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('绑定失败') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageContainer title={$t('发运备货')} description={$t('选单→选行→扫码装入（A-T14-3 五拒一成）/无轴补码（A-T14-5）；行扫满→已装箱')}>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}
      <Select
        aria-label={$t('选择发货单')}
        value={selectedId}
        onChange={(e) => setSelectedId(e.target.value)}
        options={[{ value: '', label: $t('选择待备货发货单…') }, ...orders.map((o) => ({ value: o.orderId, label: $t('{p0}（{p1}）', { p0: o.plNo, p1: o.statusLabel }) }))]}
      />
      {detail ? (
        <>
          <p style={{ fontSize: 13.5, margin: '10px 0 6px' }}>
            <b>{detail.plNo}</b>{$t('（')}{detail.statusLabel}{$t('）')}{detail.compositionMissing ? <Badge tone="warning">{$t('缺组成')}</Badge> : null}
          </p>
          {canPost && detail.status !== 'shipped' ? (
            <>
              <Select
                aria-label={$t('备货行选择')}
                value={activeLineId}
                onChange={(e) => setActiveLineId(e.target.value)}
                options={detail.lines.map((l) => ({
                  value: l.lineId,
                  label: $t('行{p0} {p1} {p2} {p3}/{p4}', { p0: l.lineNo, p1: $tx(SHIPMENT_LINE_KIND_LABELS[l.lineKind]) ?? l.lineKind, p2: l.materialCode, p3: l.scannedCount, p4: l.requiredCount }),
                  disabled: l.scannedCount >= l.requiredCount,
                }))}
              />
              <div style={{ marginTop: 8 }}>
                <ScanInput
                  onScan={(code) => void onScan(code)}
                  hint={
                    (detail.lines.find((l) => l.lineId === activeLineId)?.lineKind ?? '') === 'plain_item'
                      ? $t('无轴行补码：扫描产品轴号；演示 SHPU-OK-002')
                      : $t('扫码装入；演示合格 SHPU-OK-001 / 待检拒 SHPU-PEND-001')
                  }
                  buttonLabel={detail.lines.find((l) => l.lineId === activeLineId)?.lineKind === 'plain_item' ? $t('补码') : $t('装入')}
                  disabled={busy}
                />
              </div>
            </>
          ) : null}

          {/* 行进度卡（PC-06：数量+应扫同现） */}
          <section style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {detail.lines.map((line) => (
              <div
                key={line.lineId}
                style={{
                  border: '1px solid var(--cz-color-border)',
                  borderRadius: 8,
                  padding: '8px 10px',
                  background: line.lineId === activeLineId ? 'var(--cz-color-bg-hover)' : 'var(--cz-color-bg-surface)',
                }}
                onClick={() => line.scannedCount < line.requiredCount && setActiveLineId(line.lineId)}
              >
                <span style={{ fontSize: 13.5 }}>
                  {$t('行')}{line.lineNo} {SHIPMENT_LINE_KIND_LABELS[line.lineKind] ?? line.lineKind}{$t('｜')}{line.materialCode}{$t('｜')}
                  <b>{line.scannedCount}</b>/{line.requiredCount}{$t('｜')}
                  {line.lineStatus === 'packed' ? <Badge tone="success">{$t('已装箱')}</Badge> : <Badge>{$t('待装箱')}</Badge>}
                </span>
              </div>
            ))}
          </section>

          {/* 最近扫码（删码） */}
          {detail.scans.filter((s) => !s.deleted).length > 0 ? (
            <section style={{ marginTop: 10 }}>
              <h4 style={{ fontSize: 13, margin: '0 0 6px' }}>{$t('本单已装（可删码）')}</h4>
              {detail.scans
                .filter((s) => !s.deleted)
                .slice(0, 5)
                .map((scan) => (
                  <div key={scan.scanId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 4 }}>
                    <span style={{ flex: 1 }}>
                      {scan.unitNo}{$t('（')}{scan.scanKind === 'supplement' ? $t('补码') : $t('装入')}{$t('）')}
                    </span>
                    {canPost && detail.status !== 'shipped' ? (
                      <Button size="sm" variant="secondary" loading={busy} onClick={() => void deleteScan(scan.scanId)}>
                        {$t('删码')}
                      </Button>
                    ) : null}
                  </div>
                ))}
            </section>
          ) : null}

          {/* 打包（创建/绑定） */}
          {canPost && detail.status !== 'shipped' ? (
            <section style={{ marginTop: 12, borderTop: '1px solid var(--cz-color-border)', paddingTop: 10 }}>
              <h4 style={{ fontSize: 13, margin: '0 0 6px' }}>{$t('打包（A-T14-4：先扫托码+调入库位→扫满→绑定）')}</h4>
              {detail.packings
                .filter((pk) => pk.status === 'pending')
                .map((pk) => (
                  <div key={pk.packingId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 6 }}>
                    <span style={{ flex: 1 }}>
                      {pk.palletCode}→{pk.toLocationCode}{$t('｜')}{pk.lines.map((l) => `${l.scannedCount}/${l.requiredCount}`).join('；')}
                    </span>
                    <Button size="sm" variant="secondary" loading={busy} onClick={() => void bindPallet(pk.packingId)}>
                      {$t('绑定托码')}
                    </Button>
                  </div>
                ))}
              {packingOpen ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <ScanInput onScan={(code) => setPalletCode(code)} hint={$t('扫托码或输入（先扫托码）')} buttonLabel={$t("扫托码")} wedge={false} />
                  <Select
                    aria-label={$t('调入库位选择')}
                    value={toLocation}
                    onChange={(e) => setToLocation(e.target.value)}
                    options={[
                      { value: 'loc-01030001|01030001', label: $t('成品一库 01030001') },
                      { value: 'loc-01030002|01030002', label: $t('成品一库 01030002') },
                    ]}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button block size="lg" loading={busy} onClick={() => void createPacking()}>
                      {$t('创建打包任务')}
                    </Button>
                    <Button size="lg" variant="secondary" onClick={() => setPackingOpen(false)}>
                      {$t('收起')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button block variant="secondary" onClick={() => setPackingOpen(true)}>
                  {$t('新建打包任务（托码')} {palletCode}{$t('）')}
                </Button>
              )}
            </section>
          ) : null}
        </>
      ) : (
        <Message kind="info" title={$t('暂无待备货发货单')}>
          {orders.length === 0 ? $t('等待外部 PL 下发') : orders.map((o) => o.plNo).join('；')}
        </Message>
      )}
      <div style={{ marginTop: 14 }}>
        <Link to="/shipping/outbound" style={{ fontSize: 14, color: 'var(--cz-color-primary)' }}>
          {$t('去出库确认（待出库核对与双回传状态）→')}
        </Link>
      </div>
    </PageContainer>
  )
}
