import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Message, PageContainer, Select, Table, t as $t, tx as $tx } from '@cadenza/ui'
import {
  formatP3Error,
  type SpcChangeDetailResponse,
  type SpcChangeImpactView,
  type SpcChangeListItem,
  type SpcInProcessDispositionValue,
} from '../../../../../packages/ui/src/api/p3'
import { createWebP3Client } from '../client'
import { SPC_POST, SPC_READ, useP3Permissions } from '../permissions'

/**
 * 工艺变更页（PE-02～PE-07）：变更单列表 + PE-06 三类影响清单（受影响未执行/在制（含处置结论）/
 * 已完成（不可变更））+ PE-04 在制逐单处置（继续旧版/转新版/隔离评审）+ 发布守卫
 * （未处置在制不得发布，[PE-04]）。
 */

const DISPOSITION_OPTIONS: Array<{ value: SpcInProcessDispositionValue; label: string }> = [
  { value: 'continue_old', label: '①继续旧版完成' },
  { value: 'switch_new', label: '②转新版（生成调整指令）' },
  { value: 'isolation_review', label: '③隔离评审（暂停挂质量评审）' },
]

export function SpcChangesPage() {
  const { has } = useP3Permissions()
  const canRead = has(SPC_READ)
  const canPost = has(SPC_POST)
  const client = useMemo(() => createWebP3Client(), [])
  const [changes, setChanges] = useState<SpcChangeListItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<SpcChangeDetailResponse | null>(null)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadList = useCallback(() => {
    if (!canRead) return
    client
      .spcListChanges({ page: 1, pageSize: 20 })
      .then((page) => {
        setChanges(page.items)
        if (selectedId === null && page.items.length > 0) setSelectedId(page.items[0]!.changeNo ? page.items[0]!.id : null)
      })
      .catch((err: unknown) => setError(formatP3Error(err as { code?: string; message?: string; requestId?: string })))
  }, [canRead, client, selectedId])

  const loadDetail = useCallback(() => {
    if (!canRead || selectedId === null) return
    client
      .spcChangeDetail(selectedId)
      .then(setDetail)
      .catch((err: unknown) => setError(formatP3Error(err as { code?: string; message?: string; requestId?: string })))
  }, [canRead, client, selectedId])

  useEffect(() => {
    loadList()
  }, [loadList])

  useEffect(() => {
    loadDetail()
  }, [loadDetail])

  const dispose = async (impact: SpcChangeImpactView, disposition: SpcInProcessDispositionValue) => {
    if (detail === null) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await client.spcChangeDisposition({
        plantId: detail.change.plantId,
        changeId: detail.change.id,
        impactId: impact.id,
        disposition,
        reason: `在制处置：${DISPOSITION_OPTIONS.find((o) => o.value === disposition)?.label}`,
      })
      setNotice($t('{p0} {p1} 已处置（{p2}）；PE-07：已有报工的工序不可增/改名/调序/删行', { p0: impact.orderNo, p1: impact.operationName, p2: $tx(DISPOSITION_OPTIONS.find((o) => o.value === disposition)?.label) }))
      loadDetail()
      loadList()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  const publish = async () => {
    if (detail === null) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await client.spcChangePublish({
        plantId: detail.change.plantId,
        changeId: detail.change.id,
        reason: '发布工艺变更（页面操作）',
      })
      setNotice($t('变更单 {p0} 已发布：新版本只影响获准的未执行任务，历史实绩保留旧参数不重算（PE-02）', { p0: detail.change.changeNo }))
      loadDetail()
      loadList()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('工艺变更')} description={$t('变更影响控制：在制处置与版本对应（PE-02～PE-07）')}>
        <Message kind="warning" title={$t('无工艺变更查询权限（spc.read）')}>{$t('未授予 SPC 域查询许可，请联系管理员授权后使用。')}</Message>
      </PageContainer>
    )
  }

  const impactColumns = [
    { key: 'orderNo', title: $t('订单') },
    { key: 'operation', title: $t('工序'), render: (i: SpcChangeImpactView) => `${i.operationSeq} ${i.operationName}` },
    { key: 'plannedQty', title: $t('计划量'), render: (i: SpcChangeImpactView) => (i.recomputedPlannedQty !== null ? `${i.plannedQty} → ${i.recomputedPlannedQty}` : i.plannedQty) },
    { key: 'disposition', title: $t('处置结论'), render: (i: SpcChangeImpactView) => (i.disposition === null ? <Badge tone="warning">{$t('未处置')}</Badge> : <Badge tone="success">{$tx(DISPOSITION_OPTIONS.find((o) => o.value === i.disposition)?.label) ?? i.disposition}</Badge>) },
  ]

  return (
    <PageContainer
      title={$t('工艺变更')}
      description={$t('变更单含版本对（旧→新）、审批人、生效时间与影响任务清单；在制任务须逐单处置后方可发布（PE-04/05）')}
      actions={
        detail !== null && canPost && detail.change.status === 'draft' ? (
          <Button onClick={() => void publish()} loading={busy}>{$t('发布变更')}</Button>
        ) : undefined
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 280 }}>
          <Select
            aria-label={$t('选择变更单')}
            value={selectedId ?? ''}
            placeholder={$t('选择变更单')}
            options={changes.map((c) => ({
              value: c.id,
              label: `${c.changeNo}（${c.status === 'draft' ? '草稿' : '已发布'}；未执行 ${c.impactSummary.unexecuted}/在制 ${c.impactSummary.inProcess}/已完成 ${c.impactSummary.completed}）`,
            }))}
            onChange={(e) => setSelectedId(e.target.value)}
          />
        </div>
      </div>

      {detail !== null ? (
        <>
          <Message kind="info" title={$t('{p0}：{p1} → {p2}', { p0: detail.change.changeNo, p1: detail.oldSpecLabel, p2: detail.newSpecLabel })}>
            {$t('审批人')} {detail.change.approver}{$t('；生效时间')} {detail.change.effectiveAt.replace('T', ' ').slice(0, 16)}{$t('；')}
            {detail.change.status === 'published' ? $t(' 已发布（{p0}）', { p0: detail.change.publishedAt?.slice(0, 10) }) : $t(' 未发布')}
          </Message>

          <h3 style={{ fontSize: 15, margin: '12px 0 8px' }}>{$t('① 受影响未执行任务（随变更自动重算计划量，PE-03）')}</h3>
          <Table
            columns={impactColumns}
            rows={detail.impactGroups.unexecuted}
            rowKey={(i) => i.id}
            emptyText={$t('无未执行影响任务')}
          />

          <h3 style={{ fontSize: 15, margin: '12px 0 8px' }}>{$t('② 在制任务（已开工未完成，须逐单处置——PE-04）')}</h3>
          <Table
            columns={[
              ...impactColumns,
              {
                key: 'actions',
                title: canPost ? $t('处置（三选一）') : $t('处置'),
                render: (i: SpcChangeImpactView) =>
                  i.disposition === null ? (
                    canPost ? (
                      <Select
                        aria-label={$t('处置 {p0}', { p0: i.orderNo })}
                        value=""
                        placeholder={$t('选择处置')}
                        options={DISPOSITION_OPTIONS.map((o) => ({ ...o, label: $tx(o.label) }))}
                        disabled={busy}
                        onChange={(e) => {
                          if (e.target.value !== '') void dispose(i, e.target.value as SpcInProcessDispositionValue)
                        }}
                      />
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>{$t('无 spc.post 权限')}</span>
                    )
                  ) : (
                    <Badge tone="success">{$t('已处置（遵循')} {i.followsVersion === 'new' ? $t('新版') : $t('旧版')}{$t('）')}</Badge>
                  ),
              },
            ]}
            rows={detail.impactGroups.inProcess}
            rowKey={(i) => i.id}
            emptyText={$t('无在制影响任务')}
          />

          <h3 style={{ fontSize: 15, margin: '12px 0 8px' }}>{$t('③ 已完成/已发运（不可变更，仅提示范围——PE-06）')}</h3>
          <Table
            columns={impactColumns}
            rows={detail.impactGroups.completed}
            rowKey={(i) => i.id}
            emptyText={$t('无已完成影响任务')}
          />

          {detail.adjustments.length > 0 ? (
            <>
              <h3 style={{ fontSize: 15, margin: '12px 0 8px' }}>{$t('调整指令（转新版生成）')}</h3>
              <Table
                columns={[
                  { key: 'orderNo', title: $t('订单') },
                  { key: 'operationSeq', title: $t('工序') },
                  { key: 'qty', title: $t('计划量调整'), render: (a) => `${a.oldPlannedQty} → ${a.newPlannedQty}` },
                  { key: 'createdAt', title: $t('生成时间') },
                ]}
                rows={detail.adjustments}
                rowKey={(a) => a.id}
                emptyText={$t('无调整指令')}
              />
            </>
          ) : null}
        </>
      ) : (
        <Message kind="info" title={$t('选择变更单查看影响清单')} />
      )}
    </PageContainer>
  )
}
