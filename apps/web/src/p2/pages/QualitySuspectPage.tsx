import { useState } from 'react'
import { Badge, Button, Message, PageContainer, Table, t as $t } from '@cadenza/ui'
import type { P2SuspectRecordDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { DISPOSITION_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList } from '../shared'

/**
 * 质量存疑台账页（T18，QD-01～05）：
 * - 存疑记录 append-only：恢复写处置记录、不覆盖原记录（QD-03 完整审计链随行展示）；
 * - 存疑期间该码命令被拒（QD-04：投料/倒轴/入库上架/备货/发运/调拨/移库）；
 * - 恢复入口在 PDA（/p2/suspect，须填处置依据）；Web 台账只读核对。
 */
export function QualitySuspectPage() {
  const { has } = useP2Permissions()
  const canRead = has(DISPOSITION_READ)
  const [status, setStatus] = useState<'' | 'suspect' | 'restored'>('')
  const list = useP2AsyncList(
    (p) => p2Api.listSuspects({ page: p, pageSize: PAGE_SIZE, status: status === '' ? undefined : status }),
    [status],
  )

  if (!canRead) {
    return (
      <PageContainer title={$t('质量存疑')} description={$t('存疑与恢复审计链（quality-disposition 合同 QD-01～05）')}>
        <Message kind="warning" title={$t('没有处置域查询许可（disposition.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 disposition.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('质量存疑')}
      description={$t('存疑期间投料/倒轴/入库/备货/发运/调拨/移库均被拒（QD-04）；恢复走处置记录不覆盖原记录（QD-03）')}
      actions={
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {(
            [
              { v: '', label: $t('全部') },
              { v: 'suspect', label: $t('存疑中') },
              { v: 'restored', label: $t('已恢复') },
            ] as const
          ).map((opt) => (
            <Button key={opt.v} size="sm" variant={status === opt.v ? 'primary' : 'secondary'} onClick={() => setStatus(opt.v)}>
              {opt.label}
            </Button>
          ))}
        </span>
      }
    >
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      <Table<P2SuspectRecordDto>
        loading={list.loading}
        columns={[
          { key: 'unitNo', title: $t('轴号') },
          { key: 'materialCode', title: $t('料品') },
          { key: 'productionDeptName', title: $t('生产部门') },
          { key: 'raisedBy', title: $t('标记人') },
          { key: 'raisedAt', title: $t('标记时间'), render: (s) => new Date(s.raisedAt).toLocaleString('zh-CN') },
          {
            key: 'status',
            title: $t('状态'),
            render: (s) => (s.status === 'suspect' ? <Badge tone="danger">{$t('存疑中（QD-04 拦截）')}</Badge> : <Badge tone="success">{$t('已恢复')}</Badge>),
          },
          {
            key: 'dispositions',
            title: $t('处置记录链（QD-03）'),
            render: (s) =>
              s.dispositions.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5 }}>
                  {s.dispositions.map((d) => (
                    <li key={d.id}>
                      {new Date(d.operatedAt).toLocaleString('zh-CN')} {d.operatorName}{$t('：')}{d.basis}
                    </li>
                  ))}
                </ul>
              ) : (
                <span>{$t('—（待处置）')}</span>
              ),
          },
        ]}
        rows={list.items}
        rowKey={(s) => s.id}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无存疑记录')}
      />
    </PageContainer>
  )
}
