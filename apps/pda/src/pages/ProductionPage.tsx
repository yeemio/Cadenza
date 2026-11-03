import { ApiError, Badge, Button, Field, Input, Message, PageContainer, Select, ScanInput, formatErrorTitleAndDetail, t as $t } from '@cadenza/ui'
import { useState } from 'react'
import { api } from '../api'
import { EXECUTION_REPORT, usePermissions } from '../permissions'

interface ScanOp {
  orderId: string
  orderOperationId: string
  operationSeq: number
}

const TARGET_OPTIONS = [
  { value: 'loc-02010001', label: '02010001 拉丝线边' },
  { value: 'loc-02020001', label: '02020001 绞制线边' },
]

/**
 * PDA 生产入口页（[底稿 A6-1] 扫码报工）：
 * 扫设备码 → 任务上下文（该设备当天班次排产工序）→ 选任务 → 报工表单简化版
 * （产出数量+单位+载体码+目标线边库；来源 scan，服务端注入）。
 */
export function ProductionPage() {
  const { has } = usePermissions()
  const canReport = has(EXECUTION_REPORT)
  const [equipment, setEquipment] = useState('')
  const [ops, setOps] = useState<ScanOp[]>([])
  const [selected, setSelected] = useState<ScanOp | null>(null)
  const [quantity, setQuantity] = useState('')
  const [carrierCode, setCarrierCode] = useState('')
  const [target, setTarget] = useState(TARGET_OPTIONS[0]!.value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadContext = async (equipmentId: string) => {
    setEquipment(equipmentId)
    setError(null)
    setNotice(null)
    try {
      const entries = await api.executionScanContext({ plantId: 'n-plant', equipmentId, shiftDate: '2026-10-27' })
      setOps(entries.map((e) => ({ orderId: e.orderId, orderOperationId: e.orderOperationId, operationSeq: e.operationSeq })))
      setSelected(null)
      if (entries.length === 0) {
        setError({ title: $t('[A6-1] 该设备当天班次无排产工序，无法默认绑定') })
      }
    } catch (err) {
      setOps([])
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('查询排产上下文失败') })
    }
  }

  const submit = async () => {
    if (!selected) {
      setError({ title: $t('请先选择任务') })
      return
    }
    if (!quantity.trim()) {
      setError({ title: $t('产出数量必填（[A6-5]）') })
      return
    }
    const targetOption = TARGET_OPTIONS.find((t) => t.value === target)!
    setBusy(true)
    setError(null)
    try {
      const result = await api.reportViaScan({
        orderId: selected.orderId,
        orderOperationId: selected.orderOperationId,
        equipmentId: equipment,
        outputs: [
          {
            quantity: quantity.trim(),
            uomId: 'uom-km',
            uomCode: 'KM',
            carrierCode: carrierCode.trim() || null,
            targetLocationId: target,
            targetLocationCode: targetOption.label.slice(0, 8),
          },
        ],
      })
      const data = (result.data ?? {}) as { reportId?: string }
      setNotice($t('扫码报工已提交（报工单 {p0}，待审核）', { p0: data.reportId ?? '—' }))
      setQuantity('')
      setCarrierCode('')
      setSelected(null)
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('报工失败') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageContainer title={$t('生产')} description={$t('扫设备码 → 当天班次任务 → 报工（来源 scan）')}>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}
      <ScanInput
        onScan={(code) => void loadContext(code)}
        hint={$t('扫/输设备标识（演示：eq-0001 或 eq-0004）')}
        buttonLabel="带出任务"
      />
      <section style={{ marginTop: 14 }}>
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('任务上下文（设备')} {equipment || '—'}{$t('｜班次 2026-10-27）')}</h3>
        {ops.length === 0 ? (
          <Message kind="info" title={$t('尚未带出任务')} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ops.map((op) => (
              <button
                key={op.orderOperationId}
                onClick={() => setSelected(op)}
                style={{
                  textAlign: 'left',
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: selected?.orderOperationId === op.orderOperationId ? '2px solid var(--cz-color-primary)' : '1px solid var(--cz-color-border)',
                  background: 'var(--cz-color-bg-surface)',
                  cursor: 'pointer',
                  minHeight: 48,
                }}
              >
                <b>{$t('订单')} {op.orderId}</b>
                <span style={{ fontSize: 13, color: 'var(--cz-color-text-secondary)' }}>{$t('｜第')} {op.operationSeq} {$t('道工序')}</span>
                {selected?.orderOperationId === op.orderOperationId ? <Badge tone="info">{$t('已选')}</Badge> : null}
              </button>
            ))}
          </div>
        )}
      </section>
      {selected ? (
        <section style={{ marginTop: 14, border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 12, background: 'var(--cz-color-bg-surface)' }}>
          <h3 style={{ fontSize: 15, margin: '0 0 10px' }}>{$t('报工（简化版）')}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Field label={$t('产出数量（KM，与订单一致 [A5-2]）')} required>
              <Input inputSize="lg" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={$t('如 2.0000')} />
            </Field>
            <Field label={$t('载体码')}>
              <Input value={carrierCode} onChange={(e) => setCarrierCode(e.target.value)} placeholder={$t('如 E2A0000009')} />
            </Field>
            <Field label={$t('目标线边库（[A6-5]）')} required>
              <Select value={target} onChange={(e) => setTarget(e.target.value)} options={TARGET_OPTIONS} />
            </Field>
            <Button block size="lg" loading={busy} disabled={!canReport} onClick={() => void submit()}>
              {$t('提交报工')}
            </Button>
            {!canReport ? <Badge tone="warning">{$t('需 execution.report 许可')}</Badge> : null}
          </div>
        </section>
      ) : null}
    </PageContainer>
  )
}
