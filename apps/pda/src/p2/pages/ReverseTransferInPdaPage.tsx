import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Input, Message, PageContainer, ScanInput, Select, t as $t } from '@cadenza/ui'
import type { TransferInboundOrderDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REVERSE_POST, REVERSE_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

/**
 * PDA 调拨入库扫码上架页（T17，WR-14～17）：
 * - 选择入库中单据 → 扫码上架；调入仓为仓库时须选库位（"库位编码或货架+两位层数"，WR-15）；
 * - 托下单码须扫托（先扫托再扫码，WR-15）；
 * - 删除扫码：退回未入库、清空库位、解除锁定；无入库码时单据回待入库（WR-16）；
 * - 完成入库须每料品已入库≥待入库、至少一码已入库（WR-17）；跨厂签收由接收方执行（WR-14）。
 */
export function ReverseTransferInPdaPage() {
  const { has, plantId } = useP2PdaPermissions()
  const canPost = has(REVERSE_POST) && has(REVERSE_READ)
  const [orders, setOrders] = useState<TransferInboundOrderDto[]>([])
  const [orderId, setOrderId] = useState('')
  const [locationCode, setLocationCode] = useState('')
  const [palletCode, setPalletCode] = useState('')
  const [scanError, setScanError] = useState<{ title: string; detail?: string } | null>(null)
  const action = usePdaAction()

  const load = useCallback(async () => {
    try {
      const page = await p2Api.listTransferInbound({ page: 1, pageSize: 20 })
      const inbounding = page.items.filter((o) => o.status !== 'completed')
      setOrders(inbounding)
      if (inbounding.length > 0 && !orderId) setOrderId(inbounding[0]!.orderId)
    } catch {
      setOrders([])
    }
  }, [orderId])

  useEffect(() => {
    void load()
  }, [load])

  if (!canPost) {
    return (
      <PageContainer title={$t('调拨入库上架')} description={$t('扫码上架与签收（WR-14～17）')}>
        <Message kind="warning" title={$t('没有逆向域操作许可（reverse.read + reverse.post）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const onScan = async (code: string) => {
    if (!orderId) {
      setScanError({ title: $t('请先选择入库单') })
      return
    }
    setScanError(null)
    const ok = await action.run(
      () => p2Api.transferInboundScanPutaway({ plantId: plantId ?? 'n-plant', orderId, unitNo: code, palletCode: palletCode.trim() || undefined, locationCode: locationCode.trim() || undefined }),
      $t('上架成功：{p0}（WR-15）', { p0: code }),
    )
    if (ok) await load()
  }

  const complete = async () => {
    if (!orderId) return
    const ok = await action.run(() => p2Api.completeTransferInbound(orderId, plantId ?? 'n-plant'), $t('完成入库已提交（WR-17）'))
    if (ok) await load()
  }

  const current = orders.find((o) => o.orderId === orderId) ?? null

  return (
    <PageContainer title={$t('调拨入库上架')} description={$t('跨厂/需交接调拨由接收方扫码上架/签收（WR-14）；完成须每料品已入库≥待入库（WR-17）')}>
      <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
        <Select
          aria-label={$t('入库单')}
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          placeholder={$t('选择入库中单据')}
          options={orders.map((o) => ({ value: o.orderId, label: `${o.orderNo}（${o.inboundCount}/${o.totalCount}）` }))}
        />
        <Input placeholder={$t('库位编码或货架编码+两位层数（仓库必填，WR-15）')} value={locationCode} onChange={(e) => setLocationCode(e.target.value)} />
        <Input placeholder={$t('托码（托下单码须先扫托，WR-15）')} value={palletCode} onChange={(e) => setPalletCode(e.target.value)} />
      </div>
      <ScanInput onScan={(c) => void onScan(c)} hint={$t('扫料品码上架；库位必填时缺失将被拒绝')} />
      <section style={{ marginTop: 12 }}>
        {scanError ? <Message kind="error" title={scanError.title} detail={scanError.detail} /> : null}
        {current ? (
          <div style={{ fontSize: 13, lineHeight: 1.9 }}>
            <p style={{ margin: 0 }}>
              {$t('单据')} {current.orderNo}{$t('｜码进度')} <Badge tone="info">{current.inboundCount}/{current.totalCount}</Badge>{$t('｜ 可完成')} {current.completable ? $t('是（WR-17）') : $t('否')}
            </p>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {current.inboundLines.map((l) => (
                <li key={l.unitNo}>
                  {l.unitNo}{$t('｜')}{l.materialCode ?? '—'}{$t('｜')}{l.lineStatus === 'inbound' ? $t('已入库 {p0}', { p0: l.locationCode ?? '' }) : $t('待入库')}
                </li>
              ))}
            </ul>
            <Button style={{ marginTop: 8 }} loading={action.busy} disabled={!current.completable} onClick={() => void complete()}>
              {$t('完成入库（WR-17）')}
            </Button>
          </div>
        ) : (
          <Message kind="info" title={$t('无入库中单据')} />
        )}
      </section>
      <section style={{ marginTop: 12 }}>
        {action.error ? <Message kind="error" title={action.error.title} detail={action.error.detail} /> : null}
        {action.success ? <Message kind="success" title={action.success} /> : null}
      </section>
    </PageContainer>
  )
}
