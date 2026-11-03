import { ApiError, Badge, Button, Field, Input, Message, PageContainer, ScanInput, Select, formatErrorTitleAndDetail, type ProductionOrderDto, t as $t } from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { EXECUTION_FEED, usePermissions } from '../permissions'

interface FeedLine {
  key: number
  barcodeValue: string
  quantity: string
}

let pdaLineSeq = 1

/** [A7-2] 产品轴码预检（10 位第 2 位 E/F/M） */
function axisError(code: string): string | null {
  if (code.length !== 10 || !'EFM'.includes(code[1] ?? '')) {
    return $t('[A7-2] 不是产品轴码（托码/原料码拒绝）')
  }
  return null
}

/**
 * PDA 投料扫码页（[底稿 A7-2] 扫码投料）：
 * 选订单/工序 → 扫产品轴码逐行累计 → 提交（实时扣减；码准入链服务端终校，错误逐行渲染）。
 */
export function FeedScanPage() {
  const { has } = usePermissions()
  const canFeed = has(EXECUTION_FEED)
  const [orders, setOrders] = useState<ProductionOrderDto[]>([])
  const [orderId, setOrderId] = useState('')
  const [orderOperationId, setOrderOperationId] = useState('')
  const [lines, setLines] = useState<FeedLine[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    api
      .listProductionOrders({ page: 1, pageSize: 20, statuses: 'in_progress' })
      .then((result) => setOrders(result.items))
      .catch(() => setOrders([]))
  }, [])

  useEffect(() => {
    if (!orderId) return
    api
      .productionOrderDetail(orderId)
      .then((detail) => setOrderOperationId(detail.operations[0]?.id ?? ''))
      .catch(() => setOrderOperationId(''))
  }, [orderId])

  const submit = async () => {
    if (!orderId || !orderOperationId) {
      setError({ title: $t('请选择订单（工序默认第一道，质检工序不可投料 [A6-3]）') })
      return
    }
    if (lines.length === 0) {
      setError({ title: $t('请先扫码（至少一行）') })
      return
    }
    if (lines.some((l) => !l.quantity.trim())) {
      setError({ title: $t('每行需填写数量') })
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.submitFeed({
        orderId,
        orderOperationId,
        feeds: lines.map((l) => ({ barcodeValue: l.barcodeValue, quantity: l.quantity.trim(), salesOrderNo: 'SO-2026-0301', salesLineNo: '10' })),
      })
      setNotice($t('投料已提交（{p0} 行，实时扣减完成）', { p0: lines.length }))
      setLines([])
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('投料失败') })
      if (err instanceof ApiError) {
        setLines((prev) => prev.map((l) => ((err.message ?? '').includes(l.barcodeValue) ? { ...l, quantity: l.quantity } : l)))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageContainer title={$t('投料扫码')} description={$t('扫产品轴码逐行累计，一次提交一批（[A7-2] 码准入链服务端终校）')}>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
        <Field label={$t('生产订单（进行中）')} required>
          <Select
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            placeholder={$t('选择订单')}
            options={orders.map((o) => ({ value: o.id, label: $t('{p0}（{p1} {p2}）', { p0: o.orderNo, p1: o.productionQty, p2: o.uom }) }))}
          />
        </Field>
      </div>
      <ScanInput
        onScan={(code) => {
          setNotice(null)
          setLines((prev) => [...prev, { key: pdaLineSeq++, barcodeValue: code, quantity: '' }])
        }}
        hint={$t('演示：E5E0000007 可投；托码/非产品轴码将被拒绝')}
      />
      <section style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {lines.map((line) => {
          const local = axisError(line.barcodeValue)
          return (
            <div key={line.key} style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 10, background: local ? 'rgba(200,60,50,0.05)' : 'var(--cz-color-bg-surface)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ fontSize: 14 }}>{line.barcodeValue}</code>
                <Input
                  style={{ width: 110 }}
                  value={line.quantity}
                  onChange={(e) => setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, quantity: e.target.value } : l)))}
                  placeholder={$t('数量')}
                  aria-label={$t('行 {p0} 数量', { p0: line.key })}
                />
                <Button size="sm" variant="ghost" onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}>
                  {$t('移除')}
                </Button>
              </div>
              {local ? (
                <div role="alert" style={{ marginTop: 6, fontSize: 12.5, color: 'var(--cz-color-danger, #b42318)' }}>
                  {local}
                </div>
              ) : null}
            </div>
          )
        })}
      </section>
      <div style={{ marginTop: 12 }}>
        <Button block size="lg" loading={busy} disabled={!canFeed || lines.length === 0} onClick={() => void submit()}>
          {$t('提交投料（')}{lines.length} {$t('行）')}
        </Button>
        {!canFeed ? <Badge tone="warning">{$t('需 execution.feed 许可')}</Badge> : null}
      </div>
    </PageContainer>
  )
}
