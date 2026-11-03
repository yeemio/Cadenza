import { useState } from 'react'
import { Badge, Button, Input, Message, PageContainer, ScanInput, t as $t } from '@cadenza/ui'
import type { ReverseMoveSubmitPayload } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REVERSE_POST, REVERSE_READ, useP2PdaPermissions } from '../permissions'
import { usePdaAction } from '../shared'

interface StagedMove {
  unitNo: string
  materialCode: string
  quantity: string
  uomCode: string
  fromLocationCode: string | null
}

/**
 * PDA 移库页（T17，WR-01～03）：
 * - 扫码只查询不锁定（WR-01）；已扫码暂存本机、退出清除；
 * - 提交服务端事务重校验（WR-02：同仓库、仓库未锁定、码在库、非托下单码、不重复、原新库位不同）；
 * - 移入库位范围＝登录人部门下、已启用、仓库类型（不含线边仓）（WR-03）。
 */
export function ReverseMovePdaPage() {
  const { has, plantId } = useP2PdaPermissions()
  const canPost = has(REVERSE_POST) && has(REVERSE_READ)
  const [warehouseId, setWarehouseId] = useState('wh-1')
  const [toLocationCode, setToLocationCode] = useState('')
  const [staged, setStaged] = useState<StagedMove[]>([])
  const [scanError, setScanError] = useState<{ title: string; detail?: string } | null>(null)
  const action = usePdaAction()

  if (!canPost) {
    return (
      <PageContainer title={$t('移库')} description={$t('同仓库内库位移动（WR-01～03）')}>
        <Message kind="warning" title={$t('没有逆向域操作许可（reverse.read + reverse.post）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const onScan = async (code: string) => {
    setScanError(null)
    try {
      const info = (await p2Api.moveScanInfo({ plantId: plantId ?? 'n-plant', unitNo: code, warehouseId })) as {
        unitNo: string
        materialCode?: string
        quantity?: string
        uomCode?: string
        fromLocationCode?: string | null
      }
      if (staged.some((s) => s.unitNo === info.unitNo)) {
        setScanError({ title: $t('该码已暂存（不重复，WR-02）') })
        return
      }
      setStaged((prev) => [
        ...prev,
        {
          unitNo: info.unitNo,
          materialCode: info.materialCode ?? '—',
          quantity: info.quantity ?? '—',
          uomCode: info.uomCode ?? '',
          fromLocationCode: info.fromLocationCode ?? null,
        },
      ])
    } catch (err) {
      setScanError(err instanceof Error ? { title: $t('移库校验未通过（WR-02）'), detail: err.message } : { title: $t('扫码失败') })
    }
  }

  const submit = async () => {
    const payload: ReverseMoveSubmitPayload = {
      plantId: plantId ?? 'n-plant',
      warehouseId,
      toLocationId: toLocationCode.trim(),
      stagedUnitNos: staged.map((s) => s.unitNo),
    }
    const ok = await action.run(() => p2Api.submitMove(payload), $t('移库已提交：{p0} 码（WR-02 服务端事务重校验）', { p0: staged.length }))
    if (ok) setStaged([])
  }

  return (
    <PageContainer title={$t('移库')} description={$t('扫码只查询不锁定（WR-01）；已扫码暂存本机，退出即清除；提交时统一校验')}>
      <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
        <Input placeholder={$t('仓库 ID（演示 wh-1 成品一仓）')} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} />
        <Input placeholder={$t('移入库位编码（本部门范围内，WR-03）')} value={toLocationCode} onChange={(e) => setToLocationCode(e.target.value)} />
      </div>
      <ScanInput onScan={(c) => void onScan(c)} hint={$t('扫料品码；托下单码/不在库/已锁定将被拒绝（WR-02）')} />
      <section style={{ marginTop: 12 }}>
        {scanError ? <Message kind="error" title={scanError.title} detail={scanError.detail} /> : null}
        {staged.length > 0 ? (
          <div style={{ fontSize: 13, lineHeight: 1.9 }}>
            <p style={{ margin: 0 }}>
              {$t('已暂存')} <Badge tone="info">{staged.length} {$t('码')}</Badge>
            </p>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {staged.map((s) => (
                <li key={s.unitNo}>
                  {s.unitNo}{$t('｜')}{s.materialCode}{$t('｜')}{s.quantity} {s.uomCode}{$t('｜原库位')} {s.fromLocationCode ?? '—'}
                </li>
              ))}
            </ul>
            <Button style={{ marginTop: 8 }} loading={action.busy} disabled={toLocationCode.trim() === ''} onClick={() => void submit()}>
              {$t('提交移库')}
            </Button>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--cz-color-text-secondary)' }}>{$t('等待扫码：扫料品码后暂存本机（WR-01）。')}</p>
        )}
      </section>
      <section style={{ marginTop: 12 }}>
        {action.error ? <Message kind="error" title={action.error.title} detail={action.error.detail} /> : null}
        {action.success ? <Message kind="success" title={action.success} /> : null}
      </section>
    </PageContainer>
  )
}
