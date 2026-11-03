import { useState } from 'react'
import { Badge, Input, Message, PageContainer, Select, Table, t as $t, tx as $tx } from '@cadenza/ui'
import {
  AXIS_ABNORMAL_STATUS_LABELS,
  AXIS_INBOUND_STATUS_LABELS,
  AXIS_LOCK_STATUS_LABELS,
  AXIS_QC_STATUS_LABELS,
  AXIS_REPORT_STATUS_LABELS,
  AXIS_SALE_STATUS_LABELS,
  AXIS_SUSPECT_STATUS_LABELS,
  type AxisQueryRowDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REPORTING_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList } from '../shared'

/**
 * 轴查询页（T20，RP-08～11）：只读跨域投影。
 * - 只查询/导出，无新增/修改/删除/详情入口（RP-08）；
 * - 采购来源轴不走报工：报工状态固定"-"；按报工状态筛选不含采购来源轴（RP-09，
 *   前端不提供"-"作为筛选值）；
 * - 多状态轴分列展示（入库/质检/销售/报工/存疑/锁定/成品异常）；数量与单位同现（PC-06）。
 */
export function AxisQueryPage() {
  const { has } = useP2Permissions()
  const canRead = has(REPORTING_READ)
  const [unitNoLike, setUnitNoLike] = useState('')
  const [inboundStatus, setInboundStatus] = useState('')
  const [reportStatus, setReportStatus] = useState('')
  const list = useP2AsyncList(
    (p) =>
      p2Api.listAxisQuery({
        page: p,
        pageSize: PAGE_SIZE,
        unitNoLike: unitNoLike.trim() || undefined,
        inboundStatus: inboundStatus === '' ? undefined : inboundStatus,
        reportStatus: reportStatus === '' ? undefined : reportStatus,
      }),
    [unitNoLike, inboundStatus, reportStatus],
  )

  if (!canRead) {
    return (
      <PageContainer title={$t('轴查询')} description={$t('只读跨域投影（reporting 合同 RP-08～11）')}>
        <Message kind="warning" title={$t('没有报表域查询许可（reporting.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 reporting.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('轴查询')}
      description={$t('只读投影：只查询/导出，无新增/修改/删除/详情入口（RP-08）；采购来源轴报工状态固定「-」（RP-09）')}
      actions={
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Input
            style={{ width: 180 }}
            placeholder={$t('按轴号搜索（unitNoLike）')}
            value={unitNoLike}
            onChange={(e) => {
              list.setPage(1)
              setUnitNoLike(e.target.value)
            }}
          />
          <Select
            aria-label={$t('入库状态')}
            style={{ width: 140 }}
            value={inboundStatus}
            onChange={(e) => {
              list.setPage(1)
              setInboundStatus(e.target.value)
            }}
            placeholder={$t('入库状态')}
            options={Object.entries(AXIS_INBOUND_STATUS_LABELS).map(([v, label]) => ({ value: v, label }))}
          />
          <Select
            aria-label={$t('报工状态')}
            style={{ width: 140 }}
            value={reportStatus}
            onChange={(e) => {
              list.setPage(1)
              setReportStatus(e.target.value)
            }}
            placeholder={$t('报工状态（不含采购来源轴，RP-09）')}
            options={[
              { value: 'not_reported', label: $t('未报工') },
              { value: 'reported', label: $t('已报工') },
            ]}
          />
        </span>
      }
    >
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      <Table<AxisQueryRowDto>
        loading={list.loading}
        columns={[
          { key: 'unitNo', title: $t('轴号') },
          {
            key: 'inboundStatus',
            title: $t('入库状态'),
            render: (r) => <Badge tone={r.inboundStatus === 'in_stock' ? 'success' : 'info'}>{AXIS_INBOUND_STATUS_LABELS[r.inboundStatus]}</Badge>,
          },
          { key: 'materialCode', title: $t('料品') },
          { key: 'spec', title: $t('规格'), render: (r) => r.spec ?? '—' },
          {
            key: 'quantity',
            title: $t('数量'),
            render: (r) => (
              <span>
                {r.quantity ?? '—'} {r.uomCode ? <b style={{ fontSize: 12 }}>{r.uomCode}</b> : null}
              </span>
            ),
          },
          { key: 'warehouseName', title: $t('仓库'), render: (r) => r.warehouseName ?? '—' },
          { key: 'locationCode', title: $t('库位'), render: (r) => r.locationCode ?? '—' },
          { key: 'carrierCode', title: $t('载具'), render: (r) => r.carrierCode ?? '—' },
          { key: 'qcStatus', title: $t('质检'), render: (r) => $tx(AXIS_QC_STATUS_LABELS[r.qcStatus]) },
          { key: 'suspectStatus', title: $t('存疑'), render: (r) => (r.suspectStatus === 'suspect' ? <Badge tone="danger">{$t('存疑')}</Badge> : AXIS_SUSPECT_STATUS_LABELS[r.suspectStatus]) },
          { key: 'finishedAbnormalStatus', title: $t('成品异常'), render: (r) => (r.finishedAbnormalStatus === 'pending_handle' ? <Badge tone="danger">{$t('异常未处理')}</Badge> : AXIS_ABNORMAL_STATUS_LABELS[r.finishedAbnormalStatus]) },
          { key: 'lockStatus', title: $t('锁定'), render: (r) => (r.lockStatus === 'locked' ? <Badge tone="warning">{$t('已锁定')}</Badge> : AXIS_LOCK_STATUS_LABELS[r.lockStatus]) },
          { key: 'saleStatus', title: $t('销售'), render: (r) => $tx(AXIS_SALE_STATUS_LABELS[r.saleStatus]) },
          { key: 'reportStatus', title: $t('报工（RP-09）'), render: (r) => (r.reportStatus === 'not_applicable' ? '-' : AXIS_REPORT_STATUS_LABELS[r.reportStatus]) },
          { key: 'salesOrderNo', title: $t('销售订单'), render: (r) => r.salesOrderNo ?? '—' },
          { key: 'orderNo', title: $t('生产订单'), render: (r) => r.orderNo ?? '—' },
          { key: 'customerAxisNo', title: $t('客户轴号'), render: (r) => r.customerAxisNo ?? '—' },
          { key: 'segmentLength', title: $t('段长'), render: (r) => r.segmentLength ?? '—' },
          { key: 'workshopName', title: $t('车间'), render: (r) => r.workshopName ?? '—' },
        ]}
        rows={list.items}
        rowKey={(r) => r.unitId}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无匹配轴记录')}
      />
    </PageContainer>
  )
}
