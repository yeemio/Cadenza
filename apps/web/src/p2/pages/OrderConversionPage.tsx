import { useCallback, useState } from 'react'
import { Badge, Button, Input, Message, Modal, PageContainer, Table, t as $t } from '@cadenza/ui'
import {
  ORDER_CONVERSION_STATUS_LABELS,
  ORDER_SYNC_STATUS_LABELS,
  type OrderConversionDetailDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { CONVERSION_POST, CONVERSION_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList, useP2ActionState } from '../shared'

/**
 * 订单形态转换页（T16 协议A，FC-05～12）：
 * - 列表两列独立投影：转换状态（2 值）与同步状态（3 值）分列（FC-12）；
 * - 编辑/删除仅"待转换且尚无任何扫码（含删码留痕）"（FC-06，client 映射层按扫码事实计算）；
 * - 完成转换须每明细已扫轴数>0（FC-08）；重试仅"已完成且同步失败"（FC-09）；
 * - U9 同步失败保留本地事实不回滚（FC-10）；已完成转换无撤销入口（FC-11，GAP-F2）。
 */
export function OrderConversionPage() {
  const { has, plantId } = useP2Permissions()
  const canRead = has(CONVERSION_READ)
  const canPost = has(CONVERSION_POST)
  const [statuses, setStatuses] = useState('')
  const list = useP2AsyncList(
    (p) => p2Api.listOrderConversions({ page: p, pageSize: PAGE_SIZE, plantId: plantId ?? undefined, statuses: statuses ? statuses.split(',') : undefined }),
    [statuses, plantId],
  )
  const [detail, setDetail] = useState<OrderConversionDetailDto | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const action = useP2ActionState()

  const openDetail = useCallback(async (id: string) => {
    try {
      setDetail(await p2Api.getOrderConversion(id))
    } catch {
      setDetail(null)
    }
  }, [])

  const doComplete = useCallback(
    async (id: string) => {
      await action.run(() => p2Api.completeOrderConversion(id), $t('完成转换已提交（本地先执行，Outbox 异步外发）'))
      await openDetail(id)
    },
    [action, openDetail],
  )

  const doRetry = useCallback(
    async (id: string) => {
      await action.run(() => p2Api.retryOrderConversionSync(id), $t('重试已提交（按完成时点快照重推，FC-09）'))
      await openDetail(id)
    },
    [action, openDetail],
  )

  const doDelete = useCallback(async () => {
    if (!deleteTarget) return
    const ok = await action.run(() => p2Api.deleteOrderConversion(deleteTarget), $t('转换单已删除'))
    if (ok) {
      setDeleteTarget(null)
      list.setPage(1)
    }
  }, [action, deleteTarget, list])

  if (!canRead) {
    return (
      <PageContainer title={$t('订单形态转换')} description={$t('订单式转换（form-conversion 协议A，FC-05～12）')}>
        <Message kind="warning" title={$t('没有转换域查询许可（conversion.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 conversion.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('订单形态转换')}
      description={$t('转换状态与同步状态两列独立（FC-12）；扫码在 PDA 完成（FC-07）；PDA 端点见 /p2/conversion-scan')}
      actions={
        <Input
          style={{ width: 190 }}
          placeholder={$t('状态过滤（如 pending,completed）')}
          value={statuses}
          onChange={(e) => {
            list.setPage(1)
            setStatuses(e.target.value)
          }}
        />
      }
    >
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
      {action.actionSuccess ? <Message kind="success" title={action.actionSuccess} /> : null}
      <Table
        loading={list.loading}
        columns={[
          { key: 'conversionNo', title: $t('转换单号') },
          {
            key: 'status',
            title: $t('转换状态（FC-12）'),
            render: (r) => (
              <Badge tone={r.status === 'completed' ? 'success' : 'info'}>{ORDER_CONVERSION_STATUS_LABELS[r.status]}</Badge>
            ),
          },
          {
            key: 'syncStatus',
            title: $t('同步状态（FC-12）'),
            render: (r) => (
              <Badge tone={r.syncStatus === 'synced' ? 'success' : r.syncStatus === 'sync_failed' ? 'danger' : 'default'}>
                {ORDER_SYNC_STATUS_LABELS[r.syncStatus]}
              </Badge>
            ),
          },
          { key: 'lineCount', title: $t('明细数') },
          { key: 'createdBy', title: $t('创建人'), render: (r) => r.createdBy ?? '—' },
          { key: 'createdAt', title: $t('创建时间'), render: (r) => new Date(r.createdAt).toLocaleString('zh-CN') },
          { key: 'completedAt', title: $t('完成时间'), render: (r) => (r.completedAt ? new Date(r.completedAt).toLocaleString('zh-CN') : '—') },
          {
            key: 'actions',
            title: $t('操作'),
            render: (r) => (
              <span style={{ display: 'inline-flex', gap: 8 }}>
                <Button size="sm" variant="secondary" onClick={() => void openDetail(r.conversionId)}>
                  {$t('明细')}
                </Button>
                {canPost && r.completable && r.status === 'pending' ? (
                  <Button size="sm" onClick={() => void doComplete(r.conversionId)}>
                    {$t('完成转换（FC-08）')}
                  </Button>
                ) : null}
                {canPost && r.retryable ? (
                  <Button size="sm" variant="danger" onClick={() => void doRetry(r.conversionId)}>
                    {$t('重试同步（FC-09）')}
                  </Button>
                ) : null}
                {canPost && r.editable && r.status === 'pending' ? (
                  <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(r.conversionId)}>
                    {$t('删除（FC-06）')}
                  </Button>
                ) : null}
              </span>
            ),
          },
        ]}
        rows={list.items}
        rowKey={(r) => r.conversionId}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无订单转换单')}
      />
      <Modal open={detail !== null} title={$t('转换单明细 {p0}', { p0: detail?.conversionNo ?? '' })} size="lg" onClose={() => setDetail(null)}>
        {detail ? (
          <div style={{ fontSize: 13 }}>
            <p style={{ marginTop: 0 }}>
              {$t('转换状态')} {ORDER_CONVERSION_STATUS_LABELS[detail.status]}{$t('｜同步状态')} {ORDER_SYNC_STATUS_LABELS[detail.syncStatus]}
              {$t('｜明细可编辑')} {detail.editable ? $t('是（无任何扫码）') : $t('否（FC-06）')}
            </p>
            <h4>{$t('明细行（转换前后订单锚点，FC-05）')}</h4>
            <Table
              columns={[
                { key: 'lineNo', title: '#' },
                { key: 'sourceSalesOrderNo', title: $t('原销售订单') },
                { key: 'sourceLineNo', title: $t('原行号') },
                { key: 'targetSalesOrderNo', title: $t('转换后销售订单') },
                { key: 'targetProjectNo', title: $t('项目号') },
                { key: 'materialCode', title: $t('料品') },
                { key: 'plannedQty', title: $t('计划数量') },
                { key: 'scannedQty', title: $t('实扫数量') },
                { key: 'scannedAxes', title: $t('已扫轴数') },
                { key: 'uom', title: $t('单位') },
              ]}
              rows={detail.lines}
              rowKey={(l) => l.lineId}
              emptyText={$t('无明细')}
            />
            <h4>{$t('扫码记录（含删码留痕，FC-07）')}</h4>
            <Table
              columns={[
                { key: 'unitNo', title: $t('轴号') },
                { key: 'segmentLength', title: $t('段长'), render: (s) => s.segmentLength ?? '—' },
                { key: 'customerAxisNo', title: $t('客户轴号'), render: (s) => s.customerAxisNo ?? '—' },
                { key: 'quantity', title: $t('数量') },
                { key: 'scannedBy', title: $t('扫码人') },
                {
                  key: 'deleted',
                  title: $t('删码留痕'),
                  render: (s) => (s.deleted ? <Badge tone="warning">{$t('已删码（')}{s.deletedBy}{$t('）')}</Badge> : <Badge tone="success">{$t('有效')}</Badge>),
                },
              ]}
              rows={detail.scans}
              rowKey={(s) => s.scanId}
              emptyText={$t('尚无扫码')}
            />
          </div>
        ) : null}
      </Modal>
      <Modal
        open={deleteTarget !== null}
        title={$t('删除订单转换单')}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              {$t('取消')}
            </Button>
            <Button variant="danger" loading={action.busy} onClick={() => void doDelete()}>
              {$t('确认删除')}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13.5 }}>
          {$t('仅"待转换且尚无任何扫码（含删码留痕）"可删除（FC-06）；服务端终校。')}
        </p>
      </Modal>
    </PageContainer>
  )
}
