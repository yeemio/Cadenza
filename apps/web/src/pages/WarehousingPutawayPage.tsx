import {
  ApiError,
  Badge,
  Button,
  Field,
  Input,
  Message,
  Modal,
  PageContainer,
  PUTAWAY_SOURCE_LABELS,
  PUTAWAY_TASK_STATUS_LABELS,
  Select,
  Table,
  formatErrorTitleAndDetail,
  type PutawayTaskDto,
  t as $t,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { WAREHOUSING_POST, WAREHOUSING_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10

/** 组单入库目标（演示配置：线边仓/成品仓与库位对） */
const TARGETS = [
  { value: 'wh-0202|loc-02020001', label: '绞制线边仓 0202 → 库位 02020001' },
  { value: 'wh-0103|loc-01030001', label: '成品一库 0103 → 库位 01030001' },
]

/**
 * 入库任务页（A-T13-1）：
 * - 任务台账只读（来源：报工/成品质检异步写入，禁手工增删改）；「刷新重跑」从执行事件重新扫描；
 * - 组单入库：勾选待入库任务（或托码整托 A-T13-2）→ 目标仓库/库位 + 所有者 → 确认入库；
 * - 数量与单位同现（PC-06）；操作按 warehousing.post 显隐（PC-10）。
 */
export function WarehousingPutawayPage() {
  const { has } = usePermissions()
  const canRead = has(WAREHOUSING_READ)
  const canPost = has(WAREHOUSING_POST)
  const [items, setItems] = useState<PutawayTaskDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statuses, setStatuses] = useState('')
  const [sourceTypes, setSourceTypes] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [refreshBusy, setRefreshBusy] = useState(false)
  // 组单入库
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [target, setTarget] = useState(TARGETS[0]!.value)
  const [palletCode, setPalletCode] = useState('')
  const [confirmBusy, setConfirmBusy] = useState(false)

  const load = useCallback(() => {
    if (!canRead) return
    setLoading(true)
    api
      .listPutawayTasks({
        page,
        pageSize: PAGE_SIZE,
        statuses: statuses || undefined,
        sourceTypes: sourceTypes || undefined,
      })
      .then((result) => {
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载入库任务失败') })
      })
      .finally(() => setLoading(false))
  }, [canRead, page, statuses, sourceTypes])

  useEffect(() => {
    load()
  }, [load])

  const refresh = async () => {
    setRefreshBusy(true)
    setError(null)
    try {
      const result = await api.putawayRefresh({ plantId: 'n-plant' })
      const data = (result.data ?? {}) as { createdCount?: number; pendingCount?: number }
      setNotice($t('任务刷新重跑完成（新增 {p0} 条；当前待入库 {p1} 条）', { p0: data.createdCount ?? 0, p1: data.pendingCount ?? 0 }))
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('刷新任务失败') })
    } finally {
      setRefreshBusy(false)
    }
  }

  const doConfirm = async () => {
    const [toWarehouseId, toLocationId] = target.split('|')
    const targetLabel = TARGETS.find((t) => t.value === target)?.label ?? ''
    setConfirmBusy(true)
    setError(null)
    try {
      const payload = palletCode.trim()
        ? { plantId: 'n-plant', palletCode: palletCode.trim(), toWarehouseId, toWarehouseCode: toWarehouseId === 'wh-0103' ? '0103' : '0202', toLocationId, toLocationCode: toLocationId === 'loc-01030001' ? '01030001' : '02020001', ownerId: 'owner-1', ownerName: '中辰电缆制造有限公司' }
        : { plantId: 'n-plant', taskIds: selected, toWarehouseId, toWarehouseCode: toWarehouseId === 'wh-0103' ? '0103' : '0202', toLocationId, toLocationCode: toLocationId === 'loc-01030001' ? '01030001' : '02020001', ownerId: 'owner-1', ownerName: '中辰电缆制造有限公司' }
      const result = await api.putawayConfirm(payload)
      const data = (result.data ?? {}) as { confirmedCount?: number }
      setNotice($t('确认入库完成（{p0} 条任务{p1} → {p2}）', { p0: data.confirmedCount ?? 0, p1: palletCode.trim() ? '，整托' : '', p2: targetLabel }))
      setConfirmOpen(false)
      setSelected([])
      setPalletCode('')
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('确认入库失败') })
    } finally {
      setConfirmBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('入库任务')}>
        <Message kind="warning" title={$t('没有仓储查询许可（warehousing.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('入库任务')}
      description={$t('待入库任务台账（A-T13-1：报工/成品质检异步写入，禁手工增删改）；确认入库经库存记账（IT 合同）；托码确认＝整托（A-T13-2）')}
      actions={
        <>
          <Select
            style={{ width: 120 }}
            placeholder={$t('全部状态')}
            value={statuses}
            onChange={(e) => {
              setPage(1)
              setStatuses(e.target.value)
            }}
            options={Object.entries(PUTAWAY_TASK_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <Select
            style={{ width: 130 }}
            placeholder={$t('全部来源')}
            value={sourceTypes}
            onChange={(e) => {
              setPage(1)
              setSourceTypes(e.target.value)
            }}
            options={Object.entries(PUTAWAY_SOURCE_LABELS).map(([value, label]) => ({ value, label }))}
          />
          {canPost ? (
            <Button size="sm" variant="secondary" loading={refreshBusy} onClick={() => void refresh()}>
              {$t('刷新重跑（扫描执行事件）')}
            </Button>
          ) : null}
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}
      <Table<PutawayTaskDto>
        loading={loading}
        columns={[
          {
            key: 'select',
            title: $t('组单'),
            width: 52,
            render: (row) =>
              row.status === 'pending' ? (
                <input
                  type="checkbox"
                  aria-label={$t('选择任务 {p0}', { p0: row.id })}
                  checked={selected.includes(row.id)}
                  onChange={(e) =>
                    setSelected((prev) => (e.target.checked ? [...prev, row.id] : prev.filter((x) => x !== row.id)))
                  }
                />
              ) : null,
          },
          { key: 'sourceRef', title: $t('来源引用') },
          {
            key: 'sourceType',
            title: $t('来源'),
            render: (row) => <Badge tone="info">{PUTAWAY_SOURCE_LABELS[row.sourceType] ?? row.sourceType}</Badge>,
          },
          { key: 'unitNo', title: $t('单元号'), render: (row) => row.unitNo ?? '—' },
          { key: 'palletCode', title: $t('托码'), render: (row) => row.palletCode ?? '—' },
          { key: 'materialCode', title: $t('料品编码') },
          {
            key: 'quantity',
            title: $t('数量'),
            render: (row) => (
              <span>
                {row.quantity} <b style={{ fontSize: 12 }}>{row.uomCode}</b>
              </span>
            ),
          },
          {
            key: 'status',
            title: $t('状态'),
            render: (row) => (row.status === 'pending' ? <Badge tone="warning">{$t('待入库')}</Badge> : row.status === 'done' ? <Badge tone="success">{row.statusLabel}</Badge> : <Badge>{row.statusLabel}</Badge>),
          },
          { key: 'locationCode', title: $t('入库库位'), render: (row) => row.locationCode ?? '—' },
          { key: 'putawayBy', title: $t('入库人'), render: (row) => row.putawayBy ?? '—' },
          { key: 'putawayAt', title: $t('入库时间'), render: (row) => row.putawayAt ?? '—' },
        ]}
        rows={items}
        rowKey={(row) => row.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无入库任务')}
      />
      {canPost ? (
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button disabled={selected.length === 0} onClick={() => setConfirmOpen(true)}>
            {$t('组单入库（已选')} {selected.length} {$t('条）')}
          </Button>
          <span style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>
            {$t('托码整托：在弹窗中填托码（同托全部未入库任务一并完成，A-T13-2）')}
          </span>
        </div>
      ) : null}

      <Modal
        open={confirmOpen}
        title={$t('组单确认入库')}
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>{$t('取消')}</Button>
            <Button loading={confirmBusy} onClick={() => void doConfirm()}>{$t('确认入库')}</Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label={$t('目标仓库/库位')} required>
            <Select value={target} onChange={(e) => setTarget(e.target.value)} options={TARGETS} style={{ width: '100%' }} />
          </Field>
          <Field label={$t('托码（整托确认，选填）')} hint={$t('填写托码后忽略勾选，按托码整托完成（A-T13-2）')}>
            <Input value={palletCode} onChange={(e) => setPalletCode(e.target.value)} placeholder={$t('如 PLT-2026-001')} />
          </Field>
          <p style={{ fontSize: 13, color: 'var(--cz-color-text-secondary)', margin: 0 }}>
            {$t('确认后任务转已完成并经库存记账落库（IT-25 两段原子）；仅待入库任务可确认（A-T13-1）。')}
          </p>
        </div>
      </Modal>
    </PageContainer>
  )
}
