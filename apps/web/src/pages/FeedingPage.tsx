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
  formatErrorTitleAndDetail,
  type CommandIntent,
  type OrderOperationDto,
  type ProductionOrderDto,
  t as $t,
  tx as $tx,
} from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { EXECUTION_FEED, PROCESS_READ, usePermissions } from '../permissions'

interface FeedLine {
  key: number
  barcodeValue: string
  quantity: string
  crossOrderConfirmed: boolean
  deviationReason: string
  /** 前端码准入预检错误（逐行渲染；服务端仍终校） */
  localError: string | null
}

let lineSeq = 1
const SLOT = 'web.feed'

/** [A7-2] 展示层镜像：产品轴码（10 位第 2 位 E/F/M；托码/原料码拒绝） */
function productAxisError(code: string): string | null {
  if (code.length !== 10 || !'EFM'.includes(code[1] ?? '')) {
    return $t('[A7-2] 不是产品轴码（10 位载具码第 2 位 E/F/M）——托码/原料码拒绝，请扫产品轴码')
  }
  return null
}

/** 码准入链（链序固定，[底稿 A7-2]；前端逐条预检 + 服务端终校） */
const ADMISSION_CHAIN = [
  '产品轴码格式（10 位第 2 位 E/F/M）',
  '码存在于二维码档案',
  '有销售单号＋行号归属',
  '已审批或质检完成',
  '单元在库',
  '所在仓库存（有活动余额）',
  '所在库位为线边库',
  '非成品（成品不可消耗）',
  '非本工序产出',
  '本订单半成品须为前道产出',
  '可投数量 > 0',
]

interface FeedResultLine {
  unitNo: string
  quantity: string
  beforeQty: string
  afterQty: string
  salesOrderNo: string | null
  salesLineNo: string | null
  salesLineRemainder?: string
}

/**
 * 投料页（[底稿 A7] 单独投料：扫码输入 → 码准入链 → 实时扣减）：
 * - 扫码输入（ScanInput 楔入模式，PC-03/05/09）；每行产品轴码格式前端预检、逐行错误渲染；
 * - 码准入链以链序展示（第一步失败即拒绝；服务端错误原文渲染到对应行/主错误区）；
 * - 跨订单（[A7-3]）：行级显式确认 + 偏离原因；销售行余量（[A7-4]）在提交结果中展示扣前/扣后。
 */
