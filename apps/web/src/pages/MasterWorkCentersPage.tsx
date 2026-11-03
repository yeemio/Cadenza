import {
  ApiError,
  Badge,
  Button,
  ConfirmModal,
  Field,
  Form,
  Input,
  MASTERDATA_STATUS_LABELS,
  Message,
  Modal,
  PageContainer,
  Select,
  Table,
  formatErrorTitleAndDetail,
  type OrgNodeDto,
  type WorkCenterDto,
  t as $t,
} from '@cadenza/ui'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { MASTERDATA_ADMIN, MASTERDATA_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10

/**
 * 工作中心页（MD-17/18）：编码全局唯一、同部门内名称唯一；删除前置按 设备→工序→订单工序 顺序校验。
 */
export function MasterWorkCentersPage() {
  const { has } = usePermissions()
  const canRead = has(MASTERDATA_READ)
  const canAdmin = has(MASTERDATA_ADMIN)
  const [items, setItems] = useState<WorkCenterDto[]>([])
  const [nodes, setNodes] = useState<OrgNodeDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [codeLike, setCodeLike] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<WorkCenterDto | null>(null)
  const [deleting, setDeleting] = useState<WorkCenterDto | null>(null)
  const [reloadFlag, setReloadFlag] = useState(0)

  useEffect(() => {
    void api
      .listOrgNodes({ page: 1, pageSize: 100 })
      .then((r) => setNodes(r.items))
      .catch(() => setNodes([]))
  }, [])

  useEffect(() => {
    if (!canRead) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    api
      .listWorkCenters({ page, pageSize: PAGE_SIZE, codeLike: codeLike.trim() || undefined })
      .then((result) => {
        if (!alive) return
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载工作中心失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, codeLike, reloadFlag, canRead])

  const deptName = useMemo(() => {
    const map = new Map(nodes.map((n) => [n.id, n.name] as const))
    return (id: string) => map.get(id) ?? id
  }, [nodes])

  const refresh = () => setReloadFlag((f) => f + 1)

  if (!canRead) {
    return (
      <PageContainer title={$t('工作中心')} description={$t('工作中心主数据（master-data 合同 MD-17/MD-18）')}>
        <Message kind="warning" title={$t('没有主数据查询许可（masterdata.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('工作中心')}
      description={$t('工作中心台账（MD-17：编码全局唯一、同部门内名称唯一；MD-18：被设备/工序引用不可删除）')}
      actions={
        <>
          <Input
            style={{ width: 200 }}
            placeholder={$t('按编码搜索（codeLike）')}
            value={codeLike}
            onChange={(e) => {
              setPage(1)
              setCodeLike(e.target.value)
            }}
          />
          {canAdmin ? <Button onClick={() => setCreating(true)}>{$t('新建工作中心')}</Button> : null}
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {hint ? <Message kind="success" title={hint} /> : null}
      <Table<WorkCenterDto>
        loading={loading}
        columns={[
          { key: 'code', title: $t('编码') },
          { key: 'name', title: $t('名称') },
          { key: 'deptId', title: $t('所属部门'), render: (w) => deptName(w.deptId) },
          {
            key: 'status',
            title: $t('状态'),
            render: (w) =>
              w.status === 'active' ? (
                <Badge tone="success">{MASTERDATA_STATUS_LABELS[w.status]}</Badge>
              ) : (
                <Badge tone="default">{MASTERDATA_STATUS_LABELS[w.status]}</Badge>
              ),
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (w) =>
              canAdmin ? (
                <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                  <Button size="sm" variant="secondary" onClick={() => setEditing(w)}>
                    {$t('编辑')}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleting(w)}>
                    {$t('退役')}
                  </Button>
                </span>
              ) : null,
          },
        ]}
        rows={items}
        rowKey={(w) => w.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无工作中心')}
      />
      <WorkCenterFormModal
        open={creating || editing !== null}
        editing={editing}
        nodes={nodes}
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
      <ConfirmModal
        open={deleting !== null}
        tone="danger"
        title={$t('退役工作中心「{p0}（{p1}）」', { p0: deleting?.name ?? '', p1: deleting?.code ?? '' })}
        description={$t('被设备/工序/订单工序引用时服务端按序拒绝（MD-18）；退役为逻辑失效。')}
        confirmText={$t('确认退役')}
        onConfirm={() => {
          const w = deleting
          if (!w) return
          void api
            .retireWorkCenter(w.id, { reason: `管理员退役工作中心 ${w.code}` })
            .then((r) => {
              setDeleting(null)
              setHint($t('工作中心「{p0}」已退役（operationId：{p1}…）', { p0: w.name, p1: r.operationId.slice(0, 8) }))
              refresh()
            })
            .catch((err) => {
              setDeleting(null)
              setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('退役失败') })
            })
        }}
        onCancel={() => setDeleting(null)}
      />
    </PageContainer>
  )
}

function WorkCenterFormModal({
  open,
  editing,
  nodes,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: WorkCenterDto | null
  nodes: OrgNodeDto[]
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [form, setForm] = useState({ code: '', name: '', deptId: '' })
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
    })
  }, [open, editing])

  const deptOptions = nodes
    .filter((n) => n.kind === 'department' && n.status === 'active')
    .map((n) => ({ value: n.id, label: $t('{p0}（{p1}）', { p0: n.name, p1: n.code }) }))

  const submit = async () => {
    const next: Record<string, string> = {}
    if (!editing && !form.code.trim()) next.code = $t('编码必填（MD-17）')
    if (!form.name.trim()) next.name = $t('名称必填')
    if (!form.deptId) next.deptId = $t('请选择所属部门')
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (editing) {
        const r = await api.updateWorkCenter(
          editing.id,
          { name: form.name.trim(), code: form.code.trim() || undefined },
          { reason: `编辑工作中心 ${editing.code}` },
        )
        onSaved($t('工作中心「{p0}」已保存（operationId：{p1}…）', { p0: form.name.trim(), p1: r.operationId.slice(0, 8) }))
      } else {
        const r = await api.createWorkCenter(
          { code: form.code.trim(), name: form.name.trim(), deptId: form.deptId },
          { reason: `新建工作中心 ${form.code.trim()}` },
        )
        onSaved($t('工作中心「{p0}」已建档（operationId：{p1}…）', { p0: form.name.trim(), p1: r.operationId.slice(0, 8) }))
      }
    } catch (err) {
      setSubmitError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('保存工作中心失败') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title={editing ? $t('编辑工作中心：{p0}', { p0: editing.name }) : $t('新建工作中心')}
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
        <Field label={$t('编码')} required error={errors.code} hint={$t('全局唯一（MD-17）；已有编码修改受唯一性复检')}>
          <Input value={form.code} invalid={Boolean(errors.code)} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
        </Field>
        <Field label={$t('名称')} required error={errors.name} hint={$t('同部门内唯一（MD-17）')}>
          <Input value={form.name} invalid={Boolean(errors.name)} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label={$t('所属部门')} required error={errors.deptId} hint={$t('创建后部门变更会同步工厂归属（服务端口径）')}>
          <Select
            value={form.deptId}
            placeholder={$t('请选择部门')}
            options={deptOptions}
            invalid={Boolean(errors.deptId)}
            disabled={editing !== null}
            onChange={(e) => setForm((f) => ({ ...f, deptId: e.target.value }))}
          />
        </Field>
      </Form>
    </Modal>
  )
}
