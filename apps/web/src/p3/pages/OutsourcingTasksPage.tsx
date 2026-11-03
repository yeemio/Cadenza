import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Field, Input, Message, Modal, PageContainer, Select, Table, t as $t, tx as $tx } from '@cadenza/ui'
import {
  formatP3Error,
  type CswOutsourcingTaskView,
  type CswOutsourcingUnitView,
} from '../../../../../packages/ui/src/api/p3'
import { createWebP3Client } from '../client'
import { CSW_POST, CSW_READ, useP3Permissions } from '../permissions'
import { P3_PAGE_SIZE, useP3AsyncList } from '../shared'

/**
 * 外协任务页（CS-19～CS-25，后端并行实施中——形状按当前 csw 控制器/仓储，L0 整合对账）：
 * 状态机 草稿→待发送→已发送（在外加工）→回厂接收→检验→关闭（取消另记：收回/退回处置）；
 * 材料所有权保留（CS-20）与外协占用（CS-25）提示；两段原子步单元行（CS-21）；
 * 回厂默认全部必检（CS-22）；ERP 加工数量事实导出（CS-24，商务结算归 ERP）。
 */

const STATUS_STEPS: Array<{ value: CswOutsourcingTaskView['status']; label: string }> = [
  { value: 'draft', label: '草稿' },
  { value: 'pending_send', label: '待发送' },
  { value: 'sent', label: '已发送（在外加工）' },
  { value: 'return_received', label: '回厂接收' },
  { value: 'inspecting', label: '检验' },
  { value: 'closed', label: '关闭' },
]

interface LineForm {
  unitId: string
  quantity: string
  returnLotNo: string
}

