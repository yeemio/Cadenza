import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Message, PageContainer, Table, t as $t } from '@cadenza/ui'
import { formatP3Error, type OtGatewayEventView, type OtMonitorOverview } from '../../../../../packages/ui/src/api/p3'
import { createWebP3Client } from '../client'
import { OT_POST, OT_READ, useP3Permissions } from '../permissions'

/**
 * 采集监控页（OT-29 必监项总览）：边缘离线、采集延迟（含缺项 OT-28）、缓冲积压/溢出、
 * 去重计数异常；网关事件留痕（OT-06：注册/心跳恢复/离线/溢出，可查带时间）；巡检命令（ot.post）。
 */
export function OtMonitorPage() {
  const { has } = useP3Permissions()
  const canRead = has(OT_READ)
  const canPost = has(OT_POST)
  const client = useMemo(() => createWebP3Client(), [])
  const [overview, setOverview] = useState<OtMonitorOverview | null>(null)
  const [gatewayEvents, setGatewayEvents] = useState<OtGatewayEventView[] | null>(null)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (!canRead) return
    client
      .otMonitorOverview({})
      .then(setOverview)
      .catch((err: unknown) => setError(formatP3Error(err as { code?: string; message?: string; requestId?: string })))
    // 网关事件留痕（OT-06）：逐网关拉取后按时间倒序合并展示
    client
      .otListGateways({ page: 1, pageSize: 50 })
      .then((page) =>
        Promise.all(
          page.items.map((g) =>
            client
              .otGatewayEvents(g.gatewayCode)
              .then((events) => events)
              .catch(() => [] as OtGatewayEventView[]),
          ),
        ),
      )
      .then((groups) =>
        setGatewayEvents(
          groups
            .flat()
            .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
            .slice(0, 20),
        ),
      )
      .catch(() => setGatewayEvents([]))
  }, [canRead, client])

  useEffect(() => {
    load()
  }, [load])

  const patrol = async () => {
    setBusy(true)
    setNotice(null)
    setError(null)
    try {
      const resp = await client.otGatewayMonitor({ reason: '页面巡检（OT-29 心跳超时检查）' })
      const data = resp.data as { checked?: number; offline?: number } | null
      setNotice($t('巡检完成：检查 {p0} 个网关，离线 {p1} 个（离线事件已留痕并告警）', { p0: data?.checked ?? 0, p1: data?.offline ?? 0 }))
      load()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('采集监控')} description={$t('OT-29 必监项：边缘离线 / 采集延迟 / 缓冲积压溢出 / 去重异常')}>
        <Message kind="warning" title={$t('无采集监控权限（ot.read）')}>{$t('未授予采集域查询许可，请联系管理员授权后使用。')}</Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('采集监控')}
      description={$t('必监项总览（OT-29）：边缘离线、采集延迟、缓冲积压/溢出、去重计数异常；页面只消费汇总投影（OT-25）')}
      actions={canPost ? <Button onClick={() => void patrol()} loading={busy}>{$t('执行巡检')}</Button> : undefined}
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}

      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{$t('网关状态')}</h3>
      <Table
        columns={[
          { key: 'gatewayCode', title: $t('网关') },
          { key: 'status', title: $t('状态'), render: (g) => <Badge tone={g.status === 'online' ? 'success' : 'danger'}>{g.statusLabel}</Badge> },
          { key: 'heartbeat', title: $t('最后心跳'), render: (g) => g.lastHeartbeatAt ?? '—' },
          { key: 'stale', title: $t('心跳距今'), render: (g) => (g.staleSeconds === null ? '—' : $t('{p0} 秒', { p0: g.staleSeconds })) },
          { key: 'backlog', title: $t('缓冲积压'), render: (g) => (g.backlogCount > 0 ? <Badge tone="warning">{g.backlogCount} {$t('条')}</Badge> : `${g.backlogCount}`) },
        ]}
        rows={overview?.gateways ?? []}
        rowKey={(g) => g.gatewayCode}
        loading={overview === null}
        emptyText={$t('暂无网关注册')}
      />

      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{$t('设备采集延迟（OT-28：无样本显示缺项，不以估算冒充）')}</h3>
      <Table
        columns={[
          { key: 'deviceSerial', title: $t('设备序列号') },
          { key: 'equipmentCode', title: $t('设备编码'), render: (d) => d.equipmentCode ?? <Badge tone="warning">{$t('未映射（OT-07 隔离）')}</Badge> },
          { key: 'lastSampleAt', title: $t('最后样本'), render: (d) => d.lastSampleAt ?? '—' },
          {
            key: 'latency',
            title: $t('采集延迟'),
            render: (d) =>
              d.noData ? (
                <Badge tone="warning">{$t('缺项（无样本）')}</Badge>
              ) : (
                $t('{p0} 秒', { p0: d.latencySeconds ?? '—' })
              ),
          },
        ]}
        rows={overview?.deviceLatency ?? []}
        rowKey={(d) => d.deviceSerial}
        loading={overview === null}
      />

      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{$t('去重与溢出统计（OT-S5 可对账）')}</h3>
      <Table
        columns={[
          { key: 'statDate', title: $t('日期') },
          { key: 'gatewayCode', title: $t('网关') },
          { key: 'deviceSerial', title: $t('设备') },
          {
            key: 'dedupCount',
            title: $t('去重计数'),
            render: (r) => (r.dedupAnomaly ? <Badge tone="danger">{r.dedupCount}{$t('（异常）')}</Badge> : `${r.dedupCount}`),
          },
        ]}
        rows={overview?.dedup ?? []}
        rowKey={(r) => `${r.statDate}-${r.gatewayCode}-${r.deviceSerial}`}
        loading={overview === null}
        emptyText={$t('今日无去重记录')}
      />
      {overview !== null && overview.overflow.length > 0 ? (
        <Message
          kind="warning"
          title={$t('缓冲溢出告警（OT-17）：{p0}', { p0: overview.overflow.map((o) => `${o.gatewayCode}/${o.deviceSerial} ${$t('丢弃 {p0} 条', { p0: o.overflowCount })}`).join('；') })}
        >
          {$t('溢出丢弃最旧样本并记录统计（条数/时段/设备），不静默丢弃；请检查网关缓冲容量或网络。')}
        </Message>
      ) : null}

      <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>{$t('网关事件留痕（OT-06：注册/心跳恢复/离线/溢出，告警附恢复入口）')}</h3>
      <Table
        columns={[
          { key: 'gatewayCode', title: $t('网关') },
          {
            key: 'eventKind',
            title: $t('事件'),
            render: (e) => (
              <Badge tone={e.eventKind === 'offline' ? 'danger' : e.eventKind === 'overflow' ? 'warning' : 'info'}>{e.eventKindLabel}</Badge>
            ),
          },
          {
            key: 'detail',
            title: $t('详情'),
            render: (e) =>
              Object.entries(e.detail)
                .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                .join('；') || '—',
          },
          { key: 'occurredAt', title: $t('发生时间'), render: (e) => e.occurredAt.replace('T', ' ').slice(0, 19) },
          { key: 'createdBy', title: $t('操作者'), render: (e) => e.createdBy ?? $t('系统') },
        ]}
        rows={gatewayEvents ?? []}
        rowKey={(e) => e.eventId}
        loading={gatewayEvents === null}
        emptyText={$t('暂无网关事件')}
      />
    </PageContainer>
  )
}
