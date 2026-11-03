import { useState } from 'react'
import { Badge, Button, Message, PageContainer, Table, t as $t, tx as $tx } from '@cadenza/ui'
import {
  CARRIER_KIND_LABELS,
  CARRIER_LOAN_EVENT_LABELS,
  type CarrierLoanDto,
  type OwnershipBalanceDto,
  type StockMoveRecordDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REVERSE_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList } from '../shared'

const TABS = [
  { key: 'move', label: '移库台账' },
  { key: 'carrier', label: '载具借还' },
  { key: 'ownership', label: '所有物三分' },
] as const

/**
 * 仓储逆向台账（T17 只读三 tab，WR-05/26/27）：
 * - 移库台账：查询＋详情只读，详情为提交时快照（WR-05，原/现库位快照列 WR-S1）；
 * - 载具借还：append-only 事件流（WR-27，借出/回收/损坏/报废，不与产品退货表关联）；
 * - 所有物三分：数量、位置、所有权三者分别可核对（WR-26）。
 * 执行侧（PDA 移库/调拨出入库/盘点）见 /p2/move、/p2/transfer-out、/p2/transfer-in 与 Web 盘点页。
 */
export function ReverseLedgerPage() {
  const { has } = useP2Permissions()
  const canRead = has(REVERSE_READ)
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('move')

  if (!canRead) {
    return (
      <PageContainer title={$t('仓储逆向台账')} description={$t('移库/载具借还/所有物三分（warehouse-reverse 合同 WR-05/26/27）')}>
        <Message kind="warning" title={$t('没有逆向域查询许可（reverse.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 reverse.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('仓储逆向台账')}
      description={$t('查询与详情只读；差异必须走调整单（WR-24）；载具借还独立记录不作产品退货处理（WR-27）')}
      actions={
        <nav aria-label={$t('台账分区')} style={{ display: 'inline-flex', gap: 6 }}>
          {TABS.map((t) => (
            <Button key={t.key} size="sm" variant={tab === t.key ? 'primary' : 'secondary'} onClick={() => setTab(t.key)}>
              {$tx(t.label)}
            </Button>
          ))}
        </nav>
      }
    >
      {tab === 'move' ? <MoveTab /> : null}
      {tab === 'carrier' ? <CarrierTab /> : null}
      {tab === 'ownership' ? <OwnershipTab /> : null}
    </PageContainer>
  )
}

function MoveTab() {
  const list = useP2AsyncList((p) => p2Api.listMoveRecords({ page: p, pageSize: PAGE_SIZE }), ['move'])
  return (
    <section>
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      <Message kind="info" title={$t('移库＝同仓库内库位移动；扫码只查询不锁定（WR-01/02）')}>
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>{$t('执行入口在 PDA（/p2/move）；详情为提交时点快照（WR-05）。')}</p>
      </Message>
      <Table<StockMoveRecordDto>
        loading={list.loading}
        columns={[
          { key: 'moveNo', title: $t('移库单号') },
          { key: 'warehouseName', title: $t('仓库') },
          { key: 'toLocationCode', title: $t('现库位') },
          { key: 'materialCodesJoined', title: $t('料品') },
          {
            key: 'totalQty',
            title: $t('合计数量'),
            render: (r) => (
              <span>
                {r.totalQty} <b style={{ fontSize: 12 }}>{r.uomCode}</b>
              </span>
            ),
          },
          { key: 'movedBy', title: $t('移库人') },
          { key: 'movedAt', title: $t('移库时间'), render: (r) => new Date(r.movedAt).toLocaleString('zh-CN') },
        ]}
        rows={list.items}
        rowKey={(r) => r.recordId}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无移库记录')}
      />
    </section>
  )
}

function CarrierTab() {
  const list = useP2AsyncList((p) => p2Api.listCarrierLoans({ page: p, pageSize: PAGE_SIZE }), ['carrier'])
  return (
    <section>
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      <Table<CarrierLoanDto>
        loading={list.loading}
        columns={[
          { key: 'carrierCode', title: $t('载具码') },
          { key: 'carrierKind', title: $t('载具类型'), render: (c) => $tx(CARRIER_KIND_LABELS[c.carrierKind]) },
          {
            key: 'eventKind',
            title: $t('事件（append-only）'),
            render: (c) => <Badge tone={c.eventKind === 'damage' || c.eventKind === 'scrap' ? 'danger' : 'info'}>{CARRIER_LOAN_EVENT_LABELS[c.eventKind]}</Badge>,
          },
          { key: 'counterparty', title: $t('往来方'), render: (c) => c.counterparty ?? '—' },
          { key: 'note', title: $t('备注'), render: (c) => c.note ?? '—' },
          { key: 'occurredBy', title: $t('登记人') },
          { key: 'occurredAt', title: $t('时间'), render: (c) => new Date(c.occurredAt).toLocaleString('zh-CN') },
        ]}
        rows={list.items}
        rowKey={(c) => c.loanId}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无载具借还事件')}
      />
    </section>
  )
}

function OwnershipTab() {
  const list = useP2AsyncList((p) => p2Api.listOwnershipBalances({ page: p, pageSize: PAGE_SIZE }), ['ownership'])
  return (
    <section>
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      <Message kind="info" title={$t('所有权三分核对（WR-26/A07）：数量、位置、所有权分别可核对')}>
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>{$t('代管厂（custodianPlant）与所有者（owner）分列展示，不混写。')}</p>
      </Message>
      <Table<OwnershipBalanceDto>
        loading={list.loading}
        columns={[
          { key: 'unitNo', title: $t('轴号') },
          { key: 'locationCode', title: $t('位置（库位）') },
          { key: 'ownerName', title: $t('所有权（所有者）') },
          { key: 'custodianPlantId', title: $t('代管厂') },
          {
            key: 'quantity',
            title: $t('数量'),
            render: (o) => (
              <span>
                {o.quantity} <b style={{ fontSize: 12 }}>{o.uomCode}</b>
              </span>
            ),
          },
          { key: 'qualityStatus', title: $t('质量状态') },
        ]}
        rows={list.items}
        rowKey={(o) => o.unitId}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无所有物三分记录')}
      />
    </section>
  )
}
