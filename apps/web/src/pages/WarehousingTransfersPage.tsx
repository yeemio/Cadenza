import {
  ApiError,
  Badge,
  Button,
  Field,
  Input,
  Message,
  Modal,
  PageContainer,
  Select,
  TRANSFER_KIND_LABELS,
  TRANSFER_STATUS_LABELS,
  TRANSFER_STATUS_STEPS,
  formatErrorTitleAndDetail,
  type TransferDetailDto,
  type TransferOrderDto,
  t as $t,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { WAREHOUSING_POST, WAREHOUSING_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10

/** 状态机步骤下标（cancelled 独立分支不进步骤条） */
function stepIndexOf(status: string): number {
  const index = TRANSFER_STATUS_STEPS.indexOf(status as (typeof TRANSFER_STATUS_STEPS)[number])
  return index
}

/**
 * 调拨页（A-T13-10 状态机 + 三段操作）：
 * - 状态机可视化：草稿→待执行→出库中→已出库在途→收货中→完成 步骤条（当前步高亮）；
 * - 三段操作：出库（单行原子，来源减+在途增）/ 在途（状态推进+对账断言）/ 接收（单行原子，
 *   在途减+目的增；全部行收完→完成）；行级两段事实 out/in 展示；
 * - 提交（草稿→待执行）须锁定有效期（A-T13-11/IT-23）；创建调拨（A-T13-6/7 守卫）。
 */
export function WarehousingTransfersPage() {
  const { has } = usePermissions()
  const canRead = has(WAREHOUSING_READ)
  const canPost = has(WAREHOUSING_POST)
  const [items, setItems] = useState<TransferOrderDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statuses, setStatuses] = useState('')
  const [orderNoLike, setOrderNoLike] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 详情
  const [detail, setDetail] = useState<TransferDetailDto | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  // 提交/创建
  const [submitOpen, setSubmitOpen] = useState(false)
  const [lockValidUntil, setLockValidUntil] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState({ fromWarehouseId: 'wh-0101', toWarehouseId: 'wh-0103', unitNo: 'U-2026-1001-0001', quantity: '400.0000' })

  const load = useCallback(() => {
    if (!canRead) return
    setLoading(true)
    api
      .listTransfers({
        page,
        pageSize: PAGE_SIZE,
        statuses: statuses || undefined,
        orderNoLike: orderNoLike.trim() || undefined,
      })
      .then((result) => {
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载调拨单失败') })
      })
      .finally(() => setLoading(false))
  }, [canRead, page, statuses, orderNoLike])

  useEffect(() => {
    load()
  }, [load])

  const openDetail = async (id: string) => {
    setDetailBusy(true)
    try {
      const view = await api.transferDetail(id)
      setDetail(view)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载调拨详情失败') })
    } finally {
      setDetailBusy(false)
    }
  }

  const runAction = async (action: () => Promise<{ data?: unknown }>, successText: string) => {
    setActionBusy(true)
    setError(null)
    try {
      await action()
      setNotice(successText)
      if (detail) await openDetail(detail.id)
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('操作失败') })
    } finally {
      setActionBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('调拨')}>
        <Message kind="warning" title={$t('没有仓储查询许可（warehousing.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('调拨')}
      description={$t('状态机（A-T13-10）：草稿→待执行→出库中→已出库在途→收货中→完成；出库/接收按行两段原子（IT-25），在途段推进状态并对账（在途两仓不重复统计）')}
      actions={
        <>
          <Input
            style={{ width: 190 }}
            placeholder={$t('按调拨单号搜索（orderNoLike）')}
            value={orderNoLike}
            onChange={(e) => {
              setPage(1)
              setOrderNoLike(e.target.value)
            }}
          />
          <Select
            style={{ width: 130 }}
            placeholder={$t('全部状态')}
            value={statuses}
            onChange={(e) => {
              setPage(1)
              setStatuses(e.target.value)
            }}
            options={Object.entries(TRANSFER_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
          />
          {canPost ? (
            <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
              {$t('新建调拨')}
            </Button>
          ) : null}
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <table className="cz-table" style={{ width: '100%' }} aria-label={$t('调拨列表')}>
        <thead>
          <tr>
            <th>{$t('调拨单号')}</th>
            <th>{$t('种类')}</th>
            <th>{$t('调出仓 → 调入仓')}</th>
            <th>{$t('状态机')}</th>
            <th>{$t('锁定有效期')}</th>
            <th>{$t('操作')}</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td className="cz-table__empty" colSpan={6}>{$t('加载中…')}</td>
            </tr>
          ) : items.length === 0 ? (
            <tr>
              <td className="cz-table__empty" colSpan={6}>{$t('暂无调拨单')}</td>
            </tr>
          ) : (
            items.map((row) => {
              const current = stepIndexOf(row.status)
              return (
                <tr key={row.id}>
                  <td>
                    <b>{row.orderNo}</b>
                  </td>
                  <td>{TRANSFER_KIND_LABELS[row.transferKind] ?? row.transferKind}</td>
                  <td>
                    {row.fromWarehouseCode ?? row.fromWarehouseId} → {row.toWarehouseCode ?? row.toWarehouseId}
                  </td>
                  <td>
                    <div aria-label={$t('状态机：{p0}', { p0: row.statusLabel })} style={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                      {TRANSFER_STATUS_STEPS.map((step, i) => (
                        <span
                          key={step}
                          title={TRANSFER_STATUS_LABELS[step]}
                          style={{
                            width: 22,
                            height: 8,
                            borderRadius: 4,
                            background:
                              row.status === 'cancelled'
                                ? 'var(--cz-color-border)'
                                : i <= current
                                  ? 'var(--cz-color-primary)'
                                  : 'var(--cz-color-border)',
                          }}
                        />
                      ))}
                      <Badge tone={row.status === 'completed' ? 'success' : row.status === 'cancelled' ? 'danger' : 'info'}>{row.statusLabel}</Badge>
                    </div>
                  </td>
                  <td>{row.lockedValidUntil?.slice(0, 10) ?? '—'}</td>
                  <td>
                    <Button size="sm" variant="secondary" loading={detailBusy} onClick={() => void openDetail(row.id)}>
                      {$t('详情/操作')}
                    </Button>
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
      <nav className="cz-pagination" aria-label={$t('分页')}>
        <span className="cz-pagination__info">
          {$t('共')} <b>{total}</b> {$t('条 / 第')} {page} {$t('页（每页')} {PAGE_SIZE} {$t('条）')}
        </span>
        <span className="cz-pagination__pages">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {$t('上一页')}
          </Button>
          <Button size="sm" variant="secondary" disabled={page * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>
            {$t('下一页')}
          </Button>
        </span>
      </nav>

      {/* 调拨详情（含三段操作） */}
      <Modal
        open={detail !== null}
        title={detail ? $t('调拨单 {p0}（{p1}）', { p0: detail.orderNo, p1: detail.statusLabel }) : $t('调拨详情')}
        onClose={() => setDetail(null)}
        size="lg"
      >
        {detail ? (
          <div>
            {/* 状态机可视化 */}
            <div aria-label={$t('调拨状态机步骤')} style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
              {TRANSFER_STATUS_STEPS.map((step, i) => {
                const current = stepIndexOf(detail.status)
                const reached = detail.status !== 'cancelled' && i <= current
                return (
                  <span key={step} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span
                      style={{
                        padding: '3px 10px',
                        borderRadius: 12,
                        fontSize: 12.5,
                        background: reached ? 'var(--cz-color-primary)' : 'var(--cz-color-bg)',
                        color: reached ? '#fff' : 'var(--cz-color-text-secondary)',
                        border: '1px solid var(--cz-color-border)',
                        fontWeight: i === current ? 700 : 400,
                      }}
                    >
                      {TRANSFER_STATUS_LABELS[step]}
                    </span>
                    {i < TRANSFER_STATUS_STEPS.length - 1 ? <span style={{ color: 'var(--cz-color-text-secondary)' }}>→</span> : null}
                  </span>
                )
              })}
              {detail.status === 'cancelled' ? <Badge tone="danger">{$t('已取消')}</Badge> : null}
            </div>
            <p style={{ fontSize: 13.5, margin: '0 0 10px' }}>
              {TRANSFER_KIND_LABELS[detail.transferKind]}{$t('｜')}{detail.fromWarehouseCode} → {detail.toWarehouseCode}{$t('｜中转库位')} {detail.transitLocationCode ?? '—'}{$t('｜ 锁定至')} {detail.lockedValidUntil?.slice(0, 16).replace('T', ' ') ?? '—'}
            </p>
            <table className="cz-table" aria-label={$t('调拨行两段事实')}>
              <thead>
                <tr>
                  <th>{$t('行')}</th>
                  <th>{$t('库存单元')}</th>
                  <th>{$t('料品')}</th>
                  <th>{$t('计划量')}</th>
                  <th>{$t('已出库（out）')}</th>
                  <th>{$t('已接收（in）')}</th>
                  <th>{$t('预留')}</th>
                  <th>{$t('行操作（warehousing.post）')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line) => (
                  <tr key={line.lineId}>
                    <td>{line.lineNo}</td>
                    <td>{line.unitNo}</td>
                    <td>{line.materialCode ?? '—'}</td>
                    <td>{line.quantity}</td>
                    <td>
                      {line.outQty} {line.outDone ? <Badge tone="success">{$t('出库完成')}</Badge> : null}
                    </td>
                    <td>
                      {line.inQty} {line.inDone ? <Badge tone="success">{$t('接收完成')}</Badge> : null}
                    </td>
                    <td>{line.reservationId ? $t('已锁定') : '—'}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {canPost ? (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={line.outDone || !(detail.status === 'ready' || detail.status === 'shipping')}
                            loading={actionBusy}
                            onClick={() =>
                              void runAction(
                                () => api.shipTransfer({ transferOrderId: detail.id, lineId: line.lineId }),
                                $t('行 {p0} 出库段完成（来源减+在途增）', { p0: line.lineNo }),
                              )
                            }
                          >
                            {$t('出库')}
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={line.inDone || !(detail.status === 'shipped_in_transit' || detail.status === 'receiving') || !line.outDone}
                            loading={actionBusy}
                            onClick={() =>
                              void runAction(
                                () => api.receiveTransfer({ transferOrderId: detail.id, lineId: line.lineId }),
                                $t('行 {p0} 接收段完成（在途减+目的增）', { p0: line.lineNo }),
                              )
                            }
                          >
                            {$t('接收')}
                          </Button>
                        </>
                      ) : (
                        <span style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>{$t('需 warehousing.post')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canPost ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Button
                  size="sm"
                  disabled={detail.status !== 'draft'}
                  onClick={() => {
                    setLockValidUntil('')
                    setSubmitOpen(true)
                  }}
                >
                  {$t('提交（草稿→待执行，需锁定有效期）')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={detail.status !== 'shipping' || detail.lines.some((l) => !l.outDone)}
                  loading={actionBusy}
                  onClick={() => void runAction(() => api.transitTransfer({ transferOrderId: detail.id }), $t('已推进在途（状态=已出库在途）'))}
                >
                  {$t('推进在途')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* 提交（锁定有效期） */}
      <Modal
        open={submitOpen}
        title={$t('提交调拨（锁定=作业预留）')}
        onClose={() => setSubmitOpen(false)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSubmitOpen(false)}>{$t('取消')}</Button>
            <Button
              loading={actionBusy}
              disabled={!lockValidUntil.trim()}
              onClick={() => {
                if (!detail) return
                void runAction(
                  () => api.submitTransfer({ transferOrderId: detail.id, lockValidUntil: lockValidUntil.trim() }),
                  $t('已提交（待执行；锁定至 {p0}）', { p0: lockValidUntil.trim().slice(0, 10) }),
                ).then(() => setSubmitOpen(false))
              }}
            >
              {$t('确认提交')}
            </Button>
          </>
        }
      >
        <Field label={$t('锁定有效期（A-T13-11/IT-23）')} required hint={$t('ISO-8601；须晚于当前时间；过期后旧提交须重校验')}>
          <Input type="datetime-local" value={lockValidUntil} onChange={(e) => setLockValidUntil(e.target.value)} />
        </Field>
      </Modal>

      {/* 新建调拨 */}
      <Modal
        open={createOpen}
        title={$t('新建调拨单（草稿）')}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>{$t('取消')}</Button>
            <Button
              loading={actionBusy}
              onClick={() => {
                const transit = { id: 'loc-01010002', code: '01010002' }
                const unitPreset: Record<string, { unitId: string; unitNo: string; materialCode: string }> = {
                  'U-2026-1001-0001': { unitId: 'u-0001', unitNo: 'U-2026-1001-0001', materialCode: 'CU-8.00' },
                }
                const unit = unitPreset[createForm.unitNo]
                if (!unit) {
                  setError({ title: $t('演示单元不存在（可用：U-2026-1001-0001）') })
                  return
                }
                void runAction(
                  () =>
                    api.createTransfer({
                      plantId: 'n-plant',
                      transferKind: 'warehouse',
                      fromWarehouseId: createForm.fromWarehouseId,
                      toWarehouseId: createForm.toWarehouseId,
                      transitLocationId: transit.id,
                      transitLocationCode: transit.code,
                      lines: [{ unitId: unit.unitId, unitNo: unit.unitNo, quantity: createForm.quantity, materialCode: unit.materialCode }],
                    }),
                  $t('调拨单已创建（草稿）；提交后逐行锁定'),
                ).then(() => setCreateOpen(false))
              }}
            >
              {$t('创建草稿')}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label={$t('调出仓库')} required>
            <Select
              value={createForm.fromWarehouseId}
              onChange={(e) => setCreateForm({ ...createForm, fromWarehouseId: e.target.value })}
              options={[
                { value: 'wh-0101', label: $t('0101 原料一库') },
                { value: 'wh-0202', label: $t('0202 绞制线边仓') },
              ]}
            />
          </Field>
          <Field label={$t('调入仓库')} required hint={$t('调入仓不得等于调出仓（A-T13-6）')}>
            <Select
              value={createForm.toWarehouseId}
              onChange={(e) => setCreateForm({ ...createForm, toWarehouseId: e.target.value })}
              options={[
                { value: 'wh-0103', label: $t('0103 成品一库') },
                { value: 'wh-0202', label: $t('0202 绞制线边仓') },
              ]}
            />
          </Field>
          <Field label={$t('库存单元号')} required hint={$t('仅在库码可调拨（A-T13-7）；演示：U-2026-1001-0001')}>
            <Input value={createForm.unitNo} onChange={(e) => setCreateForm({ ...createForm, unitNo: e.target.value })} />
          </Field>
          <Field label={$t('数量')} required>
            <Input value={createForm.quantity} onChange={(e) => setCreateForm({ ...createForm, quantity: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </PageContainer>
  )
}