export function FeedingPage() {
  const { has } = usePermissions()
  const canFeed = has(EXECUTION_FEED)
  const canReadOrders = has(PROCESS_READ)
  const [orders, setOrders] = useState<ProductionOrderDto[]>([])
  const [orderId, setOrderId] = useState('')
  const [operations, setOperations] = useState<OrderOperationDto[]>([])
  const [orderOperationId, setOrderOperationId] = useState('')
  const [lines, setLines] = useState<FeedLine[]>([])
  const [busy, setBusy] = useState(false)
  const [intent, setIntent] = useState<CommandIntent | null>(null)
  const [ready, setReady] = useState(false)
  const frozen = busy || !ready || intent !== null
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [resultLines, setResultLines] = useState<FeedResultLine[]>([])

  useEffect(() => {
    let active = true
    void api.readCommandIntent(SLOT).then(saved => {
      if (!active) return
      setIntent(saved)
      if (saved) {
        setOrderId(String(saved.payload['orderId'] ?? ''))
        setOrderOperationId(String(saved.payload['orderOperationId'] ?? ''))
        const feeds = saved.payload['feeds'] as Array<{ barcodeValue: string; quantity: string; confirmed?: boolean; deviationReason?: string }>
        setLines(feeds.map(l => ({ key: lineSeq++, barcodeValue: l.barcodeValue, quantity: l.quantity, crossOrderConfirmed: l.confirmed ?? false, deviationReason: l.deviationReason ?? '', localError: null })))
      }
      setReady(true)
    }).catch(err => { if (active) setError({ title: err instanceof Error ? err.message : $t('无法读取原操作') }) })
    return () => { active = false }
  }, [])
  async function settleIntent() {
    if (!intent) return
    setBusy(true)
    try {
      await api.clearSettledCommandIntent(SLOT, intent.operationId)
      if (intent.state === 'committed') { setLines([]); setOrderId(''); setOrderOperationId(''); setResultLines([]) }
      setIntent(null); setError(null)
    } catch (err) { setError({ title: err instanceof Error ? err.message : $t('原操作不能清除') }) }
    finally { setBusy(false) }
  }

  useEffect(() => {
    if (!canReadOrders) return
    api
      .listProductionOrders({ page: 1, pageSize: 50, statuses: 'in_progress' })
      .then((result) => setOrders(result.items))
      .catch(() => setOrders([]))
  }, [canReadOrders])

  useEffect(() => {
    let active = true
    setOperations([])
    if (orderId) void api.productionOrderDetail(orderId).then(detail => { if (active) setOperations(detail.operations) }).catch(() => { if (active) setOperations([]) })
    return () => { active = false }
  }, [orderId])

  const addLine = (barcode: string) => {
    if (frozen) return
    setNotice(null)
    setResultLines([])
    setLines((prev) => [
      ...prev,
      {
        key: lineSeq++,
        barcodeValue: barcode,
        quantity: '',
        crossOrderConfirmed: false,
        deviationReason: '',
        localError: productAxisError(barcode),
      },
    ])
  }

  const submitFeeds = async () => {
    if (!ready || busy) return
    if (!intent && (!orderId || !orderOperationId || !operations.some(op => op.id === orderOperationId))) {
      setError({ title: $t('请选择订单与投料工序（[A7-1] 工序单选、质检工序不可选）') })
      return
    }
    if (!intent && lines.length === 0) {
      setError({ title: $t('投料提交至少一行（一次提交一批）') })
      return
    }
    if (!intent && lines.some((l) => !l.quantity.trim() || !(Number(l.quantity) > 0))) {
      setError({ title: $t('每行投料数量必须大于 0') })
      return
    }
    if (!intent && lines.some((l) => l.localError !== null)) {
      setError({ title: $t('存在未通过码准入预检的行（见行内错误，逐条处理后重试）') })
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api.executeCommandIntent(SLOT, 'feed', intent?.payload ?? {
        orderId,
        orderOperationId,
        feeds: lines.map((l) => ({
          barcodeValue: l.barcodeValue,
          quantity: l.quantity.trim(),
          confirmed: l.crossOrderConfirmed || undefined,
          deviationReason: l.deviationReason.trim() || undefined,
        })),
      })
      const data = (result.data ?? {}) as { lines?: FeedResultLine[] }
      setResultLines(data.lines ?? [])
      setNotice($t('原操作已确认完成') + ' ' + result.operationId)
      setIntent(await api.readCommandIntent(SLOT))
    } catch (err) {
      const shaped = err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('投料失败') }
      setError(shaped)
      try { setIntent(await api.readCommandIntent(SLOT)) } catch { setReady(false) }
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageContainer
      title={$t('投料')}
      description={$t('单独投料（[A7]）：扫码后直接提交即扣减；码准入链第一步失败即拒绝（链序见下）；跨订单需行级确认+偏离原因（[A7-3]）')}
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      {intent ? <Message kind="info" title={intent.state === 'committed' ? $t('已确认完成，请开始新作业') : intent.state === 'rejected' ? $t('已明确拒绝，可确认编辑为新操作') : $t('原操作结果待确认，保留原键和载荷')} detail={intent.operationId} /> : null}
      <fieldset disabled={frozen} style={{ border: 0, padding: 0, margin: 0 }}>
      <section style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('扫码输入（扫码枪楔入 / 手输回车 / 按钮同一入口 PC-03）')}</h3>
        <ScanInput onScan={addLine} hint={$t('扫描本次实际产品轴码，销售归属由服务端核验')} />
      </section>

      <section aria-label={$t('码准入链')} style={{ marginBottom: 16, border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 12, background: 'var(--cz-color-bg-surface)' }}>
        <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>{$t('码准入链（[A7-2] 链序固定，逐条校验）')}</h3>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--cz-color-text-secondary)', lineHeight: 1.9 }}>
          {ADMISSION_CHAIN.map((step) => (
            <li key={step}>{$tx(step)}</li>
          ))}
        </ol>
      </section>

      <section style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <Field label={$t('生产订单（进行中）')} required>
          <Select
            style={{ width: 280 }}
            value={orderId}
            onChange={(e) => {
              setOrderId(e.target.value)
              setOrderOperationId('')
              setLines([])
            }}
            placeholder={$t('选择订单')}
            options={orders.map((o) => ({ value: o.id, label: o.orderNo }))}
          />
        </Field>
        <Field label={$t('投料工序')} required hint={$t('质检工序不可选（[A6-3]，服务端终校）')}>
          <Select
            style={{ width: 200 }}
            value={orderOperationId}
            onChange={(e) => { setOrderOperationId(e.target.value); setLines([]) }}
            placeholder={$t('选择工序')}
            options={operations.map((op) => ({ value: op.id, label: `${op.seq}. ${op.operationName}` }))}
          />
        </Field>
      </section>

      <section aria-label={$t('投料行')}>
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('投料行（')}{lines.length} {$t('行）')}</h3>
        {lines.length === 0 ? (
          <Message kind="info" title={$t('尚未扫码；扫码后逐行填写数量，销售归属由服务端解析')} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {lines.map((line) => (
              <div key={line.key} style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 12, background: line.localError ? 'rgba(200,60,50,0.05)' : 'var(--cz-color-bg-surface)' }}>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <Field label={$t('产品轴码')}>
                    <Input
                      style={{ width: 150 }}
                      value={line.barcodeValue}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((l) =>
                            l.key === line.key ? { ...l, barcodeValue: e.target.value, localError: productAxisError(e.target.value) } : l,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label={$t('数量')} required>
                    <Input style={{ width: 110 }} value={line.quantity} onChange={(e) => setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, quantity: e.target.value } : l)))} placeholder={$t('如 50.0000')} />
                  </Field>
                  <Field label={$t('跨订单确认（[A7-3]）')}>
                    <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 13, paddingBottom: 8 }}>
                      <input type="checkbox" checked={line.crossOrderConfirmed} onChange={(e) => setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, crossOrderConfirmed: e.target.checked } : l)))} />
                      {$t('确认跨订单')}
                    </label>
                  </Field>
                  <Field label={$t('偏离原因')}>
                    <Input style={{ width: 160 }} value={line.deviationReason} onChange={(e) => setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, deviationReason: e.target.value } : l)))} placeholder={$t('跨订单必填')} />
                  </Field>
                  <Button size="sm" variant="ghost" onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}>
                    {$t('移除')}
                  </Button>
                </div>
                {line.localError ? (
                  <div role="alert" style={{ marginTop: 8, fontSize: 13, color: 'var(--cz-color-danger, #b42318)' }}>
                    {line.localError}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
      </fieldset>
      {intent?.state === 'committed' || intent?.state === 'rejected'
        ? <Button loading={busy} onClick={() => void settleIntent()}>{intent.state === 'committed' ? $t('开始新作业') : $t('确认编辑为新操作')}</Button>
        : <Button loading={busy} disabled={!canFeed || !ready || busy} onClick={() => void submitFeeds()}>{intent ? $t('以原操作键确认结果') : $t('提交投料（实时扣减）')}</Button>}
      {!canFeed ? <Badge tone="warning">{$t('需 execution.feed 许可')}</Badge> : null}

      {resultLines.length > 0 ? (
        <section aria-label={$t('投料结果与销售行余量')} style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('投料结果（[A7-4] 扣前/扣后 + 销售行余量）')}</h3>
          <div className="cz-table-wrap">
            <table className="cz-table">
              <thead>
                <tr>
                  <th>{$t('库存单元')}</th>
                  <th>{$t('投料数量')}</th>
                  <th>{$t('扣前余额')}</th>
                  <th>{$t('扣后余额')}</th>
                  <th>{$t('销售行')}</th>
                  <th>{$t('销售行剩余可投')}</th>
                </tr>
              </thead>
              <tbody>
                {resultLines.map((line, i) => (
                  <tr key={i}>
                    <td>{line.unitNo}</td>
                    <td>{line.quantity}</td>
                    <td>{line.beforeQty}</td>
                    <td>
                      <b>{line.afterQty}</b>
                    </td>
                    <td>{line.salesOrderNo ? $t('{p0}｜{p1}', { p0: line.salesOrderNo, p1: line.salesLineNo }) : '—'}</td>
                    <td>{line.salesLineRemainder ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </PageContainer>
  )
}
