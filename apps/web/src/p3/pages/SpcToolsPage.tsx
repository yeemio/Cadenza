import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Field, Input, Message, Modal, PageContainer, Table, t as $t, tx as $tx } from '@cadenza/ui'
import {
  formatP3Error,
  type SpcToolDetailResponse,
  type SpcToolListItem,
} from '../../../../../packages/ui/src/api/p3'
import { createWebP3Client } from '../client'
import { SPC_POST, SPC_READ, useP3Permissions } from '../permissions'

/**
 * 工具寿命页（PE-20/PE-21）：寿命台账（累计只增；修正走具名调整，理由必填＋审计）；
 * 消耗来源（报工产出/采集样本）；预警阈值与到期处置；到期工具经排产约束阻止继续排产。
 */

const LIFE_UOM_LABELS: Record<string, string> = { count: '次', meters: '米', hours: '小时' }
const EXPIRE_POLICY_LABELS: Record<string, string> = { block: '到期禁用', degrade: '到期降级用' }

export function SpcToolsPage() {
  const { has } = useP3Permissions()
  const canRead = has(SPC_READ)
  const canPost = has(SPC_POST)
  const client = useMemo(() => createWebP3Client(), [])
  const [tools, setTools] = useState<SpcToolListItem[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<SpcToolDetailResponse | null>(null)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [consumeOpen, setConsumeOpen] = useState(false)
  const [consumeQty, setConsumeQty] = useState('')
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [adjustDelta, setAdjustDelta] = useState('')
  const [adjustReason, setAdjustReason] = useState('')

  const loadList = useCallback(() => {
    if (!canRead) return
    client
      .spcListTools({ page: 1, pageSize: 20 })
      .then((page) => {
        setTools(page.items)
        if (selectedId === '' && page.items.length > 0) setSelectedId(page.items[0]!.id)
      })
      .catch(() => setTools([]))
  }, [canRead, client, selectedId])

  const loadDetail = useCallback(() => {
    if (!canRead || selectedId === '') return
    client
      .spcToolDetail(selectedId)
      .then(setDetail)
      .catch(() => setDetail(null))
  }, [canRead, client, selectedId])

  useEffect(() => {
    loadList()
  }, [loadList])
  useEffect(() => {
    loadDetail()
  }, [loadDetail])

  const submitConsume = async () => {
    if (detail === null) return
    const qty = consumeQty.trim()
    if (qty === '' || Number(qty) <= 0) {
      setError({ title: $t('消耗数量必须为正数十进制字符串（PE-20）') })
      return
    }
    setBusy(true)
    try {
      await client.spcToolConsume({
        plantId: detail.tool.plantId,
        toolId: detail.tool.id,
        source: 'work_report_output',
        quantity: qty,
        refType: 'work_report',
        refId: `rp-page-${Date.now().toString(36)}`,
        reason: '页面登记消耗',
      })
      setNotice($t('消耗已入账：累计只增不改（PE-21）；当前状态按累计/阈值重算'))
      setConsumeOpen(false)
      setConsumeQty('')
      loadList()
      loadDetail()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  const submitAdjust = async () => {
    if (detail === null) return
    const delta = adjustDelta.trim()
    if (delta === '' || Number(delta) === 0) {
      setError({ title: $t('调整增量必须为非零数（负值=扣减，PE-21）') })
      return
    }
    if (adjustReason.trim() === '') {
      setError({ title: $t('[PE-21] 寿命修正必须填写具名调整理由并留审计') })
      return
    }
    setBusy(true)
    try {
      await client.spcToolAdjust({
        plantId: detail.tool.plantId,
        toolId: detail.tool.id,
        delta,
        reason: adjustReason.trim(),
      })
      setNotice($t('具名调整已入账（理由＋审计；累计列只增，调整走独立审计行）'))
      setAdjustOpen(false)
      setAdjustDelta('')
      setAdjustReason('')
      loadList()
      loadDetail()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('工具寿命')} description={$t('工具/模具寿命台账（PE-20/PE-21）')}>
        <Message kind="warning" title={$t('无 SPC 查询权限（spc.read）')}>{$t('未授予 SPC 域查询许可，请联系管理员授权后使用。')}</Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('工具寿命')}
      description={$t('寿命计量单位按工具类型配置（次数/米数/小时）；累计只增不改，修正走具名调整（PE-21）；到期工具经排产工装约束阻止继续排产')}
      actions={
        canPost && detail !== null ? (
          <>
            <Button variant="secondary" onClick={() => setConsumeOpen(true)}>{$t('登记消耗')}</Button>
            <Button onClick={() => setAdjustOpen(true)}>{$t('具名调整')}</Button>
          </>
        ) : undefined
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <Table
        columns={[
          { key: 'toolNo', title: $t('工具号') },
          { key: 'name', title: $t('名称') },
          { key: 'life', title: $t('寿命（额定/预警阈值）'), render: (t) => $t('{p0} / {p1} {p2}', { p0: Number(t.ratedLife).toLocaleString(), p1: Number(t.warningThreshold).toLocaleString(), p2: $tx(LIFE_UOM_LABELS[t.lifeUom]) }) },
          { key: 'accumulated', title: $t('累计（含调整）'), render: (t) => $t('{p0} {p1}', { p0: Number(t.effectiveLife).toLocaleString(), p1: `${$tx(LIFE_UOM_LABELS[t.lifeUom])}${Number(t.adjustmentSum) !== 0 ? $t('（调整 {p0}）', { p0: t.adjustmentSum }) : ''}` }) },
          {
            key: 'status',
            title: $t('状态'),
            render: (t) =>
              t.status === 'expired' ? (
                <Badge tone="danger">{$t('已到期（{p0}）', { p0: $tx(EXPIRE_POLICY_LABELS[t.expirePolicy]) })}</Badge>
              ) : t.status === 'warning' ? (
                <Badge tone="warning">{$t('接近预警阈值')}</Badge>
              ) : (
                <Badge tone="success">{$t('正常')}</Badge>
              ),
          },
          { key: 'schedulable', title: $t('可排产'), render: (t) => (t.schedulableForScheduling ? $t('是') : <Badge tone="danger">{$t('否（工装约束）')}</Badge>) },
        ]}
        rows={tools}
        rowKey={(t) => t.id}
        loading={tools.length === 0}
        emptyText={$t('暂无工具台账')}
      />

      {detail !== null ? (
        <>
          <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>
            {$t('台账详情：')}{detail.tool.toolNo} {detail.tool.name}{$t('（配置 v')}{detail.tool.configVersion}{$t('）')}
          </h3>
          <Table
            columns={[
              { key: 'source', title: $t('消耗来源'), render: (u) => (u.source === 'work_report_output' ? $t('报工产出') : $t('采集样本（OT-26 显式映射）')) },
              { key: 'quantity', title: $t('数量'), render: (u) => $t('{p0} {p1}', { p0: u.quantity, p1: $tx(LIFE_UOM_LABELS[detail.tool.lifeUom]) }) },
              { key: 'ref', title: $t('来源引用'), render: (u) => `${u.refType} ${u.refId}` },
              { key: 'createdAt', title: $t('时间'), render: (u) => u.createdAt.replace('T', ' ').slice(0, 16) },
            ]}
            rows={detail.usage}
            rowKey={(u) => u.id}
            emptyText={$t('暂无消耗记录')}
          />
          <h3 style={{ fontSize: 15, margin: '12px 0 8px' }}>{$t('具名调整（审计行）')}</h3>
          <Table
            columns={[
              { key: 'delta', title: $t('增量'), render: (a) => `${Number(a.delta) > 0 ? '+' : ''}${a.delta}` },
              { key: 'reason', title: $t('理由（必填）') },
              { key: 'created', title: $t('时间/人'), render: (a) => `${a.createdAt.replace('T', ' ').slice(0, 16)}` },
            ]}
            rows={detail.adjustments}
            rowKey={(a) => a.id}
            emptyText={$t('无调整记录')}
          />
        </>
      ) : null}

      <Modal
        open={consumeOpen}
        title={$t('登记寿命消耗（PE-20）')}
        onClose={() => setConsumeOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConsumeOpen(false)}>{$t('取消')}</Button>
            <Button loading={busy} onClick={() => void submitConsume()}>{$t('提交消耗')}</Button>
          </>
        }
      >
        <Field label={$t('消耗数量（{p0}）', { p0: $tx(LIFE_UOM_LABELS[detail?.tool.lifeUom ?? 'count']) })} required>
          <Input value={consumeQty} onChange={(e) => setConsumeQty(e.target.value)} placeholder={$t('如 5200')} aria-label={$t('消耗数量')} />
        </Field>
      </Modal>

      <Modal
        open={adjustOpen}
        title={$t('具名调整（PE-21：累计只增不改，修正须留痕）')}
        onClose={() => setAdjustOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdjustOpen(false)}>{$t('取消')}</Button>
            <Button loading={busy} onClick={() => void submitAdjust()}>{$t('提交调整')}</Button>
          </>
        }
      >
        <Field label={$t('调整增量（正=补计，负=扣减）')} required>
          <Input value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)} placeholder={$t('如 -1500 或 800')} aria-label={$t('调整增量')} />
        </Field>
        <Field label={$t('理由（必填，服务端守卫）')} required error={adjustReason.trim() === '' && adjustOpen ? $t('理由不能为空（[PE-21] 具名调整）') : undefined}>
          <Input value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder={$t('如 计量修正：上次报工重复计入 1500 米')} aria-label={$t('调整理由')} />
        </Field>
      </Modal>
    </PageContainer>
  )
}
