import {
  ApiError,
  Badge,
  Button,
  Field,
  Input,
  Message,
  PageContainer,
  ScanInput,
  Select,
  Table,
  formatErrorTitleAndDetail,
  type WarehouseMoveDto,
  t as $t,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { WAREHOUSING_POST, WAREHOUSING_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10

/** 移库目标库位（演示：同仓内库位可移；跨仓库位用于演示 [A-T13-4] 跨仓拒绝） */
const MOVE_TARGETS = [
  { value: 'loc-01010002', label: '01010002（原料一库·普通库位）' },
  { value: 'loc-r-010102', label: '010102（原料一库·货架库位）' },
  { value: 'loc-02010001', label: '02010001（拉丝线边仓·跨仓演示，将被拒绝）' },
]

/** 可移库演示单元（单元号 → unitId；实际以 /inventory/units 解析） */
const DEMO_UNITS: Array<{ value: string; label: string }> = [
  { value: 'u-0003', label: 'U-2026-1001-0003（拉制铜单丝，现库位 020101）' },
  { value: 'u-0001', label: 'U-2026-1001-0001（铜杆，现库位 01010001）' },
]

/**
 * 移库页（A-T13-4）：
 * - 移库执行：选单元 + 目标库位（同仓内库位移动；原/新库位逐码 append-only 记录）；
 * - 校验错误渲染：原/新库位相同、跨仓移动、托下单码禁扫（整托）等守卫文案原样呈现（PC-14）；
 * - 记录列表：append-only 历史（unitNoLike 过滤）。
 */
export function WarehousingMovesPage() {
  const { has } = usePermissions()
  const canRead = has(WAREHOUSING_READ)
  const canPost = has(WAREHOUSING_POST)
  const [items, setItems] = useState<WarehouseMoveDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [unitNoLike, setUnitNoLike] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 移库表单
  const [unitId, setUnitId] = useState('')
  const [toLocationId, setToLocationId] = useState(MOVE_TARGETS[0]!.value)
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (!canRead) return
    setLoading(true)
    api
      .listWarehouseMoves({ page, pageSize: PAGE_SIZE, unitNoLike: unitNoLike.trim() || undefined })
      .then((result) => {
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载移库记录失败') })
      })
      .finally(() => setLoading(false))
  }, [canRead, page, unitNoLike])

  useEffect(() => {
    load()
  }, [load])

  const executeMove = async () => {
    if (!unitId) {
      setError({ title: $t('请选择/解析库存单元') })
      return
    }
    const target = MOVE_TARGETS.find((t) => t.value === toLocationId)!
    setBusy(true)
    setError(null)
    try {
      const result = await api.executeWarehouseMove({
        plantId: 'n-plant',
        unitId,
        toLocationId,
        toLocationCode: target.label.slice(0, 8),
        quantity: quantity.trim() || undefined,
        reason: reason.trim() || undefined,
      })
      const data = (result.data ?? {}) as { unitNo?: string; fromLocationCode?: string | null; toLocationCode?: string | null }
      setNotice($t('移库完成：{p0} {p1} → {p2}', { p0: data.unitNo ?? '', p1: data.fromLocationCode ?? '', p2: data.toLocationCode ?? '' }))
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('移库失败') })
    } finally {
      setBusy(false)
    }
  }

  /** 扫单元号 → 经 /inventory/units 解析 unitId（先识别再按任务校验，PC-04 次序） */
  const resolveScannedUnit = async (code: string) => {
    setError(null)
    try {
      const detail = await api.unitDetail({ unitNo: code })
      setUnitId(detail.unitId)
      setNotice($t('已识别单元 {p0}（现库位 {p1}；状态 {p2}）', { p0: detail.unitNo, p1: detail.balances[0]?.locationCode ?? '—', p2: detail.status }))
    } catch {
      const preset = DEMO_UNITS.find((u) => u.label.startsWith(code))
      if (preset) {
        setUnitId(preset.value)
        setNotice($t('已选择演示单元 {p0}', { p0: code }))
      } else {
        setError({ title: $t('未识别的单元号：{p0}（上一码信息已清除，PC-05）', { p0: code }) })
        setUnitId('')
      }
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('移库')}>
        <Message kind="warning" title={$t('没有仓储查询许可（warehousing.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('移库')}
      description={$t('同仓内库位移动（A-T13-4）：原/新库位逐码 append-only 记录；原库位与新库位相同拒绝；跨仓请走调拨；托下单码禁扫（移库只可整托）')}
      actions={
        <Input
          style={{ width: 200 }}
          placeholder={$t('按单元号过滤记录（unitNoLike）')}
          value={unitNoLike}
          onChange={(e) => {
            setPage(1)
            setUnitNoLike(e.target.value)
          }}
        />
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <section style={{ border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 14, marginBottom: 16, background: 'var(--cz-color-bg-surface)' }}>
        <h3 style={{ fontSize: 15, margin: '0 0 10px' }}>
          {$t('移库执行')}{canPost ? null : <Badge tone="warning">{$t('需 warehousing.post 许可')}</Badge>}
        </h3>
        <ScanInput
          onScan={(code) => void resolveScannedUnit(code)}
          hint={$t('扫单元号解析库存单元（先识别再按任务校验）；或用下方下拉选择演示单元')}
        />
        <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label={$t('库存单元')} required>
            <Select
              style={{ width: 300 }}
              aria-label={$t('移库单元选择')}
              value={unitId}
              onChange={(e) => setUnitId(e.target.value)}
              placeholder={$t('选择演示单元')}
              options={DEMO_UNITS}
            />
          </Field>
          <Field label={$t('目标库位')} required hint={$t('仅同仓库位可选（跨仓走调拨）')}>
            <Select style={{ width: 230 }} aria-label={$t('移库目标库位选择')} value={toLocationId} onChange={(e) => setToLocationId(e.target.value)} options={MOVE_TARGETS} />
          </Field>
          <Field label={$t('数量')} hint={$t('缺省整单元')}>
            <Input style={{ width: 120 }} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder={$t('缺省整单元')} />
          </Field>
          <Field label={$t('原因')}>
            <Input style={{ width: 150 }} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button loading={busy} disabled={!canPost || !unitId} onClick={() => void executeMove()}>
            {$t('执行移库')}
          </Button>
        </div>
      </section>

      <Table<WarehouseMoveDto>
        loading={loading}
        columns={[
          { key: 'unitNo', title: $t('库存单元号') },
          { key: 'fromLocationCode', title: $t('原库位'), render: (row) => row.fromLocationCode ?? '—' },
          { key: 'toLocationCode', title: $t('新库位'), render: (row) => row.toLocationCode ?? '—' },
          {
            key: 'quantity',
            title: $t('数量'),
            render: (row) => (
              <span>
                {row.quantity} <b style={{ fontSize: 12 }}>{row.uomCode}</b>
              </span>
            ),
          },
          { key: 'movedBy', title: $t('操作人') },
          { key: 'movedAt', title: $t('时间') },
          { key: 'reason', title: $t('原因'), render: (row) => row.reason ?? '—' },
        ]}
        rows={items}
        rowKey={(row) => row.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无移库记录')}
      />
    </PageContainer>
  )
}
