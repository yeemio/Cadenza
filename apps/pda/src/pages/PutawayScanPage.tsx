import { ApiError, Badge, Button, Message, PageContainer, Select, ScanInput, formatErrorTitleAndDetail, type PutawayTaskDto, t as $t } from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { WAREHOUSING_POST, usePermissions } from '../permissions'

const TARGET_OPTIONS = [
  { value: 'wh-0103|loc-01030001|01030001', label: '成品一库 01030001' },
  { value: 'wh-0202|loc-02020001|02020001', label: '绞制线边仓 02020001' },
]

/**
 * PDA 入库扫码页（A-T13-1/2）：
 * 扫单元号/托码 → 匹配待入库任务（任务台账只读；托码=整托）→ 选目标库位 → 确认入库。
 */
export function PutawayScanPage() {
  const { has } = usePermissions()
  const canPost = has(WAREHOUSING_POST)
  const [tasks, setTasks] = useState<PutawayTaskDto[]>([])
  const [scanValue, setScanValue] = useState('')
  const [matched, setMatched] = useState<PutawayTaskDto[]>([])
  const [target, setTarget] = useState(TARGET_OPTIONS[0]!.value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .listPutawayTasks({ page: 1, pageSize: 20, statuses: 'pending' })
      .then((result) => setTasks(result.items))
      .catch(() => setTasks([]))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const onScan = (code: string) => {
    setScanValue(code)
    setError(null)
    setNotice(null)
    if (code.startsWith('PLT-')) {
      const palletTasks = tasks.filter((t) => t.palletCode === code)
      setMatched(palletTasks)
      if (palletTasks.length === 0) {
        setError({ title: $t('托码 {p0} 无待入库任务（或已入库）', { p0: code }) })
      }
      return
    }
    const unitTasks = tasks.filter((t) => t.unitNo === code)
    setMatched(unitTasks)
    if (unitTasks.length === 0) {
      setError({ title: $t('单元 {p0} 无待入库任务（台账由报工/质检异步写入，A-T13-1；可点「刷新任务」）', { p0: code }) })
    }
  }

  const confirm = async () => {
    if (matched.length === 0) {
      setError({ title: $t('请先扫码匹配待入库任务') })
      return
    }
    const [toWarehouseId, toLocationId, toLocationCode] = target.split('|')
    setBusy(true)
    setError(null)
    try {
      const result = await api.putawayConfirm({
        plantId: 'n-plant',
        ...(scanValue.startsWith('PLT-') ? { palletCode: scanValue } : { taskIds: matched.map((t) => t.id) }),
        toWarehouseId,
        toWarehouseCode: toWarehouseId === 'wh-0103' ? '0103' : '0202',
        toLocationId,
        toLocationCode,
        ownerId: 'owner-1',
        ownerName: '中辰电缆制造有限公司',
      })
      const data = (result.data ?? {}) as { confirmedCount?: number }
      setNotice($t('确认入库完成（{p0} 条任务{p1}）', { p0: data.confirmedCount ?? 0, p1: scanValue.startsWith('PLT-') ? $t('，整托') : '' }))
      setMatched([])
      setScanValue('')
      load()
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('确认入库失败') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageContainer title={$t('入库扫码')} description={$t('扫单元号或托码 → 匹配待入库任务 → 确认入库（托码=整托 A-T13-2）')}>
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {notice ? <Message kind="success" title={notice} /> : null}
      <ScanInput onScan={onScan} hint={$t('演示：U-2026-1002-0032（单元）或 PLT-2026-001（托码整托）')} />
      <div style={{ marginTop: 10 }}>
        <Button size="sm" variant="secondary" onClick={() => load()}>
          {$t('刷新任务')}
        </Button>
      </div>
      {matched.length > 0 ? (
        <section style={{ marginTop: 12, border: '1px solid var(--cz-color-border)', borderRadius: 8, padding: 12, background: 'var(--cz-color-bg-surface)' }}>
          <h3 style={{ fontSize: 14, margin: '0 0 8px' }}>{$t('匹配到')} {matched.length} {$t('条待入库任务')}</h3>
          {matched.map((task) => (
            <p key={task.id} style={{ fontSize: 13.5, margin: '0 0 6px' }}>
              {task.materialCode}{$t('｜')}<b>{task.quantity}</b> <b style={{ fontSize: 12 }}>{task.uomCode}</b>{$t('｜来源')} {task.sourceRef}
            </p>
          ))}
          <FieldWrap>
            <Select value={target} onChange={(e) => setTarget(e.target.value)} options={TARGET_OPTIONS} aria-label={$t('目标库位')} />
          </FieldWrap>
          <Button block size="lg" loading={busy} disabled={!canPost} onClick={() => void confirm()} style={{ marginTop: 10 }}>
            {$t('确认入库')}
          </Button>
          {!canPost ? <Badge tone="warning">{$t('需 warehousing.post 许可')}</Badge> : null}
        </section>
      ) : (
        <Message kind="info" title={$t('当前待入库任务（前 5 条）')}>
          {tasks.slice(0, 5).map((t) => `${t.unitNo ?? t.palletCode ?? t.id}（${t.quantity} ${t.uomCode}）`).join('；') || $t('无')}
        </Message>
      )}
    </PageContainer>
  )
}

function FieldWrap({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: 8 }}>{children}</div>
}
