import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, ConfirmModal, Message, PageContainer, Table, t as $t } from '@cadenza/ui'
import { formatP3Error, type OtFactView, type OtMappingView } from '../../../../../packages/ui/src/api/p3'
import { createWebP3Client } from '../client'
import { OT_POST, OT_READ, useP3Permissions } from '../permissions'

/**
 * 采集入账页（OT-26 采集值→业务事实）：版本化映射配置清单 + 显式评估命令生成事实候选 +
 * manual 模式候选人工确认后派发（走正常命令链路，Outbox）；auto 模式自动入账。
 * OT-03：遥测通道只读——本页命令是映射/确认命令，不是遥测写。
 */
export function OtFactsPage() {
  const { has, plantId } = useP3Permissions()
  const canRead = has(OT_READ)
  const canPost = has(OT_POST)
  const client = useMemo(() => createWebP3Client(), [])
  const [mappings, setMappings] = useState<OtMappingView[]>([])
  const [facts, setFacts] = useState<OtFactView[]>([])
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<OtFactView | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (!canRead) return
    client
      .otListMappings({ page: 1, pageSize: 20 })
      .then((page) => setMappings(page.items))
      .catch((err: unknown) => setError(formatP3Error(err as { code?: string; message?: string; requestId?: string })))
    client
      .otListFacts({ page: 1, pageSize: 20 })
      .then((page) => setFacts(page.items))
      .catch(() => setFacts([]))
  }, [canRead, client])

  useEffect(() => {
    load()
  }, [load])

  const evaluate = async (mapping: OtMappingView) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      // 评估窗口默认当日 00:00 ~ 当前（演示口径；真实入口按班次窗口带入）
      const today = new Date().toISOString().slice(0, 10)
      const resp = await client.otMappingEvaluate({
        plantId: mapping.plantId,
        mappingId: mapping.mappingId,
        from: `${today}T00:00:00+08:00`,
        to: new Date().toISOString(),
        reason: '页面显式评估（OT-26）',
      })
      const data = resp.data as { factId?: string } | null
      setNotice($t('评估完成：生成事实候选 {p0}（manual 模式须人工确认后派发）', { p0: data?.factId ?? '' }))
      load()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  const confirmFact = async () => {
    if (confirmTarget === null) return
    setBusy(true)
    try {
      await client.otMappingConfirm({
        plantId: plantId ?? 'n-plant',
        factId: confirmTarget.factId,
        reason: '人工确认采集入账（OT-26）',
      })
      setNotice($t('事实 {p0} 已确认派发（走正常命令链路：幂等、审计、Outbox）', { p0: confirmTarget.factId }))
      setConfirmTarget(null)
      load()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
      setConfirmTarget(null)
    } finally {
      setBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('采集入账')} description={$t('采集值 → 业务事实（OT-26 显式映射＋确认规则）')}>
        <Message kind="warning" title={$t('无采集入账权限（ot.read）')}>{$t('未授予采集域查询许可，请联系管理员授权后使用。')}</Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('采集入账')}
      description={$t('采集值→业务事实须经版本化显式映射＋确认规则（OT-26）；由样本生成的业务事实走正常命令链路（幂等、审计、Outbox）')}
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>{$t('映射配置（版本化）')}</h3>
      <Table
        columns={[
          { key: 'deviceSerial', title: $t('设备') },
          { key: 'pointCode', title: $t('点位') },
          { key: 'factKindLabel', title: $t('映射事实') },
          {
            key: 'confirmMode',
            title: $t('确认规则'),
            render: (m) => <Badge tone={m.confirmMode === 'manual' ? 'warning' : 'info'}>{m.confirmModeLabel}</Badge>,
          },
          { key: 'version', title: $t('版本'), render: (m) => `v${m.version}` },
          {
            key: 'actions',
            title: $t('操作'),
            render: (m) =>
              canPost ? (
                <Button size="sm" onClick={() => void evaluate(m)} loading={busy}>
                  {$t('评估生成候选')}
                </Button>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>{$t('只读')}</span>
              ),
          },
        ]}
        rows={mappings}
        rowKey={(m) => m.mappingId}
        loading={mappings.length === 0}
        emptyText={$t('暂无映射配置')}
      />

      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{$t('事实候选（待确认 → 已派发）')}</h3>
      <Table
        columns={[
          { key: 'factId', title: $t('事实') },
          { key: 'factKindLabel', title: $t('类型') },
          { key: 'window', title: $t('窗口'), render: (f) => `${f.windowStart.slice(5, 16)} ~ ${f.windowEnd.slice(5, 16)}` },
          { key: 'value', title: $t('数值'), render: (f) => (f.factKind === 'stop_to_downtime' ? $t('{p0} 秒', { p0: f.value }) : `${f.value}`) },
          {
            key: 'status',
            title: $t('状态'),
            render: (f) => <Badge tone={f.status === 'dispatched' ? 'success' : 'warning'}>{f.statusLabel}</Badge>,
          },
          { key: 'confirmedBy', title: $t('确认人'), render: (f) => f.confirmedBy ?? '—' },
          { key: 'outbox', title: 'Outbox', render: (f) => f.outboxEventId ?? '—' },
          {
            key: 'actions',
            title: $t('操作'),
            render: (f) =>
              canPost && f.status === 'pending_confirm' ? (
                <Button size="sm" onClick={() => setConfirmTarget(f)}>{$t('人工确认')}</Button>
              ) : null,
          },
        ]}
        rows={facts}
        rowKey={(f) => f.factId}
        loading={facts.length === 0}
        emptyText={$t('暂无事实候选（先在上方评估生成）')}
      />

      <ConfirmModal
        open={confirmTarget !== null}
        title={$t('确认采集入账（OT-26）')}
        description={$t('确认后事实 {p0} 将派发走正常命令链路（幂等、审计、Outbox），不可重复确认；请核对窗口与数值。', { p0: confirmTarget?.factId ?? '' })}
        confirmText={$t('确认派发')}
        confirmLoading={busy}
        onConfirm={() => void confirmFact()}
        onCancel={() => setConfirmTarget(null)}
      />
    </PageContainer>
  )
}
