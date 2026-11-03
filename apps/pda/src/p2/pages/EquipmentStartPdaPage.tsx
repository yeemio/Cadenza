import { useState } from 'react'
import { Badge, Button, Message, PageContainer, ScanInput, t as $t } from '@cadenza/ui'
import { EQUIPMENT_STATUS_P2_LABELS, type EquipmentScanViewDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { MAINTENANCE_POST, MAINTENANCE_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

/**
 * PDA 设备开工页（T19，MT-05/06）：
 * - 开工仅限状态=正常的设备（MT-05）；
 * - 按（设备, 业务日）幂等：当日重复开工＝更新当日开工时间，不产生第二条记录（MT-06）。
 */
export function EquipmentStartPdaPage() {
  const { has } = useP2PdaPermissions()
  const canPost = has(MAINTENANCE_POST) && has(MAINTENANCE_READ)
  const [view, setView] = useState<EquipmentScanViewDto | null>(null)
  const [scanError, setScanError] = useState<{ title: string; detail?: string } | null>(null)
  const action = usePdaAction()

  if (!canPost) {
    return (
      <PageContainer title={$t('设备开工')} description={$t('当日开工登记（MT-05/06）')}>
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
      setView(await p2Api.scanEquipment(code))
    } catch (err) {
      setScanError(err instanceof Error ? { title: $t('设备不存在（MT-04）'), detail: err.message } : { title: $t('扫码失败') })
    }
  }

  const start = async () => {
    if (!view) return
    const ok = await action.run(() => p2Api.startEquipment({ equipmentId: view.equipmentId }), $t('开工已登记（当日重复开工＝更新时间，MT-06 幂等）'))
    if (ok) {
      const fresh = await p2Api.scanEquipment(view.code).catch(() => null)
      setView(fresh)
    }
  }

  return (
    <PageContainer title={$t('设备开工')} description={$t('仅状态=正常可开工（MT-05）；按（设备,业务日）幂等（MT-06）')}>
      <ScanInput onScan={(c) => void onScan(c)} hint={$t('扫设备码（EQU- 前缀宽容识别）')} />
      <section style={{ marginTop: 12 }}>
        {scanError ? <Message kind="error" title={scanError.title} detail={scanError.detail} /> : null}
        {view ? (
          <div style={{ fontSize: 13.5, lineHeight: 1.9 }}>
            <p style={{ margin: 0 }}>
              <b>{view.code}</b>{$t('｜')}{view.name}{$t('｜当前')} <Badge tone={view.status === 1 ? 'success' : 'danger'}>{EQUIPMENT_STATUS_P2_LABELS[view.status]}</Badge>
              {view.startedWorkTodayAt ? (
                <>
                  {$t('｜今日开工')} <Badge tone="info">{new Date(view.startedWorkTodayAt).toLocaleTimeString('zh-CN')}</Badge>
                </>
              ) : $t('｜今日未开工')}
            </p>
            <Button style={{ marginTop: 8 }} loading={action.busy} disabled={view.status !== 1} onClick={() => void start()}>
              {view.startedWorkTodayAt ? $t('更新开工时间（幂等）') : $t('开工')}
            </Button>
            {view.status !== 1 ? (
              <p style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)', margin: '6px 0 0' }}>
                {$t('维修中设备不可开工（MT-05）。')}
              </p>
            ) : null}
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
