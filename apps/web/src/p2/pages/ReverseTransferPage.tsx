import { useCallback, useState } from 'react'
import { Badge, Button, Message, Modal, PageContainer, Table, t as $t, tx as $tx } from '@cadenza/ui'
import {
  TRANSFER_IN_MODE_LABELS,
  TRANSFER_IN_STATUS_LABELS,
  TRANSFER_OUT_SOURCE_LABELS,
  TRANSFER_OUT_STATUS_LABELS,
  type TransferInboundOrderDto,
  type TransferOutboundDetailDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REVERSE_POST, REVERSE_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList, useP2ActionState } from '../shared'

const TABS = [
  { key: 'out', label: '调拨出库' },
  { key: 'in', label: '调拨入库' },
] as const

/**
 * 调拨出入库页（T17，WR-06～17）：
 * - 出库侧：三来源列（WR-07）＋状态投影（WR-13）；无任务单完成出库前 Web 不显示（WR-07②）；
 *   仅"待出库且未扫过码"可编辑/删除（WR-08）；完成出库＝至少扫过一码（WR-11）；
 * - 入库侧：入库方式列（WR-14：固定库位即时完成/扫码上架跨厂签收）＋码入库状态列（WR-S3）；
 *   完成入库须每料品已入库≥待入库且至少一码已入库（WR-17）。
 * PDA 无任务首扫建单入口见 /p2/transfer-out。
 */
