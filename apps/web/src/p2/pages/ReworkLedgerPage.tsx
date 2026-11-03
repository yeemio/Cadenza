import { useCallback, useState } from 'react'
import { ApiError, Badge, Button, Message, Modal, PageContainer, Table, Textarea, t as $t, tx as $tx } from '@cadenza/ui'
import {
  formatP2ErrorTitleAndDetail,
  PALLET_TASK_TYPE_LABELS,
  REEL_SPLIT_STATUS_LABELS,
  AXIS_CORRECTION_STATUS_LABELS,
  type AxisCorrectionDto,
  type AxisRetireRecordDto,
  type PalletTaskDto,
  type ReelSplitDetailDto,
  type ReelSplitOrderDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REWORK_POST, REWORK_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList } from '../shared'
const TABS = [
  { key: 'reel-split', label: '倒轴台账' },
  { key: 'pallet-task', label: '分托/解绑任务' },
  { key: 'axis-correction', label: '轴号修正' },
  { key: 'axis-retire', label: '轴码退役' },
] as const

/**
 * 倒轴与轴码治理台账（T15 rework-split，Web 四 tab 只读台账＋有限纠正动作）：
 * - 倒轴：主表＋明细展开只读（RS-08，无新增/编辑/删除入口）；冲销走反向记录＋理由（RS-12）；
 * - 分托/解绑：Web 仅展示已完成任务（RS-14，进行中不展示）；组托人/时间=首次扫码（RS-20）；
 * - 轴号修正：状态列＋修正前后值快照（RS-29/32）；回撤仅已完成（RS-32/33）；
 * - 轴码退役：清空记录快照字段全列（RS-35，逻辑退役不物理删行）。
 */
