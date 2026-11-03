import {
  ApiError,
  Badge,
  Button,
  Field,
  Input,
  Message,
  Modal,
  PageContainer,
  ScanInput,
  Select,
  Table,
  formatErrorTitleAndDetail,
  type QualityHoldDto,
  t as $t,
} from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { QUALITY_POST, QUALITY_READ, usePermissions } from '../permissions'

const PAGE_SIZE = 10

/**
 * 存疑与隔离页（A-T12-2/3）：
 * - 记录列表：隔离种类（待检/不合格/存疑）× 状态（active/released），保留发起人/时间/生产部门；
 * - 存疑登记：扫/输单元号（在库+在库位+未存疑，托码拒绝——服务端终校）；
 * - 存疑恢复：处置依据必填（最小处置记录），恢复后留痕。
 */
export function QualityHoldsPage() {
  const { has } = usePermissions()
  const canRead = has(QUALITY_READ)
  const canPost = has(QUALITY_POST)
  const [items, setItems] = useState<QualityHoldDto[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statuses, setStatuses] = useState('')
  const [holdKinds, setHoldKinds] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // 登记
  const [registerUnitNo, setRegisterUnitNo] = useState('')
  const [registerBusy, setRegisterBusy] = useState(false)
  // 恢复
  const [restoreTarget, setRestoreTarget] = useState<QualityHoldDto | null>(null)
  const [restoreNote, setRestoreNote] = useState('')
  const [restoreBusy, setRestoreBusy] = useState(false)

  const load = useCallback(() => {
    if (!canRead) return
    setLoading(true)
    api
      .listQualityHolds({
        page,
        pageSize: PAGE_SIZE,
        statuses: statuses || undefined,
        holdKinds: holdKinds || undefined,
      })
      .then((result) => {
        setItems(result.items)
        setTotal(result.total)
        setError(null)
      })
      .catch((err) => {
        setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('加载存疑记录失败') })
      })
      .finally(() => setLoading(false))
  }, [canRead, page, statuses, holdKinds])

  useEffect(() => {
    load()
  }, [load])

  const register = async (unitNo: string) => {
    setRegisterBusy(true)
    setError(null)
    try {
      await api.registerSuspect({ plantId: 'n-plant', unitNo })
      setNotice($t('单元 {p0} 已登记存疑（隔离生效，库存不可用 A-T12-2）', { p0: unitNo }))
      setRegisterUnitNo('')
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('存疑登记失败') })
    } finally {
      setRegisterBusy(false)
    }
  }

  const restore = async () => {
    if (!restoreTarget) return
    setRestoreBusy(true)
    setError(null)
    try {
      await api.restoreSuspect(
        { holdId: restoreTarget.id, dispositionNote: restoreNote.trim() },
        { reason: restoreNote.trim() },
      )
      setNotice($t('存疑已恢复（{p0}）；处置依据已留痕', { p0: restoreTarget.unitNo }))
      setRestoreTarget(null)
      setRestoreNote('')
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('存疑恢复失败') })
    } finally {
      setRestoreBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('存疑与隔离')}>
        <Message kind="warning" title={$t('没有质量查询许可（quality.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('存疑与隔离')}
      description={$t('隔离与处置相互独立（A-T12-2）：待检/不合格/存疑隔离中的库存不可用；登记须在库+在库位+未存疑（托码拒绝）；恢复必须填写处置依据（A-T12-3）')}
      actions={
        <>
          <Select
            style={{ width: 130 }}
            placeholder={$t('全部状态')}
            value={statuses}
            onChange={(e) => {
              setPage(1)
              setStatuses(e.target.value)
            }}
            options={[
              { value: 'active', label: $t('隔离中') },
              { value: 'released', label: $t('已恢复') },
            ]}
          />
          <Select
            style={{ width: 130 }}
            placeholder={$t('全部种类')}
            value={holdKinds}
            onChange={(e) => {
              setPage(1)
              setHoldKinds(e.target.value)
            }}
            options={[
              { value: 'pending_inspection', label: $t('待检隔离') },
              { value: 'unqualified', label: $t('不合格隔离') },
              { value: 'suspect', label: $t('质量存疑') },
            ]}
          />
        </>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <section style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('存疑登记')}{canPost ? null : <Badge tone="warning">{$t('需 quality.post 许可')}</Badge>}</h3>
        <div style={{ display: 'flex', gap: 8, maxWidth: 560 }}>
          <ScanInput
            onScan={(code) => {
              setRegisterUnitNo(code)
              if (canPost) void register(code)
            }}
            hint={$t('扫库存单元号（演示：U-2026-1001-0001 可登记；托码 PLT-* 被拒绝）；也可输入后点「登记存疑」')}
            buttonLabel={$t("扫码登记")}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, maxWidth: 560 }}>
          <Input
            style={{ flex: 1 }}
            placeholder={$t('或手输单元号（如 U-2026-1001-0001）')}
            value={registerUnitNo}
            onChange={(e) => setRegisterUnitNo(e.target.value)}
            aria-label={$t('单元号')}
          />
          <Button loading={registerBusy} disabled={!canPost || !registerUnitNo.trim()} onClick={() => void register(registerUnitNo.trim())}>
            {$t('登记存疑')}
          </Button>
        </div>
      </section>

      <Table<QualityHoldDto>
        loading={loading}
        columns={[
          { key: 'unitNo', title: $t('库存单元号') },
          {
            key: 'holdKind',
            title: $t('种类'),
            render: (row) => (
              <Badge tone={row.holdKind === 'suspect' ? 'warning' : row.holdKind === 'unqualified' ? 'danger' : 'info'}>
                {row.holdKindLabel}
              </Badge>
            ),
          },
          {
            key: 'status',
            title: $t('状态'),
            render: (row) => (row.status === 'active' ? <Badge tone="danger">{$t('隔离中')}</Badge> : <Badge tone="success">{$t('已恢复')}</Badge>),
          },
          { key: 'raisedBy', title: $t('发起人') },
          { key: 'raisedAt', title: $t('发起时间') },
          { key: 'productionDeptName', title: $t('生产部门'), render: (row) => row.productionDeptName ?? '—' },
          { key: 'releasedBy', title: $t('恢复人'), render: (row) => row.releasedBy ?? '—' },
          { key: 'releasedAt', title: $t('恢复时间'), render: (row) => row.releasedAt ?? '—' },
          { key: 'dispositionNote', title: $t('处置依据'), render: (row) => row.dispositionNote ?? '—' },
          {
            key: 'actions',
            title: $t('操作'),
            render: (row) =>
              row.status === 'active' && canPost ? (
                <Button size="sm" variant="secondary" onClick={() => setRestoreTarget(row)}>
                  {$t('恢复')}
                </Button>
              ) : null,
          },
        ]}
        rows={items}
        rowKey={(row) => row.id}
        page={{ page, pageSize: PAGE_SIZE }}
        total={total}
        onPageChange={(p) => setPage(Math.max(1, p))}
        emptyText={$t('暂无隔离/存疑记录')}
      />

      <Modal
        open={restoreTarget !== null}
        title={$t('存疑恢复')}
        onClose={() => setRestoreTarget(null)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRestoreTarget(null)}>{$t('取消')}</Button>
            <Button loading={restoreBusy} disabled={!restoreNote.trim()} onClick={() => void restore()}>
              {$t('确认恢复')}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13.5, lineHeight: 1.8, margin: '0 0 10px' }}>
          {$t('恢复')} {restoreTarget?.unitNo} {$t('的存疑隔离；恢复人/时间/处置依据将留痕（最小处置记录，A-T12-3）。')}
        </p>
        <Field label={$t('处置依据')} required error={!restoreNote.trim() ? $t('处置依据必填') : undefined}>
          <Input value={restoreNote} onChange={(e) => setRestoreNote(e.target.value)} placeholder={$t('如 复检合格/客户确认接受')} />
        </Field>
      </Modal>
    </PageContainer>
  )
}
