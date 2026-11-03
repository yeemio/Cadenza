import {
  ApiError,
  Badge,
  Button,
  EXECUTION_SOURCE_LABELS,
  Field,
  Form,
  Input,
  Message,
  Modal,
  PageContainer,
  REVIEW_STATUS_LABELS,
  REPORT_STATUS_LABELS,
  Select,
  Table,
  formatErrorTitleAndDetail,
  type ExecutionDraftDto,
  type OrderOperationDto,
  type OrderQuantitiesDto,
  type ProductionOrderDto,
  type ReportDetailViewDto,
  t as $t,
  tx as $tx,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { EXECUTION_READ, EXECUTION_REPORT, EXECUTION_REVIEW, PROCESS_READ, usePermissions } from '../permissions'

type Entry = 'order' | 'workbench' | 'scan'

const ENTRY_OPTIONS: Array<{ value: Entry; label: string; desc: string }> = [
  { value: 'order', label: '订单报工', desc: '从生产订单进入，实绩录入（来源 order）' },
  { value: 'workbench', label: '工作台报工', desc: '工作台选择订单与工序（来源 workbench，工序固定）' },
  { value: 'scan', label: '扫码报工', desc: '扫设备码带出当天班次排产任务（来源 scan）' },
]

/** 线边库目标库位（[A6-5]：产出只能转入线边库；A6-5 缺口以配置清单承载） */
const LINE_SIDE_TARGETS = [
  { value: 'loc-02010001', label: '02010001（拉丝线边产出位）' },
  { value: 'loc-02010002', label: '02010002（拉丝线边待检位）' },
  { value: 'loc-02020001', label: '02020001（绞制线边产出位）' },
]

/**
 * 报工工作台（[底稿 A6] 三入口同规则 + 草稿箱 + 审核操作 + 五量分栏）：
 * - 三入口语义入口页：订单/工作台/扫码三张入口卡（服务端共用单一命令路径，仅 source 不同）；
 * - 草稿箱：「N 条报工待提交」（drafts 分页），续作带回产出/载体码/库位/备注；
 * - 报工表单：产出数量+单位（与订单一致 PC-06）+载体码+目标线边库；保存草稿/直接提交；
 * - 审核操作（execution.review）：按报工单号取单 → 通过（入库转线边库）/取消审核（守卫错误渲染）；
 * - 五量分栏（[A5-3]）：草稿/提交/审核/合格/入库五列分立展示，不做混口径。
 */
export function ExecutionWorkbenchPage() {
  const { has } = usePermissions()
  const canRead = has(EXECUTION_READ)
  const canReport = has(EXECUTION_REPORT)
  const canReview = has(EXECUTION_REVIEW)
  const canReadOrders = has(PROCESS_READ)
  const [searchParams] = useSearchParams()
  const [entry, setEntry] = useState<Entry>('order')
  const [orders, setOrders] = useState<ProductionOrderDto[]>([])
  const [orderId, setOrderId] = useState(searchParams.get('orderId') ?? '')
  const [operations, setOperations] = useState<OrderOperationDto[]>([])
  const [orderOperationId, setOrderOperationId] = useState('')
  const [scanEquipment, setScanEquipment] = useState('')
  // 报工表单
  const [quantity, setQuantity] = useState('')
  const [qualifiedQty, setQualifiedQty] = useState('')
  const [carrierCode, setCarrierCode] = useState('')
  const [targetLocationId, setTargetLocationId] = useState(LINE_SIDE_TARGETS[0]!.value)
  const [remark, setRemark] = useState('')
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<{ title: string; detail?: string } | null>(null)
  const [formNotice, setFormNotice] = useState<string | null>(null)
  // 草稿箱
  const [drafts, setDrafts] = useState<ExecutionDraftDto[]>([])
  const [draftTotal, setDraftTotal] = useState(0)
  // 审核
  const [reviewIdInput, setReviewIdInput] = useState('rp-002')
  const [reviewDetail, setReviewDetail] = useState<ReportDetailViewDto | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewError, setReviewError] = useState<{ title: string; detail?: string } | null>(null)
  const [reviewNotice, setReviewNotice] = useState<string | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  // 五量
  const [fiveOrderId, setFiveOrderId] = useState(searchParams.get('orderId') ?? '')
  const [five, setFive] = useState<OrderQuantitiesDto | null>(null)
  const [fiveError, setFiveError] = useState<{ title: string; detail?: string } | null>(null)

  const selectedOrder = orders.find((o) => o.id === orderId) ?? null

  useEffect(() => {
    if (!canReadOrders) return
    api
      .listProductionOrders({ page: 1, pageSize: 50, statuses: 'released,in_progress' })
      .then((result) => setOrders(result.items))
      .catch(() => setOrders([]))
  }, [canReadOrders])

  const loadDrafts = useCallback(() => {
    if (!canRead) return
    api
      .listReportDrafts({ page: 1, pageSize: 20 })
      .then((result) => {
        setDrafts(result.items)
        setDraftTotal(result.total)
      })
      .catch(() => setDrafts([]))
  }, [canRead])

  useEffect(() => {
    loadDrafts()
  }, [loadDrafts])

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

  useEffect(() => {
    if (!fiveOrderId) {
      setFive(null)
      return
    }
    api
      .orderQuantities(fiveOrderId)
      .then((view) => {
        setFive(view)
        setFiveError(null)
      })
      .catch((err) => {
        setFive(null)
        setFiveError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('五量查询失败') })
      })
  }, [fiveOrderId])

  const loadReviewDetail = useCallback(async (reportId: string) => {
    if (!reportId.trim()) return
    setReviewBusy(true)
    try {
      const detail = await api.getReport(reportId.trim())
      setReviewDetail(detail)
      setReviewError(null)
    } catch (err) {
      setReviewDetail(null)
      setReviewError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('查询报工单失败') })
    } finally {
      setReviewBusy(false)
    }
  }, [])

  const equipmentContext = async () => {
    if (!scanEquipment.trim()) {
      setFormError({ title: $t('请先扫/选设备（扫码报工入口）') })
      return
    }
    const eq = scanEquipment.trim()
    try {
      const entries = await api.executionScanContext({ plantId: 'n-plant', equipmentId: eq, shiftDate: '2026-10-27' })
      if (entries.length === 0) {
        setFormError({ title: $t('[A6-1] 该设备当天班次无排产工序，无法默认绑定') })
      } else {
        setFormError(null)
        const first = entries[0]!
        setOrderId(first.orderId)
        setOrderOperationId(first.orderOperationId)
        setFormNotice($t('已带出该设备当天班次排产任务（{p0} 条），默认选中第一条', { p0: entries.length }))
      }
    } catch (err) {
      setFormError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('扫码上下文查询失败') })
    }
  }

  const submitReport = async (action: 'submit' | 'draft') => {
    if (!orderId) {
      setFormError({ title: $t('请选择订单') })
      return
    }
    if (!orderOperationId) {
      setFormError({ title: $t('请选择工序（质检工序不可选 [A6-3]）') })
      return
    }
    if (action === 'submit' && !quantity.trim()) {
      setFormError({ title: $t('产出数量必填（[A6-5] 保存界面产出数量为必填）') })
      return
    }
    const target = LINE_SIDE_TARGETS.find((t) => t.value === targetLocationId)!
    const payload = {
      orderId,
      orderOperationId,
      action,
      equipmentCode: entry === 'scan' ? scanEquipment.trim() : undefined,
      outputs:
        action === 'draft' && !quantity.trim()
          ? []
          : [
              {
                quantity: quantity.trim(),
                qualifiedQty: qualifiedQty.trim() || quantity.trim(),
                uomId: 'uom-km',
                uomCode: selectedOrder?.uom ?? 'KM',
                carrierCode: carrierCode.trim() || null,
                targetLocationId: targetLocationId,
                targetLocationCode: target.label.slice(0, 8),
              },
            ],
      remark: remark.trim() || undefined,
    }
    setFormBusy(true)
    setFormError(null)
    try {
      const result =
        entry === 'order'
          ? await api.reportViaOrder(orderId, payload)
          : entry === 'workbench'
            ? await api.reportViaWorkbench(payload)
            : await api.reportViaScan(payload)
      const data = (result.data ?? {}) as { reportId?: string; status?: string }
      setFormNotice(
        action === 'draft'
          ? $t('草稿已保存（报工单 {p0}）；草稿箱可续作提交', { p0: data.reportId ?? '—' })
          : $t('报工已提交（报工单 {p0}），待审核', { p0: data.reportId ?? '—' }),
      )
      setQuantity('')
      setQualifiedQty('')
      setCarrierCode('')
      setRemark('')
      loadDrafts()
      if (fiveOrderId === orderId) {
        api.orderQuantities(orderId).then(setFive).catch(() => undefined)
      }
    } catch (err) {
      setFormError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('报工失败') })
    } finally {
      setFormBusy(false)
    }
  }

  const resumeDraft = (draft: ExecutionDraftDto) => {
    setEntry(draft.source)
    setOrderId(draft.orderId)
    setOrderOperationId(draft.orderOperationId ?? '')
    const output = draft.outputs[0]
    if (output) {
      setQuantity(output.quantity)
      setQualifiedQty(output.qualifiedQty)
      setCarrierCode(output.carrierCode ?? '')
      const target = LINE_SIDE_TARGETS.find((t) => t.value === output.targetLocationId)
      setTargetLocationId(target?.value ?? LINE_SIDE_TARGETS[0]!.value)
    }
    setRemark(draft.remark ?? '')
    setFormNotice($t('已带入草稿（会话 {p0}…）；编辑后可再次保存或提交', { p0: draft.sessionId.slice(0, 10) }))
  }

  const doReview = async () => {
    if (!reviewDetail) return
    setReviewBusy(true)
    setReviewError(null)
    try {
      const result = await api.reviewReport(reviewDetail.report.id)
      const data = (result.data ?? {}) as { stockedUnits?: string[] }
      setReviewNotice($t('已审核通过；产出已转线边库（入库单元 {p0} 个）', { p0: data.stockedUnits?.length ?? 0 }))
      await loadReviewDetail(reviewDetail.report.id)
      if (fiveOrderId === reviewDetail.report.orderId) {
        api.orderQuantities(reviewDetail.report.orderId).then(setFive).catch(() => undefined)
      }
    } catch (err) {
      setReviewError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('审核失败') })
    } finally {
      setReviewBusy(false)
    }
  }

  const doCancelReview = async () => {
    if (!reviewDetail) return
    setReviewBusy(true)
    setReviewError(null)
    try {
      await api.cancelReportReview(reviewDetail.report.id, { reason: cancelReason }, { reason: cancelReason })
      setReviewNotice($t('已取消审核（回待审留痕）'))
      setCancelOpen(false)
      setCancelReason('')
      await loadReviewDetail(reviewDetail.report.id)
      if (fiveOrderId === reviewDetail.report.orderId) {
        api.orderQuantities(reviewDetail.report.orderId).then(setFive).catch(() => undefined)
      }
    } catch (err) {
      setReviewError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('取消审核失败') })
    } finally {
      setReviewBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('报工工作台')}>
        <Message kind="warning" title={$t('没有执行查询许可（execution.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('报工工作台')}
      description={$t('三入口同规则（[A6-1] 仅来源不同）；产出转线边库（[A6-5]）；审核通过即入库（五量 stocked 口径）；审核轴守卫错误原文渲染')}
    >
      {/* 三入口语义入口 */}
      <section aria-label={$t('报工入口')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10, marginBottom: 18 }}>
        {ENTRY_OPTIONS.map((option) => (
          <button
            key={option.value}
            onClick={() => setEntry(option.value)}
            style={{
              textAlign: 'left',
              padding: '12px 14px',
              borderRadius: 8,
              border: entry === option.value ? '2px solid var(--cz-color-primary)' : '1px solid var(--cz-color-border)',
              background: entry === option.value ? 'var(--cz-color-bg-hover)' : 'var(--cz-color-bg-surface)',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontWeight: 700 }}>
              {$tx(option.label)}
              {entry === option.value ? <Badge tone="info">{$t('当前入口')}</Badge> : null}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)', marginTop: 4 }}>{$tx(option.desc)}</div>
          </button>
        ))}
      </section>

      {/* 草稿箱 */}
      <section aria-label={$t('草稿箱')} style={{ marginBottom: 18 }}>
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>
          {$t('草稿箱：')}<Badge tone={draftTotal > 0 ? 'warning' : 'default'}>{draftTotal} {$t('条待提交')}</Badge>
        </h3>
        <Table<ExecutionDraftDto>
          columns={[
            { key: 'reportId', title: $t('报工单'), render: (d) => d.reportId ?? $t('（未生成）') },
            { key: 'source', title: $t('来源'), render: (d) => <Badge>{$tx(EXECUTION_SOURCE_LABELS[d.source]) ?? d.source}</Badge> },
            { key: 'operationSeq', title: $t('工序'), render: (d) => (d.operationSeq !== null ? $t('第 {p0} 道', { p0: d.operationSeq }) : '—') },
            { key: 'operatorLogin', title: $t('操作工') },
            {
              key: 'outputs',
              title: $t('产出'),
              render: (d) =>
                d.outputs.length === 0 ? (
                  '—'
                ) : (
                  <span>
                    {d.outputs[0]!.quantity} <b style={{ fontSize: 12 }}>{d.outputs[0]!.uomCode}</b>
                  </span>
                ),
            },
            {
              key: 'actions',
              title: $t('操作'),
              render: (d) => (
                <Button size="sm" variant="secondary" disabled={!canReport} onClick={() => resumeDraft(d)}>
                  {$t('续作')}
                </Button>
              ),
            },
          ]}
          rows={drafts}
          rowKey={(d) => d.sessionId}
          emptyText={$t('暂无待提交草稿')}
        />
      </section>

      {/* 报工表单 */}
      <section aria-label={$t('报工表单')} style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 14, marginBottom: 18, background: 'var(--cz-color-bg-surface)' }}>
        <h3 style={{ fontSize: 15, margin: '0 0 10px' }}>
          {$t('报工表单（{p0}）', { p0: $tx(EXECUTION_SOURCE_LABELS[entry]) ?? entry })}
          {!canReport ? <Badge tone="warning">{$t('需 execution.report 许可')}</Badge> : null}
        </h3>
        {formError ? <Message kind="error" title={formError.title} detail={formError.detail} /> : null}
        {formNotice ? <Message kind="success" title={formNotice} /> : null}
        <Form onSubmit={() => void submitReport('submit')} style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
          {entry === 'scan' ? (
            <Field label={$t('设备码（扫码/输入设备 ID）')} required>
              <div style={{ display: 'flex', gap: 8 }}>
                <Input style={{ width: 200 }} value={scanEquipment} onChange={(e) => setScanEquipment(e.target.value)} placeholder={$t('如 eq-0001')} />
                <Button variant="secondary" onClick={() => void equipmentContext()}>
                  {$t('带出任务')}
                </Button>
              </div>
            </Field>
          ) : null}
          <Field label={$t('生产订单')} required>
            <Select
              style={{ width: 260 }}
              aria-label={$t('生产订单选择')}
              value={orderId}
              onChange={(e) => {
                setOrderId(e.target.value)
                setOrderOperationId('')
              }}
              placeholder={$t('选择订单（已下达/进行中）')}
              options={orders.map((o) => ({ value: o.id, label: $t('{p0}（{p1} {p2}）', { p0: o.orderNo, p1: o.productionQty, p2: o.uom }) }))}
            />
          </Field>
          <Field label={$t('工序')} required hint={$t('质检工序不可选（[A6-3] 服务端终校）')}>
            <Select
              style={{ width: 200 }}
              aria-label={$t('工序选择')}
              value={orderOperationId}
              onChange={(e) => setOrderOperationId(e.target.value)}
              placeholder={$t('选择工序')}
              options={operations.map((op) => ({ value: op.id, label: `${op.seq}. ${op.operationName}` }))}
            />
          </Field>
          <Field label={$t('产出数量{p0}', { p0: selectedOrder ? $t('（单位 {p0}，与订单一致 [A5-2]）', { p0: selectedOrder.uom }) : '' })} required>
            <Input style={{ width: 150 }} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={$t('如 3.0000')} />
          </Field>
          <Field label={$t('合格数量')} hint={$t('缺省等于产出数量；不得大于产出数量')}>
            <Input style={{ width: 150 }} value={qualifiedQty} onChange={(e) => setQualifiedQty(e.target.value)} placeholder={$t('缺省＝产出数量')} />
          </Field>
          <Field label={$t('载体码')}>
            <Input style={{ width: 170 }} value={carrierCode} onChange={(e) => setCarrierCode(e.target.value)} placeholder={$t('如 E2A0000001')} />
          </Field>
          <Field label={$t('目标线边库')} required hint={$t('产出只能转入线边库（[A6-5]）')}>
            <Select style={{ width: 220 }} value={targetLocationId} onChange={(e) => setTargetLocationId(e.target.value)} options={LINE_SIDE_TARGETS} />
          </Field>
          <Field label={$t('备注')}>
            <Input style={{ width: 200 }} value={remark} onChange={(e) => setRemark(e.target.value)} />
          </Field>
          <div style={{ display: 'flex', gap: 8, paddingTop: 22 }}>
            <Button type="submit" loading={formBusy} disabled={!canReport}>
              {$t('提交报工')}
            </Button>
            <Button variant="secondary" loading={formBusy} disabled={!canReport} onClick={() => void submitReport('draft')}>
              {$t('保存草稿')}
            </Button>
          </div>
        </Form>
      </section>

      {/* 审核操作 */}
      <section aria-label={$t('审核操作')} style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 14, marginBottom: 18, background: 'var(--cz-color-bg-surface)' }}>
        <h3 style={{ fontSize: 15, margin: '0 0 10px' }}>
          {$t('审核操作')}
          {canReview ? null : <Badge tone="warning">{$t('需 execution.review 许可')}</Badge>}
        </h3>
        {!canReview ? (
          <Message kind="info" title={$t('当前账号无审核许可（PC-10：操作入口不出现）；查询仍可用')} />
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <Input
                style={{ width: 240 }}
                value={reviewIdInput}
                onChange={(e) => setReviewIdInput(e.target.value)}
                placeholder={$t('输入报工单号（如 rp-002）')}
                aria-label={$t('报工单号')}
              />
              <Button variant="secondary" loading={reviewBusy} onClick={() => void loadReviewDetail(reviewIdInput)}>
                {$t('查询报工单')}
              </Button>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)', margin: '0 0 10px' }}>
              {$t('后端暂无「已提交待审列表」端点（本波以单号取单审核；列表端点为后端遗留，见交付记录）。')}
            </p>
            {reviewError ? <Message kind="error" title={reviewError.title} detail={reviewError.detail} /> : null}
            {reviewNotice ? <Message kind="success" title={reviewNotice} /> : null}
            {reviewDetail ? (
              <div style={{ fontSize: 13.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span>
                  {$t('报工单')} <b>{reviewDetail.report.id}</b>{$t('｜订单')} {reviewDetail.report.orderId}{$t('｜第')} {reviewDetail.report.operationSeq} {$t('道工序｜ 状态')} <Badge>{REPORT_STATUS_LABELS[reviewDetail.report.status]}</Badge>{$t('｜审核')}{' '}
                  <Badge tone={reviewDetail.report.reviewStatus === 'manual_approved' ? 'success' : 'warning'}>
                    {REVIEW_STATUS_LABELS[reviewDetail.report.reviewStatus]}
                  </Badge>
                </span>
                <span>
                  {$t('产出：')}{reviewDetail.outputs.map((o) => `${o.quantity} ${o.uomCode}${o.carrierCode ? `（载体 ${o.carrierCode}）` : ''} → ${o.targetLocationCode}`).join('；')}
                  {reviewDetail.outputs.some((o) => o.stockUnitId !== null) ? $t('（已入库）') : ''}
                </span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <Button size="sm" loading={reviewBusy} onClick={() => void doReview()}>
                    {$t('审核通过（转线边库）')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setCancelOpen(true)}>
                    {$t('取消审核')}
                  </Button>
                </span>
              </div>
            ) : null}
          </>
        )}
      </section>

      {/* 五量分栏 */}
      <section aria-label={$t('五量分栏')}>
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('五量分栏（[A5-3] 草稿/提交/审核/合格/入库，不做混口径）')}</h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <Select
            style={{ width: 300 }}
            aria-label={$t('五量订单选择')}
            value={fiveOrderId}
            onChange={(e) => setFiveOrderId(e.target.value)}
            placeholder={$t('选择订单查看五量')}
            options={orders.map((o) => ({ value: o.id, label: o.orderNo }))}
          />
        </div>
        {fiveError ? <Message kind="error" title={fiveError.title} detail={fiveError.detail} /> : null}
        {five ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 12 }}>
              {(
                [
                  ['草稿量', five.total.draftQty],
                  ['提交量', five.total.submittedQty],
                  ['审核量', five.total.approvedQty],
                  ['合格量', five.total.qualifiedQty],
                  ['入库量', five.total.stockedQty],
                ] as const
              ).map(([label, value]) => (
                <div key={label} style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: '10px 12px', background: 'var(--cz-color-bg-surface)' }}>
                  <div style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>{label}</div>
                  <div style={{ fontSize: 17, fontWeight: 700 }}>
                    {value} <span style={{ fontSize: 12, fontWeight: 400 }}>{five.uom}</span>
                  </div>
                </div>
              ))}
            </div>
            <Table
              columns={[
                { key: 'seq', title: $t('序'), width: 40 },
                { key: 'operationName', title: $t('工序') },
                { key: 'isQc', title: $t('质检工序'), render: (row: OrderQuantitiesDto['operations'][number]) => (row.isQc ? <Badge tone="warning">{$t('质检')}</Badge> : '—') },
                { key: 'draftQty', title: $t('草稿量'), render: (row: OrderQuantitiesDto['operations'][number]) => `${row.quantities.draftQty} ${five.uom}` },
                { key: 'submittedQty', title: $t('提交量'), render: (row: OrderQuantitiesDto['operations'][number]) => `${row.quantities.submittedQty} ${five.uom}` },
                { key: 'approvedQty', title: $t('审核量'), render: (row: OrderQuantitiesDto['operations'][number]) => `${row.quantities.approvedQty} ${five.uom}` },
                { key: 'qualifiedQty', title: $t('合格量'), render: (row: OrderQuantitiesDto['operations'][number]) => `${row.quantities.qualifiedQty} ${five.uom}` },
                { key: 'stockedQty', title: $t('入库量'), render: (row: OrderQuantitiesDto['operations'][number]) => `${row.quantities.stockedQty} ${five.uom}` },
                { key: 'ready', title: $t('就绪'), render: (row: OrderQuantitiesDto['operations'][number]) => (row.ready ? <Badge tone="success">{$t('就绪')}</Badge> : <Badge tone="warning">{row.readyReason}</Badge>) },
              ]}
              rows={five.operations}
              rowKey={(row: OrderQuantitiesDto['operations'][number]) => row.orderOperationId}
              emptyText={$t('暂无工序')}
            />
          </>
        ) : (
          <Message kind="info" title={$t('选择订单后展示五量分栏')} />
        )}
      </section>

      <Modal
        open={cancelOpen}
        title={$t('取消审核')}
        onClose={() => setCancelOpen(false)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              {$t('取消')}
            </Button>
            <Button variant="danger" loading={reviewBusy} disabled={!cancelReason.trim()} onClick={() => void doCancelReview()}>
              {$t('确认取消审核')}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, margin: '0 0 10px', lineHeight: 1.8 }}>
          {$t('取消审核后报产回待审（留痕）；产出已入库/被消耗/质检完成将被守卫拦截（[A6-6]）。')}
        </p>
        <Field label={$t('取消原因')} required error={!cancelReason.trim() ? $t('取消审核必须填写原因（OA-29）') : undefined}>
          <Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
        </Field>
      </Modal>
    </PageContainer>
  )
}
