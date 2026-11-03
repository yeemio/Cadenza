import { useState } from 'react'
import { Badge, Button, Input, Message, PageContainer, ScanInput, Select, t as $t } from '@cadenza/ui'
import type { PalletScanResultDto, PalletTaskType } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REWORK_POST, REWORK_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

/**
 * PDA 分托/解绑页（T15，RS-13～22）：
 * - 首次扫码生成进行中任务；同一人同一类型仅一条进行中（RS-14）；
 * - 分托须传分入托码（RS-19）；非车间人员新托须选库位（RS-15，服务端按部门类别分叉）；
 * - 拒绝清单以 [RS-16]/[RS-22] 返回：托码/不存在/一码多物/不在库/已锁定/盘点中等；
 * - 确认=写任务与快照；放弃=已扫分入托码但无料品码时解除全部锁定并删记录（RS-21）。
 */
export function PalletTaskPdaPage() {
  const { has } = useP2PdaPermissions()
  const canPost = has(REWORK_POST) && has(REWORK_READ)
  const [taskType, setTaskType] = useState<PalletTaskType>('pallet_split')
  const [targetPalletCode, setTargetPalletCode] = useState('')
  const [locationCode, setLocationCode] = useState('')
  const [session, setSession] = useState<PalletScanResultDto | null>(null)
  const [scanned, setScanned] = useState<string[]>([])
  const [scanError, setScanError] = useState<{ title: string; detail?: string } | null>(null)
  const action = usePdaAction()

  if (!canPost) {
    return (
      <PageContainer title={$t('分托/解绑')} description={$t('分托=改绑托码，解绑=清除托码（RS-13/14）')}>
        <Message kind="warning" title={$t('没有倒轴域操作许可（rework.read + rework.post）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const onScan = async (code: string) => {
    setScanError(null)
    if (taskType === 'pallet_split' && targetPalletCode.trim() === '') {
      setSession(null)
      setScanError({ title: $t('分托须先填分入托码（RS-19）') })
      return
    }
    try {
      const result = await p2Api.palletScan({
        taskType,
        targetPalletCode: taskType === 'pallet_split' ? targetPalletCode.trim() : undefined,
        locationCode: locationCode.trim() || undefined,
        code,
      })
      setSession(result)
      setScanned((prev) => [...prev, code])
    } catch (err) {
      // PC-05：错码不改变会话对象，仅提示
      setScanError(err instanceof Error ? { title: $t('扫码被拒绝'), detail: err.message } : { title: $t('扫码失败') })
    }
  }

  const confirm = async () => {
    if (!session) return
    const ok = await action.run(() => p2Api.palletConfirm(session.task.id), $t('任务已确认：锁定解除并写台账（RS-19）'))
    if (ok) {
      setSession(null)
      setScanned([])
    }
  }

  const abandon = async () => {
    if (!session) return
    const ok = await action.run(() => p2Api.palletAbandon(session.task.id), $t('已放弃：解除全部锁定并删除进行中记录（RS-21）'))
    if (ok) {
      setSession(null)
      setScanned([])
    }
  }

  return (
    <PageContainer
      title={$t('分托/解绑')}
      description={$t('首次扫码生成进行中任务（RS-14）；快照列＝扫码时点事实（RS-17）；Web 台账仅见已完成')}
    >
      <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
        <Select
          aria-label={$t('任务类型')}
          value={taskType}
          onChange={(e) => {
            setTaskType(e.target.value as PalletTaskType)
            setSession(null)
            setScanned([])
          }}
          options={[
            { value: 'pallet_split', label: $t('分托（改绑托码）') },
            { value: 'pallet_unbind', label: $t('解绑（清除托码）') },
          ]}
        />
        {taskType === 'pallet_split' ? (
          <>
            <Input placeholder={$t('分入托码（必填，RS-19）')} value={targetPalletCode} onChange={(e) => setTargetPalletCode(e.target.value)} />
            <Input placeholder={$t('新托库位（非车间人员必填，RS-15）')} value={locationCode} onChange={(e) => setLocationCode(e.target.value)} />
          </>
        ) : null}
      </div>
      <ScanInput onScan={(c) => void onScan(c)} hint={$t('扫料品码装入任务；托码/不在库/已锁定/盘点中将被拒绝（RS-16/22）')} />
      <section style={{ marginTop: 12 }}>
        {scanError ? <Message kind="error" title={scanError.title} detail={scanError.detail} /> : null}
        {session ? (
          <div style={{ fontSize: 13.5, lineHeight: 1.9 }}>
            <p style={{ margin: 0 }}>
              {$t('进行中任务')} <Badge tone="info">{$t('已扫')} {scanned.length} {$t('件')}</Badge>
              {session.task.targetPalletCode ? $t('｜分入托 {p0}', { p0: session.task.targetPalletCode }) : $t('｜解绑模式')}
            </p>
            <p style={{ margin: 0 }}>
              {$t('最近扫码：')}<b>{session.scanned.unitNo}</b>{$t('｜')}{session.scanned.materialName}{$t('｜')}{session.scanned.quantity}{' '}
              {session.scanned.uom}{$t('｜')}{session.scanned.warehouseName ?? '—'} {session.scanned.locationCode ?? ''}
            </p>
            <div style={{ display: 'inline-flex', gap: 8, marginTop: 8 }}>
              <Button size="sm" disabled={scanned.length === 0} loading={action.busy} onClick={() => void confirm()}>
                {$t('确认任务（RS-19）')}
              </Button>
              <Button size="sm" variant="danger" onClick={() => void abandon()}>
                {$t('放弃（RS-21，解除全部锁定）')}
              </Button>
            </div>
          </div>
        ) : (
          <Message kind="info" title={$t('等待扫码')}>{$t('首次扫码将生成进行中任务（RS-14）。')}</Message>
        )}
      </section>
      <section style={{ marginTop: 12 }}>
        {action.error ? <Message kind="error" title={action.error.title} detail={action.error.detail} /> : null}
        {action.success ? <Message kind="success" title={action.success} /> : null}
      </section>
    </PageContainer>
  )
}
