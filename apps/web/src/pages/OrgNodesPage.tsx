import {
  ApiError,
  Badge,
  Button,
  ConfirmModal,
  Field,
  Form,
  Input,
  Message,
  ORG_NODE_KIND_LABELS,
  DEPT_CATEGORY_LABELS,
  PageContainer,
  Select,
  Tree,
  formatErrorTitleAndDetail,
  type CommandOk,
  type OrgNodeDto,
  type TreeNode,
  t as $t,
  tx as $tx,
} from '@cadenza/ui'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'

/** 组织节点类型四层模型（OA-08）+ enterprise 根；UI 提供建档入口的类型 */
type CreateKind = 'enterprise' | 'legal_entity' | 'plant' | 'department' | 'work_center'

/** OA-08 层级配对：每种节点的合法上级类型（与 domain ALLOWED_PARENT_KIND 同值，服务端终校） */
const ALLOWED_PARENT_KIND: Record<CreateKind, ReadonlyArray<CreateKind | null>> = {
  enterprise: [null],
  legal_entity: ['enterprise'],
  plant: ['legal_entity'],
  department: ['plant', 'department'],
  work_center: ['department'],
}

/**
 * 机构管理页（接真实 /org/nodes 分页 CRUD）：
 * - 机构树：kind/deptCategory 标签（真实字典）；名称/编码全局唯一（OA-01，服务端终校）；
 * - 新建/编辑经命令端点（POST/PATCH /org/nodes**），错误按服务端 message 渲染（[OA-xx]）；
 * - 退役（DELETE）高影响必填原因（OA-29，ConfirmModal 显式后果 PC-13）。
 */
export function OrgNodesPage() {
  const [nodes, setNodes] = useState<OrgNodeDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [savedHint, setSavedHint] = useState<string | null>(null)
  const [retiring, setRetiring] = useState<OrgNodeDto | null>(null)

  const reload = () => {
    let alive = true
    setLoading(true)
    api
      .listOrgNodes({ page: 1, pageSize: 100 })
      .then((result) => {
        if (!alive) return
        setNodes(result.items)
        setError(null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载机构失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }

  useEffect(reload, [])

  const treeData = useMemo<TreeNode[]>(() => buildTree(nodes), [nodes])
  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) ?? null, [nodes, selectedId])

  return (
    <PageContainer title={$t('机构管理')} description={$t('机构树与机构档案（字段口径：org-auth 冻结合同 OA-01～OA-09）')}>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {savedHint ? <Message kind="success" title={savedHint} /> : null}
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16, alignItems: 'start' }}>
        <section
          style={{
            background: 'var(--cz-color-bg-surface)',
            border: '1px solid var(--cz-color-border)',
            borderRadius: 8,
            padding: '12px 14px',
          }}
        >
          <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{$t('机构树')}</h3>
          {loading ? (
            <p style={{ fontSize: 13, color: 'var(--cz-color-text-secondary)' }}>{$t('加载中…')}</p>
          ) : (
            <Tree nodes={treeData} selectedId={selectedId} onSelect={setSelectedId} emptyText={$t('暂无机构')} />
          )}
        </section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <OrgNodeForm
            key={selected?.id ?? 'new'}
            node={selected}
            allNodes={nodes}
            onSaved={(msg) => {
              setSavedHint(msg)
              reload()
            }}
          />
          {selected ? (
            <section
              style={{
                background: 'var(--cz-color-bg-surface)',
                border: '1px solid var(--cz-color-border)',
                borderRadius: 8,
                padding: '12px 16px',
                maxWidth: 560,
              }}
            >
              <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{$t('危险操作')}</h3>
              <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>
                {$t('退役对本机构及全部下级做逻辑删除（OA-06）；挂有用户或被引用时服务端拒绝（OA-05/07）。')}
              </p>
              <Button variant="danger" size="sm" onClick={() => setRetiring(selected)}>
                {$t('退役该机构…')}
              </Button>
            </section>
          ) : null}
        </div>
      </div>
      <RetireNodeModal
        node={retiring}
        onClose={() => setRetiring(null)}
        onDone={(msg) => {
          setRetiring(null)
          setSelectedId(null)
          setSavedHint(msg)
          reload()
        }}
      />
    </PageContainer>
  )
}

function nodeTag(n: OrgNodeDto): string {
  const kindLabel = ORG_NODE_KIND_LABELS[n.kind] ?? n.kind
  return n.kind === 'department' && n.deptCategory != null
    ? `${kindLabel}·${DEPT_CATEGORY_LABELS[n.deptCategory] ?? n.deptCategory}`
    : kindLabel
}

