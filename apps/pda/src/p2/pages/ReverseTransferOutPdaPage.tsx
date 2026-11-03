import { useState } from 'react'
import { Badge, Button, Input, Message, PageContainer, ScanInput, t as $t } from '@cadenza/ui'
import { p2Api } from '../api'
import { REVERSE_POST, REVERSE_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

/**
 * PDA 调拨出库页（T17，WR-07②/09/11）：
 * - 无任务单模式：首扫即建单（PDA 无任务），Web 完成出库前不显示（WR-07②）；
 * - 码装入校验（WR-09）：不在库/质检未通过/已锁定/剩余为 0/仓库不匹配/仓库被锁定 → [WR-09] 拒绝；
 * - 完成出库须至少扫过一码且调出/调入仓库未锁定（WR-11）；调入仓库必填（无任务单不可无去向）。
 */
export function ReverseTransferOutPdaPage() {
  const { has, plantId } = useP2PdaPermissions()
  const canPost = has(REVERSE_POST) && has(REVERSE_READ)
  const [toWarehouseId, setToWarehouseId] = useState('wh-2')
  const [scanned, setScanned] = useState<string[]>([])
  const [orderId, setOrderId] = useState<string | null>(null)
  const [scanError, setScanError] = useState<{ title: string; detail?: string } | null>(null)
  const action = usePdaAction()

  if (!canPost) {
    return (
      <PageContainer title={$t('调拨出库')} description={$t('无任务单首扫建单（WR-07②/09/11）')}>
        <Message kind="warning" title={$t('没有逆向域操作许可（reverse.read + reverse.post）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const onScan = async (code: string) => {
    setScanError(null)
    try {
      const result = await p2Api.transferOutboundScan({
        plantId: plantId ?? 'n-plant',
        orderId: orderId ?? undefined,
        unitNo: code,
        toWarehouseId,
      })
      setScanned((prev) => [...prev, code])
      const data = result.data as { orderId?: string } | null
      if (!orderId && data?.orderId) setOrderId(data.orderId)
    } catch (err) {
      setScanError(err instanceof Error ? { title: $t('码不可装入（WR-09）'), detail: err.message } : { title: $t('扫码失败') })
    }
  }

  const complete = async () => {
    if (!orderId) return
    const ok = await action.run(() => p2Api.completeTransferOutbound({ plantId: plantId ?? 'n-plant', orderId }), $t('出库已完成：单据流转待入库（WR-11）'))
    if (ok) {
      setScanned([])
      setOrderId(null)
    }
  }

  return (
    <PageContainer title={$t('调拨出库')} description={$t('首次扫码自动建单；调入仓库不得等于调出仓库（WR-06）；完成须至少一码（WR-11）')}>
      <div style={{ marginBottom: 10 }}>
        <Input placeholder={$t('调入仓库 ID（演示 wh-2 一线边仓）')} value={toWarehouseId} onChange={(e) => setToWarehouseId(e.target.value)} />
      </div>
      <ScanInput onScan={(c) => void onScan(c)} hint={$t('扫料品码装入；不在库/已锁定/盘点锁定将被拒绝（WR-09）')} />
      <section style={{ marginTop: 12 }}>
        {scanError ? <Message kind="error" title={scanError.title} detail={scanError.detail} /> : null}
        {scanned.length > 0 ? (
          <div style={{ fontSize: 13, lineHeight: 1.9 }}>
            <p style={{ margin: 0 }}>
              {orderId ? (
                <>
                  {$t('任务单已建立')} <Badge tone="info">{orderId}</Badge>
                </>
              ) : (
                $t('首扫建单中')
              )}
              {$t('｜已装')} <Badge tone="info">{scanned.length} {$t('码')}</Badge>
            </p>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {scanned.map((c, i) => (
                <li key={`${c}-${i}`}>{c}</li>
              ))}
            </ul>
            <Button style={{ marginTop: 8 }} loading={action.busy} onClick={() => void complete()}>
              {$t('完成出库（WR-11）')}
            </Button>
          </div>
        ) : (
          <Message kind="info" title={$t('等待首扫（首扫建单，WR-07②）')} />
        )}
      </section>
      <section style={{ marginTop: 12 }}>
        {action.error ? <Message kind="error" title={action.error.title} detail={action.error.detail} /> : null}
        {action.success ? <Message kind="success" title={action.success} /> : null}
      </section>
    </PageContainer>
  )
}
