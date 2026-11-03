import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Field, Input, Message, Modal, PageContainer, Select, Table, t as $t } from '@cadenza/ui'
import {
  formatP3Error,
  type CostAllocationVersionView,
  type CostOrderSummaryResponse,
  type CostPriceVersionView,
  type CostReconItemView,
  type CostLaborCheckView,
  type CostRunDetailResponse,
  type CostRunView,
} from '../../../../../packages/ui/src/api/p3'
import { createWebP3Client } from '../client'
import { COST_POST, COST_READ, useP3Permissions } from '../permissions'
import { P3_PAGE_SIZE, useP3AsyncList } from '../shared'

/**
 * 成本报表页（CE-01～CE-18 + CE-S5/CA-12，端点对齐落盘 apps/api/src/cost）：
 * - 归集产出列表：估算（计划/BOM×价格版本）与实测（归集）两列并存（CE-17）；缺项显示缺项
 *   说明（CE-03/14：缺价不计金额、无 BOM 估算缺项），不以估算冒充实测；
 * - 归集明细：每行带源事实表+ID 可逐项回算（CE-05/15）；实测/估算分列（CE-03）；理论/差异
 *   分列（CE-07）；分摊与数据截止时点随行（CE-11）；
 * - 订单汇总：CE-17 两列 + CE-18 在制按工序已投入（材料＋工时，实测口径）；
 * - 命令：归集首跑 / 显式重算（CE-11：同订单班次已有产出→首跑拒绝、重算须理由并输出新旧对照）；
 * - 对账差异清单（CE-16/CE-S5：处置流转，未处置不得清零）；工时核对（CA-12·PROPOSED 主从口径）。
 * 本系统只读业务事实（CE-02），不结转会计分录（CE-01/18）。
 */

const SOURCE_KIND_LABELS: Record<string, string> = {
  material: '材料',
  labor: '工时',
  scrap: '损耗',
  equipment_runtime: '设备运行',
  spare_part: '备件',
  energy: '能源',
}

const RECON_KIND_LABELS: Record<string, string> = { material: '材料', labor: '工时', energy: '能源' }
const RECON_STATUS_LABELS: Record<string, { label: string; tone: 'warning' | 'success' | 'info' }> = {
  open: { label: '未处置', tone: 'warning' },
  confirmed: { label: '已确认', tone: 'success' },
  adjusted: { label: '已调整（吸收）', tone: 'info' },
}

interface RunCommandState {
  mode: 'run' | 'recalc'
  orderId: string
  shiftDate: string
  dataCutoffAt: string
  allocationVersionId: string
  priceVersionId: string
  reason: string
}

