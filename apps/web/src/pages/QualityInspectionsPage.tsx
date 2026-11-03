import {
  ApiError,
  Badge,
  Button,
  Input,
  INSPECTION_SOURCE_LABELS,
  INSPECTION_STAGE_LABELS,
  INSPECTION_STATUS_LABELS,
  Message,
  PageContainer,
  Select,
  Table,
  formatErrorTitleAndDetail,
  type InspectionOrderDto,
  t as $t,
} from '@cadenza/ui'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { QUALITY_POST, QUALITY_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10

const STATUS_OPTIONS = Object.entries(INSPECTION_STATUS_LABELS).map(([value, label]) => ({ value, label }))
const STAGE_OPTIONS = Object.entries(INSPECTION_STAGE_LABELS).map(([value, label]) => ({ value, label }))

function statusTone(status: string): 'success' | 'info' | 'warning' | 'default' {
  if (status === 'concluded') return 'success'
  if (status === 'in_progress') return 'info'
  if (status === 'pending') return 'warning'
  return 'default'
}

/**
 * 检验任务列表（A-T12-5：来源/阶段/规范版本化）：
 * - 过滤：statuses/stages 多选、orderNoLike（检验单号或生产单号），全部服务端参数；
 * - 行内「执行/处置」下钻检验执行页（实测值表单+结论提交、放行/让步）；
 * - 数量与单位同现（PC-06）；任务生成入口（quality.post）。
 */
export function QualityInspectionsPage() {
  const { has } = usePermissions()
  const canRead = has(QUALITY_READ)
  const canPost = has(QUALITY_POST)
  const [items, setItems] = useState<InspectionOrderDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statuses, setStatuses] = useState('')
  const [stages, setStages] = useState('')
  const [orderNoLike, setOrderNoLike] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [genBusy, setGenBusy] = useState(false)

  useEffect(() => {
    if (!canRead) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    api
      .listInspections({
        page,
        pageSize: PAGE_SIZE,
        statuses: statuses || undefined,
        stages: stages || undefined,
        orderNoLike: orderNoLike.trim() || undefined,
      })
      .then((result) => {
        if (!alive) return
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载检验任务失败') })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [page, statuses, stages, orderNoLike, canRead])

  const generate = async () => {
    setGenBusy(true)
    setError(null)
    try {
      const result = await api.generateInspections({ plantId: 'n-plant' })
      const data = (result.data ?? {}) as { generated?: number; inspectionOrderId?: string }
      setNotice($t('检验任务生成已执行（新增 {p0} 条）', { p0: data.generated ?? 0 }))
      setPage(1)
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('生成检验任务失败') })
    } finally {
      setGenBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('检验任务')}>
        <Message kind="warning" title={$t('没有质量查询许可（quality.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('检验任务')}
      description={$t('来源：报工/入库（A-T12-5 幂等生成）；阶段：过程/成品检验；检验规范引用版本化；放行/让步在检验执行页操作')}
      actions={
        <>
          <Input
            style={{ width: 210 }}
            placeholder={$t('检验单号/生产单号（orderNoLike）')}
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
            options={STATUS_OPTIONS}
          />
          <Select
            style={{ width: 130 }}
            placeholder={$t('全部阶段')}
            value={stages}
            onChange={(e) => {
              setPage(1)
              setStages(e.target.value)
            }}
            options={STAGE_OPTIONS}
          />
          {canPost ? (
            <Button size="sm" variant="secondary" loading={genBusy} onClick={() => void generate()}>
              {$t('生成任务（消费执行事件）')}
            </Button>
          ) : null}
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}
      <Table<InspectionOrderDto>
        loading={loading}
        columns={[
          { key: 'orderNo', title: $t('检验单号') },
          {
            key: 'sourceType',
            title: $t('来源'),
            render: (row) => (
              <Badge tone="info">
                {INSPECTION_SOURCE_LABELS[row.sourceType] ?? row.sourceType}{$t('（')}{row.sourceRef}{$t('）')}
              </Badge>
            ),
          },
          { key: 'inspectionStage', title: $t('阶段'), render: (row) => INSPECTION_STAGE_LABELS[row.inspectionStage] ?? row.inspectionStage },
          { key: 'spec', title: $t('检验规范'), render: (row) => `${row.specCode} v${row.specVersion}` },
          { key: 'productionOrderNo', title: $t('生产单号'), render: (row) => row.productionOrderNo ?? '—' },
          { key: 'materialCode', title: $t('料品编码') },
          { key: 'unitNo', title: $t('库存单元'), render: (row) => row.unitNo ?? '—' },
          {
            key: 'quantity',
            title: $t('数量'),
            render: (row) => (
              <span>
                {row.quantity} <b style={{ fontSize: 12 }}>{row.uomCode}</b>
              </span>
            ),
          },
          {
            key: 'status',
            title: $t('状态'),
            render: (row) => <Badge tone={statusTone(row.status)}>{INSPECTION_STATUS_LABELS[row.status] ?? row.status}</Badge>,
          },
          {
            key: 'actions',
            title: $t('操作'),
            render: (row) => (
              <Link to={`/quality/inspections/${encodeURIComponent(row.id)}`} style={{ fontSize: 13 }}>
                {$t('执行/处置')}
              </Link>
            ),
          },
        ]}
        rows={items}
        rowKey={(row) => row.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无检验任务')}
      />
    </PageContainer>
  )
}
