import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Message, PageContainer, ScanInput, Select, t as $t } from '@cadenza/ui'
import type { OrderConversionDetailDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { CONVERSION_POST, CONVERSION_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

/**
 * PDA 订单转换扫码页（T16 协议A，FC-07）：
 * - 选择进行中的转换单与明细行 → 扫载具码（E/F/M/P；R 拒）锁定并回写实扫数量/已扫轴数；
 * - 已用段长/客户轴号不可再选；码须属转换前订单库存且在库/有余额/未锁定（FC-07）；
 * - 删码解锁重算、留痕（FC-06 编辑门）；完成转换在 Web（FC-08）。
 */
export function OrderConversionScanPdaPage() {
  const { has } = useP2PdaPermissions()
  const canPost = has(CONVERSION_POST) && has(CONVERSION_READ)
  const [conversions, setConversions] = useState<Array<{ id: string; no: string }>>([])
  const [conversionId, setConversionId] = useState('')
  const [detail, setDetail] = useState<OrderConversionDetailDto | null>(null)
  const [lineId, setLineId] = useState('')
  const [scanError, setScanError] = useState<{ title: string; detail?: string } | null>(null)
  const action = usePdaAction()

  useEffect(() => {
    p2Api
      .listOrderConversions({ page: 1, pageSize: 20, statuses: ['pending'] })
      .then((page) => {
        setConversions(page.items.map((c) => ({ id: c.conversionId, no: c.conversionNo })))
        if (page.items.length > 0) setConversionId(page.items[0]!.conversionId)
      })
      .catch(() => setConversions([]))
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await p2Api.getOrderConversion(id)
      setDetail(d)
      if (d.lines.length > 0) setLineId(d.lines[0]!.lineId)
    } catch {
      setDetail(null)
    }
  }, [])

  useEffect(() => {
    if (conversionId) void loadDetail(conversionId)
  }, [conversionId, loadDetail])

  if (!canPost) {
    return (
      <PageContainer title={$t('订单转换扫码')} description={$t('载具码扫码锁定（form-conversion FC-07）')}>
        <Message kind="warning" title={$t('没有转换域操作许可（conversion.read + conversion.post）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const onScan = async (code: string) => {
    // 不做本地前置守卫：码合法性（含已用段长）由服务端统一拒绝（FC-07），
    // 未选单时的扫码违例同样以可行动文案反馈（PC-05/14）。
    setScanError(null)
    const ok = await action.run(() => p2Api.orderConversionScan({ conversionId, lineId, code }), $t('扫码成功：{p0} 已锁定并回写实扫数量（FC-07）', { p0: code }))
    if (ok && conversionId) await loadDetail(conversionId)
  }

  return (
    <PageContainer
      title={$t('订单转换扫码')}
      description={$t('载具码第 2 位 E/F/M/P（R 拒）；已用段长/客户轴号不可再选；重复/越界码以 [FC-07] 拒绝')}
    >
      <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
        <Select
          aria-label={$t('转换单')}
          value={conversionId}
          onChange={(e) => setConversionId(e.target.value)}
          placeholder={$t('选择待转换单')}
          options={conversions.map((c) => ({ value: c.id, label: c.no }))}
        />
        {detail ? (
          <Select
            aria-label={$t('明细行')}
            value={lineId}
            onChange={(e) => setLineId(e.target.value)}
            options={detail.lines.map((l) => ({
              value: l.lineId,
              label: $t('#{p0} {p1}（已扫轴数 {p2}）', { p0: l.lineNo, p1: l.materialCode, p2: l.scannedAxes }),
            }))}
          />
        ) : null}
      </div>
      <ScanInput onScan={(c) => void onScan(c)} hint={$t('扫载具码（E/F/M/P 起位）；提交后锁定该码（FC-07）')} />
      <section style={{ marginTop: 12 }}>
        {scanError ? <Message kind="error" title={scanError.title} detail={scanError.detail} /> : null}
        {detail ? (
          <div style={{ fontSize: 13, lineHeight: 1.9 }}>
            <p style={{ margin: 0 }}>
              {$t('转换状态')} <Badge tone="info">{$t('待转换')}</Badge>{$t('｜可完成')} {detail.completable ? $t('是（每明细已扫轴数>0）') : $t('否（FC-08）')}
            </p>
            {detail.scans.length > 0 ? (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {detail.scans.map((s) => (
                  <li key={s.scanId}>
                    {s.unitNo}{$t('｜')}{s.quantity}
                    {s.deleted ? $t('（已删码留痕）') : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ margin: 0 }}>{$t('尚无扫码。')}</p>
            )}
          </div>
        ) : (
          <Message kind="info" title={$t('选择转换单后扫码')} />
        )}
      </section>
      <section style={{ marginTop: 12 }}>
        {action.error ? <Message kind="error" title={action.error.title} detail={action.error.detail} /> : null}
        {action.success ? <Message kind="success" title={action.success} /> : null}
      </section>
      <Button variant="secondary" size="sm" onClick={() => void loadDetail(conversionId)}>
        {$t('刷新明细')}
      </Button>
    </PageContainer>
  )
}
