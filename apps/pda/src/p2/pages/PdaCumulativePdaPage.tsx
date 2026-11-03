import { useState } from 'react'
import { Badge, Button, Message, PageContainer, Select, t as $t } from '@cadenza/ui'
import { REPORT_CALIBER_LABELS, type PdaCumulativeDto } from '../../../../../packages/ui/src/api/p2'
import { p2Api } from '../api'
import { REPORTING_READ, useP2PdaPermissions } from '../permissions'

/**
 * PDA 累计报工页（T20，RP-13）：
 * - 口径分开统计（草稿/提交/审核各自总量），不混成一个完成量（RP-16 同则）；
 * - 排除历史导入行（行数如实展示）；精准订单身份；
 * - 操作工只算自己（operatorOnly）/部门含下级由服务端按登录人处理。
 */
export function PdaCumulativePdaPage() {
  const { has } = useP2PdaPermissions()
  const canRead = has(REPORTING_READ)
  const [operatorOnly, setOperatorOnly] = useState(false)
  const [data, setData] = useState<{ calibers: PdaCumulativeDto[]; operatorOnly: boolean } | null>(null)
  const [error, setError] = useState<{ title: string } | null>(null)
  const [loading, setLoading] = useState(false)

  if (!canRead) {
    return (
      <PageContainer title={$t('累计报工')} description={$t('口径分开的累计（reporting RP-13）')}>
        <Message kind="warning" title={$t('没有报表域查询许可（reporting.read）')}>
          <p style={{ margin: '4px 0 0' }}>{$t('请在授权管理配置后刷新。')}</p>
        </Message>
      </PageContainer>
    )
  }

  const load = async (onlySelf: boolean) => {
    setLoading(true)
    try {
      const resp = await p2Api.pdaCumulative({ operatorOnly: onlySelf })
      setData(resp)
      setError(null)
    } catch {
      setError({ title: $t('加载累计报工失败') })
    } finally {
      setLoading(false)
    }
  }

  return (
    <PageContainer
      title={$t('累计报工')}
      description={$t('口径分开统计（RP-13/16）；排除历史导入；操作工只算自己或部门含下级（服务端处理）')}
      actions={
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Select
            aria-label={$t('统计范围')}
            value={operatorOnly ? 'self' : 'dept'}
            onChange={(e) => {
              const onlySelf = e.target.value === 'self'
              setOperatorOnly(onlySelf)
              void load(onlySelf)
            }}
            options={[
              { value: 'dept', label: $t('部门（含下级）') },
              { value: 'self', label: $t('只看自己') },
            ]}
          />
          <Button size="sm" loading={loading} onClick={() => void load(operatorOnly)}>
            {$t('刷新')}
          </Button>
        </span>
      }
    >
      {error ? <Message kind="error" title={error.title} /> : null}
      {data ? (
        <div style={{ fontSize: 13.5, lineHeight: 2 }}>
          {data.calibers.map((c) => (
            <p key={c.caliber} style={{ margin: 0 }}>
              <Badge tone={c.caliber === 'approved' ? 'success' : 'info'}>{REPORT_CALIBER_LABELS[c.caliber]}</Badge>
              {$t('｜')}{c.groups.map((g) => `${g.uomCode}：${g.totalQuantity}`).join('；')}
            </p>
          ))}
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--cz-color-text-secondary)' }}>
            {$t('已排除历史导入行（')}{data.calibers[0]?.excludedHistoricalRows ?? 0} {$t('行，RP-13）。')}
          </p>
        </div>
      ) : (
        <Message kind="info" title={$t('选择统计范围后加载')} />
      )}
    </PageContainer>
  )
}