function buildTree(nodes: OrgNodeDto[]): TreeNode[] {
  const byParent = new Map<string | null, OrgNodeDto[]>()
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? []
    list.push(n)
    byParent.set(n.parentId, list)
  }
  const toTreeNode = (n: OrgNodeDto): TreeNode => ({
    id: n.id,
    name: n.name,
    code: n.code,
    tag: nodeTag(n),
    children: (byParent.get(n.id) ?? []).map(toTreeNode),
  })
  return (byParent.get(null) ?? []).map(toTreeNode)
}

/** 提交载荷中的空串归一为 null（parentId 等可空字段） */
function orNull(v: string | number | null | undefined): string | number | null {
  if (v === undefined) return null
  if (typeof v === 'string' && v.trim() === '') return null
  return v
}

function OrgNodeForm({
  node,
  allNodes,
  onSaved,
}: {
  node: OrgNodeDto | null
  allNodes: OrgNodeDto[]
  onSaved: (msg: string) => void
}) {
  const [name, setName] = useState(node?.name ?? '')
  const [code, setCode] = useState(node?.code ?? '')
  const [kind, setKind] = useState<CreateKind>((node?.kind as CreateKind) ?? 'department')
  const [deptCategory, setDeptCategory] = useState<string>(node?.deptCategory != null ? String(node.deptCategory) : '')
  const [plantCode, setPlantCode] = useState(node?.plantCode ?? '')
  const [companyOrgCode, setCompanyOrgCode] = useState(node?.companyOrgCode ?? '')
  const [parentId, setParentId] = useState(node?.parentId ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<{ title: string; detail?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const allowedParents = ALLOWED_PARENT_KIND[kind]
  const parentOptions = allNodes
    // OA-02：上级不可选自身及其下级；OA-08：上级类型配对（服务端终校无环）
    .filter((n) => n.id !== node?.id)
    .filter((n) => allowedParents.includes(n.kind as CreateKind))
    .map((n) => ({ value: n.id, label: $t('{p0}（{p1}·{p2}）', { p0: n.name, p1: n.code, p2: ORG_NODE_KIND_LABELS[n.kind] ?? n.kind }) }))

  const submit = async () => {
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = $t('请输入机构名称')
    if (!node && !code.trim()) next.code = $t('请输入机构编码')
    if (kind === 'plant' && plantCode.trim().length === 0) next.plantCode = $t('工厂节点必填工厂编码（OA-04）')
    else if (kind === 'plant' && plantCode.trim().length > 10) next.plantCode = $t('工厂编码最长 10 字符（OA-04）')
    if (kind === 'department' && !deptCategory) next.deptCategory = $t('部门节点必填机构类型（OA-03）')
    setErrors(next)
    if (Object.keys(next).length > 0) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      let result: CommandOk
      if (node) {
        result = await api.updateOrgNode(node.id, {
          name: name.trim(),
          ...(parentId !== (node.parentId ?? '') ? { parentId: orNull(parentId) as string | null } : {}),
          plantCode: kind === 'plant' ? plantCode.trim() : (orNull(plantCode) as string | null),
          companyOrgCode: orNull(companyOrgCode) as string | null,
          deptCategory: kind === 'department' && deptCategory ? Number(deptCategory) : null,
        })
        onSaved($t('机构「{p0}」已保存（operationId：{p1}…）', { p0: name.trim(), p1: result.operationId.slice(0, 8) }))
      } else {
        result = await api.createOrgNode({
          code: code.trim(),
          name: name.trim(),
          kind,
          parentId: orNull(parentId) as string | null,
          plantCode: plantCode.trim() ? plantCode.trim() : null,
          companyOrgCode: companyOrgCode.trim() ? companyOrgCode.trim() : null,
          deptCategory: kind === 'department' && deptCategory ? Number(deptCategory) : null,
        })
        onSaved($t('新机构「{p0}」已建档（operationId：{p1}…）', { p0: name.trim(), p1: result.operationId.slice(0, 8) }))
        setName('')
        setCode('')
      }
    } catch (err) {
      // 服务端业务拒绝（如 [OA-01] 名称已存在）按 message 渲染（PC-14）
      setSubmitError(
        err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('保存机构失败') },
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section
      style={{
        background: 'var(--cz-color-bg-surface)',
        border: '1px solid var(--cz-color-border)',
        borderRadius: 8,
        padding: '16px 20px',
        maxWidth: 560,
      }}
    >
      <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>
        {node ? $t('编辑机构：{p0}', { p0: node.name }) : $t('新建机构')}
        {node ? (
          <span style={{ marginLeft: 8 }}>
            {node.status === 'active' ? <Badge tone="success">{$t('正常')}</Badge> : <Badge tone="danger">{$t('已退役')}</Badge>}
          </span>
        ) : null}
      </h3>
      <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>
        {$t('名称与编码全局唯一（OA-01，服务端终校）；层级配对（OA-08）；工厂编码 ≤10 字符（OA-04）。')}
      </p>
      {submitError ? <Message kind="error" title={submitError.title} detail={submitError.detail} /> : null}
      <Form>
        <Field label={$t('机构名称')} required error={errors.name}>
          <Input value={name} invalid={Boolean(errors.name)} onChange={(e) => setName(e.target.value)} />
        </Field>
        {node ? (
          <Field label={$t('机构编码')} hint={$t('编码创建后不可改')}>
            <Input value={node.code} disabled />
          </Field>
        ) : (
          <Field label={$t('机构编码')} required error={errors.code}>
            <Input value={code} invalid={Boolean(errors.code)} onChange={(e) => setCode(e.target.value)} />
          </Field>
        )}
        <Field label={$t('节点类型')} required hint={node ? $t('类型创建后不可改') : $t('四层组织模型（OA-08）')}>
          <Select
            value={kind}
            disabled={Boolean(node)}
            options={[
              { value: 'enterprise', label: $t('企业') },
              { value: 'legal_entity', label: $t('法人') },
              { value: 'plant', label: $t('工厂') },
              { value: 'department', label: $t('部门') },
              { value: 'work_center', label: $t('工作中心') },
            ]}
            onChange={(e) => {
              setKind(e.target.value as CreateKind)
              setParentId('')
            }}
          />
        </Field>
        {kind === 'department' ? (
          <Field label={$t('机构类型')} required error={errors.deptCategory} hint={$t('3 值字典（OA-03）：1=车间 2=质检部 3=物流部')}>
            <Select
              value={deptCategory}
              placeholder={$t('请选择机构类型')}
              options={[
                { value: '1', label: $t('车间') },
                { value: '2', label: $t('质检部') },
                { value: '3', label: $t('物流部') },
              ]}
              onChange={(e) => setDeptCategory(e.target.value)}
            />
          </Field>
        ) : null}
        <Field
          label={$t('工厂编码')}
          error={errors.plantCode}
          hint={kind === 'plant' ? $t('工厂节点必填，最长 10 字符（OA-04）') : $t('非工厂节点选填（OA-04）')}
        >
          <Input
            value={plantCode}
            invalid={Boolean(errors.plantCode)}
            maxLength={10}
            onChange={(e) => setPlantCode(e.target.value)}
          />
        </Field>
        <Field label={$t('公司组织编码')} hint={$t('选填（OA-04）')}>
          <Input value={companyOrgCode} onChange={(e) => setCompanyOrgCode(e.target.value)} />
        </Field>
        {node ? (
          <Field label={$t('上级机构')} hint={$t('调整上级须满足层级配对与无环（OA-02/08，服务端终校）')}>
            <Select
              value={parentId}
              placeholder={$t('（保持不变）')}
              options={parentOptions}
              onChange={(e) => setParentId(e.target.value)}
            />
          </Field>
        ) : (
          <Field
            label={$t('上级机构')}
            hint={$t('上级类型须为 {p0}（OA-08）', { p0: allowedParents.map((k) => (k === null ? $t('（无，根节点）') : $tx(ORG_NODE_KIND_LABELS[k]))).join(' / ') })}
          >
            <Select
              value={parentId}
              placeholder={kind === 'enterprise' ? $t('（无，作为企业根）') : $t('请选择上级')}
              options={parentOptions}
              onChange={(e) => setParentId(e.target.value)}
            />
          </Field>
        )}
        <Button onClick={() => void submit()} loading={submitting}>
          {node ? $t('保存修改') : $t('建档')}
        </Button>
      </Form>
    </section>
  )
}

function RetireNodeModal({
  node,
  onClose,
  onDone,
}: {
  node: OrgNodeDto | null
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const confirm = async () => {
    if (!node) return
    if (!reason.trim()) {
      setError($t('退役为高影响操作，必须填写原因（OA-29）'))
      return
    }
    setSubmitting(true)
    try {
      await api.retireOrgNode(node.id, { reason: reason.trim() })
      setReason('')
      setError(null)
      onDone($t('机构「{p0}」及其下级已退役（逻辑删除，OA-06）', { p0: node.name }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : $t('退役失败，请稍后重试'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ConfirmModal
      open={node !== null}
      tone="danger"
      title={$t('退役机构「{p0}」', { p0: node?.name ?? '' })}
      description={
        <div>
          <p style={{ margin: '4px 0' }}>
            {$t('将对本机构及全部下级做逻辑删除（OA-06）；本机构或下级仍挂有用户、被工作中心/仓库/设备引用时将被服务端拒绝（OA-05/07）。')}
          </p>
          <Field label={$t('操作原因')} required error={error ?? undefined} hint={$t('高影响操作必填（OA-29），写入审计')}>
            <Input
              value={reason}
              invalid={Boolean(error)}
              placeholder={$t('例如：组织架构调整')}
              onChange={(e) => {
                setReason(e.target.value)
                setError(null)
              }}
            />
          </Field>
        </div>
      }
      confirmText={$t('确认退役')}
      confirmLoading={submitting}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    />
  )
}