export function ReworkLedgerPage() {
  const { has } = useP2Permissions()
  const canRead = has(REWORK_READ)
  const canPost = has(REWORK_POST)
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('reel-split')

  if (!canRead) {
    return (
      <PageContainer title={$t('倒轴与轴码治理')} description={$t('倒轴/分托/轴号修正/轴码退役台账（rework-split 合同 RS-01～RS-37）')}>
        <Message kind="warning" title={$t('没有倒轴域查询许可（rework.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 rework.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('倒轴与轴码治理')}
      description={$t('主表＋明细只读（RS-08）；纠正走冲销/回撤命令；数量与单位同现（PC-06）')}
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
      {tab === 'reel-split' ? <ReelSplitTab canPost={canPost} /> : null}
      {tab === 'pallet-task' ? <PalletTaskTab /> : null}
      {tab === 'axis-correction' ? <AxisCorrectionTab canPost={canPost} /> : null}
      {tab === 'axis-retire' ? <AxisRetireTab /> : null}
    </PageContainer>
  )
}

function ReelSplitTab({ canPost }: { canPost: boolean }) {
  const { items, total, page, setPage, loading, error } = useP2AsyncList(
    (p) => p2Api.listReelSplitOrders({ page: p, pageSize: PAGE_SIZE }),
    ['reel-split'],
  )
  const [detail, setDetail] = useState<ReelSplitDetailDto | null>(null)
  const [reverseTarget, setReverseTarget] = useState<ReelSplitOrderDto | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<{ title: string; detail?: string } | null>(null)

  const openDetail = useCallback(async (id: string) => {
    try {
      setDetail(await p2Api.getReelSplit(id))
    } catch (err) {
      setActionError(err instanceof ApiError ? formatP2ErrorTitleAndDetail(err) : { title: $t('加载详情失败') })
    }
  }, [])

  const submitReverse = useCallback(async () => {
    if (!reverseTarget) return
    setBusy(true)
    try {
      await p2Api.reverseReelSplit(reverseTarget.id, { reason })
      setReverseTarget(null)
      setReason('')
      setDetail(null)
    } catch (err) {
      setActionError(err instanceof ApiError ? formatP2ErrorTitleAndDetail(err) : { title: $t('冲销失败') })
    } finally {
      setBusy(false)
    }
  }, [reverseTarget, reason])

  return (
    <section>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {actionError ? <Message kind="error" title={actionError.title} detail={actionError.detail} /> : null}
      <Table<ReelSplitOrderDto>
        loading={loading}
        columns={[
          { key: 'splitNo', title: $t('倒轴单号') },
          { key: 'sourceUnitNo', title: $t('倒出轴') },
          { key: 'productionOrderNo', title: $t('生产订单') },
          { key: 'materialCode', title: $t('料品') },
          {
            key: 'quantity',
            title: $t('原数量'),
            render: (r) => (
              <span>
                {r.originalQuantity} <b style={{ fontSize: 12 }}>{r.uom}</b>
              </span>
            ),
          },
          { key: 'splitTotal', title: $t('倒入合计') },
          { key: 'remainingQuantity', title: $t('剩余数量') },
          { key: 'lossQuantity', title: $t('损耗量（RS-11）') },
          { key: 'operatorName', title: $t('操作人') },
          {
            key: 'status',
            title: $t('状态'),
            render: (r) => (
              <Badge tone={r.status === 'completed' ? 'success' : 'warning'}>{REEL_SPLIT_STATUS_LABELS[r.status]}</Badge>
            ),
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (r) => (
              <span style={{ display: 'inline-flex', gap: 8 }}>
                <Button size="sm" variant="secondary" onClick={() => void openDetail(r.id)}>
                  {$t('明细')}
                </Button>
                {canPost && r.status === 'completed' ? (
                  <Button size="sm" variant="danger" onClick={() => setReverseTarget(r)}>
                    {$t('冲销（RS-12）')}
                  </Button>
                ) : null}
              </span>
            ),
          },
        ]}
        rows={items}
        rowKey={(r) => r.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={setPage}
        emptyText={$t('暂无倒轴记录')}
      />
      <Modal open={detail !== null} title={$t('倒轴明细 {p0}', { p0: detail?.splitNo ?? '' })} onClose={() => setDetail(null)}>
        {detail ? (
          <div style={{ fontSize: 13.5, lineHeight: 1.9 }}>
            <p style={{ margin: 0 }}>
              {$t('倒出轴')} {detail.sourceUnitNo}{$t('（')}{detail.materialName}{$t('）；损耗')} {detail.lossQuantity} {detail.uom}
              {detail.lossReason ? $t('（原因：{p0}）', { p0: detail.lossReason }) : null}
            </p>
            <Table
              columns={[
                { key: 'targetUnitNo', title: $t('倒入轴') },
                { key: 'quantity', title: $t('倒入数量') },
                { key: 'uom', title: $t('单位') },
              ]}
              rows={detail.lines}
              rowKey={(l) => l.id}
              emptyText={$t('无倒入行')}
            />
          </div>
        ) : null}
      </Modal>
      <Modal
        open={reverseTarget !== null}
        title={$t('冲销倒轴单 {p0}', { p0: reverseTarget?.splitNo ?? '' })}
        onClose={() => setReverseTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReverseTarget(null)}>
              {$t('取消')}
            </Button>
            <Button variant="danger" loading={busy} disabled={reason.trim() === ''} onClick={() => void submitReverse()}>
              {$t('确认冲销')}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, marginTop: 0 }}>
          {$t('冲销写反向流水（RS-12）；子段已入库/被消耗/已发运时将被拒绝，请走逆序冲销。')}
        </p>
        <Textarea
          aria-label={$t('冲销理由')}
          placeholder={$t('冲销理由（必填）')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ width: '100%' }}
        />
      </Modal>
    </section>
  )
}

function PalletTaskTab() {
  const { items, total, page, setPage, loading, error } = useP2AsyncList(
    (p) => p2Api.listPalletTasks({ page: p, pageSize: PAGE_SIZE }),
    ['pallet-task'],
  )
  const [detail, setDetail] = useState<(PalletTaskDto & { items: Array<{ id: string; unitNo: string; materialCode: string; quantity: string; uom: string; snapshotPalletCode: string | null; snapshotWarehouseName: string | null; snapshotRackCode: string | null; snapshotLocationCode: string | null }> }) | null>(null)

  return (
    <section>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      <Message kind="info" title={$t('进行中任务不在 Web 台账展示（RS-14）')}>
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>
          {$t('分托=改绑托码、解绑=清除托码（RS-13）；组托人员/时间＝本次操作人/首次扫码时间（RS-20）。明细为扫码时点快照（RS-17）。')}
        </p>
      </Message>
      <Table<PalletTaskDto>
        loading={loading}
        columns={[
          { key: 'taskType', title: $t('任务类型'), render: (t) => $tx(PALLET_TASK_TYPE_LABELS[t.taskType]) },
          { key: 'targetPalletCode', title: $t('分入托码'), render: (t) => t.targetPalletCode ?? $t('—（解绑）') },
          { key: 'warehouseName', title: $t('仓库') },
          { key: 'itemCount', title: $t('件数') },
          { key: 'operatorName', title: $t('组托人员（RS-20）') },
          { key: 'firstScanAt', title: $t('组托时间'), render: (t) => new Date(t.firstScanAt).toLocaleString('zh-CN') },
          { key: 'status', title: $t('状态'), render: () => <Badge tone="success">{$t('已完成')}</Badge> },
          {
            key: 'actions',
            title: $t('操作'),
            render: (t) => (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void p2Api
                    .getPalletTask(t.id)
                    .then(setDetail)
                    .catch(() => setDetail(null))
                }}
              >
                {$t('明细快照')}
              </Button>
            ),
          },
        ]}
        rows={items}
        rowKey={(t) => t.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={setPage}
        emptyText={$t('暂无已完成分托/解绑任务')}
      />
      <Modal open={detail !== null} title={$t('任务明细快照 {p0}', { p0: detail?.targetPalletCode ?? $t('解绑') })} onClose={() => setDetail(null)}>
        {detail ? (
          <Table
            columns={[
              { key: 'unitNo', title: $t('轴号') },
              { key: 'materialCode', title: $t('料品') },
              { key: 'quantity', title: $t('数量') },
              { key: 'uom', title: $t('单位') },
              { key: 'snapshotPalletCode', title: $t('原托码（快照）') },
              { key: 'snapshotWarehouseName', title: $t('仓库（快照）') },
              { key: 'snapshotLocationCode', title: $t('库位（快照）') },
            ]}
            rows={detail.items}
            rowKey={(i) => i.id}
            emptyText={$t('无明细')}
          />
        ) : null}
      </Modal>
    </section>
  )
}

