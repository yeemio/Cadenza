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
  salesOrderNo: string
  salesLineNo: string
  crossOrderConfirmed: boolean
  deviationReason: string
  /** 前端码准入预检错误（逐行渲染；服务端仍终校） */
  localError: string | null
}

let lineSeq = 1

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
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [resultLines, setResultLines] = useState<FeedResultLine[]>([])

  useEffect(() => {
    if (!canReadOrders) return
    api
      .listProductionOrders({ page: 1, pageSize: 50, statuses: 'in_progress' })
      .then((result) => setOrders(result.items))
      .catch(() => setOrders([]))
  }, [canReadOrders])

  useEffect(() => {
    if (!orderId) {
      setOperations([])
      return
    }
    api
      .productionOrderDetail(orderId)
      .then((detail) => setOperations(detail.operations))
      .catch(() => setOperations([]))
  }, [orderId])

  const addLine = (barcode: string) => {
    setNotice(null)
    setResultLines([])
    setLines((prev) => [
      ...prev,
      {
        key: lineSeq++,
        barcodeValue: barcode,
        quantity: '',
        salesOrderNo: 'SO-2026-0301',
        salesLineNo: '10',
        crossOrderConfirmed: false,
        deviationReason: '',
        localError: productAxisError(barcode),
      },
    ])
  }

  const submitFeeds = async () => {
    if (!orderId || !orderOperationId) {
      setError({ title: $t('请选择订单与投料工序（[A7-1] 工序单选、质检工序不可选）') })
      return
    }
    if (lines.length === 0) {
      setError({ title: $t('投料提交至少一行（一次提交一批）') })
      return
    }
    if (lines.some((l) => !l.quantity.trim() || Number(l.quantity) <= 0)) {
      setError({ title: $t('每行投料数量必须大于 0') })
      return
    }
    if (lines.some((l) => l.localError !== null)) {
      setError({ title: $t('存在未通过码准入预检的行（见行内错误，逐条处理后重试）') })
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api.submitFeed({
        orderId,
        orderOperationId,
        feeds: lines.map((l) => ({
          barcodeValue: l.barcodeValue,
          quantity: l.quantity.trim(),
          salesOrderNo: l.salesOrderNo.trim() || undefined,
          salesLineNo: l.salesLineNo.trim() || undefined,
          confirmed: l.crossOrderConfirmed || undefined,
          deviationReason: l.deviationReason.trim() || undefined,
        })),
      })
      const data = (result.data ?? {}) as { lines?: FeedResultLine[] }
      setResultLines(data.lines ?? [])
      setNotice($t('投料已提交并实时扣减（{p0} 行；扣前/扣后与销售行余量见下表）', { p0: data.lines?.length ?? 0 }))
      setLines([])
    } catch (err) {
      const shaped = err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('投料失败') }
      setError(shaped)
      // 服务端码准入链错误归属到对应行（错误文案携带码值时）
      if (err instanceof ApiError) {
        setLines((prev) =>
          prev.map((l) => ((err.message ?? '').includes(l.barcodeValue) ? { ...l, localError: err.message } : l)),
        )
      }
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

      <section style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('扫码输入（扫码枪楔入 / 手输回车 / 按钮同一入口 PC-03）')}</h3>
        <ScanInput onScan={addLine} hint={$t('演示产品轴码：E5E0000007（本订单前道产出，可投）、E6F0000008（跨订单，需确认+偏离原因）；F3C0000002（待检，链上拒绝）')} />
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
            }}
            placeholder={$t('选择订单')}
            options={orders.map((o) => ({ value: o.id, label: o.orderNo }))}
          />
        </Field>
        <Field label={$t('投料工序')} required hint={$t('质检工序不可选（[A6-3]，服务端终校）')}>
          <Select
            style={{ width: 200 }}
            value={orderOperationId}
            onChange={(e) => setOrderOperationId(e.target.value)}
            placeholder={$t('选择工序')}
            options={operations.map((op) => ({ value: op.id, label: `${op.seq}. ${op.operationName}` }))}
          />
        </Field>
      </section>

      <section aria-label={$t('投料行')}>
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('投料行（')}{lines.length} {$t('行）')}</h3>
        {lines.length === 0 ? (
          <Message kind="info" title={$t('尚未扫码；扫码后逐行填写数量与销售行归属')} />
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
                  <Field label={$t('销售单号')} required>
                    <Input style={{ width: 140 }} value={line.salesOrderNo} onChange={(e) => setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, salesOrderNo: e.target.value } : l)))} />
                  </Field>
                  <Field label={$t('销售行号')} required>
                    <Input style={{ width: 80 }} value={line.salesLineNo} onChange={(e) => setLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, salesLineNo: e.target.value } : l)))} />
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
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button loading={busy} disabled={!canFeed} onClick={() => void submitFeeds()}>
            {$t('提交投料（实时扣减）')}
          </Button>
          {!canFeed ? <Badge tone="warning">{$t('需 execution.feed 许可')}</Badge> : null}
        </div>
      </section>

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
