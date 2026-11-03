import { useState } from 'react'
import { Button, Input, Message, PageContainer, ScanInput, Select, t as $t } from '@cadenza/ui'
import { p2Api } from '../api'
import { DISPOSITION_POST, DISPOSITION_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

/**
 * PDA 成品异常上报页（T18，QD-05/06）：
 * - 已入库的码仅线边仓允许上报；托码与不存在仓库拒绝（QD-05）；
 * - 提交校验链（QD-06）：轴号/料品/不合格类型（返工|报废）/数量（>0 且≤该料品总数，
 *   ≤4 位小数）必填；审核在 Web（/p2/quality/defect）。
 */
export function FinishedDefectPdaPage() {
  const { has } = useP2PdaPermissions()
  const canPost = has(DISPOSITION_POST) && has(DISPOSITION_READ)
  const [unitNo, setUnitNo] = useState('')
  const [defectType, setDefectType] = useState<'rework' | 'scrap'>('rework')
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const action = usePdaAction()

  if (!canPost) {
    return (
      <PageContainer title={$t('成品异常上报')} description={$t('线边仓成品异常上报（QD-05/06）')}>
        <Message kind="warning" title={$t('没有处置域操作许可（disposition.read + disposition.post）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const submit = async () => {
    const ok = await action.run(
      () => p2Api.createFinishedDefect({ unitNo, materialCode: 'MAT-CU-8', defectType, quantity, reason: reason || undefined }),
      $t('异常已上报：待 Web 审核（QD-07/08）'),
    )
    if (ok) {
      setUnitNo('')
      setQuantity('')
      setReason('')
    }
  }

  return (
    <PageContainer title={$t('成品异常上报')} description={$t('已入库码仅线边仓允许；数量 >0 且 ≤料品总数（QD-06）；审核与扣数去向在 Web')}>
      <ScanInput onScan={(c) => setUnitNo(c)} hint={$t('扫轴码带出轴号（已入库仅线边仓允许，QD-05）')} />
      <section style={{ marginTop: 12, display: 'grid', gap: 6 }}>
        <Input placeholder={$t('轴号（扫码带出）')} value={unitNo} onChange={(e) => setUnitNo(e.target.value)} />
        <Select
          aria-label={$t('不合格类型')}
          value={defectType}
          onChange={(e) => setDefectType(e.target.value as 'rework' | 'scrap')}
          options={[
            { value: 'rework', label: $t('返工') },
            { value: 'scrap', label: $t('报废') },
          ]}
        />
        <Input placeholder={$t('数量（>0，≤料品总数，≤4 位小数，QD-06）')} inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <Input placeholder={$t('原因（选填）')} value={reason} onChange={(e) => setReason(e.target.value)} />
        <Button loading={action.busy} disabled={unitNo.trim() === '' || !(Number(quantity) > 0)} onClick={() => void submit()}>
          {$t('提交异常')}
        </Button>
      </section>
      <section style={{ marginTop: 12 }}>
        {action.error ? <Message kind="error" title={action.error.title} detail={action.error.detail} /> : null}
        {action.success ? <Message kind="success" title={action.success} /> : null}
      </section>
    </PageContainer>
  )
}
