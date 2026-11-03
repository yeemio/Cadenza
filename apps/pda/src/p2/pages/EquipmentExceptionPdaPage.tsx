import { useState } from 'react'
import { Badge, Button, Message, PageContainer, ScanInput, Select, Textarea, t as $t } from '@cadenza/ui'
import { EQUIPMENT_STATUS_P2_LABELS, type EquipmentScanViewDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { MAINTENANCE_POST, MAINTENANCE_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

/**
 * PDA 设备异常上报页（T19，MT-01/03/04/13）：
 * - 扫设备码带出档案与当前状态（EQU- 前缀剥离匹配，识别宽容生成严格，MT-04）；
 * - 状态仅 2 值（1=正常 2=维修，MT-01）；状态相同不产生流水（MT-03）；
 * - 置"维修"可关联在单工单（是否强制 GAP-F23 待裁，不强制）；
 * - Web 行内同命令同守卫（PC-08/10）。
 */
export function EquipmentExceptionPdaPage() {
  const { has } = useP2PdaPermissions()
  const canPost = has(MAINTENANCE_POST) && has(MAINTENANCE_READ)
  const [view, setView] = useState<EquipmentScanViewDto | null>(null)
  const [scanError, setScanError] = useState<{ title: string; detail?: string } | null>(null)
  const [status, setStatus] = useState<'1' | '2'>('2')
  const [description, setDescription] = useState('')
  const action = usePdaAction()

  if (!canPost) {
    return (
      <PageContainer title={$t('设备异常上报')} description={$t('设备状态变更与建单（MT-01/03/04/13）')}>
        <Message kind="warning" title={$t('没有维护域操作许可（maintenance.read + maintenance.post）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const onScan = async (code: string) => {
    setView(null)
    setScanError(null)
    try {
      const v = await p2Api.scanEquipment(code)
      setView(v)
      setStatus(v.status === 1 ? '2' : '1')
    } catch (err) {
      setScanError(err instanceof Error ? { title: $t('设备不存在（MT-04）'), detail: err.message } : { title: $t('扫码失败') })
    }
  }

  const submit = async () => {
    if (!view) return
    const ok = await action.run(
      () => p2Api.changeEquipmentStatus({ equipmentId: view.equipmentId, status: Number(status) as 1 | 2, relatedOrderId: view.openOrderId ?? undefined }),
      $t('状态已变更为「{p0}」（MT-03）', { p0: EQUIPMENT_STATUS_P2_LABELS[Number(status) as 1 | 2] }),
    )
    if (ok) {
      const fresh = await p2Api.scanEquipment(view.code).catch(() => null)
      setView(fresh)
    }
  }

  const createOrder = async () => {
    if (!view || description.trim() === '') return
    const ok = await action.run(() => p2Api.createMaintenanceOrder({ equipmentId: view.equipmentId, description }), $t('维修工单已创建（MT-13）'))
    if (ok) setDescription('')
  }

  return (
    <PageContainer title={$t('设备异常上报')} description={$t('状态仅 1=正常 2=维修（MT-01）；状态相同不产生流水（MT-03）；置维修建议关联在单工单（GAP-F23）')}>
      <ScanInput onScan={(c) => void onScan(c)} hint={$t('扫设备码（EQU- 前缀宽容识别，MT-04）')} />
      <section style={{ marginTop: 12 }}>
        {scanError ? <Message kind="error" title={scanError.title} detail={scanError.detail} /> : null}
        {view ? (
          <div style={{ fontSize: 13.5, lineHeight: 1.9 }}>
            <p style={{ margin: 0 }}>
              <b>{view.code}</b>{$t('｜')}{view.name}{$t('｜当前')}{' '}
              <Badge tone={view.status === 1 ? 'success' : 'danger'}>{EQUIPMENT_STATUS_P2_LABELS[view.status]}</Badge>
              {view.openOrderId ? $t('｜在单工单 {p0}', { p0: view.openOrderId }) : ''}
              {view.startedWorkTodayAt ? $t('｜今日已开工 {p0}', { p0: new Date(view.startedWorkTodayAt).toLocaleTimeString('zh-CN') }) : ''}
            </p>
            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              <Select
                aria-label={$t('目标状态')}
                value={status}
                onChange={(e) => setStatus(e.target.value as '1' | '2')}
                options={[
                  { value: '1', label: $t('正常（1）') },
                  { value: '2', label: $t('维修（2）') },
                ]}
              />
              <Button loading={action.busy} onClick={() => void submit()}>
                {$t('提交状态变更')}
              </Button>
              <Textarea aria-label={$t('故障描述')} placeholder={$t('故障描述（建维修工单用，MT-13）')} value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: '100%' }} />
              <Button variant="secondary" loading={action.busy} disabled={description.trim() === ''} onClick={() => void createOrder()}>
                {$t('创建维修工单（MT-13）')}
              </Button>
            </div>
          </div>
        ) : null}
      </section>
      <section style={{ marginTop: 12 }}>
        {action.error ? <Message kind="error" title={action.error.title} detail={action.error.detail} /> : null}
        {action.success ? <Message kind="success" title={action.success} /> : null}
      </section>
    </PageContainer>
  )
}
