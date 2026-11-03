import {
  ApiError,
  Badge,
  Button,
  Field,
  Form,
  Input,
  MATERIAL_TYPE_LABELS,
  MASTERDATA_STATUS_LABELS,
  Message,
  Modal,
  PageContainer,
  Table,
  formatErrorTitleAndDetail,
  type ConversionLineDto,
  type MaterialDto,
  t as $t,
} from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { MASTERDATA_ADMIN, MASTERDATA_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10

/**
 * 料品管理页（MD-01/02：料品主档由 U9/ERP 同步，本系统只读，无新增/删除入口）：
 * - 列表只读 + 名称/编码过滤（服务端参数 nameLike/codeLike，企业级数据范围）；
 * - 换算行（MD-04/05）为本系统唯一可编辑部分：行内「换算行」展开查看，
 *   编辑/新版本/删除入口仅 masterdata.admin 显示（PC-10；服务端终校）；
 * - referenced=true 的换算行禁改禁删（MD-05 前端置灰 + 服务端拒绝兜底）。
 */
export function MasterMaterialsPage() {
  const { has } = usePermissions()
  const canRead = has(MASTERDATA_READ)
  const canAdmin = has(MASTERDATA_ADMIN)
  const [items, setItems] = useState<MaterialDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [nameLike, setNameLike] = useState('')
  const [codeLike, setCodeLike] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [conversionsOf, setConversionsOf] = useState<MaterialDto | null>(null)
  const [reloadFlag, setReloadFlag] = useState(0)

  useEffect(() => {
    if (!canRead) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    api
      .listMaterials({
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
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载料品失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, nameLike, codeLike, reloadFlag, canRead])

  if (!canRead) {
    return (
      <PageContainer title={$t('料品管理')} description={$t('料品主数据由 U9/ERP 同步维护（MD-01），本系统只读')}>
        <Message kind="warning" title={$t('没有主数据查询许可（masterdata.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 masterdata.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('料品管理')}
      description={$t('料品主档只读（U9 同步，MD-01/02）；换算行为本系统唯一可编辑部分（MD-04/05，需 masterdata.admin）')}
      actions={
        <>
          <Input
            style={{ width: 170 }}
            placeholder={$t('按名称搜索（nameLike）')}
            value={nameLike}
            onChange={(e) => {
              setPage(1)
              setNameLike(e.target.value)
            }}
          />
          <Input
            style={{ width: 170 }}
            placeholder={$t('按编码搜索（codeLike）')}
            value={codeLike}
            onChange={(e) => {
              setPage(1)
              setCodeLike(e.target.value)
            }}
          />
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {hint ? <Message kind="success" title={hint} /> : null}
      <Table<MaterialDto>
        loading={loading}
        columns={[
          { key: 'code', title: $t('料品编码') },
          { key: 'name', title: $t('料品名称') },
          { key: 'materialType', title: $t('料品类型'), render: (m) => MATERIAL_TYPE_LABELS[m.materialType] ?? m.materialType },
          { key: 'materialGroupName', title: $t('料品组'), render: (m) => m.materialGroupName ?? '—' },
          { key: 'spec', title: $t('规格'), render: (m) => m.spec ?? '—' },
          { key: 'baseUom', title: $t('主计量单位') },
          {
            key: 'qcFlag',
            title: $t('是否质检'),
            render: (m) => (m.qcFlag === 1 ? <Badge tone="info">{$t('质检')}</Badge> : <Badge>{$t('免检')}</Badge>),
          },
          {
            key: 'status',
            title: $t('状态'),
            render: (m) =>
              m.status === 'active' ? (
                <Badge tone="success">{MASTERDATA_STATUS_LABELS[m.status]}</Badge>
              ) : (
                <Badge tone="default">{MASTERDATA_STATUS_LABELS[m.status]}</Badge>
              ),
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (m) => (
              <Button size="sm" variant="secondary" onClick={() => setConversionsOf(m)}>
                {$t('换算行')}
              </Button>
            ),
          },
        ]}
        rows={items}
        rowKey={(m) => m.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无料品（料品由 U9/ERP 同步写入）')}
      />
      <ConversionsModal
        material={conversionsOf}
        canAdmin={canAdmin}
        onClose={() => setConversionsOf(null)}
        onChanged={(msg) => {
          setHint(msg)
          setReloadFlag((f) => f + 1)
        }}
      />
    </PageContainer>
  )
}

/** 换算行弹窗：版本化列表（MD-05：referenced 行不可改删；新版本为推荐变更方式） */
function ConversionsModal({
  material,
  canAdmin,
  onClose,
  onChanged,
}: {
  material: MaterialDto | null
  canAdmin: boolean
  onClose: () => void
  onChanged: (msg: string) => void
}) {
  const [items, setItems] = useState<ConversionLineDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [editing, setEditing] = useState<ConversionLineDto | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ unitName: '', factor: '' })
  const [formError, setFormError] = useState<{ title: string; detail?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const load = (id: string) => {
    setLoading(true)
    api
      .listConversions(id)
      .then((r) => {
        setItems(r.items)
        setError(null)
      })
      .catch((err) => setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载换算行失败') }))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (material === null) return
    setEditing(null)
    setCreating(false)
    setFormError(null)
    load(material.id)
  }, [material])

  const openCreate = () => {
    setCreating(true)
    setEditing(null)
    setForm({ unitName: '', factor: '' })
    setFormError(null)
  }

  const openEdit = (line: ConversionLineDto) => {
    setEditing(line)
    setCreating(false)
    setForm({ unitName: line.unitName, factor: line.factor })
    setFormError(null)
  }

  const submit = async () => {
    if (!material) return
    if (!form.unitName.trim()) {
      setFormError({ title: $t('换算单位名必填且最长 100 字符（MD-04）') })
      return
    }
    if (!/^\d+(\.\d+)?$/.test(form.factor.trim())) {
      setFormError({ title: $t('换算数量须为非负数字（整数≤9 位、小数≤4 位，MD-04）') })
      return
    }
    setSubmitting(true)
    setFormError(null)
    try {
      if (creating) {
        const r = await api.createConversion(
          { materialId: material.id, unitName: form.unitName.trim(), factor: form.factor.trim() },
          { reason: `维护料品 ${material.code} 换算行` },
        )
        onChanged($t('换算行已新增（operationId：{p0}…）', { p0: r.operationId.slice(0, 8) }))
      } else if (editing) {
        const r = await api.updateConversion(
          editing.id,
          { unitName: form.unitName.trim(), factor: form.factor.trim() },
          { reason: `修改料品 ${material.code} 换算行 v${editing.version}` },
        )
        onChanged($t('换算行 v{p0} 已保存（operationId：{p1}…）', { p0: editing.version, p1: r.operationId.slice(0, 8) }))
      }
      setCreating(false)
      setEditing(null)
      load(material.id)
    } catch (err) {
      setFormError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('保存换算行失败') })
    } finally {
      setSubmitting(false)
    }
  }

  const newVersion = async (line: ConversionLineDto) => {
    if (!material) return
    const factor = window.prompt($t('基于 v{p0}（{p1}＝{p2}）生成新版本的换算数量：', { p0: line.version, p1: line.unitName, p2: line.factor }), line.factor)
    if (factor === null) return
    if (!/^\d+(\.\d+)?$/.test(factor.trim())) {
      setError({ title: $t('换算数量须为非负数字（整数≤9 位、小数≤4 位，MD-04）') })
      return
    }
    try {
      const r = await api.newConversionVersion(line.id, { factor: factor.trim() }, { reason: `料品 ${material.code} 换算行升版` })
      onChanged($t('已生成新版本（operationId：{p0}…）', { p0: r.operationId.slice(0, 8) }))
      load(material.id)
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('生成新版本失败') })
    }
  }

  const retire = async (line: ConversionLineDto) => {
    if (!material) return
    if (!window.confirm($t('确认删除换算行 v{p0}（{p1}＝{p2}）？删除为逻辑失效。', { p0: line.version, p1: line.unitName, p2: line.factor }))) return
    try {
      const r = await api.retireConversion(line.id, { reason: `删除料品 ${material.code} 换算行 v${line.version}` })
      onChanged($t('换算行 v{p0} 已删除（operationId：{p1}…）', { p0: line.version, p1: r.operationId.slice(0, 8) }))
      load(material.id)
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('删除换算行失败') })
    }
  }

  return (
    <Modal
      open={material !== null}
      size="lg"
      title={material ? $t('换算行：{p0}（{p1}）', { p0: material.name, p1: material.code }) : $t('换算行')}
      onClose={onClose}
      footer={
        canAdmin && material !== null && !creating && editing === null ? (
          <Button onClick={openCreate}>{$t('新增换算行')}</Button>
        ) : null
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {creating || editing !== null ? (
        <div style={{ marginBottom: 12, border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 12 }}>
          {formError ? <Message kind="error" title={formError.title} detail={formError.detail} /> : null}
          <Form>
            <Field label={$t('换算单位名')} required hint={$t('如：卷/捆/轴/盘（MD-06：1 个新单位 = N 个主单位）')}>
              <Input value={form.unitName} onChange={(e) => setForm((f) => ({ ...f, unitName: e.target.value }))} />
            </Field>
            <Field label={$t('换算数量（1 个换算单位 = N {p0}）', { p0: material?.baseUom ?? '' })} required hint={$t('非负数字：整数≤9 位、小数≤4 位（MD-04）')}>
              <Input value={form.factor} onChange={(e) => setForm((f) => ({ ...f, factor: e.target.value }))} />
            </Field>
          </Form>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button onClick={() => void submit()} loading={submitting}>
              {$t('保存')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setCreating(false)
                setEditing(null)
                setFormError(null)
              }}
            >
              {$t('取消')}
            </Button>
          </div>
        </div>
      ) : null}
      <Table<ConversionLineDto>
        loading={loading}
        columns={[
          { key: 'version', title: $t('版本') },
          { key: 'unitName', title: $t('换算单位') },
          { key: 'factor', title: $t('数量（1 单位＝N {p0}）', { p0: material?.baseUom ?? '' }) },
          {
            key: 'referenced',
            title: $t('采购收货引用'),
            render: (c) =>
              c.referenced ? <Badge tone="warning">{$t('已被引用')}</Badge> : <Badge tone="default">{$t('未引用')}</Badge>,
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (c) =>
              canAdmin ? (
                <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                  <Button size="sm" variant="secondary" disabled={c.referenced} onClick={() => openEdit(c)}>
                    {$t('修改')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void newVersion(c)}>
                    {$t('生成新版本')}
                  </Button>
                  <Button size="sm" variant="danger" disabled={c.referenced} onClick={() => void retire(c)}>
                    {$t('删除')}
                  </Button>
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>{$t('只读（需 masterdata.admin）')}</span>
              ),
          },
        ]}
        rows={items}
        rowKey={(c) => c.id}
        emptyText={$t('暂无换算行')}
      />
      <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>
        {$t('MD-05：已被采购收货引用的换算行不可修改/删除（按钮置灰，服务端同口径拒绝）；变更请「生成新版本」。')}
      </p>
    </Modal>
  )
}
