import { useCallback, useState } from 'react'
import { Badge, Button, Input, Message, Modal, PageContainer, Table, Textarea, t as $t } from '@cadenza/ui'
import {
  BATCH_QUALITY_STATUS_LABELS,
  RECEIPT_CORRECTION_KIND_LABELS,
  RETURN_SYNC_STATUS_LABELS,
  type ReceiptBatchViewDto,
  type ReceiptCorrectionDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REVERSE_POST, REVERSE_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList, useP2ActionState } from '../shared'

/**
 * 采购批次纠正页（T17，WR-19～23）：
 * - 纠正三类分列：作废/冲销/退货（WR-S6）；退货回传状态可重试（WR-23，仅回传失败）；
 * - 批次操作条件投影（WR-19/20/21）：修改=待质检或全部不合格且合格未同步；退货=全部不合格且未退货；
 *   作废=同修改条件（免检不可普通删除）；
 * - 下游已使用按对象关系拦截（WR-22），拦截原因逐条展示，不走整单标记。
 */
export function ReceiptCorrectionPage() {
  const { has } = useP2Permissions()
  const canRead = has(REVERSE_READ)
  const canPost = has(REVERSE_POST)
  const corrections = useP2AsyncList((p) => p2Api.listReceiptCorrections({ page: p, pageSize: PAGE_SIZE }), ['corrections'])
  const batches = useP2AsyncList((p) => p2Api.listReceiptBatches({ page: p, pageSize: PAGE_SIZE }), ['batches'])
  const [batchNo, setBatchNo] = useState('')
  const [returnTarget, setReturnTarget] = useState<ReceiptBatchViewDto | null>(null)
  const [remark, setRemark] = useState('')
  const action = useP2ActionState()

  const doRetrySync = useCallback(
    async (id: string) => {
      await action.run(() => p2Api.retryReceiptReturnSync(id), $t('退货回传重试已提交（WR-23）'))
      corrections.setPage(1)
    },
    [action, corrections],
  )

  const doVoid = useCallback(
    async (b: ReceiptBatchViewDto) => {
      await action.run(() => p2Api.voidReceiptBatch({ batchNo: b.batchNo, reason: 'Web 逻辑作废（演示）' }), $t('批次已作废：明细与质检数据保留可查（WR-21）'))
      batches.setPage(1)
    },
    [action, batches],
  )

  const submitReturn = useCallback(async () => {
    if (!returnTarget) return
    const ok = await action.run(() => p2Api.returnReceiptBatch({ batchNo: returnTarget.batchNo, remark }), $t('退货已登记：回传异步、失败可重试（WR-20/23）'))
    if (ok) {
      setReturnTarget(null)
      setRemark('')
      batches.setPage(1)
    }
  }, [action, batches, remark, returnTarget])

  if (!canRead) {
    return (
      <PageContainer title={$t('采购批次纠正')} description={$t('作废/冲销/退货三类（warehouse-reverse 合同 WR-19～23）')}>
        <Message kind="warning" title={$t('没有逆向域查询许可（reverse.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 reverse.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('采购批次纠正')}
      description={$t('投影=已入账−已退货（WR-20）；下游已使用按对象拦截（WR-22）；纠正记录 append-only')}
      actions={
        <Input
          style={{ width: 200 }}
          placeholder={$t('按批次号过滤（receive-lines）')}
          value={batchNo}
          onChange={(e) => {
            batches.setPage(1)
            setBatchNo(e.target.value)
          }}
        />
      }
    >
      {corrections.error ? <Message kind="error" title={corrections.error.title} detail={corrections.error.detail} /> : null}
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
      {action.actionSuccess ? <Message kind="success" title={action.actionSuccess} /> : null}
      <h4>{$t('纠正记录（append-only）')}</h4>
      <Table<ReceiptCorrectionDto>
        loading={corrections.loading}
        columns={[
          { key: 'correctionNo', title: $t('纠正单号') },
          { key: 'batchNo', title: $t('原批次') },
          {
            key: 'correctionKind',
            title: $t('种类（WR-S6）'),
            render: (c) => <Badge tone={c.correctionKind === 'return' ? 'warning' : 'default'}>{RECEIPT_CORRECTION_KIND_LABELS[c.correctionKind]}</Badge>,
          },
          {
            key: 'quantity',
            title: $t('数量'),
            render: (c) => (
              <span>
                {c.quantity} <b style={{ fontSize: 12 }}>{c.uomCode}</b>
              </span>
            ),
          },
          { key: 'reason', title: $t('原因') },
          { key: 'remark', title: $t('备注'), render: (c) => c.remark ?? '—' },
          { key: 'attachments', title: $t('附件'), render: (c) => $t('{p0} 个', { p0: c.attachments.length }) },
          {
            key: 'returnSyncStatus',
            title: $t('回传状态（WR-23）'),
            render: (c) => <Badge tone={c.returnSyncStatus === 'synced' ? 'success' : c.returnSyncStatus === 'failed' ? 'danger' : 'info'}>{RETURN_SYNC_STATUS_LABELS[c.returnSyncStatus]}</Badge>,
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (c) =>
              canPost && c.returnSyncStatus === 'failed' ? (
                <Button size="sm" onClick={() => void doRetrySync(c.correctionId)}>
                  {$t('重试回传（WR-23）')}
                </Button>
              ) : (
                <span>—</span>
              ),
          },
        ]}
        rows={corrections.items}
        rowKey={(c) => c.correctionId}
        page={{ page: corrections.page, pageSize: PAGE_SIZE }}
        total={corrections.total}
        onPageChange={corrections.setPage}
        emptyText={$t('暂无纠正记录')}
      />
      <h4 style={{ marginTop: 18 }}>{$t('批次操作面（条件投影）')}</h4>
      <Table<ReceiptBatchViewDto>
        loading={batches.loading}
        columns={[
          { key: 'batchNo', title: $t('批次号') },
          { key: 'materialCode', title: $t('料品') },
          {
            key: 'qualityStatus',
            title: $t('质检状态（QD-15 口径）'),
            render: (b) => <Badge tone={b.qualityStatus === 'all_qualified' ? 'success' : b.qualityStatus === 'all_unqualified' ? 'danger' : 'warning'}>{BATCH_QUALITY_STATUS_LABELS[b.qualityStatus]}</Badge>,
          },
          {
            key: 'quantities',
            title: $t('已入账/已退货/投影（WR-20）'),
            render: (b) => (
              <span>
                {b.receivedQuantity}/{b.returnedQuantity}/{b.projectedInboundQuantity} <b style={{ fontSize: 12 }}>{b.uomCode}</b>
              </span>
            ),
          },
          {
            key: 'ops',
            title: $t('可执行（WR-19/20/21）'),
            render: (b) => (
              <span style={{ display: 'inline-flex', gap: 8, fontSize: 12.5 }}>
                <Badge tone={b.canModify ? 'success' : 'default'}>{$t('修改')}{b.canModify ? $t('可') : $t('否')}</Badge>
                <Badge tone={b.canReturn ? 'success' : 'default'}>{$t('退货')}{b.canReturn ? $t('可') : $t('否')}</Badge>
                <Badge tone={b.canVoid ? 'success' : 'default'}>{$t('作废')}{b.canVoid ? $t('可') : $t('否')}</Badge>
              </span>
            ),
          },
          {
            key: 'blockers',
            title: $t('下游拦截（WR-22）'),
            render: (b) =>
              b.downstreamBlockers.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5 }}>
                  {b.downstreamBlockers.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              ) : (
                <span>—</span>
              ),
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (b) => (
              <span style={{ display: 'inline-flex', gap: 8 }}>
                {canPost && b.canReturn ? (
                  <Button size="sm" variant="danger" onClick={() => setReturnTarget(b)}>
                    {$t('退货（WR-20）')}
                  </Button>
                ) : null}
                {canPost && b.canVoid ? (
                  <Button size="sm" variant="ghost" onClick={() => void doVoid(b)}>
                    {$t('作废（WR-21）')}
                  </Button>
                ) : null}
              </span>
            ),
          },
        ]}
        rows={batchNo ? batches.items.filter((b) => b.batchNo.includes(batchNo)) : batches.items}
        rowKey={(b) => b.batchNo}
        page={{ page: batches.page, pageSize: PAGE_SIZE }}
        total={batches.total}
        onPageChange={batches.setPage}
        emptyText={$t('暂无批次')}
      />
      <Modal
        open={returnTarget !== null}
        title={$t('批次退货 {p0}', { p0: returnTarget?.batchNo ?? '' })}
        onClose={() => setReturnTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReturnTarget(null)}>
              {$t('取消')}
            </Button>
            <Button variant="danger" loading={action.busy} disabled={remark.trim() === ''} onClick={() => void submitReturn()}>
              {$t('确认退货')}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, marginTop: 0 }}>{$t('仅全部不合格且未退货批次可退货；备注必填（≤200）、附件 ≤3（WR-20）。')}</p>
        <Textarea aria-label={$t('退货备注')} placeholder={$t('退货备注（必填，≤200）')} value={remark} onChange={(e) => setRemark(e.target.value)} style={{ width: '100%' }} />
      </Modal>
    </PageContainer>
  )
}
