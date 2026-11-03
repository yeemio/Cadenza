import {
  ApiError,
  Badge,
  Button,
  Input,
  Message,
  PageContainer,
  BARCODE_VIA_LABELS,
  formatErrorTitleAndDetail,
  type BarcodeResolveDto,
  t as $t,
} from '@cadenza/ui'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { INVENTORY_READ, usePermissions } from '../permissions'

const OBJECT_TYPE_LABELS: Record<string, string> = {
  inventory_unit: '库存单元',
  carrier: '载具',
  equipment: '设备',
  material: '料品',
}

/**
 * 条码解析页（IT-04/05/06：barcode → 绑定 → 候选集合）：
 * - 输入任意码值解析：呈现识别类型（kind/confidence）、活动绑定与候选对象列表；
 * - 「一码多物需选择」语义：候选多于 1 个时显式提示选择目标对象后才能继续任务操作
 *   （本页只做对象选择与下钻，不发起任务命令）；
 * - 无候选 → IT-04 可行动文案；候选为库存单元可下钻单元详情。
 */
export function InventoryBarcodePage() {
  const { has } = usePermissions()
  const canRead = has(INVENTORY_READ)
  const [value, setValue] = useState('')
  const [result, setResult] = useState<BarcodeResolveDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)

  const resolve = async (code: string) => {
    const target = code.trim()
    if (!target) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const r = await api.resolveBarcode(target)
      setResult(r)
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorTitleAndDetail(err) : { title: $t('条码解析失败') })
    } finally {
      setLoading(false)
    }
  }

  if (!canRead) {
    return (
      <PageContainer title={$t('条码解析')} description={$t('条码 → 绑定 → 候选对象（inventory-trace-core 合同 IT-04/05/06）')}>
        <Message kind="warning" title={$t('没有库存查询许可（inventory.read）')} />
      </PageContainer>
    )
  }

  return (
    <PageContainer
      title={$t('条码解析')}
      description={$t('输入或粘贴码值解析候选对象；一码多物（如载具装载多件）时须显式选择目标对象（IT-06）')}
      actions={
        <form
          style={{ display: 'flex', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault()
            void resolve(value)
          }}
        >
          <Input
            style={{ width: 320 }}
            placeholder={$t('输入条码/二维码值（如 BC-U-0001、BC-CR-01）')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit" loading={loading}>
            {$t('解析')}
          </Button>
        </form>
      }
    >
      {error ? <Message kind="error" title={error.title} detail={error.detail} /> : null}
      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            style={{
              border: '1px solid var(--cz-color-border)',
              borderRadius: 8,
              padding: '10px 14px',
              display: 'flex',
              gap: 18,
              flexWrap: 'wrap',
              fontSize: 13,
            }}
          >
            <span>
              {$t('码值：')}<b>{result.barcodeValue}</b>
            </span>
            <span>
              {$t('识别类型：')}
              <Badge tone={result.kind.kind === 'unknown' ? 'warning' : 'info'}>
                {result.kind.kind}{$t('（')}{result.kind.confidence}{$t('）')}
              </Badge>
            </span>
            <span>
              {$t('活动绑定：')}
              {result.hasActiveBinding ? (
                <Badge tone="success">
                  {result.boundType} · {result.boundId}
                </Badge>
              ) : (
                <Badge>{$t('无')}</Badge>
              )}
            </span>
          </div>
          {result.candidates.length > 1 ? (
            <Message kind="warning" title={$t('一码多物：解析到 {p0} 个候选对象，需选择要操作的目标', { p0: result.candidates.length })}>
              <p style={{ margin: '4px 0 0' }}>{$t('条码（如载具码）可能对应多个装载对象，任务操作前必须先选定目标对象（IT-06）。')}</p>
            </Message>
          ) : null}
          {result.candidates.length === 0 ? (
            <Message kind="info" title={$t('该码未解析到候选对象（IT-04）')}>
              <p style={{ margin: '4px 0 0' }}>{$t('请核对码值是否正确，或改用人工输入单元号/单据号。')}</p>
            </Message>
          ) : (
            <table className="cz-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>{$t('对象类型')}</th>
                  <th>{$t('对象标识')}</th>
                  <th>{$t('说明')}</th>
                  <th>{$t('来源')}</th>
                  <th>{$t('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {result.candidates.map((c) => (
                  <tr key={`${c.objectType}-${c.objectId}`}>
                    <td>
                      <Badge tone="info">{OBJECT_TYPE_LABELS[c.objectType] ?? c.objectType}</Badge>
                    </td>
                    <td>{c.objectId}</td>
                    <td>{c.label}</td>
                    <td>{BARCODE_VIA_LABELS[c.via] ?? c.via}</td>
                    <td>
                      {c.objectType === 'inventory_unit' ? (
                        <Link to={`/inventory/units?unitId=${encodeURIComponent(c.objectId)}`} style={{ fontSize: 13 }}>
                          {$t('查看单元详情')}
                        </Link>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--cz-color-text-secondary)' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : !error ? (
        <Message kind="info" title={$t('输入码值后点击「解析」')}>
          <p style={{ margin: '4px 0 0' }}>
            {$t('解析返回识别类型、活动绑定与候选对象集合；候选多于 1 个时须先选择目标对象再执行任务操作。')}
          </p>
        </Message>
      ) : null}
    </PageContainer>
  )
}
