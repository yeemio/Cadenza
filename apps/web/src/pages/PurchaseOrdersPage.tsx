import {
  ApiError,
  Badge,
  Button,
  Field,
  Input,
  Message,
  Modal,
  PageContainer,
  PURCHASE_ORDER_LINE_STATUS_LABELS,
  formatErrorTitleAndDetail,
  type PurchaseOrderLineDto,
  type PurchaseOrderLineStatusValue,
  t as $t,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { PURCHASE_POST, PURCHASE_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10

/**
 * 采购订单行列表 + 模拟入站 sync（对齐 POST /purchase/orders/sync）：
 * - 查询：GET /purchase/order-lines（purchase.read）；空库正确空态；
 * - 命令：模拟入站同步（purchase.post）；MES 零增删改，本入口语义=外部报文模拟落库。
 */
export function PurchaseOrdersPage() {
  const { has } = usePermissions()
  const { session } = useAuth()
  const canRead = has(PURCHASE_READ)
  const canPost = has(PURCHASE_POST)
  const [items, setItems] = useState<PurchaseOrderLineDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [orderNoLike, setOrderNoLike] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncForm, setSyncForm] = useState({
    orgCode: 'CN11',
    orderNo: '',
    supplierName: '',
    materialCode: '',
    materialName: '',
    plannedQty: '100.0000',
    uomCode: 'KG',
    lineNo: '1',
  })

  const load = useCallback(() => {
    if (!canRead) return
    setLoading(true)
    api
      .listPurchaseOrderLines({
        page,
        pageSize: PAGE_SIZE,
        plantId: session?.user.plantId || undefined,
        orderNoLike: orderNoLike.trim() || undefined,
      })
      .then((result) => {
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载采购订单行失败') })
      })
      .finally(() => setLoading(false))
  }, [canRead, page, orderNoLike, session?.user.plantId])

  useEffect(() => {
    load()
  }, [load])

  const doSync = async () => {
    const plantId = session?.user.plantId ?? ''
    if (!plantId) {
      setError({ title: $t('当前会话无工厂，无法提交采购同步') })
      return
    }
    if (!syncForm.orgCode.trim() || !syncForm.orderNo.trim() || !syncForm.materialCode.trim()) {
      setError({ title: $t('组织编码、订单号、料品编码为必填') })
      return
    }
    const lineNo = Number(syncForm.lineNo)
    if (!Number.isInteger(lineNo) || lineNo < 1) {
      setError({ title: $t('行号须为正整数') })
      return
    }
    setSyncBusy(true)
    setNotice(null)
    try {
      await api.syncPurchaseOrders({
        orgCode: syncForm.orgCode.trim(),
        orderNo: syncForm.orderNo.trim(),
        plantId,
        supplierName: syncForm.supplierName.trim() || undefined,
        lines: [
          {
            lineNo,
            materialCode: syncForm.materialCode.trim(),
            materialName: syncForm.materialName.trim() || undefined,
            uomCode: syncForm.uomCode.trim() || 'KG',
            plannedQty: syncForm.plannedQty.trim() || '0.0000',
          },
        ],
      })
      setNotice($t('采购订单 {p0} 同步已提交（本地入账，外部报文模拟）', { p0: syncForm.orderNo.trim() }))
      setSyncOpen(false)
      setPage(1)
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('采购订单同步失败') })
    } finally {
      setSyncBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('采购订单/同步')} description={$t('采购订单行查询与模拟入站同步（IF-08）')}>
        <Message kind="warning" title={$t('没有采购域查询许可（purchase.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 purchase.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('采购订单/同步')}
      description={$t('订单行只读列表（MES 零增删改）；「模拟入站同步」对齐 POST /purchase/orders/sync')}
      actions={
        <>
          <Input
            placeholder={$t('订单号包含…')}
            value={orderNoLike}
            onChange={(e) => {
              setOrderNoLike(e.target.value)
              setPage(1)
            }}
            aria-label={$t('按订单号筛选')}
          />
          {canPost ? (
            <Button size="sm" variant="secondary" onClick={() => setSyncOpen(true)}>
              {$t('模拟入站同步')}
            </Button>
          ) : null}
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <table className="cz-table" style={{ width: '100%' }} aria-label={$t('采购订单行列表')}>
        <thead>
          <tr>
            <th>{$t('订单号')}</th>
            <th>{$t('行号')}</th>
            <th>{$t('料品')}</th>
            <th>{$t('供应商')}</th>
            <th>{$t('计划/已收')}</th>
            <th>{$t('状态')}</th>
            <th>{$t('组织')}</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td className="cz-table__empty" colSpan={7}>
                {$t('加载中…')}
              </td>
            </tr>
          ) : items.length === 0 ? (
            <tr>
              <td className="cz-table__empty" colSpan={7}>
                {$t('暂无采购订单行（等待外部同步或使用「模拟入站同步」）')}
              </td>
            </tr>
          ) : (
            items.map((row) => (
              <tr key={row.lineId}>
                <td>
                  <b>{row.orderNo}</b>
                </td>
                <td>{row.lineNo}</td>
                <td>
                  {row.materialCode}
                  {row.materialName ? $t('｜{p0}', { p0: row.materialName }) : ''}
                </td>
                <td>{row.supplierName ?? '—'}</td>
                <td>
                  {row.plannedQty} / {row.receivedQty} {row.uomCode}
                </td>
                <td>
                  <Badge>
                    {row.statusLabel ||
                      PURCHASE_ORDER_LINE_STATUS_LABELS[row.status as PurchaseOrderLineStatusValue] ||
                      String(row.status)}
                  </Badge>
                </td>
                <td>{row.orgCode}</td>
              </tr>
            ))
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
          <Button
            size="sm"
            variant="secondary"
            disabled={page * PAGE_SIZE >= total}
            onClick={() => setPage(page + 1)}
          >
            {$t('下一页')}
          </Button>
        </span>
      </nav>

      <Modal open={syncOpen} title={$t('模拟入站：采购订单同步')} onClose={() => setSyncOpen(false)} size="md">
        <p style={{ fontSize: 13.5, margin: '0 0 12px', color: 'var(--cz-color-text-secondary)' }}>
          {$t('对齐')} <code>POST /purchase/orders/sync</code>{$t('（IF-08 五元组幂等）。归属工厂取当前会话；不宣称真实 SAP 接通。')}
        </p>
        <div style={{ display: 'grid', gap: 10 }}>
          <Field label={$t('组织编码 orgCode')} required>
            <Input
              value={syncForm.orgCode}
              onChange={(e) => setSyncForm((s) => ({ ...s, orgCode: e.target.value }))}
            />
          </Field>
          <Field label={$t('采购订单号')} required>
            <Input
              value={syncForm.orderNo}
              onChange={(e) => setSyncForm((s) => ({ ...s, orderNo: e.target.value }))}
              placeholder="PO-…"
            />
          </Field>
          <Field label={$t('供应商')}>
            <Input
              value={syncForm.supplierName}
              onChange={(e) => setSyncForm((s) => ({ ...s, supplierName: e.target.value }))}
            />
          </Field>
          <Field label={$t('行号')} required>
            <Input
              value={syncForm.lineNo}
              onChange={(e) => setSyncForm((s) => ({ ...s, lineNo: e.target.value }))}
            />
          </Field>
          <Field label={$t('料品编码')} required>
            <Input
              value={syncForm.materialCode}
              onChange={(e) => setSyncForm((s) => ({ ...s, materialCode: e.target.value }))}
            />
          </Field>
          <Field label={$t('料品名称')}>
            <Input
              value={syncForm.materialName}
              onChange={(e) => setSyncForm((s) => ({ ...s, materialName: e.target.value }))}
            />
          </Field>
          <Field label={$t('计划数量')}>
            <Input
              value={syncForm.plannedQty}
              onChange={(e) => setSyncForm((s) => ({ ...s, plannedQty: e.target.value }))}
            />
          </Field>
          <Field label={$t('单位')}>
            <Input
              value={syncForm.uomCode}
              onChange={(e) => setSyncForm((s) => ({ ...s, uomCode: e.target.value }))}
            />
          </Field>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="secondary" onClick={() => setSyncOpen(false)}>
            {$t('取消')}
          </Button>
          <Button loading={syncBusy} onClick={() => void doSync()}>
            {$t('提交同步')}
          </Button>
        </div>
      </Modal>
    </PageContainer>
  )
}
