import { useEffect, useState } from 'react'
import { Badge, Button, Input, Message, PageContainer, Table, t as $t, tx as $tx } from '@cadenza/ui'
import {
  METRIC_DEF_STATUS_LABELS,
  METRIC_FAMILY_LABELS,
  SNAPSHOT_STATUS_LABELS,
  TRACE_EDGE_KIND_LABELS,
  type MetricDefinitionDto,
  type ShiftSnapshotDto,
  type TraceResultDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REPORTING_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList } from '../shared'

const TABS = [
  { key: 'metrics', label: '指标定义' },
  { key: 'snapshots', label: '班次快照' },
  { key: 'trace', label: '追溯（RP-22）' },
] as const

/**
 * 指标与追溯页（T20，RP-18～22＋IT-35）：
 * - 指标定义版本化：分子/分母事实集、单位、口径版本、生效区间；被快照引用即 immutable（RP-19/RP-S3）；
 * - 班次快照幂等键（工厂+班次日期+指标+指标版本，RP-S2）；分母缺失/投影失败保留标记与原因，
 *   不以 0 冒充（RP-21）；sourceRows 为逐笔对账锚点（RP-22）；
 * - 追溯双向：正向批次→在制/轴段/客户交付；反向交付轴→原料/工序/设备/人员/检验（RP-22/IT-35）。
 */
