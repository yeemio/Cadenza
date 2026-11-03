import { useCallback, useMemo, useState } from 'react'
import { Badge, Button, Field, Input, Message, Modal, PageContainer, Select, Table, t as $t, tx as $tx } from '@cadenza/ui'
import {
  formatP3Error,
  type SpcCalibrationResultValue,
  type SpcCircleItemKindValue,
  type SpcGaugeDetailResponse,
  type SpcMiscalibrationActionKindValue,
  type SpcMiscalibrationCircleResponse,
} from '../../../../../packages/ui/src/api/p3'
import { createWebP3Client } from '../client'
import { SPC_POST, SPC_READ, useP3Permissions } from '../permissions'

/**
 * 计量校准页（PE-15～PE-19）：器具详情＋校准历史（追加式）＋检测类任务可排产判定
 * （CS-05 硬约束③）＋登记校准命令（PE-15）＋失准圈定（PE-18 只读追溯清单）与
 * 失准处置命令（PE-19，处置完成前圈定清单不得删除）。
 */

const CAL_STATUS_LABELS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'info' }> = {
  valid: { label: '有效', tone: 'success' },
  limited: { label: '限用', tone: 'warning' },
  invalid: { label: '失准', tone: 'danger' },
  expired: { label: '已过期', tone: 'danger' },
  unknown: { label: '未知（无校准记录）', tone: 'info' },
}

const CAL_RESULT_OPTIONS: Array<{ value: SpcCalibrationResultValue; label: string }> = [
  { value: 'qualified', label: '合格' },
  { value: 'limited', label: '限用' },
  { value: 'failed', label: '失准' },
]

const ACTION_KIND_OPTIONS = [
  { value: 'isolation', label: '隔离' },
  { value: 'retest', label: '复检' },
  { value: 'concession', label: '让步' },
  { value: 'rework_scrap', label: '返工/报废' },
]