export function OutsourcingTasksPage() {
  const { has } = useP3Permissions()
  const canRead = has(CSW_READ)
  const canPost = has(CSW_POST)
  const client = useMemo(() => createWebP3Client(), [])
  const [statusFilter, setStatusFilter] = useState('')
  const tasks = useP3AsyncList<CswOutsourcingTaskView>(
    (p) =>
      client.cswListOutsourcingTasks({
        page: p,
        pageSize: P3_PAGE_SIZE,
        status: statusFilter === '' ? undefined : statusFilter,
      }),
    [statusFilter],
  )
  const [detail, setDetail] = useState<{ task: CswOutsourcingTaskView; units: CswOutsourcingUnitView[] } | null>(null)
  const [erp, setErp] = useState<{ facts: Array<Record<string, string | null>>; note: string } | null>(null)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lineModal, setLineModal] = useState<{ mode: 'send' | 'receive'; task: CswOutsourcingTaskView } | null>(null)
  const [lines, setLines] = useState<LineForm[]>([{ unitId: '', quantity: '', returnLotNo: '' }])
  const [inspectModal, setInspectModal] = useState<CswOutsourcingTaskView | null>(null)
  const [inspectResult, setInspectResult] = useState<'passed' | 'rejected'>('passed')

  const loadErp = useCallback(() => {
    if (!canRead) return
    client
      .cswOutsourcingErpExport({})
      .then((resp) => setErp({ facts: resp.facts as Array<Record<string, string | null>>, note: resp.note }))
      .catch(() => setErp(null))
  }, [canRead, client])

  useEffect(() => {
    loadErp()
  }, [loadErp])

  const loadDetail = useCallback(
    (taskId: string) => {
      client
        .cswOutsourcingDetail(taskId)
        .then(setDetail)
        .catch(() => setDetail(null))
    },
    [client],
  )

  const runCommand = async (action: string, fn: () => Promise<{ data: unknown }>, successNote: (data: unknown) => string) => {
    void action
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const resp = await fn()
      setNotice(successNote(resp.data))
      tasks.reload()
      loadErp()
      setLineModal(null)
      setInspectModal(null)
      setLines([{ unitId: '', quantity: '', returnLotNo: '' }])
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  const submitLines = async () => {
    if (lineModal === null) return
    const valid = lines.filter((l) => l.unitId.trim() !== '' && l.quantity.trim() !== '')
    if (valid.length === 0) {
      setError({ title: $t('[CS-21] 交接须携带单元行（单元 ID＋数量），不整单凭空出入库') })
      return
    }
    if (lineModal.mode === 'send') {
      await runCommand(
        $t('发送'),
        () =>
          client.cswOutsourcingSend({
            taskId: lineModal.task.id,
            lines: valid.map((l) => ({ unitId: l.unitId.trim(), quantity: l.quantity.trim() })),
            reason: '外协发送（页面）',
          }),
        () => $t('已发送（在外加工）：材料所有权保留不变，库存状态转入外协在途（CS-20）；本厂该工序不排产（CS-25）'),
      )
    } else {
      await runCommand(
        $t('回厂接收'),
        () =>
          client.cswOutsourcingReceive({
            taskId: lineModal.task.id,
            lines: valid.map((l) => ({ unitId: l.unitId.trim(), quantity: l.quantity.trim(), returnLotNo: l.returnLotNo.trim() === '' ? undefined : l.returnLotNo.trim() })),
            reason: '外协回厂接收（页面）',
          }),
        () => $t('回厂接收完成（外协在途减＋回厂目的增，两段各自原子 CS-21）；回厂后默认全部必检（CS-22）'),
      )
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('外协任务')} description={$t('外协状态机与所有权保留（CS-19～CS-25）')}>
        <Message kind="warning" title={$t('无外协查询权限（csw.read）')}>{$t('未授予外协域查询许可，请联系管理员授权后使用。')}</Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('外协任务')}
      description={$t('状态机：草稿→待发送→已发送（在外加工）→回厂接收→检验→关闭；发送后取消走收回、回厂后取消走退回处置（CS-19）')}
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, maxWidth: 360 }}>
        <Select
          aria-label={$t('状态筛选')}
          value={statusFilter}
          placeholder={$t('全部状态')}
          options={[
            ...STATUS_STEPS.map((s) => ({ value: s.value, label: $tx(s.label) })),
            { value: 'recalled', label: $t('已收回') },
            { value: 'return_disposed', label: $t('已退回处置') },
          ]}
          onChange={(e) => setStatusFilter(e.target.value)}
        />
      </div>

      <Table
        columns={[
          { key: 'taskNo', title: $t('任务号') },
          { key: 'order', title: $t('订单/工序'), render: (t) => `${t.orderNo}／${t.operationName}` },
          { key: 'supplierName', title: $t('供应方') },
          { key: 'qty', title: $t('数量'), render: (t) => `${t.qty} ${t.uom}` },
          { key: 'sent', title: $t('发送/回厂'), render: (t) => `${t.sentQty} / ${t.returnedQty}` },
          { key: 'status', title: $t('状态'), render: (t) => <Badge tone={t.status === 'closed' ? 'success' : t.status === 'sent' || t.status === 'return_received' || t.status === 'inspecting' ? 'info' : t.status === 'recalled' || t.status === 'return_disposed' ? 'default' : 'warning'}>{t.statusLabel}</Badge> },
          { key: 'occupation', title: $t('外协占用'), render: (t) => (t.occupationActive ? <Badge tone="warning">{$t('占用中（本厂不排产）')}</Badge> : '—') },
          {
            key: 'actions',
            title: $t('操作（按状态启用，服务端终校）'),
            render: (t) => {
              if (!canPost) return null
              const buttons: React.ReactNode[] = []
              if (t.status === 'draft') {
                buttons.push(
                  <Button key="submit" size="sm" disabled={busy} onClick={() => void runCommand($t('提交'), () => client.cswOutsourcingSubmit({ taskId: t.id, reason: '提交待发送' }), () => $t('已提交待发送'))}>
                    {$t('提交待发送')}
                  </Button>,
                )
              }
              if (t.status === 'pending_send') {
                buttons.push(
                  <Button key="send" size="sm" disabled={busy} onClick={() => setLineModal({ mode: 'send', task: t })}>
                    {$t('发送')}
                  </Button>,
                )
              }
              if (t.status === 'sent') {
                buttons.push(
                  <Button key="receive" size="sm" disabled={busy} onClick={() => setLineModal({ mode: 'receive', task: t })}>
                    {$t('回厂接收')}
                  </Button>,
                  <Button key="recall" size="sm" variant="secondary" disabled={busy} onClick={() => void runCommand($t('收回'), () => client.cswOutsourcingRecall({ taskId: t.id, reason: '计划员收回（演示）' }), () => $t('已收回（发送后取消走收回流程，CS-19）'))}>
                    {$t('收回')}
                  </Button>,
                )
              }
              if (t.status === 'return_received') {
                buttons.push(
                  <Button key="inspect" size="sm" disabled={busy} onClick={() => setInspectModal(t)}>
                    {$t('检验结论')}
                  </Button>,
                  <Button key="dispose" size="sm" variant="secondary" disabled={busy} onClick={() => void runCommand($t('退回处置'), () => client.cswOutsourcingDispose({ taskId: t.id, reason: '检验不合格退回处置' }), () => $t('已退回处置（回厂后取消走退回处置，CS-19）'))}>
                    {$t('退回处置')}
                  </Button>,
                )
              }
              if (t.status === 'inspecting') {
                buttons.push(
                  <Button key="close" size="sm" disabled={busy || t.inspectionResult !== 'passed'} onClick={() => void runCommand($t('关闭'), () => client.cswOutsourcingClose({ taskId: t.id, reason: '检验通过关闭' }), () => $t('已关闭：工序完成判定走报工/接收事实，不以「已发送」充当完成（CS-25）'))}>
                    {$t('关闭')}
                  </Button>,
                  t.inspectionResult === 'rejected' ? (
                    <Button key="dispose2" size="sm" variant="secondary" disabled={busy} onClick={() => void runCommand($t('退回处置'), () => client.cswOutsourcingDispose({ taskId: t.id, reason: '检验不合格退回处置' }), () => $t('已退回处置'))}>
                      {$t('退回处置')}
                    </Button>
                  ) : null,
                )
              }
              buttons.push(
                <Button key="detail" size="sm" variant="ghost" onClick={() => loadDetail(t.id)}>
                  {$t('详情')}
                </Button>,
              )
              return <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{buttons}</span>
            },
          },
        ]}
        rows={tasks.items}
        rowKey={(t) => t.id}
        loading={tasks.loading}
        page={{ page: tasks.page, pageSize: P3_PAGE_SIZE }}
        total={tasks.total}
        onPageChange={tasks.setPage}
        emptyText={$t('该状态下暂无外协任务')}
      />

      {detail !== null ? (
        <>
          <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{$t('任务详情：')}{detail.task.taskNo}{$t('（')}{detail.task.statusLabel}{$t('）')}</h3>
          <Message kind="info" title={$t('{p0}／{p1} → {p2}', { p0: detail.task.orderNo, p1: detail.task.operationName, p2: detail.task.supplierName })}>
            {$t('发送')} {detail.task.sentQty} {detail.task.uom}{$t('／回厂')} {detail.task.returnedQty}{$t('；回厂位')} {detail.task.returnLocationCode ?? '—'}{$t('； 检验结论')} {detail.task.inspectionResult === null ? '—' : detail.task.inspectionResult === 'passed' ? $t('通过') : detail.task.inspectionResult === 'pending' ? $t('待检') : $t('不合格')}{$t('。 材料所有权保留不变（CS-20）；外协谱系保留父子边（CS-23）。')}
          </Message>
          <Table
            columns={[
              { key: 'unitNo', title: $t('单元号') },
              { key: 'sentQty', title: $t('发送量') },
              { key: 'returnedQty', title: $t('回厂量') },
              { key: 'returnLotId', title: $t('回厂批次（谱系）'), render: (u) => u.returnLotId ?? '—' },
              { key: 'status', title: $t('单元状态'), render: (u) => (u.status === 'sent' ? <Badge tone="info">{$t('在外加工')}</Badge> : <Badge tone="success">{$t('已回厂')}</Badge>) },
            ]}
            rows={detail.units}
            rowKey={(u) => u.id}
            emptyText={$t('该任务暂无单元行')}
          />
        </>
      ) : null}

      {erp !== null ? (
        <>
          <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{$t('ERP 加工数量事实导出（CS-24）')}</h3>
          <Message kind="info" title={erp.note}>{$t('商务结算归 ERP：本系统不记应付/加工费/发票，仅导出数量事实供结算核对。')}</Message>
          <Table
            columns={[
              { key: 'taskNo', title: $t('任务号') },
              { key: 'supplierName', title: $t('供应方') },
              { key: 'orderNo', title: $t('订单/工序'), render: (f) => `${f.orderNo}／${f.operationName}` },
              { key: 'sentQty', title: $t('发送量'), render: (f) => `${f.sentQty} ${f.uom}` },
              { key: 'returnedQty', title: $t('回厂量') },
              { key: 'closedAt', title: $t('关闭时间'), render: (f) => f.closedAt?.slice(0, 10) ?? '—' },
            ]}
            rows={erp.facts}
            rowKey={(f) => String(f.taskNo)}
            emptyText={$t('暂无已发送事实')}
          />
        </>
      ) : null}

      <Modal
        open={lineModal !== null}
        title={lineModal?.mode === 'send' ? $t('外协发送：{p0}', { p0: lineModal?.task.taskNo ?? '' }) : $t('回厂接收：{p0}', { p0: lineModal?.task.taskNo ?? '' })}
        onClose={() => setLineModal(null)}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLineModal(null)}>{$t('取消')}</Button>
            <Button loading={busy} onClick={() => void submitLines()}>
              {lineModal?.mode === 'send' ? $t('确认发送（来源减＋外协在途增）') : $t('确认接收（外协在途减＋目的增）')}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13, color: 'var(--cz-color-text-secondary)' }}>
          {lineModal?.mode === 'send'
            ? $t('CS-21 两段原子步·发送段：来源仓减＋外协在途位增；材料所有权保留不变（CS-20）。')
            : $t('CS-21 两段原子步·回厂段：外协在途减＋回厂目的位增；可声明回厂新批次（外协谱系父子边，CS-23）。回厂后默认全部必检（CS-22）。')}
        </p>
        {lines.map((line, idx) => (
          <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <Input
              value={line.unitId}
              onChange={(e) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, unitId: e.target.value } : l)))}
              placeholder={$t('单元 ID（如 unit-1005-0001）')}
              aria-label={$t('单元 ID {p0}', { p0: idx + 1 })}
              style={{ flex: 2, minWidth: 180 }}
            />
            <Input
              value={line.quantity}
              onChange={(e) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, quantity: e.target.value } : l)))}
              placeholder={$t('数量')}
              aria-label={$t('数量 {p0}', { p0: idx + 1 })}
              style={{ flex: 1, minWidth: 90 }}
            />
            {lineModal?.mode === 'receive' ? (
              <Input
                value={line.returnLotNo}
                onChange={(e) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, returnLotNo: e.target.value } : l)))}
                placeholder={$t('回厂批次（可选）')}
                aria-label={$t('回厂批次 {p0}', { p0: idx + 1 })}
                style={{ flex: 1, minWidth: 120 }}
              />
            ) : null}
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setLines((prev) => [...prev, { unitId: '', quantity: '', returnLotNo: '' }])}>
          {$t('+ 添加单元行')}
        </Button>
      </Modal>

      <Modal
        open={inspectModal !== null}
        title={$t('回厂检验结论：{p0}', { p0: inspectModal?.taskNo ?? '' })}
        onClose={() => setInspectModal(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setInspectModal(null)}>{$t('取消')}</Button>
            <Button
              loading={busy}
              onClick={() => {
                if (inspectModal !== null) {
                  void runCommand(
                    $t('检验'),
                    () => client.cswOutsourcingInspect({ taskId: inspectModal.id, inspectionResult: inspectResult, reason: '回厂检验（页面）' }),
                    () => $t('检验结论已登记（{p0}）；检验结论与放行走质量合同（CS-22）', { p0: inspectResult === 'passed' ? '通过' : '不合格' }),
                  )
                }
              }}
            >
              {$t('提交检验结论')}
            </Button>
          </>
        }
      >
        <Field label={$t('检验结论（CS-22：默认全部必检）')} required>
          <Select
            value={inspectResult}
            options={[
              { value: 'passed', label: $t('通过（可关闭）') },
              { value: 'rejected', label: $t('不合格（走退回处置）') },
            ]}
            onChange={(e) => setInspectResult(e.target.value as 'passed' | 'rejected')}
            aria-label={$t('检验结论')}
          />
        </Field>
      </Modal>
    </PageContainer>
  )
}
