import {
  ApiError,
  Badge,
  Button,
  ConfirmModal,
  Field,
  Form,
  Input,
  MATERIAL_TYPE_LABELS,
  Message,
  Modal,
  PageContainer,
  Select,
  Table,
  WAREHOUSE_TYPE_LABELS,
  ALLOWED_MATERIAL_TYPES_BY_WAREHOUSE_TYPE,
  deptAllowedWarehouseTypes,
  DEPT_CATEGORY_LABELS,
  formatErrorTitleAndDetail,
  type OrgNodeDto,
  type WarehouseDto,
  t as $t,
  tx as $tx,
} from '@cadenza/ui'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { MASTERDATA_ADMIN, MASTERDATA_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10
const MATERIAL_TYPE_OPTIONS = [1, 2, 3]

/**
 * 仓库管理页（MD-22～27）：
 * - 列表：类型/料品类型标签 + 二维码占用徽标 + 部门名称映射；
 * - 新建：MD-24 建仓部门类型约束前端即时提示（物流部→仓库、车间→线边仓；服务端终校兜底），
 *   MD-23 仓库类型限定可收料品类型（不允许的类型前端禁选）；
 * - 退役：ConfirmModal 显式后果（下级普通库位随之级联失效，MD-27）；
 * - 行内「库位/货架」下钻仓库详情页。
 */
export function MasterWarehousesPage() {
  const { has } = usePermissions()
  const canRead = has(MASTERDATA_READ)
  const canAdmin = has(MASTERDATA_ADMIN)
  const [items, setItems] = useState<WarehouseDto[]>([])
  const [nodes, setNodes] = useState<OrgNodeDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [nameLike, setNameLike] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<WarehouseDto | null>(null)
  const [deleting, setDeleting] = useState<WarehouseDto | null>(null)
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
      .listWarehouses({ page, pageSize: PAGE_SIZE, nameLike: nameLike.trim() || undefined })
      .then((result) => {
        if (!alive) return
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载仓库失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, nameLike, reloadFlag, canRead])

  const deptName = useMemo(() => {
    const map = new Map(nodes.map((n) => [n.id, n.name] as const))
    return (id: string) => map.get(id) ?? id
  }, [nodes])

  const refresh = () => setReloadFlag((f) => f + 1)

  if (!canRead) {
    return (
      <PageContainer title={$t('仓库管理')} description={$t('仓库/库位/货架主数据（master-data 合同 MD-22～MD-33）')}>
        <Message kind="warning" title={$t('没有主数据查询许可（masterdata.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 masterdata.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('仓库管理')}
      description={$t('仓库台账与类型配置（MD-22～27）；MD-24 建仓部门类型约束：物流部仅可建仓库、车间仅可建线边仓（服务端终校）')}
      actions={
        <>
          <Input
            style={{ width: 200 }}
            placeholder={$t('按名称搜索（nameLike）')}
            value={nameLike}
            onChange={(e) => {
              setPage(1)
              setNameLike(e.target.value)
            }}
          />
          {canAdmin ? <Button onClick={() => setCreating(true)}>{$t('新建仓库')}</Button> : null}
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {hint ? <Message kind="success" title={hint} /> : null}
      <Table<WarehouseDto>
        loading={loading}
        columns={[
          { key: 'code', title: $t('仓库编码') },
          { key: 'name', title: $t('仓库名称') },
          {
            key: 'warehouseType',
            title: $t('仓库类型'),
            render: (w) => <Badge tone="info">{WAREHOUSE_TYPE_LABELS[w.warehouseType] ?? w.warehouseType}</Badge>,
          },
          {
            key: 'materialTypes',
            title: $t('可收料品类型'),
            render: (w) =>
              w.materialTypes.map((t) => MATERIAL_TYPE_LABELS[t] ?? t).join(' / '),
          },
          { key: 'deptId', title: $t('建仓部门'), render: (w) => deptName(w.deptId) },
          {
            key: 'qrBound',
            title: $t('二维码'),
            render: (w) => (w.qrBound ? <Badge tone="warning">{$t('已占用')}</Badge> : <Badge tone="default">{$t('未占用')}</Badge>),
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (w) => (
              <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                <Link to={`/masterdata/warehouses/${w.id}`} style={{ alignSelf: 'center', fontSize: 13 }}>
                  {$t('库位/货架')}
                </Link>
                {canAdmin ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(w)}>
                      {$t('编辑')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleting(w)}>
                      {$t('退役')}
                    </Button>
                  </>
                ) : null}
              </span>
            ),
          },
        ]}
        rows={items}
        rowKey={(w) => w.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无仓库')}
      />
      <WarehouseFormModal
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
        title={$t('退役仓库「{p0}（{p1}）」', { p0: deleting?.name ?? '', p1: deleting?.code ?? '' })}
        description={$t('退役为逻辑失效（MD-36）：被二维码占用或存在库存引用时将被服务端拒绝（MD-26/27）；无引用时其下普通库位随之级联失效。')}
        confirmText={$t('确认退役')}
        onConfirm={() => {
          const w = deleting
          if (!w) return
          void api
            .retireWarehouse(w.id, { reason: `管理员退役仓库 ${w.code} ${w.name}` })
            .then((r) => {
              const data = r.data as { affectedNormalLocations?: number } | null
              setDeleting(null)
              setHint(
                typeof data?.affectedNormalLocations === 'number'
                  ? $t('仓库「{p0}」已退役，级联失效普通库位 {p1} 个（operationId：{p2}…）', { p0: w.name, p1: data.affectedNormalLocations, p2: r.operationId.slice(0, 8) })
                  : $t('仓库「{p0}」已退役（operationId：{p1}…）', { p0: w.name, p1: r.operationId.slice(0, 8) }),
              )
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

/**
 * 仓库表单（新建/编辑）：
 * - MD-24 前端即时提示：选择部门后按部门类型约束仓库类型可选项（物流部→仓库、车间→线边仓、其余不限），
 *   已选值越限立即重置并给出提示；服务端最终校验兜底；
 * - MD-23：仓库类型限定可收料品类型，不允许的类型禁选，切换类型时收敛已选集合。
 */
function WarehouseFormModal({
  open,
  editing,
  nodes,
  onClose,
  onSaved,
}: {
  open: boolean
  editing: WarehouseDto | null
  nodes: OrgNodeDto[]
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [form, setForm] = useState({
    code: '',
    name: '',
    deptId: '',
    warehouseType: 'WAREHOUSE',
    materialTypes: [] as number[],
    phone: '',
    address: '',
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
      warehouseType: editing?.warehouseType ?? 'WAREHOUSE',
      materialTypes: editing ? [...editing.materialTypes] : [],
      phone: editing?.phone ?? '',
      address: editing?.address ?? '',
    })
  }, [open, editing])

  const deptOptions = nodes
    .filter((n) => n.kind === 'department' && n.status === 'active')
    .map((n) => ({
      value: n.id,
      label: `${n.name}（${n.code}）${n.deptCategory ? `·${DEPT_CATEGORY_LABELS[n.deptCategory] ?? n.deptCategory}` : ''}`,
    }))

  const selectedDept = nodes.find((n) => n.id === form.deptId)
  // MD-24 前端即时提示（domain DEFAULT_DEPT_WAREHOUSE_TYPE_RULE 展示层镜像）
  const deptAllowed = deptAllowedWarehouseTypes(selectedDept?.deptCategory)
  const md24Hint =
    deptAllowed !== undefined
      ? $t('该部门类型（{p0}）仅允许创建{p1}（MD-24，服务端终校）', { p0: $tx(DEPT_CATEGORY_LABELS[selectedDept?.deptCategory ?? 0]) ?? $t('未知'), p1: deptAllowed
          .map((t) => $tx(WAREHOUSE_TYPE_LABELS[t]))
          .join('/') })
      : selectedDept
        ? $t('该部门类型不受建仓类型限制（MD-24）')
        : $t('选择部门后按其类型约束可选仓库类型（MD-24：物流部→仓库；车间→线边仓）')
  // MD-23：当前类型允许的料品类型
  const allowedMaterialTypes = ALLOWED_MATERIAL_TYPES_BY_WAREHOUSE_TYPE[form.warehouseType as 'WAREHOUSE' | 'LINE_SIDE']

  const toggleMaterialType = (t: number) => {
    setForm((f) => ({
      ...f,
      materialTypes: f.materialTypes.includes(t) ? f.materialTypes.filter((x) => x !== t) : [...f.materialTypes, t],
    }))
  }

  const changeType = (nextType: string) => {
    const allowed = ALLOWED_MATERIAL_TYPES_BY_WAREHOUSE_TYPE[nextType as 'WAREHOUSE' | 'LINE_SIDE']
    setForm((f) => ({ ...f, warehouseType: nextType, materialTypes: f.materialTypes.filter((t) => allowed.includes(t)) }))
  }

  const submit = async () => {
    const next: Record<string, string> = {}
    if (!editing) {
      if (!/^\d{4}$/.test(form.code)) next.code = $t('仓库编码必须为 4 位数字（MD-22）')
    }
    if (!form.name.trim()) next.name = $t('仓库名称必填（MD-22）')
    else if (form.name.length > 20) next.name = $t('仓库名称最长 20 字符（MD-22）')
    if (!form.deptId) next.deptId = $t('请选择建仓部门')
    if (deptAllowed !== undefined && !deptAllowed.includes(form.warehouseType as 'WAREHOUSE' | 'LINE_SIDE')) {
      next.warehouseType = $t('该部门类型仅允许{p0}（MD-24）', { p0: deptAllowed.map((t) => $tx(WAREHOUSE_TYPE_LABELS[t])).join('/') })
    }
    if (form.materialTypes.length === 0) next.materialTypes = $t('至少配置一种可收料品类型（MD-23）')
    else if (form.materialTypes.some((t) => !allowedMaterialTypes.includes(t))) {
      next.materialTypes = $t('料品类型不在{p0}允许范围内（MD-23）', { p0: $tx(WAREHOUSE_TYPE_LABELS[form.warehouseType]) })
    }
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (editing) {
        const r = await api.updateWarehouse(
          editing.id,
          {
            name: form.name.trim(),
            phone: form.phone.trim() || undefined,
            address: form.address.trim() || undefined,
          },
          { reason: `编辑仓库 ${editing.code} ${form.name.trim()}` },
        )
        onSaved($t('仓库「{p0}」已保存（operationId：{p1}…）', { p0: form.name.trim(), p1: r.operationId.slice(0, 8) }))
      } else {
        const r = await api.createWarehouse(
          {
            code: form.code,
            name: form.name.trim(),
            deptId: form.deptId,
            warehouseType: form.warehouseType as 'WAREHOUSE' | 'LINE_SIDE',
            materialTypes: [...form.materialTypes].sort((a, b) => a - b),
            phone: form.phone.trim() || undefined,
            address: form.address.trim() || undefined,
          },
          { reason: `新建仓库 ${form.code} ${form.name.trim()}` },
        )
        onSaved($t('仓库「{p0}」已建档（operationId：{p1}…）', { p0: form.name.trim(), p1: r.operationId.slice(0, 8) }))
      }
    } catch (err) {
      setSubmitError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('保存仓库失败') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title={editing ? $t('编辑仓库：{p0}', { p0: editing.name }) : $t('新建仓库')}
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
          <Field label={$t('仓库编码')} hint={$t('已有普通库位的仓库不可改编码（MD-25）；编码不在本表单修改')}>
            <Input value={editing.code} disabled />
          </Field>
        ) : (
          <Field label={$t('仓库编码')} required error={errors.code} hint={$t('4 位数字，同工厂内唯一（MD-22）')}>
            <Input
              value={form.code}
              invalid={Boolean(errors.code)}
              placeholder={$t('如 0104')}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            />
          </Field>
        )}
        <Field label={$t('仓库名称')} required error={errors.name} hint={$t('最长 20 字符，全局唯一（MD-22）')}>
          <Input value={form.name} invalid={Boolean(errors.name)} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label={$t('建仓部门')} required error={errors.deptId} hint={md24Hint}>
          <Select
            value={form.deptId}
            placeholder={$t('请选择部门')}
            options={deptOptions}
            invalid={Boolean(errors.deptId)}
            onChange={(e) => {
              const dept = nodes.find((n) => n.id === e.target.value)
              const allowed = deptAllowedWarehouseTypes(dept?.deptCategory)
              setForm((f) => ({
                ...f,
                deptId: e.target.value,
                // MD-24：部门类型变化后，若已选类型越限则自动收敛到允许值
                warehouseType:
                  allowed !== undefined && !allowed.includes(f.warehouseType as 'WAREHOUSE' | 'LINE_SIDE')
                    ? allowed[0]!
                    : f.warehouseType,
                materialTypes: f.materialTypes.filter((t) =>
                  ALLOWED_MATERIAL_TYPES_BY_WAREHOUSE_TYPE[
                    allowed !== undefined && !allowed.includes(f.warehouseType as 'WAREHOUSE' | 'LINE_SIDE')
                      ? (allowed[0] as 'WAREHOUSE' | 'LINE_SIDE')
                      : (f.warehouseType as 'WAREHOUSE' | 'LINE_SIDE')
                  ].includes(t),
                ),
              }))
            }}
          />
        </Field>
        <Field label={$t('仓库类型')} required error={errors.warehouseType} hint={md24Hint}>
          <Select
            value={form.warehouseType}
            options={[
              { value: 'WAREHOUSE', label: WAREHOUSE_TYPE_LABELS.WAREHOUSE, disabled: deptAllowed !== undefined && !deptAllowed.includes('WAREHOUSE') },
              { value: 'LINE_SIDE', label: WAREHOUSE_TYPE_LABELS.LINE_SIDE, disabled: deptAllowed !== undefined && !deptAllowed.includes('LINE_SIDE') },
            ]}
            onChange={(e) => changeType(e.target.value)}
          />
        </Field>
        <Field label={$t('可收料品类型')} required error={errors.materialTypes} hint={$t('MD-23：{p0}仅可收 {p1}；不允许的类型已禁选', { p0: WAREHOUSE_TYPE_LABELS[form.warehouseType], p1: allowedMaterialTypes.map((t) => MATERIAL_TYPE_LABELS[t]).join('/') })}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', paddingTop: 6 }}>
            {MATERIAL_TYPE_OPTIONS.map((t) => (
              <label key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={form.materialTypes.includes(t)}
                  disabled={!allowedMaterialTypes.includes(t)}
                  onChange={() => toggleMaterialType(t)}
                />
                {MATERIAL_TYPE_LABELS[t]}
              </label>
            ))}
          </div>
        </Field>
        <Field label={$t('联系电话')} hint={$t('选填')}>
          <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
        </Field>
        <Field label={$t('地址')} hint={$t('选填')}>
          <Input value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
        </Field>
      </Form>
    </Modal>
  )
}
