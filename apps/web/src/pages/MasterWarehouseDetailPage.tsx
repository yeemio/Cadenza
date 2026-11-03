import {
  ApiError,
  Badge,
  Button,
  ConfirmModal,
  Field,
  Form,
  Input,
  LOCATION_KIND_LABELS,
  MATERIAL_TYPE_LABELS,
  Message,
  Modal,
  PageContainer,
  Table,
  WAREHOUSE_TYPE_LABELS,
  formatErrorTitleAndDetail,
  type RackDto,
  type StorageLocationDto,
  type WarehouseDto,
  t as $t,
} from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { MASTERDATA_ADMIN, MASTERDATA_READ, usePermissions } from '../permissions'

/**
 * 仓库详情页（仓库管理下钻）：仓库信息摘要 + 普通库位（MD-28/29）与货架（MD-30/31/33）两张分页表。
 * - 新建普通库位：8 位编码前缀校验（前端即时提示，服务端终校 MD-28）；
 * - 新建货架：2 位编号 + 区域数/层数 1–99（MD-30/31），按「区域×层」自动生成货架库位；
 * - 行退役：ConfirmModal 显式后果（货架退役级联失效其下货架库位，MD-33）。
 */
export function MasterWarehouseDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { has } = usePermissions()
  const canRead = has(MASTERDATA_READ)
  const canAdmin = has(MASTERDATA_ADMIN)
  const [warehouse, setWarehouse] = useState<WarehouseDto | null>(null)
  const [locations, setLocations] = useState<StorageLocationDto[]>([])
  const [locationTotal, setLocationTotal] = useState(0)
  const [locationPage, setLocationPage] = useState(1)
  const [racks, setRacks] = useState<RackDto[]>([])
  const [rackTotal, setRackTotal] = useState(0)
  const [rackPage, setRackPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [creatingLocation, setCreatingLocation] = useState(false)
  const [creatingRack, setCreatingRack] = useState(false)
  const [deletingLocation, setDeletingLocation] = useState<StorageLocationDto | null>(null)
  const [deletingRack, setDeletingRack] = useState<RackDto | null>(null)
  const [reloadFlag, setReloadFlag] = useState(0)

  useEffect(() => {
    if (!canRead || !id) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void api
      .listWarehouses({ page: 1, pageSize: 100 })
      .then((r) => {
        if (!alive) return
        setWarehouse(r.items.find((w) => w.id === id) ?? null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载仓库失败') })
      })
    void api
      .listLocations({ page: locationPage, pageSize: 10, warehouseId: id })
      .then((r) => {
        if (!alive) return
        setLocations(r.items)
        setLocationTotal(r.total)
      })
      .catch(() => {
        if (alive) setLocations([])
      })
    void api
      .listRacks({ page: rackPage, pageSize: 10, warehouseId: id })
      .then((r) => {
        if (!alive) return
        setRacks(r.items)
        setRackTotal(r.total)
      })
      .catch(() => {
        if (alive) setRacks([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [id, locationPage, rackPage, reloadFlag, canRead])

  const refresh = () => setReloadFlag((f) => f + 1)

  if (!canRead) {
    return (
      <PageContainer title={$t('仓库详情')} description={$t('仓库下库位与货架管理')}>
        <Message kind="warning" title={$t('没有主数据查询许可（masterdata.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('仓库详情')}
      description={warehouse ? $t('{p0}（{p1}）', { p0: warehouse.name, p1: warehouse.code }) : $t('库位与货架下钻（MD-28～MD-33）')}
      actions={
        <>
          <Link to="/masterdata/warehouses" style={{ alignSelf: 'center', fontSize: 13 }}>
            {$t('返回仓库列表')}
          </Link>
          {canAdmin && warehouse !== null ? (
            <>
              <Button variant="secondary" onClick={() => setCreatingLocation(true)}>
                {$t('新建普通库位')}
              </Button>
              <Button onClick={() => setCreatingRack(true)}>{$t('新建货架')}</Button>
            </>
          ) : null}
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {hint ? <Message kind="success" title={hint} /> : null}
      {warehouse ? (
        <div
          style={{
            display: 'flex',
            gap: 18,
            flexWrap: 'wrap',
            border: '1px solid var(--cz-color-border)',
            borderRadius: 8,
            padding: '10px 14px',
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <span>
            {$t('仓库类型：')}<b>{WAREHOUSE_TYPE_LABELS[warehouse.warehouseType] ?? warehouse.warehouseType}</b>
          </span>
          <span>
            {$t('可收料品类型：')}<b>{warehouse.materialTypes.map((t) => MATERIAL_TYPE_LABELS[t] ?? t).join(' / ')}</b>
          </span>
          <span>
            {$t('二维码：')}
            {warehouse.qrBound ? <Badge tone="warning">{$t('已占用（类型/料品类型不可改，MD-26）')}</Badge> : <Badge tone="default">{$t('未占用')}</Badge>}
          </span>
          {warehouse.phone ? <span>{$t('电话：')}{warehouse.phone}</span> : null}
          {warehouse.address ? <span>{$t('地址：')}{warehouse.address}</span> : null}
        </div>
      ) : loading ? (
        <p style={{ color: 'var(--cz-color-text-secondary)' }}>{$t('加载中…')}</p>
      ) : (
        <Message kind="warning" title={$t('仓库不存在或不在此数据范围内')} />
      )}
      <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('普通库位（MD-28：编码＝仓库码 4 位＋库位码 4 位）')}</h3>
      <Table<StorageLocationDto>
        loading={loading}
        columns={[
          { key: 'code', title: $t('库位编码') },
          { key: 'locationKind', title: $t('类型'), render: (l) => LOCATION_KIND_LABELS[l.locationKind] ?? l.locationKind },
          { key: 'zoneCode', title: $t('区域码'), render: (l) => l.zoneCode ?? '—' },
          { key: 'remark', title: $t('备注'), render: (l) => l.remark ?? '—' },
          {
            key: 'qrBound',
            title: $t('二维码'),
            render: (l) => (l.qrBound ? <Badge tone="warning">{$t('已占用')}</Badge> : <Badge tone="default">{$t('未占用')}</Badge>),
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (l) =>
              canAdmin ? (
                <Button size="sm" variant="danger" disabled={l.qrBound} onClick={() => setDeletingLocation(l)}>
                  {$t('退役')}
                </Button>
              ) : null,
          },
        ]}
        rows={locations}
        rowKey={(l) => l.id}
        page={{ page: locationPage, pageSize: 10 }}
        total={locationTotal}
        onPageChange={(p) => setLocationPage(Math.max(1, p))}
        emptyText={$t('暂无库位')}
      />
      <h3 style={{ fontSize: 15, margin: '18px 0 8px' }}>{$t('货架（MD-30/31：编号 2 位数字；库位按区域×层自动生成）')}</h3>
      <Table<RackDto>
        loading={loading}
        columns={[
          { key: 'code', title: $t('货架编号') },
          { key: 'zones', title: $t('区域数') },
          { key: 'layers', title: $t('层数') },
          { key: 'remark', title: $t('备注'), render: (r) => r.remark ?? '—' },
          {
            key: 'actions',
            title: $t('操作'),
            render: (r) =>
              canAdmin ? (
                <Button size="sm" variant="danger" onClick={() => setDeletingRack(r)}>
                  {$t('退役')}
                </Button>
              ) : null,
          },
        ]}
        rows={racks}
        rowKey={(r) => r.id}
        page={{ page: rackPage, pageSize: 10 }}
        total={rackTotal}
        onPageChange={(p) => setRackPage(Math.max(1, p))}
        emptyText={$t('暂无货架')}
      />
      {warehouse !== null ? (
        <>
          <LocationCreateModal
            open={creatingLocation}
            warehouse={warehouse}
            onClose={() => setCreatingLocation(false)}
            onSaved={(msg) => {
              setCreatingLocation(false)
              setHint(msg)
              refresh()
            }}
          />
          <RackCreateModal
            open={creatingRack}
            warehouse={warehouse}
            onClose={() => setCreatingRack(false)}
            onSaved={(msg) => {
              setCreatingRack(false)
              setHint(msg)
              refresh()
            }}
          />
        </>
      ) : null}
      <ConfirmModal
        open={deletingLocation !== null}
        tone="danger"
        title={$t('退役库位「{p0}」', { p0: deletingLocation?.code ?? '' })}
        description={$t('退役为逻辑失效；被二维码占用或存在库存引用时服务端拒绝（MD-29/MD-37）。')}
        confirmText={$t('确认退役')}
        onConfirm={() => {
          const l = deletingLocation
          if (!l) return
          void api
            .retireLocation(l.id, { reason: `管理员退役库位 ${l.code}` })
            .then((r) => {
              setDeletingLocation(null)
              setHint($t('库位「{p0}」已退役（operationId：{p1}…）', { p0: l.code, p1: r.operationId.slice(0, 8) }))
              refresh()
            })
            .catch((err) => {
              setDeletingLocation(null)
              setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('退役库位失败') })
            })
        }}
        onCancel={() => setDeletingLocation(null)}
      />
      <ConfirmModal
        open={deletingRack !== null}
        tone="danger"
        title={$t('退役货架「{p0}」', { p0: deletingRack?.code ?? '' })}
        description={$t('货架退役将级联失效其下全部货架库位（MD-33）；存在被二维码占用库位或库存引用时服务端拒绝。')}
        confirmText={$t('确认退役')}
        onConfirm={() => {
          const r0 = deletingRack
          if (!r0) return
          void api
            .retireRack(r0.id, { reason: `管理员退役货架 ${r0.code}` })
            .then((r) => {
              const data = r.data as { affectedLocations?: number } | null
              setDeletingRack(null)
              setHint(
                typeof data?.affectedLocations === 'number'
                  ? $t('货架「{p0}」已退役，级联失效库位 {p1} 个（operationId：{p2}…）', { p0: r0.code, p1: data.affectedLocations, p2: r.operationId.slice(0, 8) })
                  : $t('货架「{p0}」已退役（operationId：{p1}…）', { p0: r0.code, p1: r.operationId.slice(0, 8) }),
              )
              refresh()
            })
            .catch((err) => {
              setDeletingRack(null)
              setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('退役货架失败') })
            })
        }}
        onCancel={() => setDeletingRack(null)}
      />
    </PageContainer>
  )
}

function LocationCreateModal({
  open,
  warehouse,
  onClose,
  onSaved,
}: {
  open: boolean
  warehouse: WarehouseDto
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [seq, setSeq] = useState('')
  const [remark, setRemark] = useState('')
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setSeq('')
    setRemark('')
    setError(null)
  }, [open])

  const submit = async () => {
    if (!/^\d{4}$/.test(seq)) {
      setError({ title: $t('库位码须为 4 位数字（完整编码＝{p0}{p1}，MD-28）', { p0: warehouse.code, p1: seq || 'XXXX' }) })
      return
    }
    const code = `${warehouse.code}${seq}`
    setSubmitting(true)
    setError(null)
    try {
      const r = await api.createLocation(
        { warehouseId: warehouse.id, code, remark: remark.trim() || undefined },
        { reason: `在仓库 ${warehouse.code} 新建库位 ${code}` },
      )
      onSaved($t('库位「{p0}」已建档（operationId：{p1}…）', { p0: code, p1: r.operationId.slice(0, 8) }))
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('新建库位失败') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title={$t('新建普通库位：{p0}（{p1}）', { p0: warehouse.name, p1: warehouse.code })}
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
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      <Form>
        <Field label={$t('库位码（后 4 位）')} required hint={$t('完整编码自动拼接为 8 位：{p0}＋库位码（MD-28，服务端终校同工厂唯一）', { p0: warehouse.code })}>
          <Input
            value={seq}
            placeholder={$t('如 0003')}
            maxLength={4}
            onChange={(e) => setSeq(e.target.value)}
          />
        </Field>
        <Field label={$t('备注')} hint={$t('选填')}>
          <Input value={remark} onChange={(e) => setRemark(e.target.value)} />
        </Field>
      </Form>
    </Modal>
  )
}

function RackCreateModal({
  open,
  warehouse,
  onClose,
  onSaved,
}: {
  open: boolean
  warehouse: WarehouseDto
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [form, setForm] = useState({ code: '', zones: '2', layers: '3', remark: '' })
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm({ code: '', zones: '2', layers: '3', remark: '' })
    setError(null)
  }, [open])

  const submit = async () => {
    if (!/^\d{2}$/.test(form.code)) {
      setError({ title: $t('货架编号必须为 2 位数字（MD-30，同工厂内唯一）') })
      return
    }
    const zones = Number(form.zones)
    const layers = Number(form.layers)
    if (!Number.isInteger(zones) || zones < 1 || zones > 99 || !Number.isInteger(layers) || layers < 1 || layers > 99) {
      setError({ title: $t('区域数量与货架层数必须为 1–99 的整数（MD-31）') })
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const r = await api.createRack(
        {
          warehouseId: warehouse.id,
          code: form.code,
          zones,
          layers,
          remark: form.remark.trim() || undefined,
        },
        { reason: `在仓库 ${warehouse.code} 新建货架 ${form.code}` },
      )
      const data = r.data as { generatedLocations?: number } | null
      onSaved(
        typeof data?.generatedLocations === 'number'
          ? $t('货架「{p0}」已建档，自动生成货架库位 {p1} 个（MD-31；operationId：{p2}…）', { p0: form.code, p1: data.generatedLocations, p2: r.operationId.slice(0, 8) })
          : $t('货架「{p0}」已建档（operationId：{p1}…）', { p0: form.code, p1: r.operationId.slice(0, 8) }),
      )
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('新建货架失败') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title={$t('新建货架：{p0}（{p1}）', { p0: warehouse.name, p1: warehouse.code })}
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
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      <Form>
        <Field label={$t('货架编号')} required hint={$t('2 位数字，同工厂内唯一（MD-30）；层数与区域数创建后不可改（MD-31）')}>
          <Input value={form.code} placeholder={$t('如 03')} maxLength={2} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
        </Field>
        <Field label={$t('区域数')} required hint={$t('1–99（MD-31）；保存后按「区域×层」自动生成货架库位')}>
          <Input
            type="number"
            min={1}
            max={99}
            value={form.zones}
            onChange={(e) => setForm((f) => ({ ...f, zones: e.target.value }))}
          />
        </Field>
        <Field label={$t('货架层数')} required hint={$t('1–99（MD-31）')}>
          <Input
            type="number"
            min={1}
            max={99}
            value={form.layers}
            onChange={(e) => setForm((f) => ({ ...f, layers: e.target.value }))}
          />
        </Field>
        <Field label={$t('备注')} hint={$t('选填')}>
          <Input value={form.remark} onChange={(e) => setForm((f) => ({ ...f, remark: e.target.value }))} />
        </Field>
      </Form>
    </Modal>
  )
}
