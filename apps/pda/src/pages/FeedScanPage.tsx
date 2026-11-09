import { ApiError, Badge, Button, Field, Input, Message, PageContainer, ScanInput, Select, formatErrorTitleAndDetail, type CommandIntent, type OrderOperationDto, type ProductionOrderDto, t as $t } from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { EXECUTION_FEED, usePermissions } from '../permissions'

interface FeedLine { key: number; barcodeValue: string; quantity: string }
let lineSeq = 1
const SLOT = 'pda.feed'
function axisError(code: string) { return code.length !== 10 || !'EFM'.includes(code[1] ?? '') ? $t('[A7-2] 不是产品轴码（托码/原料码拒绝）') : null }

export function FeedScanPage() {
  const { has } = usePermissions()
  const canFeed = has(EXECUTION_FEED)
  const [orders, setOrders] = useState<ProductionOrderDto[]>([])
  const [operations, setOperations] = useState<OrderOperationDto[]>([])
  const [orderId, setOrderId] = useState('')
  const [orderOperationId, setOrderOperationId] = useState('')
  const [lines, setLines] = useState<FeedLine[]>([])
  const [intent, setIntent] = useState<CommandIntent | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const frozen = busy || !ready || intent !== null
  const showError = (err: unknown) => setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: err instanceof Error ? err.message : $t('操作失败') })

  useEffect(() => {
    let active = true
    void api.readCommandIntent(SLOT).then(saved => {
      if (!active) return
      setIntent(saved)
      if (saved) {
        setOrderId(String(saved.payload['orderId'] ?? ''))
        setOrderOperationId(String(saved.payload['orderOperationId'] ?? ''))
        const feeds = saved.payload['feeds'] as Array<{ barcodeValue: string; quantity: string }>
        setLines(feeds.map(line => ({ ...line, key: lineSeq++ })))
      }
      setReady(true)
    }).catch(err => { if (active) showError(err) })
    void api.listProductionOrders({ page: 1, pageSize: 100, statuses: 'in_progress' }).then(result => { if (active) setOrders(result.items) }).catch(err => { if (active) showError(err) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true
    setOperations([])
    if (orderId) void api.productionOrderDetail(orderId).then(detail => { if (active) setOperations(detail.operations) }).catch(err => { if (active) showError(err) })
    return () => { active = false }
  }, [orderId])

  async function settle() {
    if (!intent) return
    setBusy(true)
    try {
      await api.clearSettledCommandIntent(SLOT, intent.operationId)
      if (intent.state === 'committed') { setLines([]); setOrderId(''); setOrderOperationId('') }
      setIntent(null); setError(null)
    } catch (err) { showError(err) } finally { setBusy(false) }
  }
  async function submit() {
    if (!ready || busy) return
    if (!intent && (!orderId || !orderOperationId || !operations.some(op => op.id === orderOperationId))) { setError({ title: $t('请选择实际订单和投料工序') }); return }
    if (!intent && (lines.length === 0 || lines.some(l => axisError(l.barcodeValue) || !l.quantity.trim() || !(Number(l.quantity) > 0)))) { setError({ title: $t('请填写有效产品轴码及正数量') }); return }
    setBusy(true); setError(null)
    try {
      const payload = intent?.payload ?? { orderId, orderOperationId, feeds: lines.map(l => ({ barcodeValue: l.barcodeValue, quantity: l.quantity.trim() })) }
      const result = await api.executeCommandIntent(SLOT, 'feed', payload)
      setIntent(await api.readCommandIntent(SLOT))
      setNotice($t('原操作已确认完成') + ' ' + result.operationId)
    } catch (err) {
      showError(err)
      try { setIntent(await api.readCommandIntent(SLOT)) } catch { setReady(false) }
    } finally { setBusy(false) }
  }
  return <PageContainer title={$t('投料扫码')} description={$t('选择订单和工序，销售归属由服务端根据实物来源核验')}>
    {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
    {notice ? <Message kind="success" title={notice} /> : null}
    {intent ? <Message kind="info" title={intent.state === 'committed' ? $t('已确认完成，请开始新作业') : intent.state === 'rejected' ? $t('已明确拒绝，可确认编辑为新操作') : $t('原操作结果待确认：保留原键和载荷重试')} detail={intent.operationId} /> : null}
    <fieldset disabled={frozen} style={{ border: 0, padding: 0, margin: 0 }}>
      <Field label={$t('生产订单')} required><Select value={orderId} onChange={e => { setOrderId(e.target.value); setOrderOperationId(''); setLines([]) }} placeholder={$t('选择订单')} options={orders.map(o => ({ value: o.id, label: o.orderNo }))} /></Field>
      <Field label={$t('投料工序')} required><Select value={orderOperationId} onChange={e => { setOrderOperationId(e.target.value); setLines([]) }} placeholder={$t('选择工序')} options={operations.map(op => ({ value: op.id, label: `${op.seq}. ${op.operationName}` }))} /></Field>
      <ScanInput onScan={code => { if (!frozen) { setNotice(null); setLines(prev => [...prev, { key: lineSeq++, barcodeValue: code, quantity: '' }]) } }} hint={$t('扫描本次实际产品轴码')} />
      {lines.map(line => <div key={line.key} style={{ marginTop: 10 }}>
        <code>{line.barcodeValue}</code>
        <Input value={line.quantity} onChange={e => setLines(prev => prev.map(l => l.key === line.key ? { ...l, quantity: e.target.value } : l))} aria-label={$t('数量')} />
        <Button variant="ghost" onClick={() => setLines(prev => prev.filter(l => l.key !== line.key))}>{$t('移除')}</Button>
        {axisError(line.barcodeValue) ? <div role="alert">{axisError(line.barcodeValue)}</div> : null}
      </div>)}
    </fieldset>
    {intent?.state === 'committed' || intent?.state === 'rejected'
      ? <Button loading={busy} onClick={() => void settle()}>{intent.state === 'committed' ? $t('开始新作业') : $t('确认编辑为新操作')}</Button>
      : <Button block size="lg" loading={busy} disabled={!canFeed || !ready || busy || (!intent && lines.length === 0)} onClick={() => void submit()}>{intent ? $t('以原操作键确认结果') : $t('提交投料')}</Button>}
    {!canFeed ? <Badge tone="warning">{$t('需 execution.feed 许可')}</Badge> : null}
  </PageContainer>
}
