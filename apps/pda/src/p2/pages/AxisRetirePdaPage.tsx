import { useState } from 'react'
import { Button, Input, Message, PageContainer, ScanInput, t as $t } from '@cadenza/ui'
import type { AxisRetireScanDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REWORK_POST, REWORK_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

/**
 * PDA 轴码退役页（T15，RS-34～37）：
 * - 可执行前置（RS-34）：质检已完成、报工已审核、无未审核成品轴信息、未入成品仓在库；
 * - 执行＝写清空记录快照并逻辑退役（RS-35，不物理删行）；
 * - 退役后全部库存命令入口显式拒绝、追溯可查（RS-36）；事务内完成（RS-37）。
 */
export function AxisRetirePdaPage() {
  const { has } = useP2PdaPermissions()
  const canPost = has(REWORK_POST) && has(REWORK_READ)
  const [view, setView] = useState<AxisRetireScanDto | null>(null)
  const [scanError, setScanError] = useState<{ title: string; detail?: string } | null>(null)
  const [reason, setReason] = useState('')
  const action = usePdaAction()

  if (!canPost) {
    return (
      <PageContainer title={$t('轴码退役')} description={$t('清空轴码库存并退役（RS-34～37）')}>
        <Message kind="warning" title={$t('没有倒轴域操作许可（rework.read + rework.post）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const onScan = async (code: string) => {
    setView(null)
    setScanError(null)
    try {
      setView(await p2Api.scanAxisRetire(code))
    } catch (err) {
      setScanError(err instanceof Error ? { title: $t('该轴码不可清空（RS-34）'), detail: err.message } : { title: $t('扫码失败') })
    }
  }

  const submit = async () => {
    if (!view) return
    const ok = await action.run(() => p2Api.executeAxisRetire({ unitNo: view.unitNo, reason: reason || undefined }), $t('轴码已退役：写清空记录快照（RS-35/37）'))
    if (ok) {
      setView(null)
      setReason('')
    }
  }

  return (
    <PageContainer title={$t('轴码退役')} description={$t('逻辑退役不物理删行（RS-35）；退役后库存命令拒绝、追溯可查（RS-36）')}>
      <ScanInput onScan={(c) => void onScan(c)} hint={$t('扫产品轴码；须质检已完成、报工已审核且未入成品仓在库（RS-34）')} />
      <section style={{ marginTop: 12 }}>
        {scanError ? <Message kind="error" title={scanError.title} detail={scanError.detail} /> : null}
        {view ? (
          <div style={{ fontSize: 13.5, lineHeight: 1.9 }}>
            <p style={{ margin: 0 }}>
              <b>{view.unitNo}</b>{$t('｜')}{view.materialName}{$t('｜数量')} {view.quantity} {view.uom}
            </p>
            <p style={{ margin: 0, fontSize: 12.5 }}>
              {$t('质检')} {view.qualityCompleted ? $t('已完成') : $t('未完成')}{$t('｜报工')} {view.reportReviewed ? $t('已审核') : $t('未审核')}{$t('｜')}
              {view.inFinishedWarehouse ? $t('已入成品仓在库（不可清空）') : $t('未入成品仓在库（可清空）')}
            </p>
            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              <Input placeholder={$t('退役原因（选填）')} value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button
                variant="danger"
                loading={action.busy}
                disabled={!view.qualityCompleted || !view.reportReviewed || view.inFinishedWarehouse}
                onClick={() => void submit()}
              >
                {$t('确认清空并退役（RS-35）')}
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
