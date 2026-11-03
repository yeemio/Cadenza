import {
  ApiError,
  Badge,
  Button,
  Field,
  Form,
  Input,
  Message,
  Modal,
  OPERATION_EXECUTION_STATUS_LABELS,
  PageContainer,
  PRODUCTION_ORDER_STATUS_LABELS,
  Select,
  Table,
  formatErrorTitleAndDetail,
  type OrderOperationDto,
  type ProductionOrderDto,
  t as $t,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { PROCESS_ADMIN, PROCESS_READ, usePermissions } from '../permissions'

interface OrderDetail {
  order: ProductionOrderDto | null
  operations: OrderOperationDto[]
}

/** 生命周期动作清单（[底稿 A1-1] 状态轴；操作按 process.admin 显隐 PC-10） */
const LIFECYCLE_ACTIONS = [
  { key: 'release', label: '放行', from: ['approved'] },
  { key: 'start', label: '开工', from: ['released'] },
  { key: 'suspend', label: '挂起', from: ['in_progress'], needReason: true },
  { key: 'resume', label: '解除挂起', from: [] },
  { key: 'void', label: '作废', from: ['approved', 'released', 'in_progress', 'pending_completion'], confirm: true },
] as const

/**
 * 生产订单详情（[底稿 A2-3] 工序明细快照：芯倍数/绞合系数/下线数量/设置版本）：
 * - 数量与单位同现（PC-06）；工序行含工作中心与执行状态；
 * - 生命周期操作（放行/开工/挂起/解除挂起/作废）按 process.admin 显隐，挂起/作废
 *   强制原因（OA-29），作废走 ConfirmModal 显式后果（PC-13）；服务端守卫错误渲染（PC-14）；
 * - 接收生产订单（模拟 U9 入站）入口（process.admin）。
 */
export function ProductionOrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { has } = usePermissions()
  const canRead = has(PROCESS_READ)
  const canAdmin = has(PROCESS_ADMIN)
  const isNew = id === 'new'
  const [detail, setDetail] = useState<OrderDetail | null>(null)
  const [loading, setLoading] = useState(!isNew)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [suspendOpen, setSuspendOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  // 接收表单（模拟 U9 入站）
  const [form, setForm] = useState({ orderNo: '', materialId: 'm-0005', productionQty: '', uom: 'KM' })

  const load = useCallback(() => {
    if (isNew || !id) return
    let alive = true
    setLoading(true)
    api
      .productionOrderDetail(id)
      .then((result) => {
        if (!alive) return
        setDetail(result)
        setError(null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载订单详情失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [id, isNew])

  useEffect(() => {
    load()
  }, [load])

  const runAction = async (action: string, payload?: { reason?: string }) => {
    if (!id) return
    setBusy(true)
    try {
      let result
      if (action === 'release') result = await api.releaseProductionOrder(id)
      else if (action === 'start') result = await api.startProductionOrder(id)
      else if (action === 'suspend') result = await api.suspendProductionOrder(id, { reason: payload?.reason }, { reason: payload?.reason })
      else if (action === 'resume') result = await api.resumeProductionOrder(id)
      else if (action === 'void') result = await api.voidProductionOrder(id, { reason: payload?.reason ?? '订单作废' })
      setNotice($t('操作已提交（{p0}）', { p0: result?.status ?? 'COMMITTED' }))
      setSuspendOpen(false)
      setVoidOpen(false)
      setReason('')
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('操作失败') })
    } finally {
      setBusy(false)
    }
  }

  const submitReceive = async () => {
    if (!form.orderNo.trim() || !form.productionQty.trim()) {
      setError({ title: $t('请填写生产单号与生产数量') })
      return
    }
    setBusy(true)
    try {
      await api.receiveProductionOrder({
        orderNo: form.orderNo.trim(),
        materialId: form.materialId,
        productionDeptId: 'n-draw',
        productionQty: form.productionQty.trim(),
        uom: form.uom,
      })
      setNotice($t('订单 {p0} 已接收（模拟 U9 入站，初始状态已审批）', { p0: form.orderNo.trim() }))
      setForm({ orderNo: '', materialId: 'm-0005', productionQty: '', uom: 'KM' })
      navigate('/production/orders')
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('接收订单失败') })
    } finally {
      setBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('订单详情')}>
        <Message kind="warning" title={$t('没有生产订单查询许可（process.read）')} />
      </PageContainer>
    )
  }

  if (isNew) {
    return (
      <PageContainer title={$t('接收生产订单')} description={$t('模拟 U9 入站（process.order.receive）：同企业生产单号唯一；初始状态已审批（可模拟上游已放行）')}>
        {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
        {canAdmin ? (
          <Form
            onSubmit={() => void submitReceive()}
            style={{ maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            <Field label={$t('生产单号')} required>
              <Input value={form.orderNo} onChange={(e) => setForm({ ...form, orderNo: e.target.value })} placeholder={$t('如 MO-2026-1028-001')} />
            </Field>
            <Field label={$t('物料')} required>
              <Select
                value={form.materialId}
                onChange={(e) => setForm({ ...form, materialId: e.target.value })}
                options={[
                  { value: 'm-0005', label: $t('STRAND-4X120 绞合导体 4×120') },
                  { value: 'm-0006', label: $t('YJV-3X70 电缆') },
                  { value: 'm-0007', label: $t('YJV-4X35 电缆') },
                ]}
              />
            </Field>
            <Field label={$t('生产数量')} required hint={$t('十进制定点字符串（≤4 位小数）')}>
              <Input value={form.productionQty} onChange={(e) => setForm({ ...form, productionQty: e.target.value })} placeholder={$t('如 12.0000')} />
            </Field>
            <Field label={$t('单位')} required>
              <Input value={form.uom} onChange={(e) => setForm({ ...form, uom: e.target.value })} />
            </Field>
            <div>
              <Button type="submit" loading={busy}>
                {$t('接收订单')}
              </Button>
            </div>
          </Form>
        ) : (
          <Message kind="warning" title={$t('接收订单需要 process.admin 许可（PC-10：无许可不出现可提交入口）')} />
        )}
      </PageContainer>
    )
  }

  const order = detail?.order ?? null
  return (
    <PageContainer
      title={order ? $t('订单 {p0}', { p0: order.orderNo }) : $t('订单详情')}
      description={$t('工序明细为接收时冻结的快照（芯倍数/绞合系数/下线数量/设置版本，[底稿 A2-3]）')}
      actions={
        order && canAdmin ? (
          <>
            {LIFECYCLE_ACTIONS.map((action) => {
              const applicable = action.key === 'resume' ? order.suspended : action.from.includes(order.orderStatus as never)
              if (!applicable) return null
              if (action.key === 'suspend') {
                return (
                  <Button key={action.key} size="sm" variant="secondary" onClick={() => setSuspendOpen(true)}>
                    {action.label}
                  </Button>
                )
              }
              if (action.key === 'void') {
                return (
                  <Button key={action.key} size="sm" variant="danger" onClick={() => setVoidOpen(true)}>
                    {action.label}
                  </Button>
                )
              }
              return (
                <Button
                  key={action.key}
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  onClick={() => void runAction(action.key)}
                >
                  {action.label}
                </Button>
              )
            })}
            <Link to="/production/orders/new" style={{ fontSize: 13, alignSelf: 'center' }}>
              {$t('接收新订单')}
            </Link>
          </>
        ) : null
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}
      {!order ? (
        <Message kind={loading ? 'info' : 'warning'} title={loading ? $t('加载中…') : $t('订单不存在或不在授权数据范围内')} />
      ) : (
        <>
          <section
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
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
              {$t('订单状态：')}
              <Badge tone={order.orderStatus === 'in_progress' ? 'success' : order.orderStatus === 'voided' ? 'danger' : 'info'}>
                {PRODUCTION_ORDER_STATUS_LABELS[order.orderStatus] ?? order.orderStatus}
              </Badge>
              {order.suspended ? (
                <>
                  {' '}
                  <Badge tone="danger">{$t('挂起（')}{order.suspendedReason ?? $t('未填原因')}{$t('）')}</Badge>
                </>
              ) : null}
            </span>
            <span>
              {$t('生产数量：')}<b>{order.productionQty}</b> <b style={{ fontSize: 12 }}>{order.uom}</b>
              {order.overrunRatio ? <span style={{ color: 'var(--cz-color-text-secondary)' }}>{$t('（超额比例')} {order.overrunRatio}{$t('）')}</span> : null}
            </span>
            <span>{$t('销售订单号：')}{order.salesOrderNo ?? '—'}</span>
            <span>{$t('工序设置版本：v')}{order.currentSettingsVersion}{$t('（快照版本）')}</span>
            <span>{$t('开工时间：')}{order.actualStartAt ?? '—'}</span>
            <span>{$t('BOM 版本：')}{order.bomRevisionId ?? '—'}{$t('｜路线版本：')}{order.routeRevisionId ?? '—'}</span>
            <span style={{ display: 'flex', gap: 8 }}>
              <Link to={`/production/scheduling?orderId=${encodeURIComponent(order.id)}`} style={{ fontSize: 13 }}>
                {$t('前往排程（订单视图）')}
              </Link>
              <Link to={`/production/workbench?orderId=${encodeURIComponent(order.id)}`} style={{ fontSize: 13 }}>
                {$t('前往报工工作台')}
              </Link>
            </span>
          </section>
          <Table<OrderOperationDto>
            loading={loading}
            columns={[
              { key: 'seq', title: $t('序'), width: 44 },
              { key: 'operationCode', title: $t('工序编码') },
              { key: 'operationName', title: $t('工序名称') },
              { key: 'coreMultiple', title: $t('芯倍数'), render: (op) => <b>×{op.coreMultiple}</b> },
              { key: 'strandFactor', title: $t('绞合系数'), render: (op) => op.strandFactor ?? '—' },
              {
                key: 'offlineQty',
                title: $t('下线数量'),
                render: (op) => (
                  <span>
                    {op.offlineQty} <b style={{ fontSize: 12 }}>{op.uom}</b>
                  </span>
                ),
              },
              { key: 'workCenterName', title: $t('工作中心'), render: (op) => `${op.workCenterName}（${op.workCenterCode}）` },
              { key: 'settingsVersion', title: $t('设置版本'), render: (op) => `v${op.settingsVersion}` },
              {
                key: 'executionStatus',
                title: $t('执行状态'),
                render: (op) =>
                  op.executionStatus === 'executed' ? (
                    <Badge tone="success">{OPERATION_EXECUTION_STATUS_LABELS[op.executionStatus]}</Badge>
                  ) : (
                    <Badge>{OPERATION_EXECUTION_STATUS_LABELS[op.executionStatus]}</Badge>
                  ),
              },
            ]}
            rows={detail?.operations ?? []}
            rowKey={(op) => op.id}
            emptyText={$t('暂无工序明细（订单未展开路线）')}
          />
        </>
      )}

      <Modal open={suspendOpen} title={$t('挂起订单')} onClose={() => setSuspendOpen(false)} size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSuspendOpen(false)}>{$t('取消')}</Button>
            <Button loading={busy} onClick={() => void runAction('suspend', { reason })}>{$t('确认挂起')}</Button>
          </>
        }
      >
        <Field label={$t('挂起原因')} required error={!reason.trim() ? $t('挂起必须填写原因（OA-29）') : undefined}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={$t('如：客户规格变更待确认')} />
        </Field>
      </Modal>

      {order ? (
        <Modal open={voidOpen} title={$t('作废订单')} onClose={() => setVoidOpen(false)} size="sm"
          footer={
            <>
              <Button variant="secondary" onClick={() => setVoidOpen(false)}>{$t('取消')}</Button>
              <Button variant="danger" loading={busy} onClick={() => void runAction('void', { reason })}>{$t('确认作废')}</Button>
            </>
          }
        >
          <p style={{ fontSize: 14, lineHeight: 1.8, margin: 0 }}>
            {$t('作废后订单')} {order.orderNo} {$t('不可再排产/报工（[A3-5]/[A6-1]），已有排产从看板隐藏、历史数据保留审计。')}
          </p>
          <div style={{ marginTop: 10 }}>
            <Field label={$t('作废原因')} required error={!reason.trim() ? $t('作废必须填写原因') : undefined}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        </Modal>
      ) : null}
    </PageContainer>
  )
}
