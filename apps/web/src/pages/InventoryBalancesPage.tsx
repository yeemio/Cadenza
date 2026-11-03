import {
  ApiError,
  Badge,
  Input,
  Message,
  PageContainer,
  QUALITY_STATUS_LABELS,
  Table,
  formatErrorTitleAndDetail,
  UNIT_STATUS_LABELS,
  type BalanceDto,
  t as $t,
} from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { INVENTORY_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10

/**
 * 库存余额页（IT-20 账面余额 + IT-14 可用量三段展示 + IT-10 英尺换算展示列）：
 * - 过滤：单元号模糊（unitNoLike）/ 料品编码（materialCode）/ 含已关闭（includeClosed），均服务端参数；
 * - 按授权数据范围自动过滤（OA-24/25 服务端收敛，本页不提供厂选择参数）；
 * - 数量与单位同现（PC-06）；行内「详情」下钻单元详情页（unitId 传递）。
 */
export function InventoryBalancesPage() {
  const { has } = usePermissions()
  const canRead = has(INVENTORY_READ)
  const [items, setItems] = useState<BalanceDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [unitNoLike, setUnitNoLike] = useState('')
  const [materialCode, setMaterialCode] = useState('')
  const [includeClosed, setIncludeClosed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)

  useEffect(() => {
    if (!canRead) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    api
      .listBalances({
        page,
        pageSize: PAGE_SIZE,
        unitNoLike: unitNoLike.trim() || undefined,
        materialCode: materialCode.trim() || undefined,
        includeClosed,
      })
      .then((result) => {
        if (!alive) return
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载库存余额失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, unitNoLike, materialCode, includeClosed, canRead])

  if (!canRead) {
    return (
      <PageContainer title={$t('库存余额')} description={$t('库存账面余额与可用量（inventory-trace-core 合同 IT-14/20）')}>
        <Message kind="warning" title={$t('没有库存查询许可（inventory.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理中为当前角色配置 inventory.read 后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('库存余额')}
      description={$t('按授权数据范围服务端过滤（OA-24/25）；可用量＝质量合格∧未被预留占用（IT-14）；英尺列为展示换算（IT-10）')}
      actions={
        <>
          <Input
            style={{ width: 190 }}
            placeholder={$t('按单元号搜索（unitNoLike）')}
            value={unitNoLike}
            onChange={(e) => {
              setPage(1)
              setUnitNoLike(e.target.value)
            }}
          />
          <Input
            style={{ width: 160 }}
            placeholder={$t('料品编码（materialCode）')}
            value={materialCode}
            onChange={(e) => {
              setPage(1)
              setMaterialCode(e.target.value)
            }}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={includeClosed}
              onChange={(e) => {
                setPage(1)
                setIncludeClosed(e.target.checked)
              }}
            />
            {$t('含已关闭余额')}
          </label>
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      <Table<BalanceDto>
        loading={loading}
        columns={[
          { key: 'unitNo', title: $t('库存单元号') },
          { key: 'materialCode', title: $t('料品编码') },
          { key: 'lotNo', title: $t('批次号') },
          { key: 'locationCode', title: $t('库位') },
          { key: 'ownerName', title: $t('所有者') },
          {
            key: 'quantity',
            title: $t('账面数量'),
            render: (b) => (
              <span>
                {b.quantity} <b style={{ fontSize: 12 }}>{b.uomCode}</b>
              </span>
            ),
          },
          { key: 'reservedQuantity', title: $t('有效预留') },
          { key: 'availableQuantity', title: $t('可用量') },
          { key: 'feetDisplay', title: $t('英尺（展示）') },
          {
            key: 'qualityStatus',
            title: $t('质量状态'),
            render: (b) => {
              const label = QUALITY_STATUS_LABELS[b.qualityStatus] ?? b.qualityStatus
              if (b.qualityStatus === 'qualified') return <Badge tone="success">{label}</Badge>
              if (b.qualityStatus === 'unqualified') return <Badge tone="danger">{label}</Badge>
              return <Badge tone="warning">{label}</Badge>
            },
          },
          {
            key: 'status',
            title: $t('余额状态'),
            render: (b) =>
              b.status === 'open' ? <Badge tone="info">{$t('在库')}</Badge> : <Badge>{UNIT_STATUS_LABELS[b.status] ?? b.status}</Badge>,
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (b) => (
              <Link to={`/inventory/units?unitId=${encodeURIComponent(b.unitId)}`} style={{ fontSize: 13 }}>
                {$t('详情')}
              </Link>
            ),
          },
        ]}
        rows={items}
        rowKey={(b) => b.balanceId}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无库存余额')}
      />
    </PageContainer>
  )
}
