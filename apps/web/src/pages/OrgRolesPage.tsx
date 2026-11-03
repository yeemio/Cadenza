import {
  ApiError,
  Badge,
  Button,
  ConfirmModal,
  Field,
  Form,
  Input,
  Message,
  Modal,
  PageContainer,
  Table,
  formatErrorTitleAndDetail,
  type RoleDto,
  t as $t,
} from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { api } from '../api'

const PAGE_SIZE = 10

/**
 * 角色管理页（接真实 /org/roles 分页 CRUD）：
 * - 名称/别名/排序在租户及上级范围内唯一（OA-17，服务端终校）；
 * - 内置角色（isSystem=2）不可删、别名不可改（OA-18，编辑表单禁用别名输入）；
 * - 删除前置（OA-19）：已关联用户/有下级角色时服务端拒绝，前端按 message 渲染。
 */
export function OrgRolesPage() {
  const [roles, setRoles] = useState<RoleDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<RoleDto | null>(null)
  const [deleting, setDeleting] = useState<RoleDto | null>(null)
  const [reloadFlag, setReloadFlag] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .listRoles({ page, pageSize: PAGE_SIZE })
      .then((result) => {
        if (!alive) return
        setRoles(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载角色失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, reloadFlag])

  const refresh = () => setReloadFlag((f) => f + 1)

  return (
    <PageContainer
      title={$t('角色管理')}
      description={$t('角色列表与建档（OA-17～OA-19）；岗位授权（scope_grant，OA-21/22）见「授权管理」页')}
      actions={<Button onClick={() => setCreating(true)}>{$t('新建角色')}</Button>}
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {hint ? <Message kind="success" title={hint} /> : null}
      <Table<RoleDto>
        loading={loading}
        columns={[
          { key: 'name', title: $t('角色名称') },
          { key: 'alias', title: $t('别名') },
          { key: 'sort', title: $t('排序') },
          {
            key: 'isSystem',
            title: $t('类型'),
            render: (r) =>
              r.isSystem === 2 ? <Badge tone="info">{$t('内置（不可删）')}</Badge> : <Badge>{$t('普通')}</Badge>,
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (r) => (
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>
                  {$t('编辑')}
                </Button>
                <Button size="sm" variant="danger" disabled={r.isSystem === 2} onClick={() => setDeleting(r)}>
                  {$t('删除')}
                </Button>
              </span>
            ),
          },
        ]}
        rows={roles}
        rowKey={(r) => r.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无角色')}
      />
      <RoleFormModal
        open={creating || editing !== null}
        editing={editing}
        existing={roles}
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
        title={$t('删除角色「{p0}」', { p0: deleting?.name ?? '' })}
        description={$t('删除为逻辑退役；已关联用户的角色、有下级角色的角色将被服务端拒绝（OA-19）。')}
        confirmText={$t('确认删除')}
        onConfirm={() => {
          const r = deleting
          if (!r) return
          void api
            .retireRole(r.id, { reason: `管理员删除角色 ${r.name}` })
            .then(() => {
              setDeleting(null)
              setHint($t('角色「{p0}」已删除', { p0: r.name }))
              refresh()
            })
            .catch((err) => {
              setDeleting(null)
              setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('删除失败') })
            })
        }}
        onCancel={() => setDeleting(null)}
      />
    </PageContainer>
  )
}

function RoleFormModal({
  open,
  editing,
  existing,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: RoleDto | null
  existing: RoleDto[]
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [form, setForm] = useState({ name: '', alias: '', sort: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<{ title: string; detail?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setErrors({})
    setSubmitError(null)
    setForm({
      name: editing?.name ?? '',
      alias: editing?.alias ?? '',
      sort: editing != null ? String(editing.sort) : String(existing.length + 1),
    })
  }, [open, editing, existing.length])

  const builtin = editing?.isSystem === 2

  const submit = async () => {
    const next: Record<string, string> = {}
    const name = form.name.trim()
    const alias = form.alias.trim()
    const sort = form.sort.trim()
    if (!name) next.name = $t('请输入角色名称')
    // OA-17：名称/别名/排序任一与既有角色重复即拒绝（前端即时提示，服务端终校）
    else if (existing.some((r) => r.name === name && r.id !== editing?.id)) next.name = $t('角色名称已存在（OA-17）')
    if (!alias) next.alias = $t('请输入角色别名')
    else if (existing.some((r) => r.alias === alias && r.id !== editing?.id)) next.alias = $t('角色别名已存在（OA-17）')
    if (!/^\d+$/.test(sort)) next.sort = $t('排序必须为数字')
    else if (existing.some((r) => String(r.sort) === sort && r.id !== editing?.id)) next.sort = $t('排序已存在（OA-17）')
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (editing) {
        const r = await api.updateRole(
          editing.id,
          { name, alias: builtin ? editing.alias : alias, sort: Number(sort) },
          { reason: `管理员编辑角色 ${name}` },
        )
        onSaved($t('角色「{p0}」已保存（operationId：{p1}…）', { p0: name, p1: r.operationId.slice(0, 8) }))
      } else {
        const r = await api.createRole({ name, alias, sort: Number(sort) }, { reason: `管理员新建角色 ${name}` })
        onSaved($t('角色「{p0}」已建档（operationId：{p1}…）', { p0: name, p1: r.operationId.slice(0, 8) }))
      }
    } catch (err) {
      setSubmitError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('保存角色失败') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title={editing ? $t('编辑角色：{p0}', { p0: editing.name }) : $t('新建角色')}
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
        <Field label={$t('角色名称')} required error={errors.name} hint={$t('同租户及上级范围内唯一（OA-17）')}>
          <Input
            value={form.name}
            invalid={Boolean(errors.name)}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </Field>
        <Field
          label={$t('别名')}
          required
          error={errors.alias}
          hint={builtin ? $t('内置角色别名不可修改（OA-18）') : $t('同租户及上级范围内唯一（OA-17）')}
        >
          <Input
            value={form.alias}
            invalid={Boolean(errors.alias)}
            disabled={builtin}
            onChange={(e) => setForm((f) => ({ ...f, alias: e.target.value }))}
          />
        </Field>
        <Field label={$t('排序')} required error={errors.sort}>
          <Input
            value={form.sort}
            invalid={Boolean(errors.sort)}
            onChange={(e) => setForm((f) => ({ ...f, sort: e.target.value }))}
          />
        </Field>
      </Form>
    </Modal>
  )
}
