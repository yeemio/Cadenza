import {
  ApiError,
  Badge,
  Button,
  EQUIPMENT_STATUS_LABELS,
  Field,
  Input,
  Message,
  ORDER_SCHEDULING_STATUS_LABELS,
  ConfirmModal,
  PageContainer,
  PRODUCTION_ORDER_STATUS_LABELS,
  Select,
  formatErrorTitleAndDetail,
  type DeviceBoardViewDto,
  type OrderSchedulingViewDto,
  type ProductionOrderDto,
  t as $t,
} from '@cadenza/ui'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { PROCESS_READ, SCHEDULING_ADMIN, SCHEDULING_READ, usePermissions } from '../permissions'

interface DrawerState {
  open: boolean
  orderId: string
  orderNo: string
  orderOperationId: string
  operationName: string
  offlineQty: string
  uom: string
  equipmentId: string
  productionDate: string
  plannedQty: string
  remark: string
}

const EMPTY_DRAWER: DrawerState = {
  open: false,
  orderId: '',
  orderNo: '',
  orderOperationId: '',
  operationName: '',
  offlineQty: '0.0000',
  uom: '',
  equipmentId: '',
  productionDate: '',
  plannedQty: '',
  remark: '',
}

/**
 * 生产排程页（[底稿 A3] 订单视图/设备视图双 Tab——同一排产事实的两套投影）：
 * - 订单视图：订单选择 → [A3-6] 详情前置（enterable/entryBlocker）+ 工序行
 *   （下线数量/已排数量/是否排完）× 槽位明细；
 * - 设备视图：工作中心 Tab × 设备行 × 日期列（[A3-5] 日期 = 今日起 ∪ 已有排产日）；
 * - 槽位编辑抽屉（scheduling.admin 显隐）：硬校验错误（[A3-2]/[A3-3]）直接渲染；
 *   超产能弱提醒（[A3-2w]）经 ConfirmModal 二次确认后携带 confirm=true 重新提交；
 * - 数量与单位同现（PC-06）。
 */
