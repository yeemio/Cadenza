import {
  ApiError,
  Badge,
  Button,
  Field,
  Input,
  INSPECTION_SOURCE_LABELS,
  INSPECTION_STAGE_LABELS,
  MEASUREMENT_JUDGEMENT_LABELS,
  Message,
  Modal,
  PageContainer,
  RESULT_KIND_LABELS,
  Select,
  TEST_CONCLUSION_LABELS,
  formatErrorTitleAndDetail,
  type InspectionDetailDto,
  type InspectionItemMeasurementDto,
  t as $t,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'
import { QUALITY_POST, QUALITY_READ, usePermissions } from '../permissions'

/**
 * 检验执行页（S14 结论版本化 + A-T12-1 处置）：
 * - 实测值表单：检验项（项号/名称/实测值/判定）动态行 + 结论提交（合格/不合格）；
 *   已结论单再提交＝复检（版本链继续追加，历史不清）；
 * - 放行：生效结论=合格才可判定放行；
 * - 让步：basedOnVersion 显式引用原不合格结论——保留原不合格事实（提示固定呈现）；
 * - 结论版本链展示（生效指针）；quality.post 显隐（PC-10），服务端守卫错误渲染（PC-14）。
 */
export function QualityInspectionDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { has } = usePermissions()
  const canRead = has(QUALITY_READ)
  const canPost = has(QUALITY_POST)
  const [detail, setDetail] = useState<InspectionDetailDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 实测表单
  const [items, setItems] = useState<Array<InspectionItemMeasurementDto>>([
    { itemNo: '1', itemName: '', measuredValue: '', judgement: 'pass', note: null },
  ])
  const [conclusion, setConclusion] = useState<'qualified' | 'unqualified'>('qualified')
  const [submitBusy, setSubmitBusy] = useState(false)
  // 处置
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [releaseReason, setReleaseReason] = useState('')
  const [concessionOpen, setConcessionOpen] = useState(false)
  const [concessionReason, setConcessionReason] = useState('')
  const [dispositionBusy, setDispositionBusy] = useState(false)

  const load = useCallback(() => {
    if (!id) return
    setLoading(true)
    api
      .inspectionDetail(id)
      .then((result) => {
        setDetail(result)
        setError(null)
      })
      .catch((err) => {
        setDetail(null)
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载检验单失败') })
      })
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const submitTest = async () => {
    if (!id) return
    if (items.some((item) => !item.itemNo.trim() || !item.measuredValue.trim())) {
      setError({ title: $t('请完整填写每行的项号与实测值') })
      return
    }
    setSubmitBusy(true)
    setError(null)
    try {
      const result = await api.submitTestResult({
        inspectionOrderId: id,
        conclusion,
        items: items.map((item) => ({
          itemNo: item.itemNo.trim(),
          itemName: (item.itemName ?? '').trim() || null,
          measuredValue: item.measuredValue.trim(),
          judgement: item.judgement,
          note: item.note,
        })),
      })
      const data = (result.data ?? {}) as { version?: number; resultKind?: string }
      setNotice($t('实测已提交（版本 v{p0}，{p1}）；生效结论已翻转', { p0: data.version ?? '—', p1: RESULT_KIND_LABELS[data.resultKind ?? 'test'] ?? data.resultKind ?? '' }))
      setItems([{ itemNo: '1', itemName: '', measuredValue: '', judgement: 'pass', note: null }])
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('提交实测失败') })
    } finally {
      setSubmitBusy(false)
    }
  }

  const doRelease = async () => {
    if (!id) return
    setDispositionBusy(true)
    setError(null)
    try {
      await api.releaseInspection({ inspectionOrderId: id, reason: releaseReason.trim() || undefined })
      setNotice($t('已判定放行（生效结论=合格）'))
      setReleaseOpen(false)
      setReleaseReason('')
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('放行失败') })
    } finally {
      setDispositionBusy(false)
    }
  }

  const doConcession = async () => {
    if (!id || !detail) return
    const unqualifiedVersion = detail.results.find((r) => r.conclusion === 'unqualified' && r.isEffective)?.version
      ?? detail.results.find((r) => r.conclusion === 'unqualified')?.version
    if (unqualifiedVersion === undefined) {
      setError({ title: $t('未找到可引用的原不合格结论版本（让步须基于不合格结论）') })
      setConcessionOpen(false)
      return
    }
    if (!concessionReason.trim()) {
      setError({ title: $t('[A-T12-1] 让步放行必须填写让步原因') })
      return
    }
    setDispositionBusy(true)
    setError(null)
    try {
      await api.concessionInspection(
        { inspectionOrderId: id, basedOnVersion: unqualifiedVersion, reason: concessionReason.trim() },
        { reason: concessionReason.trim() },
      )
      setNotice($t('已让步放行（引用原不合格结论 v{p0}；原不合格事实保留，结论链不动）', { p0: unqualifiedVersion }))
      setConcessionOpen(false)
      setConcessionReason('')
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('让步失败') })
    } finally {
      setDispositionBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('检验执行')}>
        <Message kind="warning" title={$t('没有质量查询许可（quality.read）')} />
      </PageContainer>
    )
  }

  const hasDisposition = (detail?.dispositions.length ?? 0) > 0
  return (
    <PageContainer
      title={detail ? $t('检验单 {p0}', { p0: detail.orderNo }) : $t('检验执行')}
      description={$t('实测值追加历史 + 生效结论版本化（S14）；让步放行保留原不合格事实（based_on_version 引用原结论，A-T12-1）')}
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}
      {!detail ? (
        <Message kind={loading ? 'info' : 'warning'} title={loading ? $t('加载中…') : $t('检验单不存在或不在授权数据范围内')} />
      ) : (
        <>
          <section
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 10,
              fontSize: 13.5,
              background: 'var(--cz-color-bg-surface)',
              border: '1px solid var(--cz-color-border)',
              borderRadius: 8,
              padding: 14,
              marginBottom: 16,
            }}
          >
            <span>
              {$t('状态：')}<Badge tone={detail.status === 'concluded' ? 'success' : 'warning'}>{detail.statusLabel}</Badge>
            </span>
            <span>
              {$t('来源：')}<Badge tone="info">{INSPECTION_SOURCE_LABELS[detail.sourceType] ?? detail.sourceType}</Badge>{$t('（')}{detail.sourceRef}{$t('）')}
            </span>
            <span>{$t('阶段：')}{INSPECTION_STAGE_LABELS[detail.inspectionStage] ?? detail.inspectionStage}</span>
            <span>{$t('检验规范：')}{detail.specCode} v{detail.specVersion}</span>
            <span>
              {$t('数量：')}<b>{detail.quantity}</b> <b style={{ fontSize: 12 }}>{detail.uomCode}</b>
            </span>
            <span>{$t('库存单元：')}{detail.unitNo ?? '—'}</span>
            <span>{$t('生产单号：')}{detail.productionOrderNo ?? '—'}</span>
            <span>{$t('生产部门：')}{detail.productionDeptName ?? '—'}</span>
          </section>

          {/* 处置记录 */}
          {hasDisposition ? (
            <section style={{ marginBottom: 16 }}>
              <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('处置记录')}</h3>
              {detail.dispositions.map((d) => (
                <p key={d.dispositionId} style={{ fontSize: 13.5, margin: 0 }}>
                  <Badge tone={d.dispositionKind === 'concession' ? 'warning' : 'success'}>
                    {d.dispositionKind === 'concession' ? $t('让步放行') : $t('判定放行')}
                  </Badge>{' '}
                  {$t('由')} {d.releasedBy} {$t('于')} {d.releasedAt} {$t('执行；引用结论版本 v')}{d.basedOnVersion}
                  {d.reason ? $t('；原因：{p0}', { p0: d.reason }) : ''}
                </p>
              ))}
            </section>
          ) : null}

          {/* 结论版本链 */}
          <section style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('结论版本链（追加历史 + 生效指针，S14）')}</h3>
            {detail.results.length === 0 ? (
              <Message kind="info" title={$t('尚无实测记录')} />
            ) : (
              <div className="cz-table-wrap">
                <table className="cz-table">
                  <thead>
                    <tr>
                      <th>{$t('版本')}</th>
                      <th>{$t('种类')}</th>
                      <th>{$t('结论')}</th>
                      <th>{$t('实测项')}</th>
                      <th>{$t('检验员')}</th>
                      <th>{$t('检验时间')}</th>
                      <th>{$t('生效')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.results.map((r) => (
                      <tr key={r.resultId}>
                        <td>v{r.version}</td>
                        <td>{RESULT_KIND_LABELS[r.resultKind] ?? r.resultKind}</td>
                        <td>
                          <Badge tone={r.conclusion === 'qualified' ? 'success' : r.conclusion === 'unqualified' ? 'danger' : 'default'}>
                            {TEST_CONCLUSION_LABELS[r.conclusion] ?? r.conclusion}
                          </Badge>
                        </td>
                        <td>
                          {(Array.isArray(r.items) ? (r.items as InspectionItemMeasurementDto[]) : [])
                            .map((item) => `${item.itemNo}.${item.itemName ?? ''}=${item.measuredValue}（${MEASUREMENT_JUDGEMENT_LABELS[item.judgement] ?? item.judgement}）`)
                            .join('；') || '—'}
                        </td>
                        <td>{r.inspector ?? '—'}</td>
                        <td>{r.inspectedAt ?? '—'}</td>
                        <td>{r.isEffective ? <Badge tone="success">{$t('生效中')}</Badge> : $t('历史')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 实测值表单（已处置后只读） */}
          <section style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 14, marginBottom: 16, background: 'var(--cz-color-bg-surface)' }}>
            <h3 style={{ fontSize: 15, margin: '0 0 10px' }}>
              {detail.status === 'concluded' ? $t('复检提交（已结论单再提交＝复检，版本链追加）') : $t('检验执行（实测值表单 + 结论提交）')}
              {canPost ? null : <Badge tone="warning">{$t('需 quality.post 许可')}</Badge>}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {items.map((item, index) => (
                <div key={index} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <Field label={$t('项号 {p0}', { p0: index + 1 })} required>
                    <Input style={{ width: 70 }} value={item.itemNo} onChange={(e) => setItems((prev) => prev.map((row, i) => (i === index ? { ...row, itemNo: e.target.value } : row)))} />
                  </Field>
                  <Field label={$t('检验项名称')}>
                    <Input style={{ width: 140 }} value={item.itemName ?? ''} onChange={(e) => setItems((prev) => prev.map((row, i) => (i === index ? { ...row, itemName: e.target.value } : row)))} placeholder={$t('如 导体电阻')} />
                  </Field>
                  <Field label={$t('实测值')} required>
                    <Input style={{ width: 140 }} value={item.measuredValue} onChange={(e) => setItems((prev) => prev.map((row, i) => (i === index ? { ...row, measuredValue: e.target.value } : row)))} placeholder={$t('如 0.527')} />
                  </Field>
                  <Field label={$t('判定')}>
                    <Select
                      style={{ width: 110 }}
                      value={item.judgement}
                      onChange={(e) => setItems((prev) => prev.map((row, i) => (i === index ? { ...row, judgement: e.target.value as InspectionItemMeasurementDto['judgement'] } : row)))}
                      options={[
                        { value: 'pass', label: $t('合格') },
                        { value: 'fail', label: $t('不合格') },
                        { value: 'not_tested', label: $t('未检') },
                      ]}
                    />
                  </Field>
                  {items.length > 1 ? (
                    <Button size="sm" variant="ghost" onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}>
                      {$t('移除行')}
                    </Button>
                  ) : null}
                </div>
              ))}
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Button size="sm" variant="secondary" onClick={() => setItems((prev) => [...prev, { itemNo: String(prev.length + 1), itemName: '', measuredValue: '', judgement: 'pass', note: null }])}>
                  {$t('增加检验项')}
                </Button>
                <Field label={$t('结论')} required>
                  <Select
                    style={{ width: 130 }}
                    value={conclusion}
                    onChange={(e) => setConclusion(e.target.value as 'qualified' | 'unqualified')}
                    options={[
                      { value: 'qualified', label: $t('合格') },
                      { value: 'unqualified', label: $t('不合格') },
                    ]}
                  />
                </Field>
                <Button loading={submitBusy} disabled={!canPost || hasDisposition} onClick={() => void submitTest()}>
                  {$t('提交实测与结论')}
                </Button>
                {hasDisposition ? <span style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>{$t('已有处置记录（结论链冻结供追溯；如需复检请由后端裁定流程处理）')}</span> : null}
              </div>
            </div>
          </section>

          {/* 放行/让步 */}
          <section style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 14, background: 'var(--cz-color-bg-surface)' }}>
            <h3 style={{ fontSize: 15, margin: '0 0 10px' }}>{$t('处置：放行 / 让步')}{canPost ? null : <Badge tone="warning">{$t('需 quality.post 许可')}</Badge>}</h3>
            <Message kind="info" title={$t('让步放行保留原不合格事实')}>
              {$t('让步（concession）不改动结论链：以 based_on_version 显式引用原不合格结论版本，库存质量投影转合格但历史不合格记录永久保留（A-T12-1）。')}
            </Message>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <Button variant="secondary" disabled={!canPost || hasDisposition || detail.status !== 'concluded'} onClick={() => setReleaseOpen(true)}>
                {$t('判定放行（须生效结论=合格）')}
              </Button>
              <Button variant="secondary" disabled={!canPost || hasDisposition || detail.status !== 'concluded'} onClick={() => setConcessionOpen(true)}>
                {$t('让步放行（保留原不合格事实）')}
              </Button>
            </div>
          </section>
        </>
      )}

      <Modal
        open={releaseOpen}
        title={$t('判定放行')}
        onClose={() => setReleaseOpen(false)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setReleaseOpen(false)}>{$t('取消')}</Button>
            <Button loading={dispositionBusy} onClick={() => void doRelease()}>{$t('确认放行')}</Button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, lineHeight: 1.8, margin: 0 }}>
          {$t('生效结论为合格时方可判定放行；放行后库存质量投影为合格。不合格结论请走让步放行。')}
        </p>
        <div style={{ marginTop: 10 }}>
          <Field label={$t('放行原因')}>
            <Input value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} placeholder={$t('选填')} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={concessionOpen}
        title={$t('让步放行（保留原不合格事实）')}
        onClose={() => setConcessionOpen(false)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConcessionOpen(false)}>{$t('取消')}</Button>
            <Button variant="danger" loading={dispositionBusy} disabled={!concessionReason.trim()} onClick={() => void doConcession()}>
              {$t('确认让步')}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, lineHeight: 1.8, margin: 0 }}>
          {$t('让步放行将引用原不合格结论版本（based_on_version），原不合格事实保留在结论链与处置记录中，不因让步而消失（A-T12-1）。')}
        </p>
        <div style={{ marginTop: 10 }}>
          <Field label={$t('让步原因')} required error={!concessionReason.trim() ? $t('让步必须填写原因') : undefined}>
            <Input value={concessionReason} onChange={(e) => setConcessionReason(e.target.value)} placeholder={$t('如 客户书面接受外观缺陷')} />
          </Field>
        </div>
      </Modal>
    </PageContainer>
  )
}
