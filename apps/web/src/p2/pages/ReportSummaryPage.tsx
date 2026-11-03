import { useCallback, useState } from 'react'
import { Badge, Button, Input, Message, PageContainer, Table, t as $t } from '@cadenza/ui'
import {
  REPORT_CALIBER_LABELS,
  type ReportCaliberTotalsDto,
  type ReportSelectionSummaryDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REPORTING_READ, useP2Permissions } from '../permissions'
import { useP2ActionState } from '../shared'

/**
 * 报工口径汇总页（T20，RP-12～17）：
 * - 口径分层：草稿/提交/审核/合格/入库各自有口径，逐口径展示，不混成一个完成量（RP-16）；
 * - 不同单位不得直接汇总（RP-14：按生产单位分组展示）；
 * - Web 汇总行＝勾选报工单 id 集合，服务端全量聚合（RP-12/17）；英尺汇总列随米组展示（RP-03）。
 */
export function ReportSummaryPage() {
  const { has } = useP2Permissions()
  const canRead = has(REPORTING_READ)
  const [orderNoLike, setOrderNoLike] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [calibers, setCalibers] = useState<ReportCaliberTotalsDto[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set(['rep-1', 'rep-2']))
  const [selectionSummary, setSelectionSummary] = useState<ReportSelectionSummaryDto | null>(null)
  const action = useP2ActionState()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await p2Api.reportSummaryByCaliber({ orderNoLike: orderNoLike.trim() || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined })
      setCalibers(resp.calibers)
      setError(null)
      setLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? { title: $t('加载报工汇总失败'), detail: err.message } : { title: $t('加载报工汇总失败') })
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, orderNoLike])

  const loadSelection = useCallback(async () => {
    await action.run(async () => {
      const s = await p2Api.reportSelectionSummary([...selected], { orderNoLike: orderNoLike.trim() || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined })
      setSelectionSummary(s)
    })
  }, [action, dateFrom, dateTo, orderNoLike, selected])

  if (!canRead) {
    return (
      <PageContainer title={$t('报工口径汇总')} description={$t('五口径分层汇总（reporting 合同 RP-12～17）')}>
        <Message kind="warning" title={$t('没有报表域查询许可（reporting.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 reporting.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('报工口径汇总')}
      description={$t('草稿/提交/审核/合格/入库各自有口径，逐口径展示不混成一个完成量（RP-16）；不同单位不得直接汇总（RP-14）')}
      actions={
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Input style={{ width: 150 }} placeholder={$t('订单号（模糊）')} value={orderNoLike} onChange={(e) => setOrderNoLike(e.target.value)} />
          <Input style={{ width: 130 }} placeholder={$t('日期自（YYYY-MM-DD）')} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <Input style={{ width: 130 }} placeholder={$t('日期至')} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          <Button size="sm" loading={loading} onClick={() => void load()}>
            {$t('查询汇总')}
          </Button>
        </span>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {loaded ? (
        <Table<ReportCaliberTotalsDto>
          loading={loading}
          columns={[
            {
              key: 'caliber',
              title: $t('口径（RP-16）'),
              render: (c) => <Badge tone={c.caliber === 'stocked' ? 'success' : 'info'}>{REPORT_CALIBER_LABELS[c.caliber]}</Badge>,
            },
            { key: 'axisCount', title: $t('报工总轴数') },
            {
              key: 'groups',
              title: $t('按单位分组总量（RP-14：不得跨单位直接汇总）'),
              render: (c) =>
                c.groups.length === 0
                  ? '—'
                  : c.groups.map((g) => `${g.uomCode}：${g.totalQuantity}`).join('；'),
            },
          ]}
          rows={calibers}
          rowKey={(c) => c.caliber}
          emptyText={$t('暂无数据')}
        />
      ) : (
        <Message kind="info" title={$t('设置过滤条件后查询（服务端全量聚合，RP-17）')} />
      )}
      <section style={{ marginTop: 16 }}>
        <h4 style={{ margin: '0 0 6px' }}>{$t('Web 汇总行（RP-12：勾选报工单集合，服务端全量聚合）')}</h4>
        <p style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)', margin: '0 0 8px' }}>
          {$t('演示勾选 id：rep-1、rep-2（真实报工单勾选面由报工明细页联动提供，对账清单登记）。')}
        </p>
        <Button
          size="sm"
          loading={action.busy}
          onClick={() => {
            setSelected(new Set(['rep-1', 'rep-2']))
            void loadSelection()
          }}
        >
          {$t('汇总勾选行（rep-1、rep-2）')}
        </Button>
        {selectionSummary ? (
          <Message kind="info" title={$t('口径 {p0}｜轴数 {p1}', { p0: REPORT_CALIBER_LABELS[selectionSummary.caliber], p1: selectionSummary.axisCount })}>
            <p style={{ margin: '4px 0 0', fontSize: 13 }}>
              {selectionSummary.groups.map((g) => `${g.uomCode}：${g.totalQuantity}`).join('；')}
              {selectionSummary.feetGroups ? $t('｜英尺（RP-03）：{p0}', { p0: selectionSummary.feetGroups.map((g) => g.feetQuantity).join('、') }) : ''}
            </p>
          </Message>
        ) : null}
      </section>
    </PageContainer>
  )
}