export function SchedulingPage() {
  const { has } = usePermissions()
  const { session } = useAuth()
  const plantId = session?.user.plantId
  const canRead = has(SCHEDULING_READ)
  const canReadOrders = has(PROCESS_READ)
  const canAdmin = has(SCHEDULING_ADMIN)
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState<'order' | 'device'>('order')
  const [orders, setOrders] = useState<ProductionOrderDto[]>([])
  const [orderId, setOrderId] = useState(searchParams.get('orderId') ?? '')
  const [orderView, setOrderView] = useState<OrderSchedulingViewDto | null>(null)
  const [board, setBoard] = useState<DeviceBoardViewDto | null>(null)
  const [boardWorkCenterId, setBoardWorkCenterId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<DrawerState>(EMPTY_DRAWER)
  const [drawerBusy, setDrawerBusy] = useState(false)
  const [drawerError, setDrawerError] = useState<{ title: string; detail?: string } | null>(null)
  const [weakConfirm, setWeakConfirm] = useState<{ warning: string; payload: Record<string, unknown> } | null>(null)
  const [cellDetail, setCellDetail] = useState<{ equipment: string; date: string } | null>(null)

  // 订单清单（订单视图选择器；含已排产相关的进行中/已下达/已审批）
  useEffect(() => {
    if (!canReadOrders) return
    api
      .listProductionOrders({ page: 1, pageSize: 50, statuses: 'approved,released,in_progress,pending_completion' })
      .then((result) => setOrders(result.items))
      .catch(() => setOrders([]))
  }, [canReadOrders])

  const loadOrderView = useCallback(
    (targetOrderId: string) => {
      if (!targetOrderId) {
        setOrderView(null)
        return
      }
      setLoading(true)
      api
        .schedulingOrderView(targetOrderId)
        .then((view) => {
          setOrderView(view)
          setError(null)
        })
        .catch((err) => {
          setOrderView(null)
          setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载订单视图失败') })
        })
        .finally(() => setLoading(false))
    },
    [],
  )

  useEffect(() => {
    if (canRead && tab === 'order' && orderId) loadOrderView(orderId)
  }, [canRead, tab, orderId, loadOrderView])

  const loadBoard = useCallback(
    (workCenterId: string) => {
      setLoading(true)
      // 企业范围用户须显式 plantId（服务端口径：未指定厂时企业范围不收敛默认厂 → 404）
      api
        .schedulingDeviceView({ plantId: plantId ?? undefined, workCenterId: workCenterId || undefined })
        .then((view) => {
          setBoard(view)
          setError(null)
        })
        .catch((err) => {
          setBoard(null)
          setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载设备视图失败') })
        })
        .finally(() => setLoading(false))
    },
    [plantId],
  )

  useEffect(() => {
    if (canRead && tab === 'device') loadBoard(boardWorkCenterId)
  }, [canRead, tab, boardWorkCenterId, loadBoard])

  // 抽屉打开时确保设备下拉有数据（订单视图下看板未加载则补拉一次）
  useEffect(() => {
    if (drawer.open && (board?.equipments.length ?? 0) === 0 && canRead) {
      loadBoard(boardWorkCenterId)
    }
  }, [drawer.open, board, boardWorkCenterId, canRead, loadBoard])

  const equipmentOptions = useMemo(() => {
    const rows = board?.equipments ?? []
    return rows.map((e) => ({
      value: e.equipmentId,
      label: $t('{p0}（{p1}）{p2}', { p0: e.name, p1: e.code, p2: e.equipmentStatus === 2 ? $t('·维修中[A3-3 禁排]') : '' }),
      disabled: e.equipmentStatus === 2,
    }))
  }, [board])

  const openDrawer = (state: Partial<DrawerState>) => {
    setDrawerError(null)
    setDrawer({ ...EMPTY_DRAWER, productionDate: board?.today ?? '2026-10-27', ...state, open: true })
  }

  /** 槽位保存：硬校验错误渲染；[A3-2w] 弱提醒 → ConfirmModal → confirm=true 重提 */
  const saveSlot = async (confirm: boolean, plannedQty: string) => {
    if (!drawer.orderOperationId || !drawer.equipmentId || !drawer.productionDate) {
      setDrawerError({ title: $t('请完整选择工序、设备与生产日期（[A3-1]）') })
      return
    }
    if (!plannedQty.trim()) {
      setDrawerError({ title: $t('请填写计划产量（改 0 = 删除该槽位）') })
      return
    }
    setDrawerBusy(true)
    try {
      const result = await api.saveScheduleSlot(
        {
          orderOperationId: drawer.orderOperationId,
          equipmentId: drawer.equipmentId,
          productionDate: drawer.productionDate,
          plannedQty: plannedQty.trim(),
          remark: drawer.remark.trim() || undefined,
          confirm,
        },
      )
      const data = (result.data ?? {}) as { warnings?: string[] | null; action?: string }
      setDrawerError(null)
      if (data.warnings && data.warnings.length > 0) {
        setNotice($t('已保存（含超产能弱提醒）：{p0}', { p0: data.warnings.join('；') }))
      } else {
        setNotice($t('槽位已保存'))
      }
      setDrawer({ ...drawer, open: false })
      setWeakConfirm(null)
      if (tab === 'order' && orderId) loadOrderView(orderId)
      if (tab === 'device') loadBoard(boardWorkCenterId)
    } catch (err) {
      if (err instanceof ApiError) {
        const shaped = formatErrorTitleAndDetail(err)
        if ((err.message ?? '').includes('[A3-2w]')) {
          // 弱提醒：文案即二次确认提示；ConfirmModal 确认后携带 confirm=true 重新提交
          setWeakConfirm({ warning: err.message, payload: {} })
          setDrawerError(null)
        } else {
          setDrawerError(shaped)
        }
      } else {
        setDrawerError({ title: $t('保存槽位失败') })
      }
    } finally {
      setDrawerBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('生产排程')}>
        <Message kind="warning" title={$t('没有排产查询许可（scheduling.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 scheduling.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('生产排程')}
      description={$t('订单视图与设备视图读同一排产事实（[A3] 双投影）；槽位保存硬校验一律强拒（[A3-2]/[A3-3]），超设备日产能为弱提醒（[A3-2w]）需确认后重新提交')}
      actions={
        <div role="tablist" aria-label={$t('排程视图')} style={{ display: 'inline-flex', gap: 0, border: '1px solid var(--cz-color-border)', borderRadius: 8, overflow: 'hidden' }}>
          <button
            role="tab"
            aria-selected={tab === 'order'}
            style={{ padding: '7px 16px', border: 'none', cursor: 'pointer', background: tab === 'order' ? 'var(--cz-color-primary)' : 'var(--cz-color-bg-surface)', color: tab === 'order' ? '#fff' : 'inherit' }}
            onClick={() => setTab('order')}
          >
            {$t('订单视图')}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'device'}
            style={{ padding: '7px 16px', border: 'none', cursor: 'pointer', background: tab === 'device' ? 'var(--cz-color-primary)' : 'var(--cz-color-bg-surface)', color: tab === 'device' ? '#fff' : 'inherit' }}
            onClick={() => setTab('device')}
          >
            {$t('设备视图')}
          </button>
        </div>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      {tab === 'order' ? (
        <section>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
            {canReadOrders ? (
              <Select
                style={{ width: 320 }}
                placeholder={$t('选择生产订单（已审批/已下达/进行中/完工待核）')}
                value={orderId}
                onChange={(e) => {
                  setOrderId(e.target.value)
                  const next = new URLSearchParams(searchParams)
                  if (e.target.value) next.set('orderId', e.target.value)
                  else next.delete('orderId')
                  setSearchParams(next, { replace: true })
                }}
                options={orders.map((o) => ({ value: o.id, label: $t('{p0}（{p1}）', { p0: o.orderNo, p1: PRODUCTION_ORDER_STATUS_LABELS[o.orderStatus] ?? o.orderStatus }) }))}
              />
            ) : (
              <Input
                style={{ width: 320 }}
                placeholder={$t('输入订单 ID（无 process.read 许可）')}
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
              />
            )}
            {orderView ? (
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <Badge tone={orderView.schedulingStatus === 'fully_scheduled' ? 'success' : orderView.schedulingStatus === 'partially_scheduled' ? 'warning' : 'default'}>
                  {ORDER_SCHEDULING_STATUS_LABELS[orderView.schedulingStatus]}
                </Badge>
                <span style={{ color: 'var(--cz-color-text-secondary)' }}>{$t('生产单位')} {orderView.uom}</span>
              </span>
            ) : null}
          </div>
          {!orderId ? (
            <Message kind="info" title={$t('请选择订单查看排程详情（[A3-6] 详情前置在加载后校验）')} />
          ) : loading ? (
            <Message kind="info" title={$t('加载中…')} />
          ) : orderView ? (
            <>
              {!orderView.enterable ? (
                <Message kind="warning" title={$t('排程前置未通过（[A3-6]）：{p0}', { p0: orderView.entryBlocker ?? $t('工序未配置') })} />
              ) : null}
              {orderView.operations.map((op) => (
                <div key={op.orderOperationId} style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 12, marginBottom: 10, background: 'var(--cz-color-bg-surface)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <b>
                      {op.seq}. {op.operationName}
                    </b>
                    <span style={{ fontSize: 13, color: 'var(--cz-color-text-secondary)' }}>
                      {$t('下线数量')} {op.offlineQty} {op.uom}{$t('｜已排')} {op.scheduledQty} {op.uom}
                    </span>
                    {op.fullyScheduled ? <Badge tone="success">{$t('已排完')}</Badge> : <Badge tone="warning">{$t('未排完')}</Badge>}
                    {canAdmin && orderView.enterable ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          openDrawer({
                            orderId: orderView.orderId,
                            orderNo: orderView.orderNo,
                            orderOperationId: op.orderOperationId,
                            operationName: op.operationName,
                            offlineQty: op.offlineQty,
                            uom: op.uom,
                          })
                        }
                      >
                        {$t('编辑槽位')}
                      </Button>
                    ) : null}
                  </div>
                  {op.slots.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--cz-color-text-secondary)', margin: '8px 0 0' }}>{$t('暂无槽位')}</p>
                  ) : (
                    <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13.5 }}>
                      {op.slots.map((slot) => (
                        <li key={slot.slotId} style={{ marginBottom: 4 }}>
                          {slot.productionDate}{$t('｜')}{slot.equipmentName}{$t('（')}{slot.equipmentCode}{$t('）')}
                          {slot.equipmentStatus === 2 ? <Badge tone="danger">{EQUIPMENT_STATUS_LABELS[2]}</Badge> : null}{$t('｜ 计划')} <b>{slot.plannedQty}</b> <b style={{ fontSize: 12 }}>{op.uom}</b>
                          {slot.remark ? <span style={{ color: 'var(--cz-color-text-secondary)' }}>{$t('（')}{slot.remark}{$t('）')}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </>
          ) : (
            <Message kind="warning" title={$t('未加载到订单视图')} />
          )}
        </section>
      ) : (
        <section>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {(board?.workCenters ?? []).map((wc) => (
              <button
                key={wc.id}
                onClick={() => setBoardWorkCenterId(wc.id)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 6,
                  border: '1px solid var(--cz-color-border)',
                  cursor: 'pointer',
                  background: (board?.workCenterId ?? '') === wc.id ? 'var(--cz-color-primary)' : 'var(--cz-color-bg-surface)',
                  color: (board?.workCenterId ?? '') === wc.id ? '#fff' : 'inherit',
                  fontSize: 13,
                }}
              >
                {wc.name}
              </button>
            ))}
          </div>
          {board ? (
            <div className="cz-table-wrap">
              <table className="cz-table" aria-label={$t('设备排程看板')}>
                <thead>
                  <tr>
                    <th style={{ minWidth: 150 }}>{$t('设备')}</th>
                    {board.dates.slice(0, 14).map((date) => (
                      <th key={date} style={{ minWidth: 96 }}>{date.slice(5)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {board.equipments.map((eq) => (
                    <tr key={eq.equipmentId}>
                      <td>
                        <div>
                          <b>{eq.name}</b>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>
                          {eq.code}
                          {eq.equipmentStatus === 2 ? (
                            <>
                              {' '}
                              <Badge tone="danger">{EQUIPMENT_STATUS_LABELS[2]}</Badge>
                            </>
                          ) : null}
                        </div>
                      </td>
                      {board.dates.slice(0, 14).map((date) => {
                        const cell = eq.cells.find((c) => c.productionDate === date)
                        return (
                          <td key={date}>
                            {cell ? (
                              <button
                                onClick={() => setCellDetail({ equipment: `${eq.name}（${eq.code}）`, date })}
                                title={$t('查看当日排产明细')}
                                style={{ width: '100%', border: '1px solid var(--cz-color-border)', background: 'var(--cz-color-bg-hover)', borderRadius: 6, padding: '4px 6px', cursor: 'pointer', fontSize: 12.5, textAlign: 'center' }}
                              >
                                {cell.orderCount} {$t('单 /')} {cell.plannedTotal}
                                <div style={{ fontSize: 11, color: 'var(--cz-color-text-secondary)' }}>{$t('计划量合计')}</div>
                              </button>
                            ) : canAdmin && eq.equipmentStatus !== 2 ? (
                              <button
                                onClick={() =>
                                  openDrawer({
                                    equipmentId: eq.equipmentId,
                                    productionDate: date,
                                  })
                                }
                                style={{ width: '100%', border: '1px dashed var(--cz-color-border)', background: 'transparent', borderRadius: 6, color: 'var(--cz-color-text-secondary)', cursor: 'pointer', fontSize: 12, padding: '4px 0' }}
                              >
                                {$t('+ 添加排产')}
                              </button>
                            ) : (
                              <span style={{ color: 'var(--cz-color-text-secondary)' }}>—</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Message kind="info" title={$t('加载中…')} />
          )}
          {cellDetail && board ? (
            <Message
              kind="info"
              title={$t('{p0} {p1} 排产明细', { p0: cellDetail.equipment, p1: cellDetail.date })}
              detail={board.equipments
                .flatMap((eq) => eq.cells.filter((c) => c.productionDate === cellDetail.date).flatMap((c) => c.details.map((d) => `${d.orderNo}：${d.plannedQty} ${d.uom}`)))
                .join('；')}
            >
              <button style={{ marginTop: 6, fontSize: 12, border: 'none', background: 'none', color: 'var(--cz-color-primary)', cursor: 'pointer', padding: 0 }} onClick={() => setCellDetail(null)}>
                {$t('收起明细')}
              </button>
            </Message>
          ) : null}
        </section>
      )}

      {/* 槽位编辑抽屉（右侧面板；scheduling.admin 显隐） */}
      {drawer.open ? (
        <div
          role="dialog"
          aria-label={$t('槽位编辑抽屉')}
          style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 380, background: 'var(--cz-color-bg-surface)', borderLeft: '1px solid var(--cz-color-border)', boxShadow: '-6px 0 24px rgba(0,0,0,0.12)', padding: '18px 20px', zIndex: 60, overflowY: 'auto' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>{$t('槽位编辑')}</h3>
            <Button size="sm" variant="ghost" onClick={() => setDrawer({ ...drawer, open: false })}>
              {$t('关闭')}
            </Button>
          </div>
          {drawerError ? <Message kind="error" title={drawerError.title} detail={drawerError.detail} /> : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {drawer.orderNo ? (
              <p style={{ margin: 0, fontSize: 13.5 }}>
                {$t('订单')} <b>{drawer.orderNo}</b>{$t('｜工序')} <b>{drawer.operationName || $t('（设备视图添加，需选择工序）')}</b>
                {drawer.offlineQty !== '0.0000' ? (
                  <span style={{ color: 'var(--cz-color-text-secondary)' }}>
                    {$t('（下线')} {drawer.offlineQty} {drawer.uom}{$t('）')}
                  </span>
                ) : null}
              </p>
            ) : null}
            {drawer.orderOperationId ? null : (
              <Field label={$t('订单工序')} required hint={$t('设备视图添加排产时须选择订单工序')}>
                <Select
                  value=""
                  onChange={(e) => {
                    const op = (orderView?.operations ?? []).find((o) => o.orderOperationId === e.target.value)
                    const targetOrder = orders.find((o) => o.id === orderView?.orderId)
                    if (op && orderView && targetOrder) {
                      setDrawer({
                        ...drawer,
                        orderOperationId: op.orderOperationId,
                        operationName: op.operationName,
                        offlineQty: op.offlineQty,
                        uom: op.uom,
                        orderId: orderView.orderId,
                        orderNo: orderView.orderNo,
                      })
                    }
                  }}
                  placeholder={$t('选择工序（须先在订单视图选择订单）')}
                  options={(orderView?.operations ?? []).map((op) => ({ value: op.orderOperationId, label: $t('{p0}. {p1}（下线 {p2} {p3}）', { p0: op.seq, p1: op.operationName, p2: op.offlineQty, p3: op.uom }) }))}
                />
              </Field>
            )}
            <Field label={$t('设备')} required hint={$t('维修中的设备不可排产（[A3-3]）')}>
              <Select
                value={drawer.equipmentId}
                onChange={(e) => setDrawer({ ...drawer, equipmentId: e.target.value })}
                placeholder={$t('选择设备')}
                options={equipmentOptions}
              />
            </Field>
            <Field label={$t('生产日期')} required>
              <Input type="date" value={drawer.productionDate} onChange={(e) => setDrawer({ ...drawer, productionDate: e.target.value })} />
            </Field>
            <Field label={$t('计划产量{p0}', { p0: drawer.uom ? $t('（{p0}）', { p0: drawer.uom }) : '' })} required hint={$t('十进制定点字符串；改 0 = 删除该槽位（[A3-1] 同键替换）')}>
              <Input value={drawer.plannedQty} onChange={(e) => setDrawer({ ...drawer, plannedQty: e.target.value })} placeholder={$t('如 6.0000')} />
            </Field>
            <Field label={$t('备注')}>
              <Input value={drawer.remark} onChange={(e) => setDrawer({ ...drawer, remark: e.target.value })} />
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button loading={drawerBusy} disabled={!canAdmin} onClick={() => void saveSlot(false, drawer.plannedQty)}>
                {$t('保存槽位')}
              </Button>
              {!canAdmin ? <span style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)', alignSelf: 'center' }}>{$t('保存需要 scheduling.admin 许可')}</span> : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* [A3-2w] 超产能弱提醒二次确认：确认后携带 confirm=true 重新提交 */}
      <ConfirmModal
        open={weakConfirm !== null}
        tone="primary"
        title={$t('超出设备日产能（弱提醒确认）')}
        description={weakConfirm?.warning ?? ''}
        confirmText={$t('确认提交（confirm=true）')}
        onCancel={() => setWeakConfirm(null)}
        confirmLoading={drawerBusy}
        onConfirm={() => {
          if (weakConfirm) void saveSlot(true, drawer.plannedQty)
        }}
      />
    </PageContainer>
  )
}
