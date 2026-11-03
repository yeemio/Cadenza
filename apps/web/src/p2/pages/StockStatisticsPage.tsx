import { useCallback, useState } from 'react'
import { Badge, Button, Input, Message, PageContainer, Select, Table, t as $t } from '@cadenza/ui'
import {
  FINISHED_ENTRY_STATUS_LABELS,
  STOCK_STAT_KIND_LABELS,
  STOCK_STATUS_LEGACY_LABELS,
  type SelectionSummaryDto,
  type StockStatRowDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REPORTING_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList, useP2ActionState } from '../shared'

/**
 * 库存统计页（T20，RP-01～07）：
 * - 一行一条统计结果，列表不做二次聚合（RP-01：采购收货码按"轴号+入库批次+厂家批次+牌号/线径"汇总、
 *   其余码按"轴号+订单+（有则）工序"汇总）；
 * - 计量基准标注（measurementBasis，RP-S1）；英尺列＝trunc4(数量÷0.3048)，非米显示"-"（RP-03）；
 * - 成品入库状态推导列（RP-04）；legacy 六状态与五状态轴并存展示不混写（RP-02，GAP-A7 未裁）；
 * - 勾选汇总＝服务端全量聚合，不依赖已加载分页（RP-05/17）；无单位记"未知单位"。
 */
export function StockStatisticsPage() {
  const { has } = useP2Permissions()
  const canRead = has(REPORTING_READ)
  const [unitNoLike, setUnitNoLike] = useState('')
  const [finishedEntryStatus, setFinishedEntryStatus] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [summary, setSummary] = useState<SelectionSummaryDto | null>(null)
  const list = useP2AsyncList(
    (p) =>
      p2Api.listStockStats({
        page: p,
        pageSize: PAGE_SIZE,
        unitNoLike: unitNoLike.trim() || undefined,
        finishedEntryStatus: finishedEntryStatus === '' ? undefined : (finishedEntryStatus as 'entered_warehouse' | 'not_entered'),
      }),
    [unitNoLike, finishedEntryStatus],
  )
  const action = useP2ActionState()

  const toggle = useCallback((statId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(statId)) next.delete(statId)
      else next.add(statId)
      return next
    })
  }, [])

  const loadSummary = useCallback(async () => {
    await action.run(async () => {
      const s = await p2Api.stockStatSelectionSummary([...selected])
      setSummary(s)
    })
  }, [action, selected])

  if (!canRead) {
    return (
      <PageContainer title={$t('库存统计')} description={$t('全量业务统计投影（reporting 合同 RP-01～07）')}>
        <Message kind="warning" title={$t('没有报表域查询许可（reporting.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 reporting.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('库存统计')}
      description={$t('勾选汇总为服务端全量聚合（RP-05/17）；英尺=trunc4(米÷0.3048) 非米显示「-」（RP-03）')}
      actions={
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Input
            style={{ width: 180 }}
            placeholder={$t('按轴号搜索（unitNoLike）')}
            value={unitNoLike}
            onChange={(e) => {
              list.setPage(1)
              setUnitNoLike(e.target.value)
            }}
          />
          <Select
            aria-label={$t('成品入库状态')}
            style={{ width: 160 }}
            value={finishedEntryStatus}
            onChange={(e) => {
              list.setPage(1)
              setFinishedEntryStatus(e.target.value)
            }}
            placeholder={$t('成品入库状态（RP-04）')}
            options={[
              { value: 'entered_warehouse', label: $t('成品已入库') },
              { value: 'not_entered', label: $t('成品未入库') },
            ]}
          />
          <Button size="sm" disabled={selected.size === 0} loading={action.busy} onClick={() => void loadSummary()}>
            {$t('勾选汇总（RP-05）')}
          </Button>
        </span>
      }
    >
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      {summary ? (
        <Message kind="info" title={$t('勾选汇总：共 {p0} 件（服务端全量聚合，RP-05/17）', { p0: summary.totalRows })}>
          <p style={{ margin: '4px 0 0', fontSize: 13 }}>
            {summary.groups.length === 0
              ? $t('未勾选时总量为 0')
              : summary.groups
                  .map((g) => `${g.uomLabel === g.uomCode ? g.uomCode : g.uomLabel}：${g.totalQuantity}`)
                  .join('；')}
          </p>
        </Message>
      ) : null}
      <Table<StockStatRowDto>
        loading={list.loading}
        columns={[
          {
            key: 'pick',
            title: $t('选择'),
            render: (r) => <input type="checkbox" checked={selected.has(r.statId)} onChange={() => toggle(r.statId)} aria-label={$t('选择 {p0}', { p0: r.unitNo })} />,
          },
          { key: 'statKind', title: $t('口径（RP-01）'), render: (r) => <Badge tone={r.statKind === 'purchase_receive' ? 'info' : 'default'}>{STOCK_STAT_KIND_LABELS[r.statKind]}</Badge> },
          { key: 'unitNo', title: $t('华通轴号') },
          { key: 'lotNo', title: $t('入库批次'), render: (r) => r.lotNo ?? '—' },
          { key: 'supplierLotNo', title: $t('厂家批次'), render: (r) => r.supplierLotNo ?? '—' },
          { key: 'materialCode', title: $t('料品') },
          { key: 'spec', title: $t('线径/规格'), render: (r) => r.spec ?? '—' },
          { key: 'orderNo', title: $t('订单（其余码汇总键）'), render: (r) => r.orderNo ?? '—' },
          { key: 'operationName', title: $t('工序'), render: (r) => r.operationName ?? '—' },
          {
            key: 'quantity',
            title: $t('数量（基准标注）'),
            render: (r) => (
              <span>
                {r.quantity} <b style={{ fontSize: 12 }}>{r.uomCode}</b>
                <span style={{ fontSize: 11, color: 'var(--cz-color-text-secondary)' }}>{$t('（')}{r.measurementBasis}{$t('）')}</span>
              </span>
            ),
          },
          { key: 'feetQuantity', title: $t('英尺（RP-03）'), render: (r) => (r.feetQuantity === null ? '-' : r.feetQuantity) },
          {
            key: 'stockStatus',
            title: $t('legacy 状态（RP-02）'),
            render: (r) => (r.stockStatus ? (STOCK_STATUS_LEGACY_LABELS[r.stockStatus] ?? r.stockStatus) : '—'),
          },
          { key: 'axisStatus', title: $t('五状态轴（IT-13）') },
          { key: 'reportWarehouseKind', title: $t('报工仓库类型'), render: (r) => r.reportWarehouseKind ?? '—' },
          {
            key: 'finishedEntryStatus',
            title: $t('成品入库（RP-04）'),
            render: (r) => (r.finishedEntryStatus === null ? '—' : <Badge tone={r.finishedEntryStatus === 'entered_warehouse' ? 'success' : 'warning'}>{FINISHED_ENTRY_STATUS_LABELS[r.finishedEntryStatus]}</Badge>),
          },
          {
            key: 'customerAxisNos',
            title: $t('客户轴号（排序）'),
            render: (r) => (r.customerAxisNos.length > 0 ? r.customerAxisNos.join('、') : '—'),
          },
          { key: 'warehouseName', title: $t('仓库'), render: (r) => r.warehouseName ?? '—' },
          { key: 'locationCode', title: $t('库位'), render: (r) => r.locationCode ?? '—' },
        ]}
        rows={list.items}
        rowKey={(r) => r.statId}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无统计数据')}
      />
    </PageContainer>
  )
}
