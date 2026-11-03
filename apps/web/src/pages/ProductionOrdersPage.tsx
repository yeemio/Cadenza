import {
  ApiError,
  Badge,
  Input,
  Message,
  PageContainer,
  PRODUCTION_ORDER_STATUS_LABELS,
  ORDER_SCHEDULING_STATUS_LABELS,
  Select,
  Table,
  formatErrorTitleAndDetail,
  type OrderSchedulingStatusValue,
  type ProductionOrderDto,
  t as $t,
} from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { PROCESS_READ, SCHEDULING_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10

const STATUS_OPTIONS = Object.entries(PRODUCTION_ORDER_STATUS_LABELS).map(([value, label]) => ({ value, label }))

function statusTone(status: string): 'success' | 'info' | 'warning' | 'danger' | 'default' {
  if (status === 'in_progress') return 'success'
  if (status === 'released') return 'info'
  if (status === 'approved') return 'info'
  if (status === 'pending_completion') return 'warning'
  if (status === 'voided') return 'danger'
  return 'default'
}

function schedulingTone(status: OrderSchedulingStatusValue | undefined): 'success' | 'warning' | 'default' {
  if (status === 'fully_scheduled') return 'success'
  if (status === 'partially_scheduled') return 'warning'
  return 'default'
}

/**
 * 生产订单列表（[底稿 A1-1] 状态轴标签 + [A3-4] 排产状态列）：
 * - 过滤：orderNoLike / statuses 多选 / suspended，全部服务端参数；
 * - 排产状态列：按当前页订单逐单调 /scheduling/order-view（同数据双投影的读侧），
 *   无 scheduling.read 许可或订单视图不可得时不冒充（显示「—」）；
 * - 数量与单位同现（PC-06）；行内「详情」下钻订单工序明细。
 */
export function ProductionOrdersPage() {
  const { has } = usePermissions()
  const canRead = has(PROCESS_READ)
  const canReadScheduling = has(SCHEDULING_READ)
  const [items, setItems] = useState<ProductionOrderDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [orderNoLike, setOrderNoLike] = useState('')
  const [statuses, setStatuses] = useState('')
  const [suspendedOnly, setSuspendedOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [schedStatus, setSchedStatus] = useState<Record<string, OrderSchedulingStatusValue>>({})

  useEffect(() => {
    if (!canRead) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    api
      .listProductionOrders({
        page,
        pageSize: PAGE_SIZE,
        orderNoLike: orderNoLike.trim() || undefined,
        statuses: statuses || undefined,
        suspended: suspendedOnly ? true : undefined,
      })
      .then((result) => {
        if (!alive) return
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载生产订单失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, orderNoLike, statuses, suspendedOnly, canRead])

  // 排产状态列：当前页逐单读订单视图（scheduling.read；失败静默显示「—」不阻断列表）
  useEffect(() => {
    if (!canRead || !canReadScheduling) return
    let alive = true
    for (const order of items) {
      api
        .schedulingOrderView(order.id)
        .then((view) => {
          if (alive) setSchedStatus((prev) => ({ ...prev, [order.id]: view.schedulingStatus }))
        })
        .catch(() => {
          /* 订单视图不可得（如无排产数据/无许可）时列显示「—」 */
        })
    }
    return () => {
      alive = false
    }
  }, [items, canRead, canReadScheduling])

  if (!canRead) {
    return (
      <PageContainer title={$t('生产订单')} description={$t('生产订单列表与工序明细（process.read）')}>
        <Message kind="warning" title={$t('没有生产订单查询许可（process.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 process.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('生产订单')}
      description={$t('状态轴：已审批→已下达→进行中→完工待核→已关闭（挂起/作废独立）；排产状态列读自排程订单视图（同一排产事实双投影）')}
      actions={
        <>
          <Input
            style={{ width: 200 }}
            placeholder={$t('按生产单号搜索（orderNoLike）')}
            value={orderNoLike}
            onChange={(e) => {
              setPage(1)
              setOrderNoLike(e.target.value)
            }}
          />
          <Select
            style={{ width: 150 }}
            placeholder={$t('全部状态')}
            value={statuses}
            onChange={(e) => {
              setPage(1)
              setStatuses(e.target.value)
            }}
            options={STATUS_OPTIONS}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={suspendedOnly}
              onChange={(e) => {
                setPage(1)
                setSuspendedOnly(e.target.checked)
              }}
            />
            {$t('只看挂起')}
          </label>
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      <Table<ProductionOrderDto>
        loading={loading}
        columns={[
          { key: 'orderNo', title: $t('生产单号') },
          {
            key: 'material',
            title: $t('物料（接收时快照）'),
            render: (o) => {
              const snap = o.materialSnapshot as Record<string, unknown>
              const name = typeof snap['name'] === 'string' ? snap['name'] : ''
              const spec = typeof snap['spec'] === 'string' ? snap['spec'] : ''
              return (
                <span>
                  {String(snap['code'] ?? '')} {name} {spec ? $t('（{p0}）', { p0: spec }) : ''}
                </span>
              )
            },
          },
          {
            key: 'productionQty',
            title: $t('生产数量'),
            render: (o) => (
              <span>
                {o.productionQty} <b style={{ fontSize: 12 }}>{o.uom}</b>
              </span>
            ),
          },
          {
            key: 'orderStatus',
            title: $t('订单状态'),
            render: (o) => <Badge tone={statusTone(o.orderStatus)}>{PRODUCTION_ORDER_STATUS_LABELS[o.orderStatus] ?? o.orderStatus}</Badge>,
          },
          {
            key: 'schedulingStatus',
            title: $t('排产状态'),
            render: (o) => {
              const s = schedStatus[o.id]
              if (!canReadScheduling) return <span>—</span>
              return s ? (
                <Badge tone={schedulingTone(s)}>{ORDER_SCHEDULING_STATUS_LABELS[s]}</Badge>
              ) : (
                <span>—</span>
              )
            },
          },
          {
            key: 'suspended',
            title: $t('挂起'),
            render: (o) =>
              o.suspended ? (
                <span>
                  <Badge tone="danger">{$t('挂起')}</Badge>
                  {o.suspendedReason ? (
                    <span style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>{$t('（')}{o.suspendedReason}{$t('）')}</span>
                  ) : null}
                </span>
              ) : (
                <span>—</span>
              ),
          },
          { key: 'salesOrderNo', title: $t('销售订单号'), render: (o) => o.salesOrderNo ?? '—' },
          {
            key: 'actions',
            title: $t('操作'),
            render: (o) => (
              <Link to={`/production/orders/${encodeURIComponent(o.id)}`} style={{ fontSize: 13 }}>
                {$t('详情')}
              </Link>
            ),
          },
        ]}
        rows={items}
        rowKey={(o) => o.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无生产订单')}
      />
      <p style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)', marginTop: 8 }}>
        {$t('放行/开工/挂起等生命周期操作见订单详情页（process.admin）；接收新订单（模拟 U9 入站）入口亦在详情页。')}
      </p>
    </PageContainer>
  )
}