function AxisCorrectionTab({ canPost }: { canPost: boolean }) {
  const { items, total, page, setPage, loading, error } = useP2AsyncList(
    (p) => p2Api.listAxisCorrections({ page: p, pageSize: PAGE_SIZE }),
    ['axis-correction'],
  )
  const [actionError, setActionError] = useState<{ title: string; detail?: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const withdraw = useCallback(async (id: string) => {
    setBusyId(id)
    try {
      await p2Api.withdrawAxisCorrection(id)
      setActionError(null)
    } catch (err) {
      setActionError(err instanceof ApiError ? formatP2ErrorTitleAndDetail(err) : { title: $t('回撤失败') })
    } finally {
      setBusyId(null)
    }
  }, [])

  return (
    <section>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {actionError ? <Message kind="error" title={actionError.title} detail={actionError.detail} /> : null}
      <Table<AxisCorrectionDto>
        loading={loading}
        columns={[
          { key: 'unitNo', title: $t('轴号') },
          { key: 'originalCustomerAxisNo', title: $t('原客户轴号'), render: (a) => a.originalCustomerAxisNo ?? '—' },
          { key: 'newCustomerAxisNo', title: $t('修正后客户轴号'), render: (a) => a.newCustomerAxisNo ?? '—' },
          { key: 'originalSegmentLength', title: $t('原段长'), render: (a) => a.originalSegmentLength ?? '—' },
          { key: 'newSegmentLength', title: $t('修正后段长'), render: (a) => a.newSegmentLength ?? '—' },
          { key: 'originalQuantity', title: $t('原数量') },
          { key: 'cutQuantity', title: $t('截取数量') },
          { key: 'newQuantity', title: $t('修正后数量') },
          {
            key: 'uom',
            title: $t('单位'),
            render: (a) => (
              <span>
                <b style={{ fontSize: 12 }}>{a.uom}</b>{$t('（随主计量单位，RS-31）')}
              </span>
            ),
          },
          {
            key: 'status',
            title: $t('状态'),
            render: (a) => (
              <Badge tone={a.status === 'completed' ? 'success' : 'default'}>{AXIS_CORRECTION_STATUS_LABELS[a.status]}</Badge>
            ),
          },
          { key: 'correctedBy', title: $t('修正人') },
          {
            key: 'actions',
            title: $t('操作'),
            render: (a) =>
              canPost && a.status === 'completed' ? (
                <Button size="sm" variant="danger" loading={busyId === a.id} onClick={() => void withdraw(a.id)}>
                  {$t('回撤（RS-32/33）')}
                </Button>
              ) : (
                <span>—</span>
              ),
          },
        ]}
        rows={items}
        rowKey={(a) => a.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={setPage}
        emptyText={$t('暂无轴号修正记录')}
      />
    </section>
  )
}

function AxisRetireTab() {
  const { items, total, page, setPage, loading, error } = useP2AsyncList(
    (p) => p2Api.listAxisRetires({ page: p, pageSize: PAGE_SIZE }),
    ['axis-retire'],
  )
  return (
    <section>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      <Message kind="info" title={$t('轴码退役＝逻辑清空，不物理删行（RS-35/36）')}>
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>
          {$t('退役后全部库存命令入口显式拒绝，追溯查询可查（RS-36）。')}
        </p>
      </Message>
      <Table<AxisRetireRecordDto>
        loading={loading}
        columns={[
          { key: 'unitNo', title: $t('轴号') },
          { key: 'quantityBefore', title: $t('清空前数量') },
          {
            key: 'uom',
            title: $t('单位'),
            render: (a) => (
              <span>
                <b style={{ fontSize: 12 }}>{a.uom}</b>
              </span>
            ),
          },
          { key: 'materialCode', title: $t('料品') },
          { key: 'productionOrderNo', title: $t('生产订单') },
          { key: 'salesOrderNo', title: $t('销售订单') },
          { key: 'lineNo', title: $t('行号') },
          { key: 'processName', title: $t('工序') },
          { key: 'reportedBy', title: $t('报工人') },
          { key: 'operatedBy', title: $t('清空操作人') },
          { key: 'operatedAt', title: $t('清空时间'), render: (a) => new Date(a.operatedAt).toLocaleString('zh-CN') },
        ]}
        rows={items}
        rowKey={(a) => a.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={setPage}
        emptyText={$t('暂无轴码退役记录')}
      />
    </section>
  )
}
