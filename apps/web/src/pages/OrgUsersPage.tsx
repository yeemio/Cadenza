import {
  ApiError,
  Badge,
  Button,
  ConfirmModal,
  Field,
  Form,
  Input,
  LOGIN_PLATFORM_LABELS,
  Message,
  Modal,
  PageContainer,
  Select,
  Table,
  formatErrorTitleAndDetail,
  type OrgNodeDto,
  type RoleDto,
  type UserAccountDto,
  t as $t,
} from '@cadenza/ui'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'

const PAGE_SIZE = 10

/** 锁定中判定（OA-16：锁定缓存到期自动解锁；解封仅清缓存） */
function isLocked(u: UserAccountDto): boolean {
  return u.lockedUntil !== null && new Date(u.lockedUntil).getTime() > Date.now()
}

/**
 * 用户管理页（接真实 /org/users 分页 CRUD）：
 * - 列表：分页（PC-16 total 服务端口径）+ loginNameLike 过滤（服务端参数）；
 * - 部门/角色名由 deptId/roleId 经机构与角色列表映射解析（真实 DTO 不含名称字段）；
 * - 新建/编辑（OA-10/12/13/14 前端即时提示，服务端终校）；
 * - 行操作：重置密码（OA-15，留空用系统初始口令）、解封（OA-16，锁定行显示）、删除（OA-11 自删服务端拒绝）；
 * - 表单错误按服务端 details/message 渲染（[OA-xx] 文案）。
 */
