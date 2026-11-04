import { ApiError, Badge, Button, Field, Message, PageContainer, Select, ScanInput, formatErrorTitleAndDetail, type CommandIntent, type PutawayTaskDto, type StorageLocationDto, type WarehouseDto, t as $t } from '@cadenza/ui'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { WAREHOUSING_POST, usePermissions } from '../permissions'

const SLOT = 'pda.putaway'
export function PutawayScanPage() {
  const { has } = usePermissions()
  const canPost = has(WAREHOUSING_POST)
  const [tasks, setTasks] = useState<PutawayTaskDto[]>([])
  const [matched, setMatched] = useState<PutawayTaskDto[]>([])
  const [scanValue, setScanValue] = useState('')
  const [warehouses, setWarehouses] = useState<WarehouseDto[]>([])
  const [locations, setLocations] = useState<StorageLocationDto[]>([])
  const [target, setTarget] = useState('')
  const [intent, setIntent] = useState<CommandIntent | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const frozen = busy || !ready || intent !== null
  const plants = [...new Set(matched.map(t => t.plantId))]
  const plantId = plants.length === 1 ? plants[0]! : ''
  const showError = (err: unknown) => setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: err instanceof Error ? err.message : $t('操作失败') })
  const load = useCallback(async () => {
    const all: PutawayTaskDto[] = []
    for (let page = 1; ; page++) {
      const result = await api.listPutawayTasks({ page, pageSize: 100, statuses: 'pending' })
      all.push(...result.items)
      if (result.items.length < 100 || all.length >= result.total) break
    }
    setTasks(all)
  }, [])
  useEffect(() => {
    let active = true
    void api.readCommandIntent(SLOT).then(saved => {
      if (!active) return
      setIntent(saved); setReady(true)
      if (saved) { setTarget(String(saved.payload['toLocationId'] ?? '')); setScanValue(String(saved.payload['palletCode'] ?? '')) }
    }).catch(err => { if (active) showError(err) })
    void load().catch(showError)
    return () => { active = false }
  }, [load])
  useEffect(() => {
    let active = true
    setWarehouses([]); setLocations([])
    if (!plantId || intent) return
    void (async () => {
      const ws: WarehouseDto[] = [], ls: StorageLocationDto[] = []
      for (let page = 1; ; page++) {
        const result = await api.listWarehouses({ plantId, page, pageSize: 100 })
        ws.push(...result.items)
        if (result.items.length < 100 || ws.length >= result.total) break
      }
      for (let page = 1; ; page++) {
        const result = await api.listLocations({ plantId, page, pageSize: 100 })
        ls.push(...result.items)
        if (result.items.length < 100 || ls.length >= result.total) break
      }
      if (active) { setWarehouses(ws.filter(w => w.status === 'active' && w.warehouseType === 'WAREHOUSE')); setLocations(ls.filter(l => l.status === 'active' && l.locationKind === 'RACK')) }
    })().catch(err => { if (active) showError(err) })
    return () => { active = false }
  }, [plantId, intent])
  const candidates = locations.filter(l => warehouses.some(w => w.id === l.warehouseId) && matched.every(t => !t.targetWarehouseId || t.targetWarehouseId === l.warehouseId))
  function onScan(code: string) {
    if (frozen) return
    setScanValue(code); setTarget(''); setNotice(null); setError(null)
    const pallet = tasks.filter(t => t.palletCode === code)
    const found = pallet.length ? pallet : tasks.filter(t => t.unitNo === code)
    setMatched(found)
    if (!found.length) setError({ title: $t('未找到实际待入库任务，请刷新任务后核对单元号或托码') })
    else if (new Set(found.map(t => t.plantId)).size !== 1) setError({ title: $t('任务跨工厂，不能合并确认') })
  }
  async function settle() {
    if (!intent) return
    setBusy(true)
    try {
      await api.clearSettledCommandIntent(SLOT, intent.operationId)
      setIntent(null); setMatched([]); setScanValue(''); setTarget(''); setError(null)
      await load()
    } catch (err) { showError(err) } finally { setBusy(false) }
  }
  async function confirm() {
    if (!ready || busy) return
    const location = candidates.find(l => l.id === target)
    if (!intent && (!plantId || !matched.length || !location)) { setError({ title: $t('请选择实际任务及本工厂目标货架库位') }); return }
    setBusy(true); setError(null)
    try {
      const payload = intent?.payload ?? {
        plantId, taskIds: matched.map(t => t.id),
        ...(matched.every(t => t.palletCode === scanValue) ? { palletCode: scanValue } : {}),
        toWarehouseId: location!.warehouseId, toLocationId: location!.id, toLocationCode: location!.code,
      }
      const result = await api.executeCommandIntent(SLOT, 'putaway', payload)
      setIntent(await api.readCommandIntent(SLOT))
      setNotice($t('原操作已确认完成') + ' ' + result.operationId)
    } catch (err) {
      showError(err)
      try { setIntent(await api.readCommandIntent(SLOT)) } catch { setReady(false) }
    } finally { setBusy(false) }
  }
  return <PageContainer title={$t('入库扫码')} description={$t('实际任务决定工厂和货权；目标库位由工厂主数据选择')}>
    {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
    {notice ? <Message kind="success" title={notice} /> : null}
    {intent ? <Message kind="info" title={intent.state === 'committed' ? $t('已确认完成，请开始新作业') : intent.state === 'rejected' ? $t('已明确拒绝，可重新选择任务') : $t('原操作结果待确认，保留原任务和原操作键')} detail={intent.operationId + '｜' + String(intent.payload['toLocationCode'] ?? '')} /> : null}
    <fieldset disabled={frozen} style={{ border: 0, padding: 0, margin: 0 }}>
      <ScanInput onScan={onScan} hint={$t('扫描实际单元号或整托托码')} />
      <Button variant="secondary" onClick={() => { setMatched([]); setTarget(''); void load().catch(showError) }}>{$t('刷新任务')}</Button>
      {matched.map(task => <p key={task.id}>{task.materialCode}｜{task.quantity} {task.uomCode}｜{task.sourceRef}</p>)}
      <Field label={$t('目标货架库位')} required><Select value={target} onChange={e => setTarget(e.target.value)} placeholder={$t('选择实际库位')} options={candidates.map(l => ({ value: l.id, label: `${warehouses.find(w => w.id === l.warehouseId)?.name ?? ''} ${l.code}` }))} /></Field>
    </fieldset>
    {intent?.state === 'committed' || intent?.state === 'rejected'
      ? <Button loading={busy} onClick={() => void settle()}>{intent.state === 'committed' ? $t('开始新作业') : $t('确认选择为新操作')}</Button>
      : <Button block size="lg" loading={busy} disabled={!canPost || !ready || busy || (!intent && (!plantId || !target))} onClick={() => void confirm()}>{intent ? $t('以原操作键确认结果') : $t('确认入库')}</Button>}
    {!canPost ? <Badge tone="warning">{$t('需 warehousing.post 许可')}</Badge> : null}
  </PageContainer>
}
