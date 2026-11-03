import { useCallback, useState } from 'react'
import { Badge, Button, Message, PageContainer, Select, Table, t as $t } from '@cadenza/ui'
import { STOCKTAKE_STATUS_LABELS, type StocktakeOrderDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REVERSE_POST, REVERSE_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList, useP2ActionState } from '../shared'

/**
 * 盘点与差异调整页（T17，WR-24～25，最小语义）：
 * - 盘点期间仓库锁定：拦截分托/解绑/移库/调拨出入库/入库（WR-24①，locked 投影列）；
 * - 差异不直改余额，必须走调整单：原因必填＋去向＋关联流水（WR-24②/③）；
 * - 调整与业务流水并发以事务序为准，基准为命令时点实时余额（WR-25）；
 * - 全流程盘点细化（盲盘/复盘等）为 GAP-F10 待裁，未实现不冒充。
 */
export function ReverseStocktakePage() {
  const { has } = useP2Permissions()
  const canRead = has(REVERSE_READ)
  const canPost = has(REVERSE_POST)
  const list = useP2AsyncList((p) => p2Api.listStocktakes({ page: p, pageSize: PAGE_SIZE }), ['stocktake'])
  const adjustments = useP2AsyncList((p) => p2Api.listStockAdjustments({ page: p, pageSize: PAGE_SIZE }), ['adjustment'])
  const [warehouseId, setWarehouseId] = useState('wh-2')
  const action = useP2ActionState()

  const openStocktake = useCallback(async () => {
    await action.run(() => p2Api.openStocktake('n-plant', warehouseId), $t('盘点已开启：仓库即锁定（WR-24①）'))
    list.setPage(1)
  }, [action, list, warehouseId])

  const closeStocktake = useCallback(
    async (id: string) => {
      await action.run(() => p2Api.closeStocktake(id, 'n-plant'), $t('盘点已关闭：仓库解锁（WR-24①）'))
      list.setPage(1)
    },
    [action, list],
  )

  if (!canRead) {
    return (
      <PageContainer title={$t('盘点与差异调整')} description={$t('仓库盘点锁定与差异调整单（warehouse-reverse 合同 WR-24/25）')}>
        <Message kind="warning" title={$t('没有逆向域查询许可（reverse.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 reverse.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('盘点与差异调整')}
      description={$t('盘点锁仓期间各库存命令被拦截；差异必须走调整单（原因必填＋去向）；全流程盘点为 GAP-F10 待裁')}
      actions={
        canPost ? (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <Select
              aria-label={$t('盘点仓库')}
              style={{ width: 160 }}
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              options={[
                { value: 'wh-1', label: $t('成品一仓（WH-F01）') },
                { value: 'wh-2', label: $t('一线边仓（WH-L01）') },
              ]}
            />
            <Button size="sm" loading={action.busy} onClick={() => void openStocktake()}>
              {$t('开启盘点')}
            </Button>
          </span>
        ) : null
      }
    >
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
      {action.actionSuccess ? <Message kind="success" title={action.actionSuccess} /> : null}
      <h4>{$t('盘点单')}</h4>
      <Table<StocktakeOrderDto>
        loading={list.loading}
        columns={[
          { key: 'orderNo', title: $t('盘点单号') },
          { key: 'warehouseName', title: $t('仓库'), render: (s) => s.warehouseName ?? s.warehouseCode ?? '—' },
          {
            key: 'locked',
            title: $t('锁仓（WR-24①）'),
            render: (s) => (s.locked ? <Badge tone="danger">{$t('锁定中（拦截库存命令）')}</Badge> : <Badge tone="success">{$t('未锁定')}</Badge>),
          },
          {
            key: 'status',
            title: $t('状态'),
            render: (s) => <Badge tone={s.status === 'counting' ? 'warning' : 'default'}>{STOCKTAKE_STATUS_LABELS[s.status]}</Badge>,
          },
          { key: 'startedBy', title: $t('发起人') },
          { key: 'startedAt', title: $t('开始时间'), render: (s) => new Date(s.startedAt).toLocaleString('zh-CN') },
          { key: 'closedBy', title: $t('关闭人'), render: (s) => s.closedBy ?? '—' },
          {
            key: 'actions',
            title: $t('操作'),
            render: (s) =>
              canPost && s.status === 'counting' ? (
                <Button size="sm" onClick={() => void closeStocktake(s.orderId)}>
                  {$t('关闭并解锁')}
                </Button>
              ) : (
                <span>—</span>
              ),
          },
        ]}
        rows={list.items}
        rowKey={(s) => s.orderId}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无盘点单')}
      />
      <h4 style={{ marginTop: 18 }}>{$t('差异调整单（WR-24②/③：原因必填＋去向；禁止直改余额）')}</h4>
      {adjustments.error ? <Message kind="error" title={adjustments.error.title} detail={adjustments.error.detail} /> : null}
      <Table
        loading={adjustments.loading}
        columns={[
          { key: 'adjustmentNo', title: $t('调整单号') },
          { key: 'stocktakeOrderNo', title: $t('关联盘点单'), render: (a) => a.stocktakeOrderNo ?? $t('—（非盘点来源）') },
          { key: 'warehouseName', title: $t('仓库'), render: (a) => a.warehouseName ?? '—' },
          { key: 'reason', title: $t('原因（必填）') },
          { key: 'destination', title: $t('去向（必填）') },
          { key: 'lineCount', title: $t('行数') },
          { key: 'totalAdjustQty', title: $t('调整量合计') },
          { key: 'adjustedBy', title: $t('调整人') },
        ]}
        rows={adjustments.items}
        rowKey={(a) => a.adjustmentId}
        page={{ page: adjustments.page, pageSize: PAGE_SIZE }}
        total={adjustments.total}
        onPageChange={adjustments.setPage}
        emptyText={$t('暂无差异调整单')}
      />
      <p style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>
        {$t('调整单明细行（码/账面/实盘/差异）随详情只读展示；建单流程按 WR-24② 表单在后端命令面提供。')}
      </p>
    </PageContainer>
  )
}
