import { useCallback, useState } from 'react'
import { Badge, Button, Input, Message, Modal, PageContainer, Select, Table, Textarea, t as $t } from '@cadenza/ui'
import { MAINTENANCE_ORDER_STATUS_LABELS, EQUIPMENT_STATUS_P2_LABELS, type MaintenanceOrderDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { MAINTENANCE_POST, MAINTENANCE_READ, useP2Permissions } from '../permissions'
import { P2_PAGE_SIZE as PAGE_SIZE, useP2AsyncList, useP2ActionState } from '../shared'

/**
 * 维修工单页（T19，MT-07～14）：
 * - 状态机：已报修→分派→处理中→待复机→关闭；越级/逆向迁移拒绝；取消另记（MT-07/14）；
 * - 取消仅已报修/已分派/处理中（原因必填）；停机事实保留（MT-14）；
 * - 复机＝工单关闭＋置正常＋闭停机事件＋能力变化事件一次事务（MT-10）；结果与责任人必填（MT-07）；
 * - 备件消耗与工单关闭同事务、≤实时可用量（MT-11）。
 */
export function MaintenanceOrdersPage() {
  const { has } = useP2Permissions()
  const canRead = has(MAINTENANCE_READ)
  const canPost = has(MAINTENANCE_POST)
  const [status, setStatus] = useState('')
  const list = useP2AsyncList(
    (p) => p2Api.listMaintenanceOrders({ page: p, pageSize: PAGE_SIZE, status: status === '' ? undefined : (status as MaintenanceOrderDto['status']) }),
    [status],
  )
  const [createOpen, setCreateOpen] = useState(false)
  const [assignTarget, setAssignTarget] = useState<MaintenanceOrderDto | null>(null)
  const [assigneeName, setAssigneeName] = useState('')
  const [recoverTarget, setRecoverTarget] = useState<MaintenanceOrderDto | null>(null)
  const [result, setResult] = useState('')
  const [responsibleName, setResponsibleName] = useState('')
  const [sparePartCode, setSparePartCode] = useState('')
  const [sparePartQty, setSparePartQty] = useState('')
  const [cancelTarget, setCancelTarget] = useState<MaintenanceOrderDto | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const action = useP2ActionState()

  const doAssign = useCallback(async () => {
    if (!assignTarget) return
    const ok = await action.run(() => p2Api.assignMaintenanceOrder(assignTarget.id, { assigneeName }), $t('工单已分派（MT-07）'))
    if (ok) {
      setAssignTarget(null)
      setAssigneeName('')
      list.setPage(1)
    }
  }, [action, assignTarget, assigneeName, list])

  const doRecover = useCallback(async () => {
    if (!recoverTarget) return
    const ok = await action.run(
      () =>
        p2Api.recoverMaintenanceOrder(recoverTarget.id, {
          result,
          responsibleName,
          spareParts: sparePartCode && sparePartQty ? [{ materialCode: sparePartCode, quantity: sparePartQty }] : undefined,
        }),
      $t('复机完成：工单关闭＋设备置正常＋停机事件关闭（MT-10）'),
    )
    if (ok) {
      setRecoverTarget(null)
      setResult('')
      setResponsibleName('')
      setSparePartCode('')
      setSparePartQty('')
      list.setPage(1)
    }
  }, [action, list, recoverTarget, responsibleName, result, sparePartCode, sparePartQty])

  const doCancel = useCallback(async () => {
    if (!cancelTarget) return
    const ok = await action.run(() => p2Api.cancelMaintenanceOrder(cancelTarget.id, { reason: cancelReason }), $t('工单已取消（停机事实保留，MT-14）'))
    if (ok) {
      setCancelTarget(null)
      setCancelReason('')
      list.setPage(1)
    }
  }, [action, cancelTarget, cancelReason, list])

  if (!canRead) {
    return (
      <PageContainer title={$t('维修工单')} description={$t('报修-分派-处理-复机状态机（maintenance 合同 MT-07～14）')}>
        <Message kind="warning" title={$t('没有维护域查询许可（maintenance.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 maintenance.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('维修工单')}
      description={$t('复机=工单关闭＋置正常＋闭停机事件＋能力变化事件一次事务（MT-10）；备件消耗同事务（MT-11）')}
      actions={
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Select
            aria-label={$t('状态过滤')}
            style={{ width: 150 }}
            value={status}
            onChange={(e) => {
              list.setPage(1)
              setStatus(e.target.value)
            }}
            placeholder={$t('全部状态')}
            options={Object.entries(MAINTENANCE_ORDER_STATUS_LABELS).map(([v, label]) => ({ value: v, label }))}
          />
          {canPost ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              {$t('手工报修（MT-13）')}
            </Button>
          ) : null}
        </span>
      }
    >
      {list.error ? <Message kind="error" title={list.error.title} detail={list.error.detail} /> : null}
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
      {action.actionSuccess ? <Message kind="success" title={action.actionSuccess} /> : null}
      <Table<MaintenanceOrderDto>
        loading={list.loading}
        columns={[
          { key: 'orderNo', title: $t('工单号') },
          { key: 'equipmentCode', title: $t('设备') },
          { key: 'description', title: $t('故障描述') },
          {
            key: 'status',
            title: $t('状态（MT-07）'),
            render: (o) => (
              <Badge tone={o.status === 'closed' ? 'success' : o.status === 'cancelled' ? 'default' : o.status === 'awaiting_recovery' ? 'warning' : 'info'}>
                {MAINTENANCE_ORDER_STATUS_LABELS[o.status]}
              </Badge>
            ),
          },
          { key: 'source', title: $t('来源'), render: (o) => (o.source === 'PDA' ? $t('PDA 异常上报') : $t('Web 手工')) },
          { key: 'reportedBy', title: $t('报修人') },
          { key: 'assigneeName', title: $t('处理人'), render: (o) => o.assigneeName ?? '—' },
          { key: 'result', title: $t('处理结果'), render: (o) => o.result ?? '—' },
          {
            key: 'downtime',
            title: $t('停机起止（MT-09）'),
            render: (o) =>
              o.downtimeStartAt
                ? $t('{p0} ~ {p1}', { p0: new Date(o.downtimeStartAt).toLocaleString('zh-CN'), p1: o.downtimeEndAt ? new Date(o.downtimeEndAt).toLocaleString('zh-CN') : $t('（进行中）') })
                : '—',
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (o) => (
              <span style={{ display: 'inline-flex', gap: 8 }}>
                {canPost && o.status === 'reported' ? (
                  <Button size="sm" onClick={() => setAssignTarget(o)}>
                    {$t('分派')}
                  </Button>
                ) : null}
                {canPost && o.recoverable ? (
                  <Button size="sm" onClick={() => setRecoverTarget(o)}>
                    {$t('复机（MT-10）')}
                  </Button>
                ) : null}
                {canPost && o.cancellable ? (
                  <Button size="sm" variant="ghost" onClick={() => setCancelTarget(o)}>
                    {$t('取消（MT-14）')}
                  </Button>
                ) : null}
              </span>
            ),
          },
        ]}
        rows={list.items}
        rowKey={(o) => o.id}
        page={{ page: list.page, pageSize: PAGE_SIZE }}
        total={list.total}
        onPageChange={list.setPage}
        emptyText={$t('暂无维修工单')}
      />
      {createOpen ? (
        <CreateOrderModal
          onClose={() => setCreateOpen(false)}
          onDone={() => list.setPage(1)}
        />
      ) : null}
      <Modal
        open={assignTarget !== null}
        title={$t('分派工单 {p0}', { p0: assignTarget?.orderNo ?? '' })}
        onClose={() => setAssignTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAssignTarget(null)}>
              {$t('取消')}
            </Button>
            <Button loading={action.busy} disabled={assigneeName.trim() === ''} onClick={() => void doAssign()}>
              {$t('确认分派')}
            </Button>
          </>
        }
      >
        <Input aria-label={$t('处理人')} placeholder={$t('处理人（必填）')} value={assigneeName} onChange={(e) => setAssigneeName(e.target.value)} />
      </Modal>
      <Modal
        open={recoverTarget !== null}
        title={$t('复机 {p0}（工单 {p1}）', { p0: recoverTarget?.equipmentName ?? '', p1: recoverTarget?.orderNo ?? '' })}
        onClose={() => setRecoverTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRecoverTarget(null)}>
              {$t('取消')}
            </Button>
            <Button loading={action.busy} disabled={result.trim() === '' || responsibleName.trim() === ''} onClick={() => void doRecover()}>
              {$t('确认复机关单')}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, marginTop: 0 }}>
          {$t('复机仅"待复机"可执行；结果与责任人必填（MT-07/10）；备件消耗与关单同事务且 ≤ 实时可用量（MT-11）。 设备状态将置为「')}{EQUIPMENT_STATUS_P2_LABELS[1]}{$t('」（MT-01）。')}
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          <Textarea aria-label={$t('处理结果')} placeholder={$t('处理结果（必填）')} value={result} onChange={(e) => setResult(e.target.value)} style={{ width: '100%' }} />
          <Input aria-label={$t('责任人')} placeholder={$t('责任人（必填）')} value={responsibleName} onChange={(e) => setResponsibleName(e.target.value)} />
          <div style={{ display: 'flex', gap: 6 }}>
            <Input aria-label={$t('备件料品')} placeholder={$t('备件料品编码（选填）')} value={sparePartCode} onChange={(e) => setSparePartCode(e.target.value)} />
            <Input aria-label={$t('备件数量')} placeholder={$t('数量')} style={{ width: 120 }} value={sparePartQty} onChange={(e) => setSparePartQty(e.target.value)} />
          </div>
        </div>
      </Modal>
      <Modal
        open={cancelTarget !== null}
        title={$t('取消工单 {p0}', { p0: cancelTarget?.orderNo ?? '' })}
        onClose={() => setCancelTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelTarget(null)}>
              {$t('取消')}
            </Button>
            <Button variant="danger" loading={action.busy} disabled={cancelReason.trim() === ''} onClick={() => void doCancel()}>
              {$t('确认取消')}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, marginTop: 0 }}>{$t('仅已报修/已分派/处理中可取消；待复机/已关闭不可；停机事实保留（MT-14）。')}</p>
        <Textarea aria-label={$t('取消原因')} placeholder={$t('取消原因（必填）')} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} style={{ width: '100%' }} />
      </Modal>
    </PageContainer>
  )
}

function CreateOrderModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [equipmentId, setEquipmentId] = useState('eq-draw-01')
  const [description, setDescription] = useState('')
  const action = useP2ActionState()

  const submit = useCallback(async () => {
    const ok = await action.run(() => p2Api.createMaintenanceOrder({ equipmentId, description }), $t('工单已创建（MT-13 Web 手工报修）'))
    if (ok) {
      onClose()
      onDone()
    }
  }, [action, description, equipmentId, onClose, onDone])

  return (
    <Modal
      open
      title={$t('手工报修（MT-13）')}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {$t('取消')}
          </Button>
          <Button loading={action.busy} disabled={description.trim() === ''} onClick={() => void submit()}>
            {$t('提交报修')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 8 }}>
        <Select
          aria-label={$t('设备')}
          value={equipmentId}
          onChange={(e) => setEquipmentId(e.target.value)}
          options={[
            { value: 'eq-draw-01', label: $t('拉丝一线主机（EQ-DRAW-01）') },
            { value: 'eq-twist-02', label: $t('绞制二线主机（EQ-TWIST-02）') },
            { value: 'eq-extrude-01', label: $t('挤塑一线主机（EQ-EXTR-01）') },
          ]}
        />
        <Textarea aria-label={$t('故障描述')} placeholder={$t('故障描述（必填）')} value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: '100%' }} />
      </div>
      {action.actionError ? <Message kind="error" title={action.actionError.title} detail={action.actionError.detail} /> : null}
    </Modal>
  )
}
