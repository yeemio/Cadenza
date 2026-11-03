import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Field, Input, Message, Modal, PageContainer, Select, Table, t as $t, tx as $tx } from '@cadenza/ui'
import {
  formatP3Error,
  type SpcControlItemView,
  type SpcControlChartResponse,
  type SpcOocTaskView,
} from '../../../../../packages/ui/src/api/p3'
import { createWebP3Client } from '../client'
import { SPC_POST, SPC_READ, useP3Permissions } from '../permissions'

/**
 * SPC 控制图页（PE-08～PE-14）：受控项目选择 + 控制限版本链（PE-10）+ 样本点图（判定绑定
 * 判定时点版本）+ 样本登记（PE-11 准入：坏点/偏差/校准可疑拒绝入图）+ 失控处置闭环
 * （PE-12：处置→复控确认；失控≠不合格 PE-13）。
 */

const CRITERIA_LABELS: Record<string, string> = {
  point_beyond_limits: '单点越限',
  run_same_side_6: '连续 6 点同侧',
  trend_6: '趋势',
}

export function SpcChartsPage() {
  const { has } = useP3Permissions()
  const canRead = has(SPC_READ)
  const canPost = has(SPC_POST)
  const client = useMemo(() => createWebP3Client(), [])
  const [items, setItems] = useState<SpcControlItemView[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [chart, setChart] = useState<SpcControlChartResponse | null>(null)
  const [oocTasks, setOocTasks] = useState<SpcOocTaskView[]>([])
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [recordOpen, setRecordOpen] = useState(false)
  const [measured, setMeasured] = useState('')
  const [gaugeId, setGaugeId] = useState('g-001')
  const [busy, setBusy] = useState(false)
  const [disposeTarget, setDisposeTarget] = useState<SpcOocTaskView | null>(null)
  const [cause, setCause] = useState('')
  const [corrective, setCorrective] = useState('')

  const loadChart = useCallback(() => {
    if (!canRead || selectedId === '') return
    client
      .spcControlChart(selectedId)
      .then(setChart)
      .catch((err: unknown) => setError(formatP3Error(err as { code?: string; message?: string; requestId?: string })))
  }, [canRead, client, selectedId])

  const loadOoc = useCallback(() => {
    if (!canRead) return
    client
      .spcListOocTasks({ page: 1, pageSize: 10 })
      .then((page) => setOocTasks(page.items))
      .catch(() => setOocTasks([]))
  }, [canRead, client])

  useEffect(() => {
    if (!canRead) return
    client
      .spcListControlItems({ page: 1, pageSize: 20 })
      .then((page) => {
        setItems(page.items)
        if (page.items.length > 0) setSelectedId((prev) => (prev === '' ? page.items[0]!.id : prev))
      })
      .catch(() => setItems([]))
  }, [canRead, client])

  useEffect(() => {
    loadChart()
  }, [loadChart])

  useEffect(() => {
    loadOoc()
  }, [loadOoc])

  const submitSample = async () => {
    if (selectedId === '' || measured.trim() === '') {
      setError({ title: $t('测量值不能为空（十进制字符串，如 0.5271）') })
      return
    }
    const item = items.find((i) => i.id === selectedId)
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const resp = await client.spcSampleRecord({
        plantId: item?.plantId ?? 'n-plant',
        controlItemId: selectedId,
        source: 'manual_inspection',
        measuredValue: measured.trim(),
        gaugeId: gaugeId.trim() === '' ? undefined : gaugeId.trim(),
        reason: '页面样本登记',
      })
      const data = resp.data as { admission?: string; rejectReason?: string; verdict?: string; violatedCodes?: string[]; note?: string; pointNo?: number } | null
      if (data?.admission === 'rejected') {
        setNotice($t('样本已登记但拒绝准入（PE-11）：{p0}——记录保留可查，不入控制图', { p0: data.note ?? data.rejectReason ?? '' }))
      } else if (data?.verdict === 'out_of_control') {
        setNotice($t('样本已入图并判定失控（命中 {p0}）：已生成 SPC 异常处置任务（PE-12）', { p0: (data.violatedCodes ?? []).map((c) => $tx(CRITERIA_LABELS[c]) ?? c).join('、') }))
      } else {
        setNotice($t('样本已入图（第 {p0} 点，判定在控）', { p0: data?.pointNo ?? '—' }))
      }
      setRecordOpen(false)
      setMeasured('')
      loadChart()
      loadOoc()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  const submitDispose = async () => {
    if (disposeTarget === null) return
    if (!cause.trim() || !corrective.trim()) {
      setError({ title: $t('处置记录必须包含原因分类与纠正措施（PE-12）') })
      return
    }
    setBusy(true)
    try {
      await client.spcOocDispose({
        plantId: disposeTarget.plantId,
        oocTaskId: disposeTarget.id,
        causeCategory: cause.trim(),
        correctiveAction: corrective.trim(),
        reason: '失控处置（页面）',
      })
      setNotice($t('处置已记录；复控确认后闭环（PE-12：失控未处置不得静默关闭）'))
      setDisposeTarget(null)
      setCause('')
      setCorrective('')
      loadOoc()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  const confirmRecontrol = async (task: SpcOocTaskView) => {
    setBusy(true)
    setError(null)
    try {
      await client.spcOocConfirmRecontrol({ plantId: task.plantId, oocTaskId: task.id, reason: '复控确认（页面）' })
      setNotice($t('{p0} 已确认复控，处置链闭环', { p0: task.taskNo }))
      loadOoc()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('SPC 控制图')} description={$t('受控项目控制图与失控处置闭环（PE-08～PE-14）')}>
        <Message kind="warning" title={$t('无 SPC 查询权限（spc.read）')}>{$t('未授予 SPC 域查询许可，请联系管理员授权后使用。')}</Message>
      </PageContainer>
    )
  }

  const activeLimit = chart === null ? null : [...chart.limitVersions].reverse().find((v) => v.status === 'active') ?? null
  const plot = useMemoPlot(chart)

  return (
    <PageContainer
      title={$t('SPC 控制图')}
      description={$t('受控项目＝检验规范版本中的计量型特性；判定绑定判定时点控制限版本（PE-10）；SPC 结论仅作质量证据输入（PE-13）')}
      actions={canPost ? <Button onClick={() => setRecordOpen(true)}>{$t('登记样本')}</Button> : undefined}
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 300 }}>
          <Select
            aria-label={$t('受控项目')}
            value={selectedId}
            placeholder={$t('选择受控项目')}
            options={items.map((i) => ({
              value: i.id,
              label: `${i.specCode} v${i.specVersion}／${i.itemNo} ${i.itemName ?? ''}${i.pointRef !== null ? `（点位 ${i.pointRef}）` : ''}`,
            }))}
            onChange={(e) => setSelectedId(e.target.value)}
          />
        </div>
        {chart?.ruleSet !== null && chart !== null ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone="info">{$t('规则集：')}{chart.ruleSet.name} v{chart.ruleSet.version}</Badge>
            {chart.ruleSet.isDefault ? <Badge tone="warning">{$t('默认规则集（PE-09，采用版本待裁 GAP-E14）')}</Badge> : null}
            <Badge>{chart.ruleSet.criteria.map((c) => $tx(CRITERIA_LABELS[c]) ?? c).join('＋')}</Badge>
          </div>
        ) : null}
      </div>

      {plot !== null ? (
        <div style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 12, background: 'var(--cz-color-bg-surface)' }}>
          <svg viewBox={plot.viewBox} width="100%" height={plot.height} role="img" aria-label={$t('{p0} 控制图', { p0: chart?.controlItem.itemNo })}>
            {plot.guides.map((g, idx) => (
              <line key={idx} x1={g.x1} y1={g.y} x2={g.x2} y2={g.y} stroke={g.color} strokeDasharray={g.dash} strokeWidth={1} />
            ))}
            {plot.guides.map((g, idx) => (
              <text key={`t-${idx}`} x={4} y={g.y - 3} fontSize={9} fill={g.color}>
                {g.label}
              </text>
            ))}
            {plot.points.map((p) => (
              <circle
                key={p.sampleId}
                cx={p.cx}
                cy={p.cy}
                r={p.out ? 5 : 3.5}
                fill={p.out ? '#d9480f' : '#1c6fb5'}
                stroke={p.out ? '#a61e00' : 'none'}
                strokeWidth={1.5}
              />
            ))}
          </svg>
          <div style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>
            {$t('当前控制限 v')}{activeLimit?.version ?? '—'}{$t('（')}{activeLimit?.method === 'mean_pm_3sigma' ? $t('均值±3σ') : activeLimit?.method}{$t('，首')} {activeLimit?.baselineGroupCount ?? '—'} {$t('组建立）： UCL')} {activeLimit?.ucl ?? '—'} {$t('｜ CL')} {activeLimit?.cl ?? '—'} {$t('｜ LCL')} {activeLimit?.lcl ?? '—'}{$t('；橙点＝失控点（判定绑定判定时点版本，PE-10）')}
          </div>
        </div>
      ) : (
        <Message kind="info" title={$t('该受控项目暂无控制限（building 阶段：首 n 组建立后生效）')} />
      )}

      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{$t('样本与判定（已准入）')}</h3>
      <Table
        columns={[
          { key: 'pointNo', title: $t('点号'), render: (s) => `${s.judgement?.pointNo ?? '—'}` },
          { key: 'measuredValue', title: $t('测量值') },
          { key: 'sampledAt', title: $t('采样时间'), render: (s) => s.sampledAt.replace('T', ' ').slice(0, 16) },
          { key: 'source', title: $t('来源'), render: (s) => (s.source === 'manual_inspection' ? $t('人工检验') : $t('采集')) },
          { key: 'gauge', title: $t('器具/校准'), render: (s) => (s.gaugeId !== null ? `${s.gaugeId}（${s.calibrationStatus ?? '—'}）` : '—') },
          { key: 'order', title: $t('定位（订单/工序/设备/班次，PE-14）'), render: (s) => s.productionOrderId !== null ? $t('{p0}／工序{p1}／{p2}／{p3}', { p0: s.productionOrderId, p1: s.operationSeq ?? '—', p2: s.equipmentCode ?? '—', p3: s.shiftDate ?? '—' }) : '—' },
          {
            key: 'verdict',
            title: $t('判定'),
            render: (s) =>
              s.judgement === null ? (
                '—'
              ) : s.judgement.verdict === 'out_of_control' ? (
                <Badge tone="danger">{$t('失控：')}{(s.judgement.violatedCodes ?? []).map((c) => $tx(CRITERIA_LABELS[c]) ?? c).join('、')}{$t('（限 v')}{s.judgement.controlLimitVersion}{$t('）')}</Badge>
              ) : (
                <Badge tone="success">{$t('在控（限 v')}{s.judgement.controlLimitVersion}{$t('）')}</Badge>
              ),
          },
        ]}
        rows={chart?.samples ?? []}
        rowKey={(s) => s.id}
        loading={chart === null}
        emptyText={$t('暂无准入样本')}
      />

      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{$t('失控处置任务（PE-12 闭环）')}</h3>
      <Table
        columns={[
          { key: 'taskNo', title: $t('任务') },
          { key: 'status', title: $t('状态'), render: (t) => <Badge tone={t.status === 'open' ? 'danger' : t.status === 'disposed' ? 'warning' : 'success'}>{t.status === 'open' ? $t('待处置') : t.status === 'disposed' ? $t('已处置待复控') : $t('已复控确认')}</Badge> },
          { key: 'qualityDoubtHint', title: $t('质量存疑提示'), render: (t) => (t.qualityDoubtHint ? <Badge tone="warning">{$t('已触发（PE-13：失控≠自动不合格）')}</Badge> : '—') },
          { key: 'cause', title: $t('原因/措施'), render: (t) => (t.causeCategory !== null ? `${t.causeCategory}／${t.correctiveAction}` : '—') },
          {
            key: 'actions',
            title: $t('操作'),
            render: (t) =>
              canPost ? (
                t.status === 'open' ? (
                  <Button size="sm" onClick={() => setDisposeTarget(t)}>{$t('处置')}</Button>
                ) : t.status === 'disposed' ? (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void confirmRecontrol(t)}>{$t('复控确认')}</Button>
                ) : null
              ) : null,
          },
        ]}
        rows={oocTasks}
        rowKey={(t) => t.id}
        emptyText={$t('无失控处置任务')}
      />

      <Modal
        open={recordOpen}
        title={$t('登记 SPC 样本（PE-11 准入）')}
        onClose={() => setRecordOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRecordOpen(false)}>{$t('取消')}</Button>
            <Button loading={busy} onClick={() => void submitSample()}>{$t('提交样本')}</Button>
          </>
        }
      >
        <Field label={$t('测量值（十进制字符串）')} required hint={$t('坏点/时钟偏差/校准状态可疑样本将被拒绝准入（记录保留可查）')}>
          <Input value={measured} onChange={(e) => setMeasured(e.target.value)} placeholder={$t('如 0.5271')} aria-label={$t('测量值')} />
        </Field>
        <Field label={$t('出具器具 ID（PE-16：绑定器具＋当时校准状态）')} hint={$t('如 g-001；g-002 为失准器具（演示校准可疑拒绝准入）')}>
          <Input value={gaugeId} onChange={(e) => setGaugeId(e.target.value)} aria-label={$t('出具器具')} />
        </Field>
      </Modal>

      <Modal
        open={disposeTarget !== null}
        title={$t('失控处置（{p0}）', { p0: disposeTarget?.taskNo ?? '' })}
        onClose={() => setDisposeTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDisposeTarget(null)}>{$t('取消')}</Button>
            <Button loading={busy} onClick={() => void submitDispose()}>{$t('提交处置')}</Button>
          </>
        }
      >
        <Field label={$t('原因分类')} required>
          <Input value={cause} onChange={(e) => setCause(e.target.value)} placeholder={$t('如 模具磨损')} aria-label={$t('原因分类')} />
        </Field>
        <Field label={$t('纠正措施')} required>
          <Input value={corrective} onChange={(e) => setCorrective(e.target.value)} placeholder={$t('如 更换模具并复测')} aria-label={$t('纠正措施')} />
        </Field>
        <p style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>
          {$t('处置后须复控确认闭环；SPC 失控仅触发质量存疑提示，放行/隔离结论出自质量域（PE-12/13）。')}
        </p>
      </Modal>
    </PageContainer>
  )
}

