import {
  ApiError,
  Badge,
  Button,
  Field,
  Form,
  Input,
  Message,
  Modal,
  ORG_PERMISSION_OPTIONS,
  ORG_NODE_KIND_LABELS,
  PageContainer,
  SCOPE_TYPE_LABELS,
  Select,
  Table,
  formatErrorTitleAndDetail,
  type GrantPayload,
  type OrgNodeDto,
  type RoleDto,
  type ScopeGrantDto,
  type UserAccountDto,
  t as $t,
} from '@cadenza/ui'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'

const PAGE_SIZE = 10

/**
 * 授权管理页（接真实 /org/grants 查询 + org.grant.grant / org.grant.revoke 命令）：
 * - 授权事实以落库行集合为准（OA-21）：主体（角色/用户）× 范围对象 × 岗位许可；
 * - 授权/回收为高影响操作，必填原因（OA-29）；同键至多一行，重复授权合并权限（OA-22）；
 * - 配置含 org.role.admin 的授权须持管理员权限（OA-20，服务端终校）。
 */
export function OrgGrantsPage() {
  const [grants, setGrants] = useState<ScopeGrantDto[]>([])
  const [nodes, setNodes] = useState<OrgNodeDto[]>([])
  const [roles, setRoles] = useState<RoleDto[]>([])
  const [users, setUsers] = useState<UserAccountDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [principalType, setPrincipalType] = useState<'' | 'role' | 'user'>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [granting, setGranting] = useState(false)
  const [revoking, setRevoking] = useState<ScopeGrantDto | null>(null)
  const [reloadFlag, setReloadFlag] = useState(0)

  useEffect(() => {
    // 名称映射用基础数据（dev 规模全量；users 取前 100 活动账号）
    void api
      .listOrgNodes({ page: 1, pageSize: 100 })
      .then((r) => setNodes(r.items))
      .catch(() => setNodes([]))
    void api
      .listRoles({ page: 1, pageSize: 100 })
      .then((r) => setRoles(r.items))
      .catch(() => setRoles([]))
    void api
      .listUsers({ page: 1, pageSize: 100 })
      .then((r) => setUsers(r.items))
      .catch(() => setUsers([]))
  }, [reloadFlag])

  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .listGrants({ page, pageSize: PAGE_SIZE, principalType: principalType || undefined })
      .then((result) => {
        if (!alive) return
        setGrants(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载授权失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, principalType, reloadFlag])

  const refresh = () => setReloadFlag((f) => f + 1)

  const nodeName = useMemo(() => {
    const map = new Map(nodes.map((n) => [n.id, n.name] as const))
    return (id: string) => map.get(id) ?? id
  }, [nodes])

  const principalName = (g: ScopeGrantDto): string => {
    if (g.principalType === 'role') {
      const r = roles.find((x) => x.id === g.principalId)
      return r ? `角色·${r.name}` : `角色·${g.principalId}`
    }
    const u = users.find((x) => x.id === g.principalId)
    return u ? `用户·${u.displayName}（${u.loginName}）` : `用户·${g.principalId}`
  }

  return (
    <PageContainer
      title={$t('授权管理')}
      description={$t('岗位操作许可与数据范围授权（OA-20～OA-26；授权事实以落库行集合为准）')}
      actions={
        <>
          <Select
            style={{ width: 150 }}
            value={principalType}
            options={[
              { value: '', label: $t('全部主体') },
              { value: 'role', label: $t('按角色') },
              { value: 'user', label: $t('按用户') },
            ]}
            onChange={(e) => {
              setPage(1)
              setPrincipalType(e.target.value as '' | 'role' | 'user')
            }}
          />
          <Button onClick={() => setGranting(true)}>{$t('新增授权')}</Button>
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {hint ? <Message kind="success" title={hint} /> : null}
      <Table<ScopeGrantDto>
        loading={loading}
        columns={[
          { key: 'principal', title: $t('授权主体'), render: (g) => principalName(g) },
          { key: 'scope', title: $t('数据范围'), render: (g) => `${SCOPE_TYPE_LABELS[g.scopeType] ?? g.scopeType}｜${nodeName(g.scopeObjectId)}` },
          {
            key: 'permissions',
            title: $t('岗位许可'),
            render: (g) => (
              <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                {g.permissions.map((p) => (
                  <Badge key={p} tone={p === 'org.role.admin' ? 'warning' : 'info'}>
                    {p}
                  </Badge>
                ))}
              </span>
            ),
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (g) => (
              <Button size="sm" variant="danger" onClick={() => setRevoking(g)}>
                {$t('回收…')}
              </Button>
            ),
          },
        ]}
        rows={grants}
        rowKey={(g) => g.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无授权')}
      />
      <GrantModal
        open={granting}
        nodes={nodes}
        roles={roles}
        users={users}
        onClose={() => setGranting(false)}
        onSaved={(msg) => {
          setGranting(false)
          setHint(msg)
          refresh()
        }}
      />
      <RevokeModal
        grant={revoking}
        principalLabel={revoking ? principalName(revoking) : ''}
        scopeLabel={
          revoking
            ? $t('{p0}｜{p1}', { p0: SCOPE_TYPE_LABELS[revoking.scopeType] ?? revoking.scopeType, p1: nodeName(revoking.scopeObjectId) })
            : ''
        }
        onClose={() => setRevoking(null)}
        onDone={(msg) => {
          setRevoking(null)
          setHint(msg)
          refresh()
        }}
      />
    </PageContainer>
  )
}

function GrantModal({
  open,
  nodes,
  roles,
  users,
  onClose,
  onSaved,
}: {
  open: boolean
  nodes: OrgNodeDto[]
  roles: RoleDto[]
  users: UserAccountDto[]
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [principalType, setPrincipalType] = useState<'role' | 'user'>('role')
  const [principalId, setPrincipalId] = useState('')
  const [scopeType, setScopeType] = useState<GrantPayload['scopeType']>('plant')
  const [scopeObjectId, setScopeObjectId] = useState('')
  const [permissions, setPermissions] = useState<string[]>(['org.read'])
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<{ title: string; detail?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // scope_type 与目标节点类型配对（OA-23/GAP-A4：workshop → work_center）
  const scopeObjectKind: Record<GrantPayload['scopeType'], string> = {
    enterprise: 'enterprise',
    plant: 'plant',
    workshop: 'work_center',
  }
  const scopeOptions = nodes
    .filter((n) => n.kind === scopeObjectKind[scopeType] && n.status === 'active')
    .map((n) => ({
      value: n.id,
      label: $t('{p0}（{p1}·{p2}）', { p0: n.name, p1: n.code, p2: ORG_NODE_KIND_LABELS[n.kind] ?? n.kind }),
    }))

  const principalOptions =
    principalType === 'role'
      ? roles.filter((r) => r.status === 'active').map((r) => ({ value: r.id, label: $t('角色·{p0}（{p1}）', { p0: r.name, p1: r.alias }) }))
      : users.map((u) => ({ value: u.id, label: $t('用户·{p0}（{p1}）', { p0: u.displayName, p1: u.loginName }) }))

  const submit = async () => {
    const next: Record<string, string> = {}
    if (!principalId) next.principalId = $t('请选择授权主体')
    if (!scopeObjectId) next.scopeObjectId = `请选择范围对象（${SCOPE_TYPE_LABELS[scopeType]}对应 ${
      ORG_NODE_KIND_LABELS[scopeObjectKind[scopeType]] ?? scopeObjectKind[scopeType]
    } 节点）`
    if (permissions.length === 0) next.permissions = $t('至少勾选一项岗位许可')
    if (!reason.trim()) next.reason = $t('授权为高影响操作，必须填写原因（OA-29）')
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const payload: GrantPayload = {
        principalType,
        principalId,
        scopeType,
        scopeObjectId,
        permissions,
      }
      const r = await api.grant(payload, { reason: reason.trim() })
      onSaved($t('授权已保存（operationId：{p0}…；同键重复授权将合并权限，OA-22）', { p0: r.operationId.slice(0, 8) }))
      setPrincipalId('')
      setScopeObjectId('')
      setPermissions(['org.read'])
      setReason('')
    } catch (err) {
      setSubmitError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('保存授权失败') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title={$t('新增授权')}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {$t('取消')}
          </Button>
          <Button onClick={() => void submit()} loading={submitting}>
            {$t('保存授权')}
          </Button>
        </>
      }
    >
      {submitError ? <Message kind="error" title={submitError.title} detail={submitError.detail} /> : null}
      <Form>
        <Field label={$t('授权主体类型')} required>
          <Select
            value={principalType}
            options={[
              { value: 'role', label: $t('角色') },
              { value: 'user', label: $t('用户') },
            ]}
            onChange={(e) => {
              setPrincipalType(e.target.value as 'role' | 'user')
              setPrincipalId('')
            }}
          />
        </Field>
        <Field label={$t('授权主体')} required error={errors.principalId}>
          <Select
            value={principalId}
            placeholder={$t('请选择主体')}
            options={principalOptions}
            invalid={Boolean(errors.principalId)}
            onChange={(e) => setPrincipalId(e.target.value)}
          />
        </Field>
        <Field label={$t('范围类型')} required hint={$t('数据范围三维（OA-23）；workshop 取工作中心节点（GAP-A4 口径）')}>
          <Select
            value={scopeType}
            options={[
              { value: 'enterprise', label: $t('企业范围') },
              { value: 'plant', label: $t('工厂范围') },
              { value: 'workshop', label: $t('车间范围') },
            ]}
            onChange={(e) => {
              setScopeType(e.target.value as GrantPayload['scopeType'])
              setScopeObjectId('')
            }}
          />
        </Field>
        <Field label={$t('范围对象')} required error={errors.scopeObjectId}>
          {scopeOptions.length === 0 ? (
            <Input value="" disabled placeholder={$t('（当前范围类型下无可用节点）')} />
          ) : (
            <Select
              value={scopeObjectId}
              placeholder={$t('请选择范围对象')}
              options={scopeOptions}
              invalid={Boolean(errors.scopeObjectId)}
              onChange={(e) => setScopeObjectId(e.target.value)}
            />
          )}
        </Field>
        <Field label={$t('岗位许可')} required error={errors.permissions} hint={$t('勾选 org.role.admin 须持管理员权限（OA-20）')}>
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
            {ORG_PERMISSION_OPTIONS.map((opt) => (
              <label key={opt.value} style={{ fontSize: 13.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={permissions.includes(opt.value)}
                  onChange={(e) => {
                    setPermissions((prev) =>
                      e.target.checked ? [...prev, opt.value] : prev.filter((p) => p !== opt.value),
                    )
                  }}
                />
                {opt.label}
              </label>
            ))}
          </span>
        </Field>
        <Field label={$t('操作原因')} required error={errors.reason} hint={$t('高影响操作必填（OA-29），写入审计')}>
          <Input
            value={reason}
            invalid={Boolean(errors.reason)}
            placeholder={$t('例如：为生产计划员开通本厂查询权限')}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </Form>
    </Modal>
  )
}

function RevokeModal({
  grant,
  principalLabel,
  scopeLabel,
  onClose,
  onDone,
}: {
  grant: ScopeGrantDto | null
  principalLabel: string
  scopeLabel: string
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [reason, setReason] = useState('')
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setSelected(grant ? [...grant.permissions] : [])
    setReason('')
    setError(null)
  }, [grant])

  const submit = async () => {
    if (!grant) return
    if (selected.length === 0) {
      setError({ title: $t('至少勾选一项要回收的许可') })
      return
    }
    if (!reason.trim()) {
      setError({ title: $t('回收为高影响操作，必须填写原因（OA-29）') })
      return
    }
    setSubmitting(true)
    try {
      const r = await api.revokeGrant(
        {
          principalType: grant.principalType,
          principalId: grant.principalId,
          scopeType: grant.scopeType,
          scopeObjectId: grant.scopeObjectId,
          permissions: selected,
        },
        { reason: reason.trim() },
      )
      onDone($t('已回收 {p0} 项许可（operationId：{p1}…）', { p0: selected.length, p1: r.operationId.slice(0, 8) }))
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('回收失败') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={grant !== null}
      title={$t('回收授权：{p0}', { p0: principalLabel })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {$t('取消')}
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={submitting}>
            {$t('确认回收')}
          </Button>
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      <p style={{ margin: '0 0 10px', fontSize: 13 }}>{$t('范围：')}{scopeLabel}</p>
      <Form>
        <Field label={$t('回收许可（多选）')} required>
          <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
            {(grant?.permissions ?? []).map((p) => (
              <label key={p} style={{ fontSize: 13.5, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={selected.includes(p)}
                  onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, p] : prev.filter((x) => x !== p)))}
                />
                {p}
              </label>
            ))}
          </span>
        </Field>
        <Field label={$t('操作原因')} required hint={$t('高影响操作必填（OA-29），写入审计')}>
          <Input value={reason} invalid={Boolean(error)} placeholder={$t('例如：岗位调整，收回管理权限')} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Form>
    </Modal>
  )
}
