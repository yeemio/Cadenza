import { useCallback, useState } from 'react'
import { Badge, Button, Input, Message, Modal, PageContainer, Select, Table, t as $t } from '@cadenza/ui'
import {
  DISPOSITION_KIND_LABELS,
  REWORK_TASK_STATUS_LABELS,
  type DispositionRecordDto,
  type ReworkTaskDto,
} from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { DISPOSITION_POST, DISPOSITION_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList, useP2ActionState } from '../shared'

/**
 * 处置决定与返工任务页（T18，QD-19～25）：
 * - 处置四类：返工/报废/让步/放行（QD-20）；放行与报废强制理由＋审计；
 * - 返工处置产生返工任务；产出走报工命令与谱系，不在库存账凭空生成数量（QD-21）；
 * - 报废从可用量移除并记去向（QD-22）；让步放行保留原不合格事实、范围外仍拦截（QD-23）；
 * - QD-18 终态处置细化（报废/让步/降级自动流转）为待裁项，不自动裁定。
 */
export function DispositionPage() {
  const { has } = useP2Permissions()
  const canRead = has(DISPOSITION_READ)
  const canPost = has(DISPOSITION_POST)
  const records = useP2AsyncList((p) => p2Api.listDispositions({ page: p, pageSize: PAGE_SIZE }), ['records'])
  const tasks = useP2AsyncList((p) => p2Api.listReworkTasks({ page: p, pageSize: PAGE_SIZE }), ['tasks'])
  const [createOpen, setCreateOpen] = useState(false)
  const action = useP2ActionState()

  if (!canRead) {
    return (
      <PageContainer title={$t('处置决定')} description={$t('四类处置与返工任务（quality-disposition 合同 QD-19～25）')}>
        <Message kind="warning" title={$t('没有处置域查询许可（disposition.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 disposition.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('处置决定')}
      description={$t('放行与报废强制理由＋审计（QD-20）；返工产出走报工与谱系（QD-21）；让步范围外仍拦截（QD-23）')}
      actions={canPost ? <Button size="sm" onClick={() => setCreateOpen(true)}>{$t('新建处置决定')}</Button> : null}
    >
      {records.error ? <Message kind="error" title={records.error.title} detail={records.error.detail} /> : null}
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
      {action.actionSuccess ? <Message kind="success" title={action.actionSuccess} /> : null}
      <Table<DispositionRecordDto>
        loading={records.loading}
        columns={[
          {
            key: 'kind',
            title: $t('处置类型（QD-20）'),
            render: (d) => (
              <Badge tone={d.kind === 'release' ? 'success' : d.kind === 'scrap' ? 'danger' : 'warning'}>{DISPOSITION_KIND_LABELS[d.kind]}</Badge>
            ),
          },
          { key: 'targetKind', title: $t('关联对象'), render: (d) => (d.targetKind === 'inspection' ? $t('检验') : d.targetKind === 'defect' ? $t('异常记录') : $t('库存单元')) },
          { key: 'targetRef', title: $t('对象引用') },
          { key: 'basis', title: $t('依据（强制）') },
          { key: 'reason', title: $t('理由'), render: (d) => d.reason ?? '—' },
          { key: 'concessionScope', title: $t('让步范围（QD-23）'), render: (d) => d.concessionScope ?? '—' },
          { key: 'relatedReworkTaskId', title: $t('返工任务'), render: (d) => d.relatedReworkTaskId ?? '—' },
          { key: 'decidedBy', title: $t('决定人') },
          { key: 'decidedAt', title: $t('决定时间'), render: (d) => new Date(d.decidedAt).toLocaleString('zh-CN') },
        ]}
        rows={records.items}
        rowKey={(d) => d.id}
        page={{ page: records.page, pageSize: PAGE_SIZE }}
        total={records.total}
        onPageChange={records.setPage}
        emptyText={$t('暂无处置决定')}
      />
      <h4 style={{ marginTop: 18 }}>{$t('返工任务（QD-21）')}</h4>
      {tasks.error ? <Message kind="error" title={tasks.error.title} detail={tasks.error.detail} /> : null}
      <Table<ReworkTaskDto>
        loading={tasks.loading}
        columns={[
          { key: 'taskNo', title: $t('任务号') },
          { key: 'unitNo', title: $t('轴号') },
          { key: 'orderNo', title: $t('生产订单') },
          { key: 'sourceProcessName', title: $t('原工序') },
          {
            key: 'status',
            title: $t('状态'),
            render: (t) => (
              <Badge tone={t.status === 'done' ? 'success' : t.status === 'in_progress' ? 'info' : 'default'}>
                {REWORK_TASK_STATUS_LABELS[t.status]}
              </Badge>
            ),
          },
          { key: 'createdBy', title: $t('创建人') },
          { key: 'createdAt', title: $t('创建时间'), render: (t) => new Date(t.createdAt).toLocaleString('zh-CN') },
        ]}
        rows={tasks.items}
        rowKey={(t) => t.id}
        page={{ page: tasks.page, pageSize: PAGE_SIZE }}
        total={tasks.total}
        onPageChange={tasks.setPage}
        emptyText={$t('暂无返工任务')}
      />
      {createOpen ? <CreateModal onClose={() => setCreateOpen(false)} onDone={() => records.setPage(1)} /> : null}
    </PageContainer>
  )
}

function CreateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<DispositionRecordDto['kind']>('concession')
  const [targetKind, setTargetKind] = useState<DispositionRecordDto['targetKind']>('inspection')
  const [targetRef, setTargetRef] = useState('')
  const [basis, setBasis] = useState('')
  const [reason, setReason] = useState('')
  const [concessionScope, setConcessionScope] = useState('')
  const action = useP2ActionState()

  const submit = useCallback(async () => {
    const ok = await action.run(
      () => p2Api.createDisposition({ kind, targetKind, targetRef, basis, reason, concessionScope: concessionScope || undefined }),
      $t('处置决定已记录（append-only 审计）'),
    )
    if (ok) {
      onClose()
      onDone()
    }
  }, [action, basis, concessionScope, kind, onClose, onDone, reason, targetKind, targetRef])

  const needBasis = kind === 'release' || kind === 'scrap'
  return (
    <Modal
      open
      title={$t('新建处置决定（QD-20）')}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {$t('取消')}
          </Button>
          <Button loading={action.busy} disabled={!targetRef || !reason || (needBasis && basis.trim() === '')} onClick={() => void submit()}>
            {$t('提交')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
        <Select
          aria-label={$t('处置类型')}
          value={kind}
          onChange={(e) => setKind(e.target.value as DispositionRecordDto['kind'])}
          options={[
            { value: 'rework', label: $t('返工') },
            { value: 'scrap', label: $t('报废（强制理由＋审计）') },
            { value: 'concession', label: $t('让步') },
            { value: 'release', label: $t('放行（强制理由＋审计）') },
          ]}
        />
        <Select
          aria-label={$t('关联对象类型')}
          value={targetKind}
          onChange={(e) => setTargetKind(e.target.value as DispositionRecordDto['targetKind'])}
          options={[
            { value: 'inspection', label: $t('检验记录') },
            { value: 'defect', label: $t('异常记录') },
            { value: 'unit', label: $t('库存单元') },
          ]}
        />
        <Input aria-label={$t('对象引用')} placeholder={$t('对象引用（如 LOT-20261027-05/QD-IQC-03）')} value={targetRef} onChange={(e) => setTargetRef(e.target.value)} />
        <Input aria-label={$t('处置依据')} placeholder={needBasis ? $t('处置依据（必填）') : $t('处置依据')} value={basis} onChange={(e) => setBasis(e.target.value)} />
        <Input aria-label={$t('理由')} placeholder={$t('理由（必填）')} value={reason} onChange={(e) => setReason(e.target.value)} />
        {kind === 'concession' ? (
          <Input aria-label={$t('让步范围')} placeholder={$t('让步范围（批次/数量/期限，QD-23）')} value={concessionScope} onChange={(e) => setConcessionScope(e.target.value)} />
        ) : null}
      </div>
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
    </Modal>
  )
}