export function CostReportsPage() {
  const { has, plantId } = useP3Permissions()
  const canRead = has(COST_READ)
  const canPost = has(COST_POST)
  const client = useMemo(() => createWebP3Client(), [])
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // ---------------- 归集产出列表（服务端分页，PC-16） ----------------
  const runs = useP3AsyncList<CostRunView>(
    (p) => client.costListRuns({ page: p, pageSize: P3_PAGE_SIZE, plantId: plantId ?? undefined }),
    [plantId],
  )

  // ---------------- 选中 run 的明细 + 订单汇总 ----------------
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runDetail, setRunDetail] = useState<CostRunDetailResponse | null>(null)
  const [orderSummary, setOrderSummary] = useState<CostOrderSummaryResponse | null>(null)

  const loadDetail = useCallback(
    (runId: string) => {
      setSelectedRunId(runId)
      client
        .costRunDetail(runId)
        .then((detail) => {
          setRunDetail(detail)
          return client.costOrderSummary(detail.run.orderId).catch(() => null)
        })
        .then(setOrderSummary)
        .catch((err: unknown) => {
          setRunDetail(null)
          setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
        })
    },
    [client],
  )

  useEffect(() => {
    if (!canRead || selectedRunId === null) return
    loadDetail(selectedRunId)
  }, [canRead, selectedRunId])

  // ---------------- 对账差异与工时核对 ----------------
  const [reconItems, setReconItems] = useState<CostReconItemView[]>([])
  const [laborChecks, setLaborChecks] = useState<CostLaborCheckView[]>([])
  const [reconTarget, setReconTarget] = useState<CostReconItemView | null>(null)
  const [reconStatus, setReconStatus] = useState<'confirmed' | 'adjusted'>('confirmed')
  const [reconReason, setReconReason] = useState('')
  const [checkTarget, setCheckTarget] = useState<CostLaborCheckView | null>(null)
  const [checkReason, setCheckReason] = useState('')

  const loadReconAndChecks = useCallback(() => {
    if (!canRead) return
    client
      .costListReconItems({ page: 1, pageSize: 20, plantId: plantId ?? undefined })
      .then((page) => setReconItems(page.items))
      .catch(() => setReconItems([]))
    client
      .costListLaborChecks({ page: 1, pageSize: 20, plantId: plantId ?? undefined })
      .then((page) => setLaborChecks(page.items))
      .catch(() => setLaborChecks([]))
  }, [canRead, client, plantId])

  useEffect(() => {
    loadReconAndChecks()
  }, [loadReconAndChecks])

  // ---------------- 归集首跑 / 显式重算（CE-11） ----------------
  const [allocationVersions, setAllocationVersions] = useState<CostAllocationVersionView[]>([])
  const [priceVersions, setPriceVersions] = useState<CostPriceVersionView[]>([])
  const [runCmdOpen, setRunCmdOpen] = useState(false)
  const [runCmd, setRunCmd] = useState<RunCommandState>({
    mode: 'run',
    orderId: 'po-1027-001',
    shiftDate: '2026-10-28',
    dataCutoffAt: '2026-10-28T20:00:00+08:00',
    allocationVersionId: '',
    priceVersionId: '',
    reason: '',
  })

  useEffect(() => {
    if (!canRead) return
    client
      .costListAllocationVersions({ statuses: 'active', page: 1, pageSize: 20 })
      .then((page) => {
        setAllocationVersions(page.items)
        setRunCmd((s) => ({ ...s, allocationVersionId: s.allocationVersionId || (page.items[0]?.id ?? '') }))
      })
      .catch(() => setAllocationVersions([]))
    client
      .costListPriceVersions({ statuses: 'active', page: 1, pageSize: 20 })
      .then((page) => {
        setPriceVersions(page.items)
        setRunCmd((s) => ({ ...s, priceVersionId: s.priceVersionId || (page.items[0]?.id ?? '') }))
      })
      .catch(() => setPriceVersions([]))
  }, [canRead, client])

  const submitRunCommand = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (runCmd.mode === 'run') {
        const resp = await client.costAcquisitionRun({
          plantId: plantId ?? 'n-plant',
          orderId: runCmd.orderId.trim(),
          shiftDate: runCmd.shiftDate.trim(),
          dataCutoffAt: runCmd.dataCutoffAt.trim(),
          allocationVersionId: runCmd.allocationVersionId,
          priceVersionId: runCmd.priceVersionId,
          reason: '页面归集首跑（CE-02 只读业务事实）',
        })
        setNotice($t('归集完成：{p0}——估算/实测两列并存（CE-17），明细带源事实 ID 可回算（CE-15）', { p0: String((resp.data as { runNo?: string } | null)?.runNo ?? resp.operationId) }))
      } else {
        if (runCmd.reason.trim() === '') {
          setError({ title: $t('[CE-11] 显式重算必须填写理由（OA-29 高影响操作留痕）') })
          return
        }
        const resp = await client.costAcquisitionRecalc({
          plantId: plantId ?? 'n-plant',
          orderId: runCmd.orderId.trim(),
          shiftDate: runCmd.shiftDate.trim(),
          dataCutoffAt: runCmd.dataCutoffAt.trim(),
          allocationVersionId: runCmd.allocationVersionId,
          priceVersionId: runCmd.priceVersionId,
          reason: runCmd.reason.trim(),
        })
        const cmp = (resp.data as { oldNewComparison?: Record<string, unknown> } | null)?.oldNewComparison
        setNotice(
          $t('重算完成：新旧对照已固化（{p0}）——历史产出不改写（CE-11）', { p0: cmp ? Object.entries(cmp).filter(([k]) => k !== 'note' && k !== 'reason').map(([k, v]) => `${k}=${String(v)}`).join('；') : $t('见明细') }),
        )
      }
      setRunCmdOpen(false)
      runs.setPage(1)
      runs.reload()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  const submitReconResolve = async () => {
    if (reconTarget === null) return
    if (reconReason.trim() === '') {
      setError({ title: $t('[CE-S5] 对账处置必须填写理由（差异处置留痕）') })
      return
    }
    setBusy(true)
    setError(null)
    try {
      await client.costReconResolve({
        plantId: plantId ?? 'n-plant',
        itemId: reconTarget.id,
        targetStatus: reconStatus,
        reason: reconReason.trim(),
      })
      setNotice($t('对账差异 {p0} 已处置（{p1}）；差异清单未处置不得清零（CE-S5）', { p0: reconTarget.reconKey, p1: RECON_STATUS_LABELS[reconStatus]?.label }))
      setReconTarget(null)
      setReconReason('')
      loadReconAndChecks()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  const submitCheckAcknowledge = async () => {
    if (checkTarget === null) return
    if (checkReason.trim() === '') {
      setError({ title: $t('[CA-12] 工时核对确认必须填写理由（主从冲突不自动改写报工工时）') })
      return
    }
    setBusy(true)
    setError(null)
    try {
      await client.costLaborCheckAcknowledge({ plantId: plantId ?? 'n-plant', checkId: checkTarget.id, reason: checkReason.trim() })
      setNotice($t('工时核对 {p0} 已确认留痕（报工工时为主源不被改写，CA-12）', { p0: checkTarget.id }))
      setCheckTarget(null)
      setCheckReason('')
      loadReconAndChecks()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  const runLaborCheck = async () => {
    setBusy(true)
    setError(null)
    try {
      const resp = await client.costLaborCheckRun({
        plantId: plantId ?? 'n-plant',
        orderId: runCmd.orderId.trim(),
        shiftDate: runCmd.shiftDate.trim(),
        reason: '页面生成工时核对（CA-12）',
      })
      const data = resp.data as { checkId?: string; deviationRatio?: string | null; note?: string } | null
      setNotice($t('工时核对已生成：{p0}（偏差率 {p1}；{p2}）', { p0: data?.checkId ?? '', p1: data?.deviationRatio ?? '—', p2: data?.note ?? '报工 labor_record 主源 vs OT 运行参考源' }))
      loadReconAndChecks()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('成本报表')} description={$t('订单成本归集：估算与实测分列（CE-17）')}>
        <Message kind="warning" title={$t('无成本报表权限（cost.read）')}>{$t('未授予成本域查询许可，请联系管理员授权后使用。')}</Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('成本报表')}
      description={$t('估算（计划/BOM×价格版本）与实测（归集）两列并存（CE-17）；归集只读业务事实、不结转分录（CE-02/18）——本页只消费归集投影')}
      actions={
        canPost ? (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => { setRunCmd((s) => ({ ...s, mode: 'run' })); setRunCmdOpen(true) }}>{$t('执行归集（首跑）')}</Button>
            <Button onClick={() => { setRunCmd((s) => ({ ...s, mode: 'recalc', reason: '' })); setRunCmdOpen(true) }}>{$t('显式重算（CE-11）')}</Button>
          </>
        ) : undefined
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}
      {runs.error ? <Message kind="error" title={runs.error.title} detail={runs.error.detail} /> : null}

      <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('归集产出（估算/实测两列并存，CE-17）')}</h3>
      <Table
        columns={[
          { key: 'runNo', title: $t('产出号') },
          { key: 'orderId', title: $t('订单 ID') },
          { key: 'shiftDate', title: $t('班次') },
          {
            key: 'estimate',
            title: $t('估算（计划口径）'),
            render: (r) =>
              r.estimatePossible ? (
                r.estimateAmount ?? <Badge tone="warning">{$t('缺项（缺价行）')}</Badge>
              ) : (
                <Badge tone="warning">{$t('缺项（')}{r.estimateMissingReason ?? $t('估算不可用')}{$t('）')}</Badge>
              ),
          },
          {
            key: 'actual',
            title: $t('实测（归集口径）'),
            render: (r) => (r.actualAmount === null ? <Badge tone="warning">{$t('缺项（存在缺价行，CE-14 不计金额）')}</Badge> : r.actualAmount),
          },
          {
            key: 'energy',
            title: $t('能源实测/估算（覆盖率）'),
            render: (r) =>
              `${r.energyMeteredUsage} / ${r.energyEstimatedUsage}${r.energyUomCode ? ` ${r.energyUomCode}` : ''}${
                r.energyCoverageRatio === null ? '' : `（${(Number(r.energyCoverageRatio) * 100).toFixed(1)}%，CE-09）`
              }`,
          },
          { key: 'machineHours', title: $t('机时（H）') },
          { key: 'recalcOf', title: $t('重算链'), render: (r) => (r.recalcOf === null ? '—' : <Badge tone="info">{$t('重算自')} {r.recalcOf}</Badge>) },
          { key: 'dataCutoffAt', title: $t('数据截至'), render: (r) => r.dataCutoffAt.replace('T', ' ').slice(0, 16) },
          {
            key: 'actions',
            title: $t('明细'),
            render: (r) => (
              <Button size="sm" variant="ghost" onClick={() => loadDetail(r.id)}>
                {$t('明细＋订单汇总')}
              </Button>
            ),
          },
        ]}
        rows={runs.items}
        rowKey={(r) => r.id}
        loading={runs.loading}
        page={{ page: runs.page, pageSize: P3_PAGE_SIZE }}
        total={runs.total}
        onPageChange={runs.setPage}
        emptyText={$t('暂无归集产出（先执行归集首跑）')}
      />

      {runDetail !== null ? (
        <>
          <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>
            {$t('归集明细：')}{runDetail.run.runNo}{$t('（分摊版本')} {runDetail.run.allocationVersionId}{$t('；数据截至')} {runDetail.run.dataCutoffAt.replace('T', ' ').slice(0, 16)}{$t('）')}
          </h3>
          <Message kind="info" title={$t('工时主源：{p0}｜设备成本口径：{p1}', { p0: runDetail.run.laborSource, p1: runDetail.run.equipmentCostCaliber })}>
            {runDetail.run.recalcOf !== null
              ? $t('本产出为显式重算（CE-11）：基于 {p0}，新旧对照已固化于产出记录。', { p0: runDetail.run.recalcOf })
              : $t('CE-02：归集只读业务事实，不重新执行报工或扣库存；CE-01/18：成品成本结转归 ERP，本系统不结转分录。')}
          </Message>
          <Table
            columns={[
              { key: 'kind', title: $t('类别'), render: (l) => SOURCE_KIND_LABELS[String(l.sourceKind)] ?? String(l.sourceKind) },
              { key: 'source', title: $t('源事实（CE-15 可回算）'), render: (l) => `${l.sourceTable}／${l.sourceFactId}` },
              { key: 'valueFlag', title: $t('实测/估算'), render: (l) => (l.valueFlag === 'measured' ? <Badge tone="success">{$t('实测')}</Badge> : <Badge tone="warning">{$t('估算')}</Badge>) },
              { key: 'quantity', title: $t('数量＋单位'), render: (l) => `${l.quantity} ${l.uomCode}` },
              {
                key: 'theory',
                title: $t('理论/差异（CE-07）'),
                render: (l) => (l.theoreticalQuantity === null ? '—' : `${l.theoreticalQuantity}${l.varianceQuantity === null ? '' : `（差 ${l.varianceQuantity}）`}`),
              },
              {
                key: 'price',
                title: $t('单价（CE-14）'),
                render: (l) => (l.priceMissing ? <Badge tone="warning">{$t('缺价（不填默认价）')}</Badge> : l.unitPrice ?? '—'),
              },
              { key: 'amount', title: $t('金额'), render: (l) => l.amount ?? <Badge tone="warning">{$t('缺价不计金额')}</Badge> },
            ]}
            rows={runDetail.lines}
            rowKey={(l) => l.lineId}
            emptyText={$t('该产出暂无明细行')}
          />

          {orderSummary !== null ? (
            <>
              <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>
                {$t('订单汇总：')}{orderSummary.orderNo}{$t('（状态')} {orderSummary.orderStatus}{$t('；计划量')} {orderSummary.plannedQty}{$t('）')}
              </h3>
              <Table
                columns={[
                  { key: 'materialCode', title: $t('估算行（BOM×计划量×价格版本）') },
                  { key: 'theoreticalQty', title: $t('理论量'), render: (l) => `${l.theoreticalQty} ${l.uomCode}` },
                  { key: 'unitPrice', title: $t('单价'), render: (l) => (l.priceMissing ? <Badge tone="warning">{$t('缺价')}</Badge> : l.unitPrice ?? '—') },
                  { key: 'amount', title: $t('金额'), render: (l) => l.amount ?? <Badge tone="warning">{$t('缺价不计金额')}</Badge> },
                ]}
                rows={orderSummary.estimate.lines}
                rowKey={(l) => l.materialCode}
                emptyText={orderSummary.estimate.possible ? $t('无估算行') : orderSummary.estimate.missingReason ?? $t('估算缺项')}
              />
              {orderSummary.estimate.missingReason !== null ? (
                <Message kind="warning" title={$t('估算列缺项（CE-03/17）：{p0}', { p0: orderSummary.estimate.missingReason })}>{$t('数量照常列示，不以估算冒充实测。')}</Message>
              ) : null}
              <h3 style={{ fontSize: 15, margin: '12px 0 8px' }}>{$t('在制按工序已投入（CE-18：材料＋工时，实测口径；结转归 ERP）')}</h3>
              <Table
                columns={[
                  { key: 'operationSeq', title: $t('工序'), render: (w) => w.operationSeq ?? '—' },
                  { key: 'materialQty', title: $t('材料量'), render: (w) => w.materialQty },
                  { key: 'materialAmount', title: $t('材料金额'), render: (w) => w.materialAmount ?? <Badge tone="warning">{$t('缺价不计金额')}</Badge> },
                  { key: 'laborHours', title: $t('工时（H）'), render: (w) => w.laborHours },
                ]}
                rows={orderSummary.wipByOperation}
                rowKey={(w) => `${w.orderOperationId ?? 'none'}`}
                emptyText={$t('无在制投入行')}
              />
            </>
          ) : null}
        </>
      ) : null}

      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{$t('对账差异清单（CE-16：本系统归集数量基础 vs ERP；未处置不得清零，CE-S5）')}</h3>
      <Table
        columns={[
          { key: 'kind', title: $t('维度'), render: (i) => RECON_KIND_LABELS[String(i.kind)] ?? String(i.kind) },
          { key: 'orderNo', title: $t('订单'), render: (i) => i.orderNo ?? '—' },
          { key: 'materialCode', title: $t('料品'), render: (i) => i.materialCode ?? '—' },
          { key: 'local', title: $t('本系统数量'), render: (i) => `${i.localQuantity} ${i.uomCode}` },
          { key: 'erp', title: $t('ERP 数量'), render: (i) => `${i.erpQuantity} ${i.uomCode}` },
          { key: 'diff', title: $t('差异'), render: (i) => (Number(i.diffQuantity) === 0 ? '0' : <Badge tone={Number(i.diffQuantity) > 0 ? 'warning' : 'info'}>{i.diffQuantity}</Badge>) },
          { key: 'erpDocumentRef', title: $t('ERP 单据'), render: (i) => i.erpDocumentRef ?? '—' },
          {
            key: 'status',
            title: $t('处置状态'),
            render: (i) => {
              const s = RECON_STATUS_LABELS[String(i.dispositionStatus)]
              return s ? <Badge tone={s.tone}>{s.label}</Badge> : String(i.dispositionStatus)
            },
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (i) =>
              canPost && i.dispositionStatus === 'open' ? (
                <Button size="sm" onClick={() => { setReconTarget(i); setReconStatus('confirmed'); setReconReason('') }}>{$t('处置')}</Button>
              ) : null,
          },
        ]}
        rows={reconItems}
        rowKey={(i) => i.id}
        loading={reconItems.length === 0}
        emptyText={$t('暂无对账差异（ERP 对账以模拟适配器入站，真实联调 BLOCKED_EXTERNAL）')}
      />

      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>
        {$t('工时核对（CA-12·PROPOSED：报工 labor_record 主源 vs OT 运行参考源，冲突不自动改写）')}
      </h3>
      <Table
        columns={[
          { key: 'orderId', title: $t('订单') },
          { key: 'operationKey', title: $t('工序') },
          { key: 'shiftDate', title: $t('班次') },
          { key: 'laborHours', title: $t('报工工时（H）') },
          { key: 'otRuntimeHours', title: $t('OT 运行（H）'), render: (c) => c.otRuntimeHours ?? <Badge tone="warning">{$t('缺项（')}{c.missingSide === 'ot' ? $t('OT 侧无数据') : '—'}{$t('）')}</Badge> },
          {
            key: 'deviationRatio',
            title: $t('偏差率/阈值'),
            render: (c) =>
              c.deviationRatio === null
                ? '—'
                : Number(c.deviationRatio) > Number(c.thresholdRatio)
                  ? <Badge tone="danger">{c.deviationRatio} {$t('＞')} {c.thresholdRatio}</Badge>
                  : `${c.deviationRatio} / ${c.thresholdRatio}`,
          },
          { key: 'status', title: $t('状态'), render: (c) => (c.status === 'open' ? <Badge tone="warning">{$t('待核对')}</Badge> : <Badge tone="success">{$t('已确认')}</Badge>) },
          {
            key: 'actions',
            title: $t('操作'),
            render: (c) =>
              canPost && c.status === 'open' ? (
                <Button size="sm" onClick={() => { setCheckTarget(c); setCheckReason('') }}>{$t('确认留痕')}</Button>
              ) : null,
          },
        ]}
        rows={laborChecks}
        rowKey={(c) => c.id}
        loading={laborChecks.length === 0}
        emptyText={$t('暂无核对提示')}
      />
      {canPost ? (
        <div style={{ marginTop: 8 }}>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void runLaborCheck()}>
            {$t('生成工时核对（订单')} {runCmd.orderId}{$t('／班次')} {runCmd.shiftDate}{$t('，CA-12）')}
          </Button>
        </div>
      ) : null}

      <Modal
        open={runCmdOpen}
        title={runCmd.mode === 'run' ? $t('执行归集（首跑，CE-S1/CE-02）') : $t('显式重算（CE-11：新版本＋新旧对照）')}
        onClose={() => setRunCmdOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRunCmdOpen(false)}>{$t('取消')}</Button>
            <Button loading={busy} onClick={() => void submitRunCommand()}>{runCmd.mode === 'run' ? $t('执行归集') : $t('执行重算')}</Button>
          </>
        }
      >
        <Field label={$t('订单 ID')} required hint={$t('如 po-1027-001（演示数据；真实单据 ID 由订单页跳转带入）')}>
          <Input value={runCmd.orderId} onChange={(e) => setRunCmd((s) => ({ ...s, orderId: e.target.value }))} aria-label={$t('订单 ID')} />
        </Field>
        <Field label={$t('班次日期（YYYY-MM-DD）')} required>
          <Input value={runCmd.shiftDate} onChange={(e) => setRunCmd((s) => ({ ...s, shiftDate: e.target.value }))} aria-label={$t('班次日期')} />
        </Field>
        <Field label={$t('数据截止时点（CE-11）')} required>
          <Input value={runCmd.dataCutoffAt} onChange={(e) => setRunCmd((s) => ({ ...s, dataCutoffAt: e.target.value }))} aria-label={$t('数据截止时点')} />
        </Field>
        <Field label={$t('分摊版本（CE-12 默认机时占比）')} required>
          <Select
            value={runCmd.allocationVersionId}
            aria-label={$t('分摊版本')}
            options={allocationVersions.map((v) => ({ value: v.id, label: $t('v{p0} {p1}{p2}', { p0: v.versionNo, p1: v.formula === 'machine_hours' ? $t('机时占比') : v.formula, p2: v.status === 'active' ? '' : $t('（已停用）') }) }))}
            onChange={(e) => setRunCmd((s) => ({ ...s, allocationVersionId: e.target.value }))}
          />
        </Field>
        <Field label={$t('价格版本（CE-14 价格主权归上游）')} required>
          <Select
            value={runCmd.priceVersionId}
            aria-label={$t('价格版本')}
            options={priceVersions.map((v) => ({ value: v.id, label: $t('v{p0} {p1}', { p0: v.versionNo, p1: v.priceSource === 'standard_cost' ? $t('标准成本') : $t('ERP 实际价') }) }))}
            onChange={(e) => setRunCmd((s) => ({ ...s, priceVersionId: e.target.value }))}
          />
        </Field>
        {runCmd.mode === 'recalc' ? (
          <Field label={$t('重算理由（必填，OA-29 高影响操作留痕）')} required error={runCmdOpen && runCmd.reason.trim() === '' ? $t('理由不能为空（[CE-11]）') : undefined}>
            <Input value={runCmd.reason} onChange={(e) => setRunCmd((s) => ({ ...s, reason: e.target.value }))} placeholder={$t('如 换用 2026Q4 价格版本重估')} aria-label={$t('重算理由')} />
          </Field>
        ) : (
          <p style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>
            {$t('同订单同班次已有归集产出时首跑被拒（CE-11：历史报表不静默重算，重算走显式命令）。')}
          </p>
        )}
      </Modal>

      <Modal
        open={reconTarget !== null}
        title={$t('对账差异处置：{p0}', { p0: reconTarget?.reconKey ?? '' })}
        onClose={() => setReconTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReconTarget(null)}>{$t('取消')}</Button>
            <Button loading={busy} onClick={() => void submitReconResolve()}>{$t('提交处置')}</Button>
          </>
        }
      >
        <Field label={$t('目标状态（CE-S5）')} required>
          <Select
            value={reconStatus}
            options={[
              { value: 'confirmed', label: $t('确认（差异属实，交业务/财务跟进）') },
              { value: 'adjusted', label: $t('调整（差异吸收，终态留痕）') },
            ]}
            onChange={(e) => setReconStatus(e.target.value as 'confirmed' | 'adjusted')}
            aria-label={$t('目标处置状态')}
          />
        </Field>
        <Field label={$t('理由（必填）')} required error={reconTarget !== null && reconReason.trim() === '' ? $t('理由不能为空（[CE-S5]）') : undefined}>
          <Input value={reconReason} onChange={(e) => setReconReason(e.target.value)} placeholder={$t('如 与 ERP 侧核对为计量口径差，业务确认')} aria-label={$t('处置理由')} />
        </Field>
        <p style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>{$t('差异输出具名清单交业务/财务确认，不静默吸收（CE-16）；adjusted 为终态不可再流转。')}</p>
      </Modal>

      <Modal
        open={checkTarget !== null}
        title={$t('工时核对确认：{p0}（{p1}）', { p0: checkTarget?.operationKey ?? '', p1: checkTarget?.shiftDate ?? '' })}
        onClose={() => setCheckTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCheckTarget(null)}>{$t('取消')}</Button>
            <Button loading={busy} onClick={() => void submitCheckAcknowledge()}>{$t('确认留痕')}</Button>
          </>
        }
      >
        <Field label={$t('确认理由（必填）')} required error={checkTarget !== null && checkReason.trim() === '' ? $t('理由不能为空（[CA-12]）') : undefined}>
          <Input value={checkReason} onChange={(e) => setCheckReason(e.target.value)} placeholder={$t('如 设备待机时间计入 OT 运行，报工工时无误')} aria-label={$t('确认理由')} />
        </Field>
        <p style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>
          {$t('报工工时为主源（CA-12·PROPOSED）：确认仅留痕核对结论，不自动改写报工工时；口径变更走 PM 裁定。')}
        </p>
      </Modal>
    </PageContainer>
  )
}
