import { useCallback, useState } from 'react'
import { Badge, Button, Message, Modal, PageContainer, Select, Table, Textarea, t as $t } from '@cadenza/ui'
import {
  DEFECT_DESTINATION_LABELS,
  DEFECT_TYPE_LABELS,
  REVIEW_STATUS_LABELS,
  type FinishedDefectDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { DISPOSITION_POST, DISPOSITION_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList, useP2ActionState } from '../shared'

/**
 * 成品异常记录页（T18，QD-05～10）：
 * - 审核状态 3 值（未审核/通过/不通过）＋不合格类型 2 值（返工/报废）（QD-06/10）；
 * - 审核仅限未审核记录（QD-07）；审核通过扣数必须记录去向——报废/返工/其它＋说明（QD-08，
 *   禁止无去向扣数：前端不放行＋服务端终校）；
 * - 上报入口在 PDA（/p2/defect）；Web 为审核面。
 */
export function FinishedDefectPage() {
  const { has } = useP2Permissions()
  const canRead = has(DISPOSITION_READ)
  const canPost = has(DISPOSITION_POST)
  const [reviewStatus, setReviewStatus] = useState<'' | 'unreviewed' | 'approved' | 'rejected'>('')
  const list = useP2AsyncList(
    (p) => p2Api.listFinishedDefects({ page: p, pageSize: PAGE_SIZE, reviewStatus: reviewStatus === '' ? undefined : reviewStatus }),
    [reviewStatus],
  )
  const [reviewTarget, setReviewTarget] = useState<FinishedDefectDto | null>(null)
  const [approved, setApproved] = useState(true)
  const [destination, setDestination] = useState<'scrap' | 'rework' | 'other'>('scrap')
  const [destinationNote, setDestinationNote] = useState('')
  const action = useP2ActionState()

  const submitReview = useCallback(async () => {
    if (!reviewTarget) return
    const ok = await action.run(
      () =>
        p2Api.reviewFinishedDefect(reviewTarget.id, {
          approved,
          destination: approved ? destination : undefined,
          destinationNote: approved ? destinationNote : undefined,
        }),
      approved ? $t('审核通过：扣数已记录去向（QD-08）') : $t('审核不通过已记录'),
    )
    if (ok) {
      setReviewTarget(null)
      setDestinationNote('')
      list.setPage(1)
    }
  }, [action, approved, destination, destinationNote, list, reviewTarget])

  if (!canRead) {
    return (
      <PageContainer title={$t('成品异常')} description={$t('异常上报审核（quality-disposition 合同 QD-05～10）')}>
        <Message kind="warning" title={$t('没有处置域查询许可（disposition.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 disposition.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('成品异常')}
      description={$t('审核通过扣数须登记去向说明（QD-08 去向＋说明，禁止无去向扣数）；上报在 PDA（/p2/defect）')}
      actions={
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {(
            [
              { v: '', label: $t('全部') },
              { v: 'unreviewed', label: $t('未审核') },
              { v: 'approved', label: $t('通过') },
              { v: 'rejected', label: $t('不通过') },
            ] as const
          ).map((opt) => (
            <Button key={opt.v} size="sm" variant={reviewStatus === opt.v ? 'primary' : 'secondary'} onClick={() => setReviewStatus(opt.v)}>
              {opt.label}
            </Button>
          ))}
        </span>
      }
    >
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
      {action.actionSuccess ? <Message kind="success" title={action.actionSuccess} /> : null}
      <Table<FinishedDefectDto>
        loading={list.loading}
        columns={[
          { key: 'unitNo', title: $t('轴号') },
          { key: 'materialCode', title: $t('料品') },
          {
            key: 'defectType',
            title: $t('不合格类型（QD-10）'),
            render: (d) => <Badge tone={d.defectType === 'scrap' ? 'danger' : 'warning'}>{DEFECT_TYPE_LABELS[d.defectType]}</Badge>,
          },
          {
            key: 'quantity',
            title: $t('数量'),
            render: (d) => (
              <span>
                {d.quantity} <b style={{ fontSize: 12 }}>{d.uom}</b>
              </span>
            ),
          },
          { key: 'productionDeptName', title: $t('生产部门') },
          { key: 'raisedBy', title: $t('上报人') },
          { key: 'raisedAt', title: $t('上报时间'), render: (d) => new Date(d.raisedAt).toLocaleString('zh-CN') },
          {
            key: 'reviewStatus',
            title: $t('审核状态'),
            render: (d) => (
              <Badge tone={d.reviewStatus === 'approved' ? 'success' : d.reviewStatus === 'rejected' ? 'danger' : 'warning'}>
                {REVIEW_STATUS_LABELS[d.reviewStatus]}
              </Badge>
            ),
          },
          {
            key: 'destination',
            title: $t('扣数去向（QD-08）'),
            render: (d) => (d.destination ? `${DEFECT_DESTINATION_LABELS[d.destination]}（${d.destinationNote ?? '—'}）` : '—'),
          },
          { key: 'reviewedBy', title: $t('审核人'), render: (d) => d.reviewedBy ?? '—' },
          {
            key: 'actions',
            title: $t('操作'),
            render: (d) =>
              canPost && d.reviewStatus === 'unreviewed' ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setReviewTarget(d)
                    setApproved(true)
                    setDestination('scrap')
                  }}
                >
                  {$t('审核（QD-07）')}
                </Button>
              ) : (
                <span>—</span>
              ),
          },
        ]}
        rows={list.items}
        rowKey={(d) => d.id}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无成品异常记录')}
      />
      <Modal
        open={reviewTarget !== null}
        title={$t('审核成品异常 {p0}', { p0: reviewTarget?.unitNo ?? '' })}
        onClose={() => setReviewTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReviewTarget(null)}>
              {$t('取消')}
            </Button>
            <Button
              loading={action.busy}
              disabled={approved && destinationNote.trim() === ''}
              onClick={() => void submitReview()}
            >
              {$t('提交审核')}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, marginTop: 0 }}>
          {$t('审核仅限未审核记录（QD-07）；通过扣数必须记录去向（QD-08），未填说明前端不放行、服务端终校。')}
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          <Select
            aria-label={$t('审核结果')}
            value={approved ? 'approved' : 'rejected'}
            onChange={(e) => setApproved(e.target.value === 'approved')}
            options={[
              { value: 'approved', label: $t('通过（扣数）') },
              { value: 'rejected', label: $t('不通过') },
            ]}
          />
          {approved ? (
            <>
              <Select
                aria-label={$t('扣数去向')}
                value={destination}
                onChange={(e) => setDestination(e.target.value as 'scrap' | 'rework' | 'other')}
                options={[
                  { value: 'scrap', label: $t('报废') },
                  { value: 'rework', label: $t('返工') },
                  { value: 'other', label: $t('其它') },
                ]}
              />
              <Textarea
                aria-label={$t('去向说明')}
                placeholder={$t('去向说明（通过时必填，QD-08）')}
                value={destinationNote}
                onChange={(e) => setDestinationNote(e.target.value)}
                style={{ width: '100%' }}
              />
            </>
          ) : null}
        </div>
      </Modal>
    </PageContainer>
  )
}
