import { useState } from 'react'
import { Badge, Button, Input, Message, PageContainer, ScanInput, t as $t } from '@cadenza/ui'
import type { ReelSplitSourceScanDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REWORK_POST, REWORK_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

/**
 * PDA 倒轴执行页（T15，RS-01～11）：
 * - 扫倒出轴（RS-03 前置拒绝链：托码/锁定/质检未完成/报工未审核等 → 错码清对象）；
 * - 会话模型（RS-06）：页面行仅本会话有效，提交时统一校验守恒式
 *   原量 = 倒入合计 + 留存量 + 损耗（RS-01）；
 * - 带客户轴号/段长必须全量倒出且倒入仅一条（RS-05 前端提示，服务端终校）；
 * - 损耗 >0 须填原因（RS-11）；数量 ≤4 位小数（RS-02）。
 */
export function ReelSplitPdaPage() {
  const { has } = useP2PdaPermissions()
  const canPost = has(REWORK_POST) && has(REWORK_READ)
  const [source, setSource] = useState<ReelSplitSourceScanDto | null>(null)
  const [scanError, setScanError] = useState<{ title: string; detail?: string } | null>(null)
  const [targetUnitNo, setTargetUnitNo] = useState('')
  const [targetQty, setTargetQty] = useState('')
  const [lossQty, setLossQty] = useState('0')
  const [lossReason, setLossReason] = useState('')
  const [lines, setLines] = useState<Array<{ targetUnitNo: string; quantity: string }>>([])
  const action = usePdaAction()

  if (!canPost) {
    return (
      <PageContainer title={$t('倒轴')} description={$t('扫倒出轴执行倒轴（rework-split RS-01～11）')}>
        <Message kind="warning" title={$t('没有倒轴域操作许可（rework.read + rework.post）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const onScan = async (code: string) => {
    // PC-05：错码立即清除旧对象
    setSource(null)
    setScanError(null)
    try {
      setSource(await p2Api.scanReelSplitSource(code))
    } catch (err) {
      setSource(null)
      setScanError(err instanceof Error ? { title: $t('倒出轴不可倒轴（RS-03）'), detail: err.message } : { title: $t('扫码失败') })
    }
  }

  const total = lines.reduce((acc, l) => acc + Number(l.quantity || 0), 0)
  const remaining = source ? Number(source.quantity) - total - Number(lossQty || 0) : 0
  const mustFull = source?.hasCustomerAxisNo === true || source?.hasSegmentLength === true

  const addLine = () => {
    if (!targetUnitNo.trim() || !(Number(targetQty) > 0)) return
    if (source && targetUnitNo.trim() === source.unitNo) {
      action.clearFeedback()
      return
    }
    setLines([...lines, { targetUnitNo: targetUnitNo.trim(), quantity: targetQty }])
    setTargetUnitNo('')
    setTargetQty('')
  }

  const submit = async () => {
    if (!source) return
    const ok = await action.run(
      () => p2Api.executeReelSplit({ sourceUnitNo: source.unitNo, lines, lossQuantity: lossQty || undefined, lossReason: lossReason || undefined }),
      $t('倒轴完成：倒入合计 {p0}，剩余 {p1}（RS-01 守恒式校验通过）', { p0: total.toFixed(4), p1: Math.max(0, remaining).toFixed(4) }),
    )
    if (ok) {
      setSource(null)
      setLines([])
      setLossQty('0')
      setLossReason('')
    }
  }

  return (
    <PageContainer title={$t('倒轴')} description={$t('会话模型：全部规则提交时统一校验（RS-06）；守恒式＝倒入合计+留存量+损耗（RS-01）')}>
      <ScanInput onScan={(c) => void onScan(c)} hint={$t('扫倒出轴（产品轴码）；托码/锁定/质检未完成等将被拒绝')} />
      <section style={{ marginTop: 12 }}>
        {scanError ? <Message kind="error" title={scanError.title} detail={scanError.detail} /> : null}
        {source ? (
          <div style={{ fontSize: 13.5, lineHeight: 1.9 }}>
            <p style={{ margin: 0 }}>
              <b>{source.unitNo}</b>{$t('｜')}{source.materialName}{$t('｜数量')}{' '}
              {source.quantity} {source.uom}
              {source.productionOrderNo ? $t('｜订单 {p0}', { p0: source.productionOrderNo }) : ''}
            </p>
            <p style={{ margin: 0, fontSize: 12.5 }}>
              {source.hasCustomerAxisNo || source.hasSegmentLength ? (
                <Badge tone="warning">{$t('带客户轴号/段长：必须全量倒出且倒入仅一条（RS-05）')}</Badge>
              ) : (
                <Badge tone="info">{$t('可部分倒出（多行倒入，RS-08）')}</Badge>
              )}
            </p>
          </div>
        ) : null}
      </section>
      {source ? (
        <section style={{ marginTop: 12 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <Input placeholder={$t('倒入轴号（目标码）')} value={targetUnitNo} onChange={(e) => setTargetUnitNo(e.target.value)} />
            <Input placeholder={$t('倒入数量（>0，≤4 位小数，RS-02）')} inputMode="decimal" value={targetQty} onChange={(e) => setTargetQty(e.target.value)} />
            <Button size="sm" variant="secondary" onClick={addLine}>
              {$t('加入倒入行')}
            </Button>
          </div>
          {lines.length > 0 ? (
            <ul style={{ fontSize: 13, paddingLeft: 18, margin: '8px 0' }}>
              {lines.map((l, i) => (
                <li key={`${l.targetUnitNo}-${i}`}>
                  {l.targetUnitNo}{$t('：')}{l.quantity} {source.uom}
                  <Button
                    size="sm"
                    variant="ghost"
                    style={{ marginLeft: 8 }}
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                  >
                    {$t('移除')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
            <Input placeholder={$t('损耗量（默认 0，>0 须填原因，RS-11）')} inputMode="decimal" value={lossQty} onChange={(e) => setLossQty(e.target.value)} />
            {Number(lossQty) > 0 ? <Input placeholder={$t('损耗原因（必填，RS-11）')} value={lossReason} onChange={(e) => setLossReason(e.target.value)} /> : null}
          </div>
          <p style={{ fontSize: 13 }}>
            {$t('倒入合计')} <b>{Number(total.toFixed(4))}</b>{$t('｜剩余（留存量）')} <b>{Number(remaining.toFixed(4))}</b> {source.uom}
            {remaining < 0 ? <Badge tone="danger">{$t('超量（RS-01 拒绝）')}</Badge> : null}
          </p>
          <Button
            loading={action.busy}
            disabled={lines.length === 0 || remaining < 0 || (Number(lossQty) > 0 && lossReason.trim() === '') || (mustFull && (lines.length !== 1 || Math.abs(remaining) > 0.00005))}
            onClick={() => void submit()}
          >
            {$t('提交倒轴（RS-01/02 服务端终校）')}
          </Button>
          {mustFull ? (
            <p style={{ fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>
              {$t('本轴带客户轴号/段长：须一条倒入行且全量倒出（剩余=0）才可提交（RS-05）。')}
            </p>
          ) : null}
        </section>
      ) : null}
      <section style={{ marginTop: 12 }}>
        {action.error ? <Message kind="error" title={action.error.title} detail={action.error.detail} /> : null}
        {action.success ? <Message kind="success" title={action.success} /> : null}
      </section>
    </PageContainer>
  )
}
