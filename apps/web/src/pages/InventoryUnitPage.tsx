import {
  ApiError,
  Badge,
  Button,
  Input,
  Message,
  MOVEMENT_KIND_LABELS,
  PageContainer,
  QUALITY_STATUS_LABELS,
  TRACE_MODE_LABELS,
  UNIT_STATUS_LABELS,
  formatErrorTitleAndDetail,
  type UnitDetailDto,
  t as $t,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { INVENTORY_READ, usePermissions } from '../permissions'

/**
 * 库存单元详情页（IT-01/35）：身份 + 余额 + 有效预留 + 近期流水 + 谱系边摘要。
 * - 支持单元号反查（unitNo）或单元 ID 直达（?unitId=，余额/条码页下钻入口）；
 * - 查无/越范围 → 服务端 404 统一口径（OA-24/25 不可见语义）；
 * - 数量为十进制字符串原样呈现（IT-07）。
 */
export function InventoryUnitPage() {
  const { has } = usePermissions()
  const canRead = has(INVENTORY_READ)
  const [searchParams, setSearchParams] = useSearchParams()
  const [input, setInput] = useState(searchParams.get('unitNo') ?? '')
  const [detail, setDetail] = useState<UnitDetailDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)

  const load = useCallback(
    (query: { unitId?: string; unitNo?: string }) => {
      setLoading(true)
      setError(null)
      api
        .unitDetail(query)
        .then((d) => setDetail(d))
        .catch((err) => {
          setDetail(null)
          setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载单元详情失败') })
        })
        .finally(() => setLoading(false))
    },
    [],
  )

  useEffect(() => {
    if (!canRead) return
    const unitId = searchParams.get('unitId')
    const unitNo = searchParams.get('unitNo')
    if (unitId || unitNo) load({ unitId: unitId ?? undefined, unitNo: unitNo ?? undefined })
  }, [searchParams, canRead, load])

  if (!canRead) {
    return (
      <PageContainer title={$t('单元详情')} description={$t('库存单元身份/余额/预留/流水/谱系（inventory-trace-core 合同 IT-01/35）')}>
        <Message kind="warning" title={$t('没有库存查询许可（inventory.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('单元详情')}
      description={$t('单元号或单元 ID 查询；含余额、有效预留、近期流水与谱系边摘要（端点返回口径）')}
      actions={
        <form
          style={{ display: 'flex', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault()
            const unitNo = input.trim()
            if (!unitNo) return
            setSearchParams({ unitNo })
          }}
        >
          <Input
            style={{ width: 300 }}
            placeholder={$t('输入库存单元号（如 U-2026-1001-0001）')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <Button type="submit" loading={loading}>
            {$t('查询')}
          </Button>
        </form>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {loading ? <p style={{ color: 'var(--cz-color-text-secondary)' }}>{$t('加载中…')}</p> : null}
      {detail ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              border: '1px solid var(--cz-color-border)',
              borderRadius: 8,
              padding: '10px 14px',
              display: 'flex',
              gap: 18,
              flexWrap: 'wrap',
              fontSize: 13,
            }}
          >
            <span>
              {$t('单元号：')}<b>{detail.unitNo}</b>
            </span>
            <span>{$t('料品：')}{detail.materialCode}</span>
            <span>{$t('批次：')}{detail.lotNo}</span>
            <span>
              {$t('追溯模式：')}<Badge tone="info">{TRACE_MODE_LABELS[detail.traceMode] ?? detail.traceMode}</Badge>
            </span>
            <span>
              {$t('状态：')}
              <Badge tone={detail.status === 'in_stock' ? 'success' : 'default'}>
                {UNIT_STATUS_LABELS[detail.status] ?? detail.status}
              </Badge>
            </span>
            <span>{$t('余额开口：')}{detail.balanceOpen ? $t('是') : $t('否')}</span>
          </div>
          <section>
            <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('余额')}</h3>
            <table className="cz-table">
              <thead>
                <tr>
                  <th>{$t('库位')}</th>
                  <th>{$t('所有者')}</th>
                  <th>{$t('数量')}</th>
                  <th>{$t('质量状态')}</th>
                  <th>{$t('余额状态')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.balances.map((b) => (
                  <tr key={b.balanceId}>
                    <td>{b.locationCode}</td>
                    <td>{b.ownerName}</td>
                    <td>{b.quantity}</td>
                    <td>{QUALITY_STATUS_LABELS[b.qualityStatus] ?? b.qualityStatus}</td>
                    <td>{b.status === 'open' ? $t('在库') : b.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('有效预留（IT-23）')}</h3>
            {detail.activeReservations.length === 0 ? (
              <p style={{ color: 'var(--cz-color-text-secondary)', margin: 0 }}>{$t('无有效预留')}</p>
            ) : (
              <table className="cz-table">
                <thead>
                  <tr>
                    <th>{$t('预留号')}</th>
                    <th>{$t('占用者类型')}</th>
                    <th>{$t('占用者标识')}</th>
                    <th>{$t('数量')}</th>
                    <th>{$t('有效期至')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.activeReservations.map((r) => (
                    <tr key={r.reservationId}>
                      <td>{r.reservationId}</td>
                      <td>{r.holderType}</td>
                      <td>{r.holderRef}</td>
                      <td>{r.quantity}</td>
                      <td>{new Date(r.validUntil).toLocaleString('zh-CN')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section>
            <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('近期流水（最近 20 行）')}</h3>
            {detail.recentTransactions.length === 0 ? (
              <p style={{ color: 'var(--cz-color-text-secondary)', margin: 0 }}>{$t('暂无流水')}</p>
            ) : (
              <table className="cz-table">
                <thead>
                  <tr>
                    <th>{$t('流水号')}</th>
                    <th>{$t('行号')}</th>
                    <th>{$t('变动类型')}</th>
                    <th>{$t('变动量')}</th>
                    <th>{$t('变动前')}</th>
                    <th>{$t('变动后')}</th>
                    <th>{$t('业务时间')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.recentTransactions.map((t) => (
                    <tr key={`${t.transactionId}-${t.lineNo}`}>
                      <td>{t.transactionId}</td>
                      <td>{t.lineNo}</td>
                      <td>{MOVEMENT_KIND_LABELS[t.movementKind] ?? t.movementKind}</td>
                      <td>{t.quantity}</td>
                      <td>{t.beforeQty}</td>
                      <td>{t.afterQty}</td>
                      <td>{new Date(t.businessTime).toLocaleString('zh-CN')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section>
            <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('谱系边摘要（IT-34）')}</h3>
            {detail.genealogy.length === 0 ? (
              <p style={{ color: 'var(--cz-color-text-secondary)', margin: 0 }}>{$t('无谱系边')}</p>
            ) : (
              <table className="cz-table">
                <thead>
                  <tr>
                    <th>{$t('边类型')}</th>
                    <th>{$t('起点')}</th>
                    <th>{$t('终点')}</th>
                    <th>{$t('数量')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.genealogy.map((e) => (
                    <tr key={e.edgeId}>
                      <td>{e.edgeKind}</td>
                      <td>
                        {e.fromType}·{e.fromId}
                      </td>
                      <td>
                        {e.toType}·{e.toId}
                      </td>
                      <td>{e.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      ) : !error && !loading ? (
        <Message kind="info" title={$t('输入单元号查询，或从库存余额/条码解析页下钻进入')} />
      ) : null}
    </PageContainer>
  )
}
