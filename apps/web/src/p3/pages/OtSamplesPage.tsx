import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, Field, Input, Message, Modal, PageContainer, Select, Table, t as $t } from '@cadenza/ui'
import {
  formatP3Error,
  type OtAggregateView,
  type OtDeviceView,
  type OtSampleView,
} from '../../../../../packages/ui/src/api/p3'
import { createWebP3Client } from '../client'
import { OT_POST, OT_READ, useP3Permissions } from '../permissions'
import { P3_PAGE_SIZE, useP3AsyncList } from '../shared'

/**
 * 采集样本页（OT-25 按设备收敛 + OT-22 坏点/偏差可查带原因 + OT-13 会话人工绑定）：
 * - 必须先选设备（服务端终校 deviceSerial 必填，[OT-25]）；
 * - 坏点/时钟偏差/迟到/隔离筛选；双轨时间分列（事件时间/接收时间，OT-09）；
 * - 汇总投影段（OT-25：页面只消费汇总投影，带更新时间与延迟标注＋坏点率 OT-22）；
 * - 待确认/未关联样本可人工绑定工序会话（ot.post，留痕）。
 */
export function OtSamplesPage() {
  const { has, plantId } = useP3Permissions()
  const canRead = has(OT_READ)
  const canPost = has(OT_POST)
  const client = useMemo(() => createWebP3Client(), [])
  const [devices, setDevices] = useState<OtDeviceView[]>([])
  const [deviceSerial, setDeviceSerial] = useState('')
  const [filterBad, setFilterBad] = useState(false)
  const [filterSkew, setFilterSkew] = useState(false)
  const [aggregates, setAggregates] = useState<OtAggregateView[] | null>(null)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [linkTarget, setLinkTarget] = useState<OtSampleView | null>(null)
  const [linkSession, setLinkSession] = useState('')
  const [linkBusy, setLinkBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!canRead) return
    client
      .otListDevices({ page: 1, pageSize: 50 })
      .then((page) => setDevices(page.items))
      .catch(() => setDevices([]))
  }, [canRead, client])

  /** OT-25：未选设备不发起查询（服务端同样拒绝）；样本明细服务端分页（PC-16）。 */
  const samples = useP3AsyncList<OtSampleView>(
    (page) =>
      deviceSerial === ''
        ? Promise.resolve({ items: [], total: 0 })
        : client.otListSamples({
            deviceSerial,
            isBad: filterBad || undefined,
            isClockSkew: filterSkew || undefined,
            page,
            pageSize: P3_PAGE_SIZE,
          }),
    [deviceSerial, filterBad, filterSkew],
  )

  useEffect(() => {
    if (!canRead || deviceSerial === '') {
      setAggregates(null)
      return
    }
    client
      .otListAggregates({ deviceSerial, page: 1, pageSize: 10 })
      .then((page) => setAggregates(page.items))
      .catch(() => setAggregates([]))
  }, [canRead, client, deviceSerial])

  const submitLink = async () => {
    if (linkTarget === null) return
    if (!linkSession.trim()) {
      setError({ title: $t('会话 ID 不能为空（解除绑定请在会话框输入 UNLINK 后确认）') })
      return
    }
    setLinkBusy(true)
    try {
      const unlink = linkSession.trim() === 'UNLINK'
      await client.otSessionLink({
        plantId: plantId ?? 'n-plant',
        sampleId: linkTarget.sampleId,
        sessionId: unlink ? null : linkSession.trim(),
        reason: unlink ? '解除错误关联' : '样本-工序会话人工绑定',
      })
      setNotice($t('样本 {p0} 已{p1}（OT-13 留痕，不自动静默改绑）', { p0: linkTarget.sampleId, p1: unlink ? '解除绑定' : '人工绑定' }))
      setLinkTarget(null)
      setLinkSession('')
      samples.reload()
    } catch (err) {
      setError(formatP3Error(err as { code?: string; message?: string; requestId?: string }))
    } finally {
      setLinkBusy(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('采集样本')} description={$t('样本明细按设备收敛查询（OT-25）')}>
        <Message kind="warning" title={$t('无采集样本权限（ot.read）')}>{$t('未授予采集域查询许可，请联系管理员授权后使用。')}</Message>
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('采集样本')}
      description={$t('样本明细按设备收敛（OT-25 页面不扫高频原始点位）；坏点/偏差保留可查带原因（OT-22）；时间双轨分列（OT-09）')}
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}
      {samples.error ? <Message kind="error" title={samples.error.title} detail={samples.error.detail} /> : null}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ minWidth: 260 }}>
          <Field label={$t('设备序列号（必选）')} hint={$t('未选择设备时不发起查询——服务端同样拒绝（[OT-25]）')}>
            <Select
              aria-label={$t('设备序列号')}
              placeholder={$t('请选择设备')}
              value={deviceSerial}
              options={devices.map((d) => ({
                value: d.deviceSerial,
                label: $t('{p0}{p1}', { p0: d.deviceSerial, p1: d.equipmentCode === null ? $t('（未映射·隔离态）') : $t('（{p0}）', { p0: d.equipmentCode }) }),
              }))}
              onChange={(e) => setDeviceSerial(e.target.value)}
            />
          </Field>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, paddingTop: 26 }}>
          <input type="checkbox" checked={filterBad} onChange={(e) => setFilterBad(e.target.checked)} /> {$t('只看坏点')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, paddingTop: 26 }}>
          <input type="checkbox" checked={filterSkew} onChange={(e) => setFilterSkew(e.target.checked)} /> {$t('只看时钟偏差')}
        </label>
      </div>

      {deviceSerial === '' ? (
        <Message kind="info" title={$t('请先选择设备（OT-25：样本明细必须按设备收敛）')} />
      ) : (
        <>
          <Table
            columns={[
              { key: 'pointCode', title: $t('点位') },
              { key: 'raw', title: $t('原始值＋单位'), render: (s) => `${s.rawValue} ${s.rawUnit}` },
              { key: 'normalized', title: $t('归一值'), render: (s) => s.normalizedValue ?? (s.conversionMissing ? <Badge tone="warning">{$t('缺换算')}</Badge> : '—') },
              { key: 'quality', title: $t('质量码'), render: (s) => <Badge tone={s.qualityLevel === 'good' ? 'success' : s.qualityLevel === 'bad' ? 'danger' : 'warning'}>{s.qualityLabel}</Badge> },
              {
                key: 'flags',
                title: $t('标记'),
                render: (s) => (
                  <>
                    {s.isBad ? <Badge tone="danger">{$t('坏点：')}{s.badReasons.map((r) => r.label).join('＋')}</Badge> : null}
                    {s.isClockSkew ? <Badge tone="warning">{$t('时钟偏差（')}{s.clockSkewLabel}{$t('）')}</Badge> : null}
                    {s.isLate ? <Badge tone="info">{$t('迟到')}</Badge> : null}
                    {s.calibrationSuspect ? <Badge tone="warning">{$t('校准状态可疑（OT-12）')}</Badge> : null}
                    {s.isQuarantined ? <Badge tone="warning">{$t('隔离：')}{s.quarantineReason}</Badge> : null}
                  </>
                ),
              },
              { key: 'eventTime', title: $t('事件时间（设备侧）') },
              { key: 'receivedAt', title: $t('接收时间（服务端）') },
              {
                key: 'session',
                title: $t('工序关联'),
                render: (s) => (
                  <>
                    <span>{s.sessionLinkStatusLabel}</span>
                    {canPost && (s.sessionLinkStatus === 'pending_confirm' || s.sessionLinkStatus === 'unlinked') ? (
                      <Button size="sm" variant="ghost" style={{ marginLeft: 6 }} onClick={() => setLinkTarget(s)}>
                        {$t('人工绑定')}
                      </Button>
                    ) : null}
                  </>
                ),
              },
            ]}
            rows={samples.items}
            rowKey={(s) => s.sampleId}
            loading={samples.loading}
            page={{ page: samples.page, pageSize: P3_PAGE_SIZE }}
            total={samples.total}
            onPageChange={samples.setPage}
            emptyText={$t('该设备在筛选条件下暂无样本')}
          />

          <h3 style={{ fontSize: 15, margin: '16px 0 8px' }}>
            {$t('汇总投影（OT-25：页面只消费投影；带更新时间与延迟标注；坏点率 OT-22）')}
          </h3>
          <Table
            columns={[
              { key: 'pointCode', title: $t('点位') },
              {
                key: 'granularity',
                title: $t('粒度'),
                render: (a) => (a.granularity === 'minute' ? $t('分钟') : a.granularity === 'shift' ? $t('班次') : String(a.granularity)),
              },
              { key: 'windowStart', title: $t('窗口起'), render: (a) => a.windowStart.replace('T', ' ').slice(0, 16) },
              { key: 'sampleCount', title: $t('样本数'), render: (a) => $t('{p0}（好 {p1}／坏 {p2}／偏差 {p3}）', { p0: a.sampleCount, p1: a.goodCount, p2: a.badCount, p3: a.skewCount }) },
              {
                key: 'badRate',
                title: $t('坏点率'),
                render: (a) => (a.badRate === null ? '—' : <Badge tone={a.badRate > 0.05 ? 'danger' : a.badRate > 0.01 ? 'warning' : 'success'}>{(a.badRate * 100).toFixed(2)}%</Badge>),
              },
              { key: 'sumValue', title: $t('累计值') },
              { key: 'range', title: $t('最小/最大'), render: (a) => `${a.minValue ?? '—'} / ${a.maxValue ?? '—'}` },
              {
                key: 'updatedAt',
                title: $t('投影更新（OT-25 延迟标注）'),
                render: (a) => $t('{p0}（延迟 {p1} 秒）', { p0: a.updatedAt.replace('T', ' ').slice(0, 16), p1: a.dataLagSeconds }),
              },
            ]}
            rows={aggregates ?? []}
            rowKey={(a) => a.aggregateId}
            loading={aggregates === null}
            emptyText={$t('该设备暂无汇总投影（OT-S4：班次粒度由显式重建命令生成）')}
          />
        </>
      )}

      <Modal
        open={linkTarget !== null}
        title={$t('样本-工序会话人工绑定（OT-13）')}
        onClose={() => setLinkTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setLinkTarget(null)}>{$t('取消')}</Button>
            <Button loading={linkBusy} onClick={() => void submitLink()}>{$t('确认绑定')}</Button>
          </>
        }
      >
        <p style={{ fontSize: 13, color: 'var(--cz-color-text-secondary)' }}>
          {$t('样本')} {linkTarget?.sampleId}{$t('（')}{linkTarget?.pointCode}{$t('）：绑定结果人工留痕，不自动静默改绑；输入 UNLINK 解除绑定。')}
        </p>
        <Field label={$t('工序会话 ID')} required hint={$t('例如 exec-20261028-a；UNLINK=解除绑定')}>
          <Input value={linkSession} onChange={(e) => setLinkSession(e.target.value)} placeholder="exec-…" aria-label={$t('工序会话 ID')} />
        </Field>
      </Modal>
    </PageContainer>
  )
}