/** 控制图 SVG 坐标计算（纯展示，无图表库依赖）。 */
function useMemoPlot(chart: SpcControlChartResponse | null): {
  viewBox: string
  height: number
  guides: Array<{ x1: number; x2: number; y: number; color: string; dash?: string; label: string }>
  points: Array<{ sampleId: string; cx: number; cy: number; out: boolean }>
} | null {
  return useMemo(() => {
    if (chart === null || chart.samples.length === 0) return null
    const active = [...chart.limitVersions].reverse().find((v) => v.status === 'active') ?? null
    if (active === null || active.cl === null || active.ucl === null || active.lcl === null) return null
    const width = 720
    const height = 200
    const padL = 56
    const padR = 16
    const padY = 18
    const values = chart.samples.map((s) => Number(s.measuredValue))
    const ucl = Number(active.ucl)
    const lcl = Number(active.lcl)
    const cl = Number(active.cl)
    const min = Math.min(...values, lcl)
    const max = Math.max(...values, ucl)
    const span = max - min || 1
    const yOf = (v: number) => padY + ((max - v) / span) * (height - padY * 2)
    const step = chart.samples.length > 1 ? (width - padL - padR) / (chart.samples.length - 1) : 0
    const guides = [
      { x1: padL, x2: width - padR, y: yOf(ucl), color: '#d9480f', dash: '4 3', label: `UCL ${active.ucl}` },
      { x1: padL, x2: width - padR, y: yOf(cl), color: '#2b8a3e', dash: '4 3', label: `CL ${active.cl}` },
      { x1: padL, x2: width - padR, y: yOf(lcl), color: '#d9480f', dash: '4 3', label: `LCL ${active.lcl}` },
    ]
    const points = chart.samples.map((s, idx) => ({
      sampleId: s.id,
      cx: padL + step * idx,
      cy: yOf(Number(s.measuredValue)),
      out: s.judgement?.verdict === 'out_of_control',
    }))
    return { viewBox: `0 0 ${width} ${height}`, height, guides, points }
  }, [chart])
}
