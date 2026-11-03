import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Input, Message, Modal, PageContainer, Select, Table, t as $t } from '@cadenza/ui'
import {
  STOCK_DISPLAY_STATUS_LABELS,
  STOCK_INTERNAL_STATUS_LABELS,
  STOCK_EXTERNAL_PUSH_LABELS,
  STOCK_LOCAL_APPLY_LABELS,
  type StockCandidateDto,
  type StockConversionDetailDto,
  type StockConversionLinePayload,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { CONVERSION_POST, CONVERSION_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList, useP2ActionState } from '../shared'

/**
 * 库存形态转换页（T16 协议B，FC-13～21）：
 * - 四列状态分立：内部六态/对外三态/外部接口/本地应用（FC-02/14）；
 * - 左侧候选源（FC-17：成品、库存>0、在库、仓库类型=仓库；无托单轴一行/有托按托汇总一行，
 *   已添加置灰）；右侧转换清单提交前校验（FC-18）；
 * - 重新转换仅转换失败单；重新同步只做本地不再推 U9（FC-15，u9Success 幂等标记 FC-S4）。
 */
export function StockConversionPage() {
  const { has, plantId } = useP2Permissions()
  const canRead = has(CONVERSION_READ)
  const canPost = has(CONVERSION_POST)
  const list = useP2AsyncList(
    (p) => p2Api.listStockConversions({ page: p, pageSize: PAGE_SIZE, plantId: plantId ?? undefined }),
    [plantId],
  )
  const [detail, setDetail] = useState<StockConversionDetailDto | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const action = useP2ActionState()

  const openDetail = useCallback(async (id: string) => {
    try {
      setDetail(await p2Api.getStockConversion(id))
    } catch {
      setDetail(null)
    }
  }, [])

  const doReconvert = useCallback(
    async (id: string) => {
      await action.run(() => p2Api.reconvertStock(id), $t('重新转换已提交（原单更新，FC-15）'))
      await openDetail(id)
    },
    [action, openDetail],
  )

  const doResync = useCallback(
    async (id: string) => {
      await action.run(() => p2Api.resyncStock(id), $t('重新同步已提交（只做本地 MES 改码与库存统计，不再推 U9）'))
      await openDetail(id)
    },
    [action, openDetail],
  )

  if (!canRead) {
    return (
      <PageContainer title={$t('库存形态转换')} description={$t('库存式转换（form-conversion 协议B，FC-13～21）')}>
        <Message kind="warning" title={$t('没有转换域查询许可（conversion.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 conversion.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('库存形态转换')}
      description={$t('U9 先成功、再本地改码与库存统计（FC-13）；外部结果未知先查询外部流水再决定重试（FC-03）')}
      actions={
        canPost ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            {$t('新建库存转换（FC-17/18）')}
          </Button>
        ) : null
      }
    >
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
      {action.actionSuccess ? <Message kind="success" title={action.actionSuccess} /> : null}
      <Table
        loading={list.loading}
        columns={[
          { key: 'conversionNo', title: $t('转换单号') },
          { key: 'materialCode', title: $t('料品') },
          {
            key: 'internalStatus',
            title: $t('内部状态（FC-14 六态）'),
            render: (r) => <Badge tone={r.internalStatus === 'completed' ? 'success' : 'info'}>{STOCK_INTERNAL_STATUS_LABELS[r.internalStatus]}</Badge>,
          },
          {
            key: 'displayStatus',
            title: $t('对外状态（FC-14 三态）'),
            render: (r) => (
              <Badge tone={r.displayStatus === 'convert_success' ? 'success' : 'danger'}>{STOCK_DISPLAY_STATUS_LABELS[r.displayStatus]}</Badge>
            ),
          },
          {
            key: 'externalPushStatus',
            title: $t('外部接口（FC-02）'),
            render: (r) => <Badge tone={r.externalPushStatus === 'succeeded' ? 'success' : r.externalPushStatus === 'failed' ? 'danger' : 'warning'}>{STOCK_EXTERNAL_PUSH_LABELS[r.externalPushStatus]}</Badge>,
          },
          {
            key: 'localApplyStatus',
            title: $t('本地应用（FC-02）'),
            render: (r) => <Badge tone={r.localApplyStatus === 'applied' ? 'success' : r.localApplyStatus === 'failed' ? 'danger' : 'default'}>{STOCK_LOCAL_APPLY_LABELS[r.localApplyStatus]}</Badge>,
          },
          { key: 'u9Success', title: $t('U9 已成功（FC-S4）'), render: (r) => (r.u9Success ? <Badge tone="success">{$t('是')}</Badge> : <Badge>{$t('否')}</Badge>) },
          { key: 'totalQty', title: $t('转换数量（FC-21）') },
          { key: 'axisCount', title: $t('转换轴数（FC-21）') },
          { key: 'externalDocNo', title: $t('外部单号'), render: (r) => r.externalDocNo ?? '—' },
          {
            key: 'actions',
            title: $t('操作'),
            render: (r) => (
              <span style={{ display: 'inline-flex', gap: 8 }}>
                <Button size="sm" variant="secondary" onClick={() => void openDetail(r.conversionId)}>
                  {$t('明细')}
                </Button>
                {canPost && r.reconvertable ? (
                  <Button size="sm" onClick={() => void doReconvert(r.conversionId)}>
                    {$t('重新转换（FC-15）')}
                  </Button>
                ) : null}
                {canPost && r.resyncable ? (
                  <Button size="sm" variant="danger" onClick={() => void doResync(r.conversionId)}>
                    {$t('重新同步（FC-15）')}
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
        emptyText={$t('暂无库存转换单')}
      />
      <Modal open={detail !== null} title={$t('库存转换单明细 {p0}', { p0: detail?.conversionNo ?? '' })} size="lg" onClose={() => setDetail(null)}>
        {detail ? (
          <div style={{ fontSize: 13 }}>
            <p style={{ marginTop: 0 }}>
              {$t('目标：销售订单')} {detail.targetSalesOrderNo} {$t('行')} {detail.targetLineNo} {$t('批次')} {detail.targetBatchNo}
              {detail.targetProjectNo ? $t(' 项目 {p0}', { p0: detail.targetProjectNo }) : ''}
            </p>
            {detail.externalFailureReason ? (
              <Message kind="error" title={$t('外部失败原因（保留本地事实，FC-10）')}>
                <p style={{ margin: '4px 0 0' }}>{detail.externalFailureReason}</p>
              </Message>
            ) : null}
            <Table
              columns={[
                { key: 'unitNo', title: $t('轴号') },
                { key: 'palletCode', title: $t('托码'), render: (l) => l.palletCode ?? '—' },
                { key: 'quantity', title: $t('数量') },
                { key: 'segmentLength', title: $t('段长') },
                { key: 'customerAxisNo', title: $t('客户轴号'), render: (l) => l.customerAxisNo ?? '—' },
                { key: 'sourceSalesOrderNo', title: $t('来源销售订单（快照）'), render: (l) => l.sourceSalesOrderNo ?? '—' },
                { key: 'sourceBatchNo', title: $t('来源批次（快照）'), render: (l) => l.sourceBatchNo ?? '—' },
                { key: 'warehouseCode', title: $t('仓库') },
                { key: 'locationCode', title: $t('库位') },
              ]}
              rows={detail.lines}
              rowKey={(l) => l.lineId}
              emptyText={$t('无明细')}
            />
          </div>
        ) : null}
      </Modal>
      {createOpen ? <StockCreateModal plantId={plantId} onClose={() => setCreateOpen(false)} /> : null}
    </PageContainer>
  )
}

function StockCreateModal({ plantId, onClose }: { plantId: string | null; onClose: () => void }) {
  const [materialCode, setMaterialCode] = useState('MAT-XLPE-1')
  const [candidates, setCandidates] = useState<StockCandidateDto[]>([])
  const [selected, setSelected] = useState<StockCandidateDto[]>([])
  const [targetSalesOrderNo, setTargetSalesOrderNo] = useState('')
  const [targetLineNo, setTargetLineNo] = useState('')
  const [targetBatchNo, setTargetBatchNo] = useState('')
  const [targetProjectNo, setTargetProjectNo] = useState('')
  const [loaded, setLoaded] = useState(false)
  const action = useP2ActionState()

  const load = useCallback(async () => {
    const rows = await p2Api.listStockCandidates({ materialCode: materialCode || undefined })
    setCandidates(rows)
    setSelected([])
    setLoaded(true)
  }, [materialCode])

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const toggle = (c: StockCandidateDto) => {
    if (selected.some((s) => s.groupKind === c.groupKind && s.productAxisNo === c.productAxisNo && s.palletCode === c.palletCode)) {
      setSelected(selected.filter((s) => !(s.groupKind === c.groupKind && s.productAxisNo === c.productAxisNo && s.palletCode === c.palletCode)))
    } else {
      setSelected([...selected, c])
    }
  }

  const submit = useCallback(async () => {
    const lines: StockConversionLinePayload[] = selected.map((c) => ({
      unitNo: c.groupKind === 'axis' ? (c.productAxisNo ?? '') : '',
      segmentLength: '400.0000',
      customerAxisNo: c.customerAxisNo,
      palletCode: c.palletCode,
      quantity: c.quantity,
      uom: c.uom,
      sourceSalesOrderNo: c.salesOrderNo,
      sourceLineNo: c.lineNo,
      sourceBatchNo: c.batchNo,
      warehouseCode: c.warehouseCode,
      locationCode: c.locationCode,
    }))
    const ok = await action.run(
      () =>
        p2Api.createStockConversion({
          plantId: plantId ?? 'n-plant',
          targetSalesOrderNo,
          targetLineNo,
          targetBatchNo,
          targetProjectNo: targetProjectNo || null,
          lines,
        }),
      $t('库存转换单已创建（提交链路四步，FC-13）'),
    )
    if (ok) onClose()
  }, [action, onClose, plantId, selected, targetBatchNo, targetLineNo, targetProjectNo, targetSalesOrderNo])

  return (
    <Modal
      open
      size="lg"
      title={$t('新建库存转换（左候选源 / 右转换清单，FC-17/18）')}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {$t('取消')}
          </Button>
          <Button
            loading={action.busy}
            disabled={selected.length === 0 || !targetSalesOrderNo || !targetLineNo || !targetBatchNo}
            onClick={() => void submit()}
          >
            {$t('提交转换')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
        <section>
          <h4 style={{ margin: '0 0 6px' }}>{$t('左侧：候选源（FC-17 选源限定）')}</h4>
          <p style={{ margin: '0 0 6px', fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>
            {$t('无托单轴一行；有托按托汇总一行（FC-17）；已添加行置灰不可再选。')}
          </p>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <Input style={{ width: 150 }} placeholder={$t('料品编码')} value={materialCode} onChange={(e) => setMaterialCode(e.target.value)} />
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              {$t('查询')}
            </Button>
          </div>
          <Table
            columns={[
              { key: 'pick', title: $t('选择'), render: (c) => <input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(c)} disabled={c.alreadyAdded} aria-label={$t('选择 {p0}', { p0: c.productAxisNo ?? c.palletCode ?? '' })} /> },
              { key: 'productAxisNo', title: $t('产品轴号'), render: (c) => c.productAxisNo ?? $t('—（按托）') },
              { key: 'palletCode', title: $t('托码'), render: (c) => c.palletCode ?? '—' },
              { key: 'axisCount', title: $t('轴数') },
              { key: 'quantity', title: $t('数量') },
              { key: 'uom', title: $t('单位') },
            ]}
            rows={candidates}
            rowKey={(c) => `${c.groupKind}-${c.productAxisNo ?? ''}-${c.palletCode ?? ''}`}
            emptyText={$t('无候选（成品、库存>0、在库、仓库类型=仓库）')}
          />
        </section>
        <section>
          <h4 style={{ margin: '0 0 6px' }}>{$t('右侧：转换清单（FC-18 提交前校验）')}</h4>
          <p style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>
            {$t('销售单号/行号/批次号必填（≤50）；每行段长必填（最小 0.0001）；已添加行左侧置灰不可再选（FC-17/20）。')}
          </p>
          <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
            <Input placeholder={$t('目标销售单号（必填）')} value={targetSalesOrderNo} onChange={(e) => setTargetSalesOrderNo(e.target.value)} />
            <Input placeholder={$t('目标行号（必填）')} value={targetLineNo} onChange={(e) => setTargetLineNo(e.target.value)} />
            <Input placeholder={$t('目标批次号（必填，自由文本 ≤50）')} value={targetBatchNo} onChange={(e) => setTargetBatchNo(e.target.value)} />
            <Input placeholder={$t('目标项目号（非必填）')} value={targetProjectNo} onChange={(e) => setTargetProjectNo(e.target.value)} />
            <Select
              aria-label={$t('段长预设')}
              placeholder={$t('段长预设（演示）')}
              options={[{ value: '400.0000', label: '400.0000' }, { value: '250.0000', label: '250.0000' }]}
            />
          </div>
          <Table
            columns={[
              { key: 'unitNo', title: $t('轴号/托码'), render: (c) => c.productAxisNo ?? c.palletCode ?? '—' },
              { key: 'quantity', title: $t('数量') },
              { key: 'uom', title: $t('单位') },
            ]}
            rows={selected}
            rowKey={(c) => `${c.groupKind}-${c.productAxisNo ?? ''}-${c.palletCode ?? ''}`}
            emptyText={$t('未选择')}
          />
        </section>
      </div>
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
    </Modal>
  )
}
