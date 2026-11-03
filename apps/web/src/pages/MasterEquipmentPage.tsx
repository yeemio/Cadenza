import {
  ApiError,
  Badge,
  Button,
  Field,
  Form,
  Input,
  EQUIPMENT_STATUS_LABELS,
  Message,
  Modal,
  PageContainer,
  Select,
  Table,
  formatErrorTitleAndDetail,
  type EquipmentDto,
  type EquipmentStatusLogDto,
  type OrgNodeDto,
  type WorkCenterDto,
  t as $t,
  tx as $tx,
} from '@cadenza/ui'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { MASTERDATA_ADMIN, MASTERDATA_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10

/**
 * 设备管理页（MD-09～16）：
 * - 列表：状态标签（MD-13：1=正常 2=维修）+ 名称/编码过滤 + 服务端分页；
 * - 状态变更走专用入口 change-status（MD-14 记流水，含流水查看）；
 * - 新建/编辑：部门与工作中心联动（MD-10 一致性前端即时提示 + 服务端终校）；
 * - 命令按钮仅 masterdata.admin 显示；设备码（EQU-+编码）在新建成功提示中呈现（MD-15）。
 */
export function MasterEquipmentPage() {
  const { has } = usePermissions()
  const canRead = has(MASTERDATA_READ)
  const canAdmin = has(MASTERDATA_ADMIN)
  const [items, setItems] = useState<EquipmentDto[]>([])
  const [nodes, setNodes] = useState<OrgNodeDto[]>([])
  const [workCenters, setWorkCenters] = useState<WorkCenterDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [nameLike, setNameLike] = useState('')
  const [codeLike, setCodeLike] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<EquipmentDto | null>(null)
  const [statusTarget, setStatusTarget] = useState<EquipmentDto | null>(null)
  const [logsOf, setLogsOf] = useState<EquipmentDto | null>(null)
  const [reloadFlag, setReloadFlag] = useState(0)

  useEffect(() => {
    void api
      .listOrgNodes({ page: 1, pageSize: 100 })
      .then((r) => setNodes(r.items))
      .catch(() => setNodes([]))
    void api
      .listWorkCenters({ page: 1, pageSize: 100 })
      .then((r) => setWorkCenters(r.items))
      .catch(() => setWorkCenters([]))
  }, [])

  useEffect(() => {
    if (!canRead) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    api
      .listEquipment({
        page,
        pageSize: PAGE_SIZE,
        nameLike: nameLike.trim() || undefined,
        codeLike: codeLike.trim() || undefined,
      })
      .then((result) => {
        if (!alive) return
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载设备失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, nameLike, codeLike, reloadFlag, canRead])

  const deptName = useMemo(() => {
    const map = new Map(nodes.map((n) => [n.id, n.name] as const))
    return (id: string) => map.get(id) ?? id
  }, [nodes])
  const wcName = useMemo(() => {
    const map = new Map(workCenters.map((w) => [w.id, w.name] as const))
    return (id: string) => map.get(id) ?? id
  }, [workCenters])

  const refresh = () => setReloadFlag((f) => f + 1)

  if (!canRead) {
    return (
      <PageContainer title={$t('设备管理')} description={$t('设备台账与状态管理（master-data 合同 MD-09～MD-16）')}>
        <Message kind="warning" title={$t('没有主数据查询许可（masterdata.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 masterdata.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('设备管理')}
      description={$t('设备台账与状态变更（状态字典 MD-13：1=正常 2=维修；变更记流水 MD-14；维护需 masterdata.admin）')}
      actions={
        <>
          <Input
            style={{ width: 160 }}
            placeholder={$t('按名称搜索（nameLike）')}
            value={nameLike}
            onChange={(e) => {
              setPage(1)
              setNameLike(e.target.value)
            }}
          />
          <Input
            style={{ width: 160 }}
            placeholder={$t('按编码搜索（codeLike）')}
            value={codeLike}
            onChange={(e) => {
              setPage(1)
              setCodeLike(e.target.value)
            }}
          />
          {canAdmin ? <Button onClick={() => setCreating(true)}>{$t('新建设备')}</Button> : null}
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {hint ? <Message kind="success" title={hint} /> : null}
      <Table<EquipmentDto>
        loading={loading}
        columns={[
          { key: 'code', title: $t('设备编码') },
          { key: 'name', title: $t('设备名称') },
          { key: 'deptId', title: $t('所属部门'), render: (e) => deptName(e.deptId) },
          { key: 'workCenterId', title: $t('工作中心'), render: (e) => wcName(e.workCenterId) },
          {
            key: 'equipmentStatus',
            title: $t('设备状态'),
            render: (e) =>
              e.equipmentStatus === 1 ? (
                <Badge tone="success">{EQUIPMENT_STATUS_LABELS[e.equipmentStatus]}</Badge>
              ) : (
                <Badge tone="warning">{EQUIPMENT_STATUS_LABELS[e.equipmentStatus] ?? e.equipmentStatus}</Badge>
              ),
          },
          { key: 'capacity', title: $t('产能'), render: (e) => (e.capacity ? `${e.capacity}` : '—') },
          {
            key: 'actions',
            title: $t('操作'),
            render: (e) =>
              canAdmin ? (
                <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(e)}>
                    {$t('编辑')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setStatusTarget(e)}>
                    {$t('状态变更')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setLogsOf(e)}>
                    {$t('流水')}
                  </Button>
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>{$t('只读（需 masterdata.admin）')}</span>
              ),
          },
        ]}
        rows={items}
        rowKey={(e) => e.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无设备')}
      />
      <EquipmentFormModal
        open={creating || editing !== null}
        editing={editing}
        nodes={nodes}
        workCenters={workCenters}
        onClose={() => {
          setCreating(false)
          setEditing(null)
        }}
        onSaved={(msg) => {
          setCreating(false)
          setEditing(null)
          setHint(msg)
          refresh()
        }}
      />
      <StatusChangeModal
        equipment={statusTarget}
        onClose={() => setStatusTarget(null)}
        onDone={(msg) => {
          setStatusTarget(null)
          setHint(msg)
          refresh()
        }}
      />
      <StatusLogsModal equipment={logsOf} onClose={() => setLogsOf(null)} />
    </PageContainer>
  )
}

function EquipmentFormModal({
  open,
  editing,
  nodes,
  workCenters,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: EquipmentDto | null
  nodes: OrgNodeDto[]
  workCenters: WorkCenterDto[]
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [form, setForm] = useState({
    code: '',
    name: '',
    deptId: '',
    workCenterId: '',
    equipmentStatus: '1',
    capacity: '',
    actualNo: '',
    model: '',
    stdRateText: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<{ title: string; detail?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setErrors({})
    setSubmitError(null)
    setForm({
      code: editing?.code ?? '',
      name: editing?.name ?? '',
      deptId: editing?.deptId ?? '',
      workCenterId: editing?.workCenterId ?? '',
      equipmentStatus: editing ? String(editing.equipmentStatus) : '1',
      capacity: editing?.capacity ?? '',
      actualNo: editing?.actualNo ?? '',
      model: editing?.model ?? '',
      stdRateText: editing?.stdRateText ?? '',
    })
  }, [open, editing])

  const deptOptions = nodes
    .filter((n) => n.kind === 'department' && n.status === 'active')
    .map((n) => ({ value: n.id, label: $t('{p0}（{p1}）', { p0: n.name, p1: n.code }) }))
  // MD-10 前端即时提示：工作中心下拉仅列与所选部门一致的工作中心
  const wcOptions = workCenters
    .filter((w) => w.status === 'active' && (form.deptId === '' || w.deptId === form.deptId))
    .map((w) => ({ value: w.id, label: $t('{p0}（{p1}）', { p0: w.name, p1: w.code }) }))

  const submit = async () => {
    const next: Record<string, string> = {}
    if (!editing) {
      if (!form.code.trim()) next.code = $t('设备编码必填（MD-09）')
      else if (form.code.toUpperCase().startsWith('EQU-')) next.code = $t('设备编码不得自带 EQU- 前缀（MD-15，设备码由系统生成）')
      else if (form.code.length > 32) next.code = $t('设备编码最长 32 字符（MD-09）')
    }
    if (!form.name.trim()) next.name = $t('设备名称必填（MD-09）')
    else if (form.name.length > 50) next.name = $t('设备名称最长 50 字符（MD-09）')
    if (!form.deptId) next.deptId = $t('请选择所属部门')
    if (!form.workCenterId) next.workCenterId = $t('请选择工作中心（须与部门一致，MD-10）')
    if (form.capacity && !/^\d{1,10}(\.\d{1,4})?$/.test(form.capacity.trim())) {
      next.capacity = $t('产能须为十进制数字（整数≤10 位、小数≤4 位，MD-16）')
    }
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (editing) {
        const r = await api.updateEquipment(
          editing.id,
          {
            name: form.name.trim(),
            capacity: form.capacity.trim() || undefined,
            actualNo: form.actualNo.trim() || undefined,
            model: form.model.trim() || undefined,
            stdRateText: form.stdRateText.trim() || undefined,
          },
          { reason: `编辑设备 ${editing.code}` },
        )
        onSaved($t('设备「{p0}」已保存（operationId：{p1}…）', { p0: editing.code, p1: r.operationId.slice(0, 8) }))
      } else {
        const r = await api.createEquipment(
          {
            code: form.code.trim(),
            name: form.name.trim(),
            deptId: form.deptId,
            workCenterId: form.workCenterId,
            equipmentStatus: Number(form.equipmentStatus),
            capacity: form.capacity.trim() || undefined,
            actualNo: form.actualNo.trim() || undefined,
            model: form.model.trim() || undefined,
            stdRateText: form.stdRateText.trim() || undefined,
          },
          { reason: `新建设备 ${form.code.trim()}` },
        )
        const data = r.data as { equipmentQrCode?: string } | null
        onSaved(
          $t('设备「{p0}」已建档，设备码 {p1}（operationId：{p2}…）', { p0: form.code.trim(), p1: data?.equipmentQrCode ?? 'EQU-' + form.code.trim(), p2: r.operationId.slice(0, 8) }),
        )
      }
    } catch (err) {
      setSubmitError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('保存设备失败') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title={editing ? $t('编辑设备：{p0}', { p0: editing.code }) : $t('新建设备')}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {$t('取消')}
          </Button>
          <Button onClick={() => void submit()} loading={submitting}>
            {$t('保存')}
          </Button>
        </>
      }
    >
      {submitError ? <Message kind="error" title={submitError.title} detail={submitError.detail} /> : null}
      <Form>
        {editing ? (
          <Field label={$t('设备编码')} hint={$t('设备码（EQU-+编码）由系统按编码生成，编码创建后不再提示修改')}>
            <Input value={editing.code} disabled />
          </Field>
        ) : (
          <Field label={$t('设备编码')} required error={errors.code} hint={$t('全局唯一、最长 32 字符；不得自带 EQU- 前缀（MD-09/15）')}>
            <Input
              value={form.code}
              invalid={Boolean(errors.code)}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            />
          </Field>
        )}
        <Field label={$t('设备名称')} required error={errors.name} hint={$t('全局唯一（MD-09）')}>
          <Input value={form.name} invalid={Boolean(errors.name)} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label={$t('所属部门')} required error={errors.deptId}>
          <Select
            value={form.deptId}
            placeholder={$t('请选择部门')}
            options={deptOptions}
            invalid={Boolean(errors.deptId)}
            disabled={editing !== null}
            onChange={(e) => setForm((f) => ({ ...f, deptId: e.target.value, workCenterId: '' }))}
          />
        </Field>
        <Field
          label={$t('工作中心')}
          required
          error={errors.workCenterId}
          hint={form.deptId ? $t('仅列出与所属部门一致的工作中心（MD-10，服务端终校）') : $t('请先选择部门（MD-10：部门与工作中心须一致）')}
        >
          <Select
            value={form.workCenterId}
            placeholder={form.deptId ? $t('请选择工作中心') : $t('（先选部门）')}
            options={wcOptions}
            invalid={Boolean(errors.workCenterId)}
            disabled={editing !== null || form.deptId === ''}
            onChange={(e) => setForm((f) => ({ ...f, workCenterId: e.target.value }))}
          />
        </Field>
        {!editing ? (
          <Field label={$t('初始状态')} required hint={$t('MD-13：1=正常 2=维修；后续变更走「状态变更」（记流水 MD-14）')}>
            <Select
              value={form.equipmentStatus}
              options={[
                { value: '1', label: $t('正常') },
                { value: '2', label: $t('维修') },
              ]}
              onChange={(e) => setForm((f) => ({ ...f, equipmentStatus: e.target.value }))}
            />
          </Field>
        ) : null}
        <Field label={$t('产能')} error={errors.capacity} hint={$t('选填；十进制（整数≤10 位、小数≤4 位，MD-16）')}>
          <Input
            value={form.capacity}
            invalid={Boolean(errors.capacity)}
            onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
          />
        </Field>
        <Field label={$t('实际编号')} hint={$t('选填')}>
          <Input value={form.actualNo} onChange={(e) => setForm((f) => ({ ...f, actualNo: e.target.value }))} />
        </Field>
        <Field label={$t('型号')} hint={$t('选填')}>
          <Input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} />
        </Field>
        <Field label={$t('标准产能说明')} hint={$t('选填（文本）')}>
          <Input value={form.stdRateText} onChange={(e) => setForm((f) => ({ ...f, stdRateText: e.target.value }))} />
        </Field>
      </Form>
    </Modal>
  )
}

/** 状态变更（MD-14：新旧值不同才记流水；来源 WEB） */
function StatusChangeModal({
  equipment,
  onClose,
  onDone,
}: {
  equipment: EquipmentDto | null
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const [next, setNext] = useState('1')
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (equipment) setNext(equipment.equipmentStatus === 1 ? '2' : '1')
  }, [equipment])

  const submit = async () => {
    if (!equipment) return
    setSubmitting(true)
    setError(null)
    try {
      const r = await api.changeEquipmentStatus(
        equipment.id,
        { equipmentStatus: Number(next), source: 'WEB' },
        { reason: $t('设备 {p0} 状态变更为 {p1}', { p0: equipment.code, p1: $tx(EQUIPMENT_STATUS_LABELS[Number(next)]) ?? next }) },
      )
      const data = r.data as { journaled?: boolean } | null
      onDone(
        data?.journaled === false
          ? $t('状态未变化（原值即为目标值），未产生流水（MD-14）')
          : $t('设备「{p0}」状态已变更为{p1}，已记状态流水（MD-14）', { p0: equipment.code, p1: $tx(EQUIPMENT_STATUS_LABELS[Number(next)]) ?? next }),
      )
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('状态变更失败') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={equipment !== null}
      title={$t('状态变更：{p0}（{p1}）', { p0: equipment?.name ?? '', p1: equipment?.code ?? '' })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {$t('取消')}
          </Button>
          <Button onClick={() => void submit()} loading={submitting}>
            {$t('确认变更')}
          </Button>
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      <Form>
        <Field label={$t('当前状态')}>
          <Input value={$t('{p0} 当前：{p1}', { p0: equipment?.code ?? '', p1: EQUIPMENT_STATUS_LABELS[equipment?.equipmentStatus ?? 1] ?? '' })} disabled />
        </Field>
        <Field label={$t('变更为')} required hint={$t('MD-13：1=正常 2=维修；变更将记录状态流水（MD-14，来源 WEB）')}>
          <Select
            value={next}
            options={[
              { value: '1', label: $t('正常') },
              { value: '2', label: $t('维修') },
            ]}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
      </Form>
    </Modal>
  )
}

/** 状态流水（MD-14 append-only） */
function StatusLogsModal({ equipment, onClose }: { equipment: EquipmentDto | null; onClose: () => void }) {
  const [logs, setLogs] = useState<EquipmentStatusLogDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)

  useEffect(() => {
    if (equipment === null) return
    setLoading(true)
    api
      .listEquipmentStatusLogs(equipment.id)
      .then((rows) => {
        setLogs(rows)
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载状态流水失败') }))
      .finally(() => setLoading(false))
  }, [equipment])

  return (
    <Modal open={equipment !== null} size="lg" title={$t('状态流水：{p0}（MD-14）', { p0: equipment?.name ?? '' })} onClose={onClose}>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      <Table<EquipmentStatusLogDto>
        loading={loading}
        columns={[
          {
            key: 'change',
            title: $t('状态变化'),
            render: (l) =>
              `${EQUIPMENT_STATUS_LABELS[l.oldStatus] ?? l.oldStatus} → ${EQUIPMENT_STATUS_LABELS[l.newStatus] ?? l.newStatus}`,
          },
          { key: 'source', title: $t('来源'), render: (l) => (l.source === 'PDA' ? 'PDA' : 'WEB') },
          { key: 'actor', title: $t('操作人') },
          { key: 'createdAt', title: $t('时间'), render: (l) => new Date(l.createdAt).toLocaleString('zh-CN') },
        ]}
        rows={logs}
        rowKey={(l) => l.id}
        emptyText={$t('暂无状态流水')}
      />
    </Modal>
  )
}