export function SpcCalibrationPage() {
  const { has } = useP3Permissions()
  const canRead = has(SPC_READ)
  const canPost = has(SPC_POST)
  const client = useMemo(() => createWebP3Client(), [])
  const [gaugeInput, setGaugeInput] = useState('g-002')
  const [detail, setDetail] = useState<SpcGaugeDetailResponse | null>(null)
  const [circle, setCircle] = useState<SpcMiscalibrationCircleResponse | null>(null)
  /** 圈定窗口（PE-18）：默认近两个月，可改；处置命令与圈定查询共用同一窗口 */
  const [circleFrom, setCircleFrom] = useState('2026-09-01T00:00:00+08:00')
  const [circleTo, setCircleTo] = useState('2026-10-20T00:00:00+08:00')
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [calOpen, setCalOpen] = useState(false)
  const [calForm, setCalForm] = useState({ calibratedAt: '2026-10-28', result: 'qualified' as SpcCalibrationResultValue, certificateNo: '', validUntil: '2027-04-28', basis: 'JJG 21-2008 千分尺检定规程' })
  const [actionTarget, setActionTarget] = useState<{ itemKind: string; itemRef: string; itemLabel: string } | null>(null)
  const [actionKind, setActionKind] = useState('isolation')

  const loadGauge = useCallback(() => {
    if (!canRead || gaugeInput.trim() === '') return
    setError(null)
    client
      .spcGaugeDetail(gaugeInput.trim())
      .then(setDetail)
      .catch((err: unknown) => {
        setDetail(null)
        setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
      })
  }, [canRead, client, gaugeInput])

  const loadCircle = useCallback(() => {
    if (!canRead || detail === null) return
    client
      .spcMiscalibrationCircle({ gaugeId: detail.gauge.id, from: circleFrom, to: circleTo })
      .then(setCircle)
      .catch(() => setCircle(null))
  }, [canRead, client, detail, circleFrom, circleTo])

  const submitCalibration = async () => {
    if (detail === null) return
    if (!calForm.certificateNo.trim()) {
      setError({ title: $t('证书编号不能为空（PE-15 校准记录必含证书编号）') })
      return
    }
    setBusy(true)
    try {
      await client.spcCalibrationRecord({
        plantId: detail.gauge.plantId,
        gaugeId: detail.gauge.id,
        calibratedAt: calForm.calibratedAt,
        result: calForm.result,
        certificateNo: calForm.certificateNo.trim(),
        validUntil: calForm.validUntil,
        basis: calForm.basis,
        reason: '登记校准记录（页面）',
      })
      setNotice($t('校准记录已追加（PE-15：新校准不改写旧记录；当前状态按最新记录快照）'))
      setCalOpen(false)
      setCalForm((f) => ({ ...f, certificateNo: '' }))
      loadGauge()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  const submitAction = async () => {
    if (actionTarget === null || circle === null) return
    setBusy(true)
    try {
      await client.spcMiscalibrationAction({
        plantId: detail?.gauge.plantId ?? 'n-plant',
        gaugeId: circle.gauge.id,
        windowFrom: circleFrom,
        windowTo: circleTo,
        itemKind: actionTarget.itemKind as SpcCircleItemKindValue,
        itemRef: actionTarget.itemRef,
        itemLabel: actionTarget.itemLabel,
        actionKind: actionKind as SpcMiscalibrationActionKindValue,
        reason: `失准处置（${actionKind}）`,
      })
      setNotice($t('圈定项 {p0} 已登记处置（{p1}）；处置完成前圈定清单不得删除（PE-19）', { p0: actionTarget.itemLabel, p1: $tx(ACTION_KIND_OPTIONS.find((o) => o.value === actionKind)?.label) }))
      setActionTarget(null)
      loadCircle()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('计量校准')} description={$t('器具校准历史与失准影响圈定（PE-15～PE-19）')}>
        <Message kind="warning" title={$t('无 SPC 查询权限（spc.read）')}>{$t('未授予 SPC 域查询许可，请联系管理员授权后使用。')}</Message>
      </PageContainer>
    )
  }

  const calStatus = detail === null ? null : CAL_STATUS_LABELS[detail.calibrationStatus] ?? { label: String(detail.calibrationStatus), tone: 'info' as const }

  return (
    <PageContainer
      title={$t('计量校准')}
      description={$t('校准记录追加式（PE-15）；实测绑定器具＋当时校准状态（PE-16）；检测类任务可排产判定联动排程硬约束（PE-17/CS-05③）')}
      actions={canPost && detail !== null ? <Button onClick={() => setCalOpen(true)}>{$t('登记校准记录')}</Button> : undefined}
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, maxWidth: 480 }}>
        <Input
          value={gaugeInput}
          onChange={(e) => setGaugeInput(e.target.value)}
          placeholder={$t('输入器具 ID 或器具号（如 g-001 / G-DIA-002）')}
          aria-label={$t('器具查询')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') loadGauge()
          }}
        />
        <Button variant="secondary" onClick={loadGauge}>{$t('查询器具')}</Button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)', marginTop: -6 }}>
        {$t('后端暂无器具列表端点（按 ID 直查，先例：单元详情页）；失准圈定窗口默认 2026-09-01 ～ 2026-10-20（处置命令与圈定共用同一窗口）。')}
      </p>

      {detail !== null ? (
        <>
          <Message kind="info" title={`${detail.gauge.gaugeNo} ${detail.gauge.name}${detail.gauge.gaugeKind !== null ? `（${detail.gauge.gaugeKind}）` : ''}`}>
            {$t('当前校准状态：')}
            {calStatus !== null ? <Badge tone={calStatus.tone}>{calStatus.label}</Badge> : '—'}{$t('； 检测类任务可排产：')}
            {detail.schedulableForInspection ? <Badge tone="success">{$t('可排产')}</Badge> : <Badge tone="danger">{$t('不可排产（CS-05 硬约束③）')}</Badge>}
          </Message>

          <h3 style={{ fontSize: 15, margin: '12px 0 8px' }}>{$t('校准历史（追加式，最新在前）')}</h3>
          <Table
            columns={[
              { key: 'calibratedAt', title: $t('校准日期'), render: (r) => r.calibratedAt.slice(0, 10) },
              { key: 'result', title: $t('结果'), render: (r) => <Badge tone={r.result === 'qualified' ? 'success' : r.result === 'limited' ? 'warning' : 'danger'}>{$tx(CAL_RESULT_OPTIONS.find((o) => o.value === r.result)?.label) ?? r.result}</Badge> },
              { key: 'certificateNo', title: $t('证书编号') },
              { key: 'validUntil', title: $t('有效期至') },
              { key: 'basis', title: $t('校准依据') },
              { key: 'recordedBy', title: $t('登记人'), render: (r) => r.recordedBy ?? '—' },
            ]}
            rows={detail.calibrationHistory}
            rowKey={(r) => r.id}
            emptyText={$t('无校准记录（状态未知）')}
          />

          {canPost ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Input
                value={circleFrom.slice(0, 10)}
                onChange={(e) => setCircleFrom(`${e.target.value}T00:00:00+08:00`)}
                aria-label={$t('圈定窗口起')}
                style={{ width: 140 }}
              />
              <span style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>{$t('～')}</span>
              <Input
                value={circleTo.slice(0, 10)}
                onChange={(e) => setCircleTo(`${e.target.value}T23:59:59+08:00`)}
                aria-label={$t('圈定窗口止')}
                style={{ width: 140 }}
              />
              <Button variant="ghost" size="sm" onClick={loadCircle}>
                {$t('查询失准圈定（PE-18，只读追溯清单）')}
              </Button>
            </div>
          ) : null}

          {circle !== null ? (
            <>
              <h3 style={{ fontSize: 15, margin: '12px 0 8px' }}>
                {$t('失准圈定：')}{circle.gauge.gaugeNo}{$t('（窗口')} {circleFrom.slice(0, 10)} {$t('～')} {circleTo.slice(0, 10)}{$t('）')}
              </h3>
              <Message kind="warning" title={$t('处置进度：已处置 {p0} / 待处置 {p1}（PE-19：处置完成前圈定清单不得删除）', { p0: circle.dispositionProgress.acted, p1: circle.dispositionProgress.pending })}>
                {$t('圈定为只读追溯清单，不自动改写质量结论；已发运项进入客诉/召回提示范围。')}
              </Message>
              <Table
                columns={[
                  { key: 'unitNo', title: $t('单元/批次'), render: (r) => r.itemLabel },
                  { key: 'kind', title: $t('圈定类别') },
                  { key: 'order', title: $t('关联订单'), render: (r) => r.productionOrderNo ?? '—' },
                  {
                    key: 'actions',
                    title: $t('处置（逐项走质量处置 T18）'),
                    render: (r) =>
                      canPost ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setActionTarget({ itemKind: r.itemKind, itemRef: r.itemRef, itemLabel: r.itemLabel })
                            setActionKind('isolation')
                          }}
                        >
                          {$t('登记处置')}
                        </Button>
                      ) : null,
                  },
                ]}
                rows={[
                  ...circle.circle.shippedUnits.map((u) => ({ itemKind: 'shipped_unit', itemRef: u.inventoryUnitId, itemLabel: u.unitNo, productionOrderNo: u.productionOrderNo, customerHint: true })),
                  ...circle.circle.stockUnits.map((u) => ({ itemKind: 'stock_unit', itemRef: u.inventoryUnitId, itemLabel: u.unitNo, productionOrderNo: u.productionOrderNo, customerHint: false })),
                  ...circle.circle.wipOrders.map((o) => ({ itemKind: 'wip_order', itemRef: o, itemLabel: o, productionOrderNo: o, customerHint: false })),
                ]}
                rowKey={(r) => `${r.itemKind}-${r.itemRef}`}
                emptyText={$t('窗口内无圈定项')}
              />
              {circle.circle.customerComplaintHints.length > 0 ? (
                <Message kind="error" title={$t('客诉/召回提示（PE-19）：已发运 {p0}', { p0: circle.circle.customerComplaintHints.map((h) => h.unitNo).join('、') })}>
                  {$t('已发运项处置涉及客诉/召回流程，请同步质量域与客服。')}
                </Message>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <Message kind="info" title={$t('输入器具 ID 查询详情')} />
      )}

      <Modal
        open={calOpen}
        title={$t('登记校准记录（PE-15 追加式）')}
        onClose={() => setCalOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCalOpen(false)}>{$t('取消')}</Button>
            <Button loading={busy} onClick={() => void submitCalibration()}>{$t('提交校准记录')}</Button>
          </>
        }
      >
        <Field label={$t('校准日期')} required>
          <Input value={calForm.calibratedAt} onChange={(e) => setCalForm((f) => ({ ...f, calibratedAt: e.target.value }))} aria-label={$t('校准日期')} />
        </Field>
        <Field label={$t('校准结果')} required>
          <Select value={calForm.result} options={CAL_RESULT_OPTIONS.map((o) => ({ ...o, label: $tx(o.label) }))} onChange={(e) => setCalForm((f) => ({ ...f, result: e.target.value as SpcCalibrationResultValue }))} aria-label={$t('校准结果')} />
        </Field>
        <Field label={$t('证书编号')} required>
          <Input value={calForm.certificateNo} onChange={(e) => setCalForm((f) => ({ ...f, certificateNo: e.target.value }))} placeholder={$t('如 JJG21-2026-201')} aria-label={$t('证书编号')} />
        </Field>
        <Field label={$t('有效期至')} required>
          <Input value={calForm.validUntil} onChange={(e) => setCalForm((f) => ({ ...f, validUntil: e.target.value }))} aria-label={$t('有效期至')} />
        </Field>
        <Field label={$t('校准依据')} required>
          <Input value={calForm.basis} onChange={(e) => setCalForm((f) => ({ ...f, basis: e.target.value }))} aria-label={$t('校准依据')} />
        </Field>
      </Modal>

      <Modal
        open={actionTarget !== null}
        title={$t('失准处置：{p0}', { p0: actionTarget?.itemLabel ?? '' })}
        onClose={() => setActionTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setActionTarget(null)}>{$t('取消')}</Button>
            <Button loading={busy} onClick={() => void submitAction()}>{$t('登记处置')}</Button>
          </>
        }
      >
        <Field label={$t('处置动作（PE-19：圈定后逐项走质量处置）')} required>
          <Select value={actionKind} options={ACTION_KIND_OPTIONS.map((o) => ({ ...o, label: $tx(o.label) }))} onChange={(e) => setActionKind(e.target.value)} aria-label={$t('处置动作')} />
        </Field>
        <p style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>
          {$t('处置登记仅留痕圈定进度；隔离/复检/让步/返工报废的执行在质量域（T18）完成。')}
        </p>
      </Modal>
    </PageContainer>
  )
}