export function OrgUsersPage() {
  const [users, setUsers] = useState<UserAccountDto[]>([])
  const [nodes, setNodes] = useState<OrgNodeDto[]>([])
  const [roles, setRoles] = useState<RoleDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<UserAccountDto | null>(null)
  const [resetting, setResetting] = useState<UserAccountDto | null>(null)
  const [deleting, setDeleting] = useState<UserAccountDto | null>(null)
  const [reloadFlag, setReloadFlag] = useState(0)

  const loadOptions = () => {
    void api
      .listOrgNodes({ page: 1, pageSize: 100 })
      .then((r) => setNodes(r.items))
      .catch(() => setNodes([]))
    void api
      .listRoles({ page: 1, pageSize: 100 })
      .then((r) => setRoles(r.items))
      .catch(() => setRoles([]))
  }

  useEffect(loadOptions, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .listUsers({ page, pageSize: PAGE_SIZE, loginNameLike: keyword.trim() || undefined })
      .then((result) => {
        if (!alive) return
        setUsers(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载用户失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, keyword, reloadFlag])

  const deptName = useMemo(() => {
    const map = new Map(nodes.map((n) => [n.id, n.name] as const))
    return (id: string) => map.get(id) ?? id
  }, [nodes])
  const roleName = useMemo(() => {
    const map = new Map(roles.map((r) => [r.id, r.name] as const))
    return (id: string) => map.get(id) ?? id
  }, [roles])

  const refresh = () => setReloadFlag((f) => f + 1)

  return (
    <PageContainer
      title={$t('用户管理')}
      description={$t('用户账号列表与建档（字段口径：org-auth 冻结合同 OA-10～OA-16；服务端分页与范围过滤）')}
      actions={
        <>
          <Input
            style={{ width: 220 }}
            placeholder={$t('按登录账号搜索（loginNameLike）')}
            value={keyword}
            onChange={(e) => {
              setPage(1)
              setKeyword(e.target.value)
            }}
          />
          <Button onClick={() => setCreating(true)}>{$t('新建用户')}</Button>
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {hint ? <Message kind="success" title={hint} /> : null}
      <Table<UserAccountDto>
        loading={loading}
        columns={[
          { key: 'loginName', title: $t('登录账号') },
          { key: 'displayName', title: $t('姓名') },
          { key: 'deptId', title: $t('所属部门'), render: (u) => deptName(u.deptId) },
          { key: 'roleId', title: $t('所属角色'), render: (u) => roleName(u.roleId) },
          { key: 'loginPlatform', title: $t('登录平台'), render: (u) => LOGIN_PLATFORM_LABELS[u.loginPlatform] ?? u.loginPlatform },
          {
            key: 'accountStatus',
            title: $t('账号状态'),
            render: (u) =>
              u.accountStatus === 'enabled' ? (
                isLocked(u) ? (
                  <Badge tone="warning">{$t('锁定中')}</Badge>
                ) : (
                  <Badge tone="success">{$t('启用')}</Badge>
                )
              ) : (
                <Badge tone="danger">{$t('禁用')}</Badge>
              ),
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (u) => (
              <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                <Button size="sm" variant="secondary" onClick={() => setEditing(u)}>
                  {$t('编辑')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setResetting(u)}>
                  {$t('重置密码')}
                </Button>
                {isLocked(u) ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      void api
                        .unlockUser(u.id, { reason: '管理员解封（OA-16）' })
                        .then(() => {
                          setHint($t('账号「{p0}」已解封（失败计数已清零）', { p0: u.loginName }))
                          refresh()
                        })
                        .catch((err) =>
                          setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('解封失败') }),
                        )
                    }}
                  >
                    {$t('解封')}
                  </Button>
                ) : null}
                <Button size="sm" variant="danger" onClick={() => setDeleting(u)}>
                  {$t('删除')}
                </Button>
              </span>
            ),
          },
        ]}
        rows={users}
        rowKey={(u) => u.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无用户')}
      />
      <UserFormModal
        open={creating || editing !== null}
        editing={editing}
        nodes={nodes}
        roles={roles}
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
      <ResetPasswordModal
        user={resetting}
        onClose={() => setResetting(null)}
        onDone={(msg) => {
          setResetting(null)
          setHint(msg)
        }}
      />
      <ConfirmModal
        open={deleting !== null}
        tone="danger"
        title={$t('删除用户「{p0}（{p1}）」', { p0: deleting?.displayName ?? '', p1: deleting?.loginName ?? '' })}
        description={$t('删除为逻辑注销（status=retired），删除当前登录账号自身将被服务端拒绝（OA-11）。')}
        confirmText={$t('确认删除')}
        onConfirm={() => {
          const u = deleting
          if (!u) return
          void api
            .retireUser(u.id, { reason: `管理员删除账号 ${u.loginName}` })
            .then(() => {
              setDeleting(null)
              setHint($t('用户「{p0}」已删除', { p0: u.loginName }))
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

function UserFormModal({
  open,
  editing,
  nodes,
  roles,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: UserAccountDto | null
  nodes: OrgNodeDto[]
  roles: RoleDto[]
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [form, setForm] = useState({
    loginName: '',
    password: '',
    displayName: '',
    deptId: '',
    workshopDeptId: '',
    roleId: '',
    platform: 'PDA',
    password2: '',
    status: 'enabled',
    phone: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<{ title: string; detail?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setErrors({})
    setSubmitError(null)
    setForm({
      loginName: editing?.loginName ?? '',
      password: '',
      displayName: editing?.displayName ?? '',
      deptId: editing?.deptId ?? '',
      workshopDeptId: editing?.workshopDeptId ?? '',
      roleId: editing?.roleId ?? '',
      platform: editing?.loginPlatform ?? 'PDA',
      password2: '',
      status: editing?.accountStatus ?? 'enabled',
      phone: editing?.phone ?? '',
    })
  }, [open, editing])

  // 部门下拉仅列 department 节点（服务端口径：deptId 须为部门节点）
  const deptOptions = nodes
    .filter((n) => n.kind === 'department' && n.status === 'active')
    .map((n) => ({ value: n.id, label: $t('{p0}（{p1}）', { p0: n.name, p1: n.code }) }))
  const selectedDept = nodes.find((n) => n.id === form.deptId)
  // OA-13：所属部门为质检部（deptCategory=2）时车间部门必填（服务端强制）
  const workshopRequired = selectedDept?.deptCategory === 2

  const submit = async () => {
    const next: Record<string, string> = {}
    if (!editing) {
      if (!/^[A-Za-z0-9]+$/.test(form.loginName.trim())) next.loginName = $t('登录账号仅允许字母与数字（OA-10）')
      if (!/^(?=.*[A-Za-z])(?=.*\d).{8,16}$/.test(form.password)) {
        next.password = $t('密码须 8–16 位且同时包含数字与字母（OA-14）')
      } else if (form.password !== form.password2) {
        next.password2 = $t('两次输入的密码不一致')
      }
    }
    if (!form.displayName.trim()) next.displayName = $t('请输入姓名')
    if (!form.deptId) next.deptId = $t('请选择所属部门（OA-12 必填）')
    if (workshopRequired && !form.workshopDeptId) next.workshopDeptId = $t('所属部门为质检部时车间部门必填（OA-13）')
    if (!form.roleId) next.roleId = $t('请选择所属角色（OA-12 必填）')
    if (!form.platform) next.platform = $t('请选择登录平台（OA-12 必填）')
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (editing) {
        const payload: Parameters<typeof api.updateUser>[1] = {
          displayName: form.displayName.trim(),
          deptId: form.deptId,
          workshopDeptId: form.workshopDeptId || null,
          roleId: form.roleId,
          loginPlatform: form.platform as 'WEB' | 'PDA',
          accountStatus: form.status as 'enabled' | 'disabled',
          phone: form.phone.trim() || null,
        }
        const r = await api.updateUser(editing.id, payload, { reason: `管理员编辑账号 ${editing.loginName}` })
        onSaved($t('用户「{p0}」已保存（operationId：{p1}…）', { p0: editing.loginName, p1: r.operationId.slice(0, 8) }))
      } else {
        const r = await api.createUser(
          {
            loginName: form.loginName.trim(),
            password: form.password,
            displayName: form.displayName.trim(),
            deptId: form.deptId,
            workshopDeptId: form.workshopDeptId || null,
            roleId: form.roleId,
            loginPlatform: form.platform as 'WEB' | 'PDA',
            accountStatus: form.status as 'enabled' | 'disabled',
            phone: form.phone.trim() || null,
          },
          { reason: `管理员新建账号 ${form.loginName.trim()}` },
        )
        onSaved($t('用户「{p0}」已建档（operationId：{p1}…）', { p0: form.loginName.trim(), p1: r.operationId.slice(0, 8) }))
      }
    } catch (err) {
      // 服务端业务拒绝（如 [OA-10] 账号已存在）按 message 渲染（PC-14）
      setSubmitError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('保存用户失败') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title={editing ? $t('编辑用户：{p0}', { p0: editing.loginName }) : $t('新建用户')}
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
          <Field label={$t('登录账号')} hint={$t('账号创建后不可改')}>
            <Input value={editing.loginName} disabled />
          </Field>
        ) : (
          <Field label={$t('登录账号')} required error={errors.loginName} hint={$t('全局唯一，仅字母与数字（OA-10）')}>
            <Input
              value={form.loginName}
              invalid={Boolean(errors.loginName)}
              onChange={(e) => setForm((f) => ({ ...f, loginName: e.target.value }))}
            />
          </Field>
        )}
        <Field label={$t('姓名')} required error={errors.displayName}>
          <Input
            value={form.displayName}
            invalid={Boolean(errors.displayName)}
            onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
          />
        </Field>
        <Field label={$t('所属部门')} required error={errors.deptId}>
          <Select
            value={form.deptId}
            placeholder={$t('请选择部门')}
            options={deptOptions}
            invalid={Boolean(errors.deptId)}
            onChange={(e) => setForm((f) => ({ ...f, deptId: e.target.value, workshopDeptId: '' }))}
          />
        </Field>
        <Field
          label={$t('车间部门')}
          required={workshopRequired}
          error={errors.workshopDeptId}
          hint={$t('所属部门为质检部（deptCategory=2）时必填（OA-13）；工厂归属由部门在服务端计算（OA-33）')}
        >
          <Select
            value={form.workshopDeptId}
            placeholder={workshopRequired ? $t('请选择车间部门') : $t('（无）')}
            options={deptOptions}
            invalid={Boolean(errors.workshopDeptId)}
            onChange={(e) => setForm((f) => ({ ...f, workshopDeptId: e.target.value }))}
          />
        </Field>
        <Field label={$t('所属角色')} required error={errors.roleId}>
          <Select
            value={form.roleId}
            placeholder={$t('请选择角色')}
            options={roles.map((r) => ({ value: r.id, label: r.name }))}
            invalid={Boolean(errors.roleId)}
            onChange={(e) => setForm((f) => ({ ...f, roleId: e.target.value }))}
          />
        </Field>
        <Field label={$t('登录平台')} required error={errors.platform} hint={$t('单值（OA-12）：该账号允许登录的平台')}>
          <Select
            value={form.platform}
            options={[
              { value: 'WEB', label: $t('Web 工作台') },
              { value: 'PDA', label: $t('PDA 现场终端') },
            ]}
            onChange={(e) => setForm((f) => ({ ...f, platform: e.target.value }))}
          />
        </Field>
        {!editing ? (
          <>
            <Field label={$t('初始密码')} required error={errors.password} hint={$t('8–16 位，须同时包含数字与字母（OA-14）')}>
              <Input
                type="password"
                value={form.password}
                invalid={Boolean(errors.password)}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              />
            </Field>
            <Field label={$t('确认密码')} required error={errors.password2}>
              <Input
                type="password"
                value={form.password2}
                invalid={Boolean(errors.password2)}
                onChange={(e) => setForm((f) => ({ ...f, password2: e.target.value }))}
              />
            </Field>
          </>
        ) : null}
        <Field label={$t('账号状态')} required hint={$t('禁用后不可登录（OA-16）')}>
          <Select
            value={form.status}
            options={[
              { value: 'enabled', label: $t('启用') },
              { value: 'disabled', label: $t('禁用（不可登录，OA-16）') },
            ]}
            onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
          />
        </Field>
        <Field label={$t('联系电话')} hint={$t('选填')}>
          <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
        </Field>
      </Form>
    </Modal>
  )
}

function ResetPasswordModal({
  user,
  onClose,
  onDone,
}: {
  user: UserAccountDto | null
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (!user) return
    if (password && !/^(?=.*[A-Za-z])(?=.*\d).{8,16}$/.test(password)) {
      setError({ title: $t('密码须 8–16 位且同时包含数字与字母（OA-14）') })
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const r = await api.resetUserPassword(
        user.id,
        password ? { password } : {},
        { reason: `管理员重置 ${user.loginName} 密码` },
      )
      setPassword('')
      onDone(
        password
          ? $t('已为「{p0}」设置新密码（operationId：{p1}…）', { p0: user.loginName, p1: r.operationId.slice(0, 8) })
          : $t('已为「{p0}」重置为系统初始口令（account.initPassword，OA-15）', { p0: user.loginName }),
      )
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('重置密码失败') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={user !== null}
      title={$t('重置密码：{p0}（{p1}）', { p0: user?.displayName ?? '', p1: user?.loginName ?? '' })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {$t('取消')}
          </Button>
          <Button onClick={() => void submit()} loading={submitting}>
            {password ? $t('设置新密码') : $t('重置为系统初始口令')}
          </Button>
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      <Form>
        <Field
          label={$t('新密码')}
          hint={$t('留空则重置为系统参数 account.initPassword（OA-15）；显式给密须满足 OA-14')}
        >
          <Input
            type="password"
            value={password}
            placeholder={$t('（留空使用系统初始口令）')}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </Form>
    </Modal>
  )
}
