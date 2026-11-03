import { useState } from 'react'
import { Badge, Button, Input, Message, PageContainer, ScanInput, t as $t } from '@cadenza/ui'
import type { AxisCorrectionScanDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REWORK_POST, REWORK_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

/**
 * PDA 轴号修正页（T15，RS-25～31）：
 * - 扫码前置拒绝链（RS-25：托码/物流部仓库/已销售/质检未完成/报工未审核等）；
 * - 可选新轴号范围按订单分段明细生成；原码有段长时仅保留同段长项（RS-26）；
 * - 选中"已使用"轴号须确认占用＋理由（RS-30 客户轴段重新分配权限）；
 * - 截取数量单位随物料主计量单位（RS-31）；提交校验链服务端终校（RS-27）。
 */
export function AxisCorrectionPdaPage() {
  const { has } = useP2PdaPermissions()
  const canPost = has(REWORK_POST) && has(REWORK_READ)
  const [view, setView] = useState<AxisCorrectionScanDto | null>(null)
  const [scanError, setScanError] = useState<{ title: string; detail?: string } | null>(null)
  const [optionIdx, setOptionIdx] = useState<number | null>(null)
  const [cutQuantity, setCutQuantity] = useState('')
  const [reason, setReason] = useState('')
  const action = usePdaAction()

  if (!canPost) {
    return (
      <PageContainer title={$t('轴号修正')} description={$t('客户轴号/段长/虚拟轴号修正（RS-25～31）')}>
        <Message kind="warning" title={$t('没有倒轴域操作许可（rework.read + rework.post）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const onScan = async (code: string) => {
    setView(null)
    setOptionIdx(null)
    setScanError(null)
    setCutQuantity('')
    try {
      const v = await p2Api.scanAxisCorrection(code)
      setView(v)
    } catch (err) {
      setScanError(err instanceof Error ? { title: $t('该码不可修正（RS-25）'), detail: err.message } : { title: $t('扫码失败') })
    }
  }

  const submit = async () => {
    if (!view || optionIdx === null) return
    const opt = view.options[optionIdx]
    const ok = await action.run(
      () =>
        p2Api.submitAxisCorrection({
          unitNo: view.unitNo,
          newCustomerAxisNo: opt.customerAxisNo ?? undefined,
          newSegmentLength: opt.segmentLength ?? undefined,
          newVirtualAxisNo: opt.virtualAxisNo ?? undefined,
          cutQuantity,
          occupyConfirmed: opt.used ? true : undefined,
          reason: reason || undefined,
        }),
      $t('修正已提交（RS-27 校验通过后落记录）'),
    )
    if (ok) {
      setView(null)
      setOptionIdx(null)
      setCutQuantity('')
      setReason('')
    }
  }

  return (
    <PageContainer title={$t('轴号修正')} description={$t('可选新轴号按订单分段明细生成（RS-26）；截取数量单位随主计量单位（RS-31）')}>
      <ScanInput onScan={(c) => void onScan(c)} hint={$t('扫产品轴码；托码/已销售/质检未完成等将被拒绝（RS-25）')} />
      <section style={{ marginTop: 12 }}>
        {scanError ? <Message kind="error" title={scanError.title} detail={scanError.detail} /> : null}
        {view ? (
          <div style={{ fontSize: 13.5, lineHeight: 1.9 }}>
            <p style={{ margin: 0 }}>
              <b>{view.unitNo}</b>{$t('｜')}{view.materialName}{$t('｜数量')} {view.quantity} {view.uom}
              {view.customerAxisNo ? $t('｜当前客户轴号 {p0}', { p0: view.customerAxisNo }) : ''}
              {view.segmentLength ? $t('｜段长 {p0}', { p0: view.segmentLength }) : ''}
            </p>
            <p style={{ margin: 0, fontSize: 12.5 }}>{$t('单次最大报工数量')} {view.maxSingleReportQuantity}{$t('（截取上限）')}</p>
            <h4 style={{ margin: '8px 0 4px' }}>{$t('可选新轴号（RS-26）')}</h4>
            {view.options.map((opt, i) => (
              <label key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="radio"
                  name="axis-option"
                  checked={optionIdx === i}
                  onChange={() => setOptionIdx(i)}
                  aria-label={$t('选择轴号 {p0}', { p0: opt.customerAxisNo ?? opt.virtualAxisNo ?? i })}
                />
                {opt.customerAxisNo ?? $t('（不改客户轴号）')}
                {opt.segmentLength ? $t('｜段长 {p0}', { p0: opt.segmentLength }) : ''}
                {opt.virtualAxisNo ? $t('｜虚拟 {p0}', { p0: opt.virtualAxisNo }) : ''}
                {opt.used ? (
                  <Badge tone="danger">{$t('已使用（')}{opt.usedByUnitNo}{$t('；占用须确认+理由，RS-30）')}</Badge>
                ) : (
                  <Badge tone="success">{$t('可用')}</Badge>
                )}
              </label>
            ))}
            <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              <Input placeholder={$t('截取数量（>0，≤单次最大，RS-27）')} inputMode="decimal" value={cutQuantity} onChange={(e) => setCutQuantity(e.target.value)} />
              <Input placeholder={$t('修正理由（占用已使用轴号时必填，RS-30）')} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button
              style={{ marginTop: 8 }}
              loading={action.busy}
              disabled={optionIdx === null || !(Number(cutQuantity) > 0) || Number(cutQuantity) > Number(view.maxSingleReportQuantity)}
              onClick={() => void submit()}
            >
              {$t('提交修正')}
            </Button>
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