export function ReverseTransferPage() {
  const { has } = useP2Permissions()
  const canRead = has(REVERSE_READ)
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('out')

  if (!canRead) {
    return (
      <PageContainer title={$t('调拨出入库')} description={$t('跨仓调拨（warehouse-reverse 合同 WR-06～17）')}>
        <Message kind="warning" title={$t('没有逆向域查询许可（reverse.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 reverse.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('调拨出入库')}
      description={$t('调入≠调出仓库；线边仓调出只能入线边仓；生产调拨只能入线边仓且限原材料/半成品（WR-06）')}
      actions={
        <nav aria-label={$t('调拨分区')} style={{ display: 'inline-flex', gap: 6 }}>
          {TABS.map((t) => (
            <Button key={t.key} size="sm" variant={tab === t.key ? 'primary' : 'secondary'} onClick={() => setTab(t.key)}>
              {$tx(t.label)}
            </Button>
          ))}
        </nav>
      }
    >
      {tab === 'out' ? <OutTab /> : null}
      {tab === 'in' ? <InTab /> : null}
    </PageContainer>
  )
}

function OutTab() {
  const { has } = useP2Permissions()
  const canPost = has(REVERSE_POST)
  const list = useP2AsyncList((p) => p2Api.listTransferOutbound({ page: p, pageSize: PAGE_SIZE }), ['out'])
  const [detail, setDetail] = useState<TransferOutboundDetailDto | null>(null)
  const action = useP2ActionState()

  const openDetail = useCallback(async (id: string) => {
    try {
      setDetail(await p2Api.getTransferOutbound(id))
    } catch {
      setDetail(null)
    }
  }, [])

  const doComplete = useCallback(
    async (id: string) => {
      await action.run(() => p2Api.completeTransferOutbound({ plantId: 'n-plant', orderId: id }), $t('完成出库已提交（未选调入库位→在途待入库，WR-11）'))
      await openDetail(id)
    },
    [action, openDetail],
  )

  return (
    <section>
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
      <Table
        loading={list.loading}
        columns={[
          { key: 'orderNo', title: $t('调拨单号') },
          { key: 'sourceKind', title: $t('来源（WR-07）'), render: (r) => $tx(TRANSFER_OUT_SOURCE_LABELS[r.sourceKind]) },
          { key: 'transferKind', title: $t('类型'), render: (r) => (r.transferKind === 'production' ? $t('生产调拨') : $t('仓库调拨')) },
          { key: 'fromWarehouseName', title: $t('调出仓'), render: (r) => r.fromWarehouseName ?? r.fromWarehouseCode ?? '—' },
          { key: 'toWarehouseName', title: $t('调入仓'), render: (r) => r.toWarehouseName ?? r.toWarehouseCode ?? '—' },
          {
            key: 'status',
            title: $t('状态（WR-13）'),
            render: (r) => (
              <Badge tone={r.status === 'outbounded' ? 'success' : r.status === 'cancelled' ? 'default' : 'info'}>
                {TRANSFER_OUT_STATUS_LABELS[r.status]}
              </Badge>
            ),
          },
          { key: 'scannedCount', title: $t('已扫码数') },
          {
            key: 'totalOutQty',
            title: $t('调出数量合计'),
            render: (r) => (
              <span>
                {r.totalOutQty} <b style={{ fontSize: 12 }}>{r.uomCode}</b>
              </span>
            ),
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (r) => (
              <span style={{ display: 'inline-flex', gap: 8 }}>
                <Button size="sm" variant="secondary" onClick={() => void openDetail(r.orderId)}>
                  {$t('明细')}
                </Button>
                {canPost && r.status === 'pending_out' || canPost && r.status === 'outbounding' ? (
                  <Button size="sm" onClick={() => void doComplete(r.orderId)}>
                    {$t('完成出库（WR-11）')}
                  </Button>
                ) : null}
              </span>
            ),
          },
        ]}
        rows={list.items}
        rowKey={(r) => r.orderId}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无调拨出库单')}
      />
      <Modal open={detail !== null} title={$t('调拨出库单明细 {p0}', { p0: detail?.orderNo ?? '' })} size="lg" onClose={() => setDetail(null)}>
        {detail ? (
          <div style={{ fontSize: 13 }}>
            <p style={{ marginTop: 0 }}>
              {detail.fromWarehouseName ?? detail.fromWarehouseCode} → {detail.toWarehouseName ?? detail.toWarehouseCode}
              {detail.toLocationCode ? $t('（调入库位 {p0}）', { p0: detail.toLocationCode }) : $t('（未选调入库位，完成后在途）')}
            </p>
            <Table
              columns={[
                { key: 'unitNo', title: $t('码（轴号）') },
                { key: 'materialCode', title: $t('料品') },
                { key: 'fromLocationCode', title: $t('原库位'), render: (s) => s.fromLocationCode ?? '—' },
                { key: 'quantity', title: $t('数量') },
                { key: 'outQty', title: $t('调出数量') },
                { key: 'scannedBy', title: $t('扫码人') },
                {
                  key: 'status',
                  title: $t('码状态'),
                  render: (s) => (s.status === 'loaded' ? <Badge tone="success">{$t('已装车')}</Badge> : <Badge tone="warning">{$t('已删除（退回）')}</Badge>),
                },
              ]}
              rows={detail.scans}
              rowKey={(s) => s.scanId}
              emptyText={$t('尚无扫码')}
            />
          </div>
        ) : null}
      </Modal>
    </section>
  )
}

function InTab() {
  const { has } = useP2Permissions()
  const canPost = has(REVERSE_POST)
  const list = useP2AsyncList((p) => p2Api.listTransferInbound({ page: p, pageSize: PAGE_SIZE }), ['in'])
  const action = useP2ActionState()

  const doComplete = useCallback(
    async (id: string) => {
      await action.run(() => p2Api.completeTransferInbound(id, 'n-plant'), $t('完成入库已提交（WR-17）'))
      list.setPage(1)
    },
    [action, list],
  )

  return (
    <section>
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
      {action.actionSuccess ? <Message kind="success" title={action.actionSuccess} /> : null}
      <Message kind="info" title={$t('固定库位＝厂内即时转仓（生成即已完成）；扫码上架＝跨厂/需交接由接收方签收（WR-14）')}>
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>{$t('PDA 扫码上架入口见 /p2/transfer-in；删除扫码退回未入库并解除锁定（WR-16）。')}</p>
      </Message>
      <Table<TransferInboundOrderDto>
        loading={list.loading}
        columns={[
          { key: 'orderNo', title: $t('入库单号') },
          { key: 'outboundOrderNo', title: $t('关联出库单'), render: (r) => r.outboundOrderNo ?? '—' },
          {
            key: 'inboundMode',
            title: $t('入库方式（WR-14）'),
            render: (r) => <Badge tone={r.inboundMode === 'fixed_location' ? 'info' : 'warning'}>{TRANSFER_IN_MODE_LABELS[r.inboundMode]}</Badge>,
          },
          {
            key: 'status',
            title: $t('状态'),
            render: (r) => (
              <Badge tone={r.status === 'completed' ? 'success' : 'info'}>{TRANSFER_IN_STATUS_LABELS[r.status]}</Badge>
            ),
          },
          { key: 'fromWarehouseCode', title: $t('来自仓'), render: (r) => r.fromWarehouseCode ?? '—' },
          { key: 'toWarehouseCode', title: $t('调入仓'), render: (r) => r.toWarehouseCode ?? '—' },
          {
            key: 'counts',
            title: $t('码入库进度（WR-S3）'),
            render: (r) => (
              <span>
                {r.inboundCount}/{r.totalCount}
              </span>
            ),
          },
          { key: 'completedBy', title: $t('完成人（固定库位=出库方快照）'), render: (r) => r.completedBy ?? '—' },
          {
            key: 'actions',
            title: $t('操作'),
            render: (r) =>
              canPost && r.status === 'inbounding' ? (
                <Button size="sm" disabled={!r.completable} onClick={() => void doComplete(r.orderId)}>
                  {$t('完成入库（WR-17）')}
                </Button>
              ) : (
                <span>—</span>
              ),
          },
        ]}
        rows={list.items}
        rowKey={(r) => r.orderId}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无调拨入库单')}
      />
    </section>
  )
}