export function ShiftMetricsPage() {
  const { has } = useP2Permissions()
  const canRead = has(REPORTING_READ)
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('metrics')

  if (!canRead) {
    return (
      <PageContainer title={$t('指标与追溯')} description={$t('核心指标与双向追溯（reporting 合同 RP-18～22）')}>
        <Message kind="warning" title={$t('没有报表域查询许可（reporting.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 reporting.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('指标与追溯')}
      description={$t('分母缺失保留标记与原因，不以 0 冒充（RP-21）；快照幂等键（RP-S2）；追溯正反向（RP-22/IT-35）')}
      actions={
        <nav aria-label={$t('指标分区')} style={{ display: 'inline-flex', gap: 6 }}>
          {TABS.map((t) => (
            <Button key={t.key} size="sm" variant={tab === t.key ? 'primary' : 'secondary'} onClick={() => setTab(t.key)}>
              {$tx(t.label)}
            </Button>
          ))}
        </nav>
      }
    >
      {tab === 'metrics' ? <MetricsTab /> : null}
      {tab === 'snapshots' ? <SnapshotsTab /> : null}
      {tab === 'trace' ? <TraceTab /> : null}
    </PageContainer>
  )
}

function MetricsTab() {
  const [rows, setRows] = useState<MetricDefinitionDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string } | null>(null)
  useEffect(() => {
    let alive = true
    p2Api
      .listMetricDefinitions()
      .then((defs) => {
        if (!alive) return
        setRows(defs)
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setError({ title: $t('加载指标定义失败') })
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])
  return (
    <section>
      {error ? <Message kind="error" title={error.title} /> : null}
      <Table<MetricDefinitionDto>
        loading={loading}
        columns={[
          { key: 'metricKey', title: $t('指标键') },
          { key: 'family', title: $t('族'), render: (d) => <Badge>{METRIC_FAMILY_LABELS[d.family]}</Badge> },
          { key: 'version', title: $t('版本') },
          { key: 'caliberVersion', title: $t('口径版本') },
          { key: 'numeratorFactSet', title: $t('分子事实集'), render: (d) => d.numeratorFactSet.kind },
          { key: 'denominatorFactSet', title: $t('分母事实集'), render: (d) => d.denominatorFactSet?.kind ?? $t('—（无分母）') },
          { key: 'uom', title: $t('单位/模式'), render: (d) => $t('{p0}（{p1}）', { p0: d.uomCode, p1: d.uomMode === 'percent' ? '百分比' : '数值' }) },
          { key: 'effectiveFrom', title: $t('生效自') },
          { key: 'effectiveTo', title: $t('生效至'), render: (d) => d.effectiveTo ?? '—' },
          { key: 'status', title: $t('状态'), render: (d) => <Badge tone={d.status === 'active' ? 'success' : 'default'}>{METRIC_DEF_STATUS_LABELS[d.status]}</Badge> },
          { key: 'referenced', title: $t('被引用（immutable，RP-S3）'), render: (d) => (d.referenced ? $t('是（不可改）') : $t('否')) },
          { key: 'description', title: $t('说明'), render: (d) => d.description ?? '—' },
        ]}
        rows={rows}
        rowKey={(d) => d.id}
        emptyText={$t('暂无指标定义')}
      />
    </section>
  )
}

function SnapshotsTab() {
  const [statuses, setStatuses] = useState('')
  const list = useP2AsyncList(
    (p) => p2Api.listShiftSnapshots({ page: p, pageSize: PAGE_SIZE, statuses: statuses === '' ? undefined : statuses.split(',') }),
    [statuses],
  )
  return (
    <section>
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      <Message kind="info" title={$t('快照保留缺失标记与原因（RP-21）：分母缺失/投影失败不以 0 冒充成功数值')}>
        <p style={{ margin: '4px 0 0', fontSize: 13 }}>{$t('sourceRows＝参与聚合的事实行数（RP-22 逐笔对账锚点）。')}</p>
      </Message>
      <div style={{ margin: '8px 0' }}>
        <Input
          style={{ width: 220 }}
          placeholder={$t('状态过滤（如 ok,denominator_missing）')}
          value={statuses}
          onChange={(e) => {
            list.setPage(1)
            setStatuses(e.target.value)
          }}
        />
      </div>
      <Table<ShiftSnapshotDto>
        loading={list.loading}
        columns={[
          { key: 'shiftDate', title: $t('班次日期') },
          { key: 'metricKey', title: $t('指标') },
          { key: 'metricVersion', title: $t('指标版本') },
          { key: 'caliberVersion', title: $t('口径版本') },
          { key: 'numeratorValue', title: $t('分子'), render: (s) => s.numeratorValue ?? $t('—（缺失）') },
          { key: 'denominatorValue', title: $t('分母'), render: (s) => s.denominatorValue ?? $t('—（缺失）') },
          { key: 'value', title: $t('快照值'), render: (s) => s.value ?? $t('—（不以 0 冒充）') },
          { key: 'uomCode', title: $t('单位') },
          {
            key: 'status',
            title: $t('状态'),
            render: (s) => (
              <Badge tone={s.status === 'ok' ? 'success' : 'danger'}>{SNAPSHOT_STATUS_LABELS[s.status]}</Badge>
            ),
          },
          { key: 'missingReason', title: $t('缺失/失败原因（RP-21）'), render: (s) => s.missingReason ?? '—' },
          { key: 'sourceRows', title: $t('事实行数（RP-22）') },
          { key: 'computedAt', title: $t('计算时间'), render: (s) => new Date(s.computedAt).toLocaleString('zh-CN') },
          { key: 'computedBy', title: $t('计算者') },
        ]}
        rows={list.items}
        rowKey={(s) => s.id}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无班次快照')}
      />
    </section>
  )
}

function TraceTab() {
  const [unitNo, setUnitNo] = useState('U-2026-1001-0001')
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward')
  const [result, setResult] = useState<TraceResultDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)

  const run = async () => {
    setLoading(true)
    try {
      setResult(await p2Api.trace(unitNo.trim(), direction))
      setError(null)
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? { title: $t('追溯失败'), detail: err.message } : { title: $t('追溯失败') })
    } finally {
      setLoading(false)
    }
  }

  return (
    <section>
      <div style={{ display: 'inline-flex', gap: 6, marginBottom: 10 }}>
        <Input style={{ width: 200 }} placeholder={$t('根对象轴号')} value={unitNo} onChange={(e) => setUnitNo(e.target.value)} />
        <Button size="sm" variant={direction === 'forward' ? 'primary' : 'secondary'} onClick={() => setDirection('forward')}>
          {$t('正向（批次→交付）')}
        </Button>
        <Button size="sm" variant={direction === 'backward' ? 'primary' : 'secondary'} onClick={() => setDirection('backward')}>
          {$t('反向（交付→原料）')}
        </Button>
        <Button size="sm" loading={loading} onClick={() => void run()}>
          {$t('追溯')}
        </Button>
      </div>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {result ? (
        <>
          <h4 style={{ margin: '10px 0 6px' }}>
            {$t('方向：')}{result.direction === 'forward' ? $t('正向') : $t('反向')}{$t('｜根：')}{result.root.unitNo ?? result.root.nodeId}
          </h4>
          <Table
            columns={[
              { key: 'nodeId', title: $t('节点') },
              { key: 'nodeType', title: $t('类型') },
              { key: 'unitNo', title: $t('轴号'), render: (n) => n.unitNo ?? '—' },
              { key: 'materialCode', title: $t('料品'), render: (n) => n.materialCode ?? '—' },
              { key: 'status', title: $t('状态'), render: (n) => n.status ?? '—' },
              { key: 'depth', title: $t('深度') },
              { key: 'operationName', title: $t('工序'), render: (n) => n.operationName ?? '—' },
              { key: 'equipmentCode', title: $t('设备'), render: (n) => n.equipmentCode ?? '—' },
              { key: 'operatorLogin', title: $t('操作工'), render: (n) => n.operatorLogin ?? '—' },
            ]}
            rows={result.nodes}
            rowKey={(n) => n.nodeId}
            emptyText={$t('无节点')}
          />
          <h4 style={{ margin: '12px 0 6px' }}>{$t('边（数量随行）')}</h4>
          <Table
            columns={[
              { key: 'fromNodeId', title: $t('从') },
              { key: 'toNodeId', title: $t('到') },
              { key: 'edgeKind', title: $t('边类型'), render: (e) => <Badge>{TRACE_EDGE_KIND_LABELS[e.edgeKind]}</Badge> },
              {
                key: 'quantity',
                title: $t('数量'),
                render: (e) => (
                  <span>
                    {e.quantity} <b style={{ fontSize: 12 }}>{e.uomCode}</b>
                  </span>
                ),
              },
              { key: 'businessTime', title: $t('业务时间'), render: (e) => new Date(e.businessTime).toLocaleString('zh-CN') },
            ]}
            rows={result.edges}
            rowKey={(e) => `${e.fromNodeId}-${e.toNodeId}-${e.edgeKind}`}
            emptyText={$t('无边')}
          />
        </>
      ) : (
        <Message kind="info" title={$t('输入轴号并选择方向开始追溯（RP-22/IT-35）')} />
      )}
    </section>
  )
}
